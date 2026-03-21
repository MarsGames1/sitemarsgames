// ══════════════════════════════════════════════════════
// SUPABASE EDGE FUNCTION: mercadopago-webhook
// Deploy: supabase functions deploy mercadopago-webhook
//
// Variáveis de ambiente:
//   MERCADOPAGO_ACCESS_TOKEN = seu access token do Mercado Pago
//   RESEND_API_KEY           = API key do Resend (email)
// ══════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: any;

serve(async (req) => {
  try {
    const MP_TOKEN = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN")!;
    const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
    const SUPA_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const sb = createClient(SUPA_URL, SUPA_KEY);

    // Mercado Pago envia notificações via query string
    const url = new URL(req.url);
    const topic = url.searchParams.get("topic");
    const resourceId = url.searchParams.get("id");

    console.log("Webhook recebido:", { topic, resourceId });

    // Só processa pagamentos
    if (topic !== "payment") {
      return new Response("ok", { status: 200 });
    }

    if (!resourceId) {
      return new Response("sem id", { status: 200 });
    }

    // Busca detalhes do pagamento no Mercado Pago
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, {
      headers: {
        "Authorization": `Bearer ${MP_TOKEN}`,
      },
    });

    const payment = await mpRes.json();
    console.log("Pagamento:", JSON.stringify(payment));

    // Só processa pagamentos aprovados
    if (payment.status !== "approved") {
      console.log("Pagamento não aprovado:", payment.status);
      return new Response("ok", { status: 200 });
    }

    const reference = payment.external_reference;
    if (!reference) {
      console.error("Sem external_reference");
      return new Response("sem reference", { status: 200 });
    }

    console.log("Processando reference:", reference);

    // Evita reprocessar
    const { data: pedidoExistente } = await sb
      .from("pedidos")
      .select("*")
      .eq("reference", reference)
      .maybeSingle();

    if (pedidoExistente?.status === "aprovado") {
      console.log("Pedido já processado:", reference);
      return new Response("ja processado", { status: 200 });
    }

    // Busca pedido_temp
    let pedido = pedidoExistente;
    if (!pedido) {
      const { data: pedidoTemp, error: tempErr } = await sb
        .from("pedidos_temp")
        .select("*")
        .eq("reference", reference)
        .maybeSingle();

      if (tempErr || !pedidoTemp) {
        console.error("pedidos_temp não encontrado:", reference);
        return new Response("pedido nao encontrado", { status: 200 });
      }

      const { data: novoPedido, error: insErr } = await sb
        .from("pedidos")
        .insert({
          user_id: pedidoTemp.user_id,
          cliente_email: pedidoTemp.user_email,
          valor: pedidoTemp.valor,
          status: "pendente",
          mp_status: "approved",
          mp_payment_id: payment.id,
          itens: pedidoTemp.itens,
          reference: reference,
        })
        .select()
        .single();

      if (insErr) throw insErr;
      pedido = novoPedido;

      await sb.from("pedidos_temp").delete().eq("reference", reference);
    } else {
      await sb.from("pedidos").update({
        mp_payment_id: payment.id,
        mp_status: "approved",
      }).eq("reference", reference);
    }

    // ── ENTREGA DAS CHAVES ──
    const itens = pedido.itens || [];
    const chavesEntregues: any[] = [];
    let erroEstoque = false;

    for (const item of itens) {
      try {
        const { data: chaves, error: buscarErr } = await sb
          .from("estoque_chaves")
          .select("id, conteudo, tipo, produto_nome")
          .eq("produto_id", item.id)
          .eq("status", "disponivel")
          .limit(1);

        if (buscarErr) throw new Error(buscarErr.message);
        if (!chaves || chaves.length === 0) throw new Error("Sem estoque para: " + item.nome);

        const chave = chaves[0];

        const { error: updateErr } = await sb
          .from("estoque_chaves")
          .update({
            status: "entregue",
            entregue_em: new Date().toISOString(),
            pedido_id: pedido.id,
          })
          .eq("id", chave.id)
          .eq("status", "disponivel");

        if (updateErr) throw new Error(updateErr.message);

        chavesEntregues.push({
          produto_id: item.id,
          produto_nome: chave.produto_nome || item.nome,
          tipo: chave.tipo,
          conteudo: chave.conteudo,
          entregue_em: new Date().toISOString(),
        });

      } catch (e) {
        console.error("Erro ao entregar chave:", item.nome, e);
        erroEstoque = true;
        chavesEntregues.push({
          produto_id: item.id,
          produto_nome: item.nome,
          tipo: "erro",
          conteudo: "ERRO_ESTOQUE",
          erro: String(e),
        });
      }
    }

    await sb.from("pedidos").update({
      status: "aprovado",
      chaves_entregues: chavesEntregues,
      email_enviado: false,
      updated_at: new Date().toISOString(),
    }).eq("id", pedido.id);

    // Email via Resend
    if (RESEND_KEY && !erroEstoque) {
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "MarsGames <noreply@marsgames.com.br>",
          to: [pedido.cliente_email],
          subject: "🎮 Seus jogos chegaram! MarsGames",
          html: montarEmailChaves(pedido.cliente_email, chavesEntregues, pedido.valor),
        }),
      });
      if (emailRes.ok) {
        await sb.from("pedidos").update({ email_enviado: true }).eq("id", pedido.id);
      }
    }

    // Notificação admin
    await sb.from("notificacoes_admin").insert({
      tipo: "venda",
      titulo: `💰 Nova venda — R$ ${Number(pedido.valor).toFixed(2)}`,
      mensagem: `${pedido.cliente_email} comprou ${itens.length} item(s)`,
      dados: {
        pedido_id: pedido.id,
        reference,
        email: pedido.cliente_email,
        valor: pedido.valor,
        itens: itens.map((i: any) => i.nome),
        erro_estoque: erroEstoque,
      },
    });

    if (erroEstoque) {
      await sb.from("notificacoes_admin").insert({
        tipo: "erro_entrega",
        titulo: "⚠️ ERRO — Sem estoque!",
        mensagem: `Pedido ${pedido.id} (${reference}) pago mas sem chave. Entrega manual necessária!`,
        dados: { pedido_id: pedido.id, reference, email: pedido.cliente_email },
      });
    }

    return new Response("ok", { status: 200 });

  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(String(err), { status: 500 });
  }
});

function montarEmailChaves(email: string, chaves: any[], valor: number): string {
  const itensHtml = chaves.map(c => {
    if (c.tipo === "login_senha") {
      const [login, senha] = c.conteudo.split("|");
      return `<div style="background:#1a1a20;border:1px solid #e8421a;border-radius:12px;padding:20px;margin-bottom:16px">
        <div style="color:#888;font-size:11px;font-weight:700;letter-spacing:2px;margin-bottom:12px">🎮 ${c.produto_nome}</div>
        <div style="margin-bottom:8px"><span style="color:#666;font-size:11px">Login:</span>
          <div style="font-family:monospace;font-size:15px;font-weight:700;color:#00ff55;background:#0a0a0e;padding:8px 12px;border-radius:6px;margin-top:4px">${login}</div></div>
        <div><span style="color:#666;font-size:11px">Senha:</span>
          <div style="font-family:monospace;font-size:15px;font-weight:700;color:#00ff55;background:#0a0a0e;padding:8px 12px;border-radius:6px;margin-top:4px">${senha}</div></div>
      </div>`;
    }
    return `<div style="background:#1a1a20;border:1px solid #e8421a;border-radius:12px;padding:20px;margin-bottom:16px">
      <div style="color:#888;font-size:11px;font-weight:700;letter-spacing:2px;margin-bottom:12px">🎮 ${c.produto_nome}</div>
      <div style="font-family:monospace;font-size:16px;font-weight:700;color:#00ff55;background:#0a0a0e;padding:10px 14px;border-radius:6px;letter-spacing:2px">${c.conteudo}</div>
    </div>`;
  }).join("");

  return `<!DOCTYPE html><html><body style="background:#0a0a0e;font-family:'Helvetica Neue',sans-serif;padding:0;margin:0">
    <div style="max-width:560px;margin:0 auto;padding:40px 20px">
      <div style="text-align:center;margin-bottom:40px">
        <div style="font-family:monospace;font-size:28px;font-weight:900;letter-spacing:4px;color:#fff">Mars<span style="color:#e8421a">Games</span></div>
      </div>
      <div style="background:linear-gradient(135deg,rgba(232,66,26,.15),rgba(0,255,85,.05));border:1px solid rgba(232,66,26,.3);border-radius:16px;padding:28px;text-align:center;margin-bottom:32px">
        <div style="font-size:40px;margin-bottom:12px">🎮</div>
        <div style="font-size:22px;font-weight:900;color:#fff;margin-bottom:8px">Seus jogos chegaram!</div>
        <div style="color:#888;font-size:13px">Pagamento confirmado • R$ ${Number(valor).toFixed(2).replace(".", ",")}</div>
      </div>
      ${itensHtml}
      <div style="text-align:center;padding:24px;border-top:1px solid #252530">
        <a href="https://discord.gg/bKnR9accnw" style="display:inline-block;padding:10px 24px;background:#7289da;border-radius:8px;color:#fff;font-weight:700;font-size:12px;text-decoration:none">💬 Suporte no Discord</a>
        <div style="color:#333;font-size:10px;margin-top:20px">© MarsGames</div>
      </div>
    </div></body></html>`;
}
