// ══════════════════════════════════════════════════════
// SUPABASE EDGE FUNCTION: mp-webhook
// Deploy: supabase functions deploy mp-webhook
//
// Variáveis de ambiente:
//   MP_ACCESS_TOKEN    = access token do Mercado Pago
//   MP_WEBHOOK_SECRET  = secret configurado no painel MP
//   RESEND_API_KEY     = API key do Resend (email)
//   SITE_URL           = URL do site
// ══════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const MP_TOKEN     = Deno.env.get("MP_ACCESS_TOKEN")!;
    const RESEND_KEY   = Deno.env.get("RESEND_API_KEY");
    const SUPA_URL     = Deno.env.get("SUPABASE_URL")!;
    const SUPA_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const sb = createClient(SUPA_URL, SUPA_KEY);

    const body = await req.json();
    console.log("Webhook MP:", JSON.stringify(body));

    // MP envia diferentes tipos de notificação
    const tipo = body.type || body.topic;
    const dataId = body.data?.id || body.id;

    if (tipo !== "payment" || !dataId) {
      return new Response("ok", { status: 200 });
    }

    // Busca detalhes do pagamento no MP
    const payRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${dataId}`,
      { headers: { "Authorization": `Bearer ${MP_TOKEN}` } }
    );
    const payment = await payRes.json();
    console.log("Payment status:", payment.status, "ref:", payment.external_reference);

    // external_reference = pedido_id
    const pedidoId = payment.external_reference;
    if (!pedidoId) return new Response("sem referencia", { status: 200 });

    // Busca pedido
    const { data: pedido, error: pErr } = await sb
      .from("pedidos")
      .select("*")
      .eq("id", pedidoId)
      .single();

    if (pErr || !pedido) {
      console.error("Pedido não encontrado:", pedidoId);
      return new Response("pedido nao encontrado", { status: 200 });
    }

    // Atualiza status MP no pedido
    await sb.from("pedidos").update({
      mp_payment_id: String(dataId),
      mp_status:     payment.status,
    }).eq("id", pedidoId);

    // Só processa entrega se aprovado
    if (payment.status !== "approved") {
      console.log("Pagamento não aprovado:", payment.status);
      return new Response("ok", { status: 200 });
    }

    // Evita processar duas vezes
    if (pedido.status === "pago") {
      console.log("Pedido já processado:", pedidoId);
      return new Response("ja processado", { status: 200 });
    }

    // ── RESERVA E ENTREGA DAS CHAVES ──
    const itens = pedido.itens || [];
    const chavesEntregues: any[] = [];
    let erroEstoque = false;

    for (const item of itens) {
      try {
        // Reserva a chave atomicamente (sem venda dupla)
        const { data: chaveId, error: rErr } = await sb.rpc("reservar_chave", {
          p_produto_id: item.id,
          p_pedido_id:  pedidoId,
        });

        if (rErr) throw new Error(rErr.message);

        // Busca o conteúdo da chave
        const { data: chave } = await sb
          .from("estoque_chaves")
          .select("id, conteudo, tipo, produto_nome")
          .eq("id", chaveId)
          .single();

        if (!chave) throw new Error("Chave não encontrada após reserva");

        // Marca como entregue
        await sb.from("estoque_chaves").update({
          status:       "entregue",
          entregue_em:  new Date().toISOString(),
        }).eq("id", chave.id);

        chavesEntregues.push({
          produto_id:   item.id,
          produto_nome: chave.produto_nome || item.nome,
          tipo:         chave.tipo,
          conteudo:     chave.conteudo,
          entregue_em:  new Date().toISOString(),
        });

      } catch (e) {
        console.error("Erro ao reservar chave para:", item.nome, e);
        erroEstoque = true;
        chavesEntregues.push({
          produto_id:   item.id,
          produto_nome: item.nome,
          tipo:         "erro",
          conteudo:     "ERRO_ESTOQUE",
          erro:         String(e),
        });
      }
    }

    // Atualiza pedido como pago com as chaves
    await sb.from("pedidos").update({
      status:           "pago",
      chaves_entregues: chavesEntregues,
      email_enviado:    false, // será atualizado após envio
      updated_at:       new Date().toISOString(),
    }).eq("id", pedidoId);

    // ── ENVIA EMAIL COM AS CHAVES ──
    if (RESEND_KEY && !erroEstoque) {
      const emailBody = montarEmailChaves(
        pedido.cliente_email,
        chavesEntregues,
        pedido.valor
      );

      const emailRes = await fetch("https://api.resend.com/emails", {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          from:    "MarsGames <noreply@marsgames.com.br>",
          to:      [pedido.cliente_email],
          subject: "🎮 Seus jogos chegaram! MarsGames",
          html:    emailBody,
        }),
      });

      if (emailRes.ok) {
        await sb.from("pedidos").update({ email_enviado: true }).eq("id", pedidoId);
      }
    }

    // ── NOTIFICA ADMINS ──
    await sb.from("notificacoes_admin").insert({
      tipo:     "venda",
      titulo:   `💰 Nova venda — R$ ${Number(pedido.valor).toFixed(2)}`,
      mensagem: `${pedido.cliente_email} comprou ${itens.length} item(s)`,
      dados:    {
        pedido_id:     pedidoId,
        email:         pedido.cliente_email,
        valor:         pedido.valor,
        itens:         itens.map((i: any) => i.nome),
        erro_estoque:  erroEstoque,
      },
    });

    // Se teve erro de estoque, cria notificação de alerta separada
    if (erroEstoque) {
      await sb.from("notificacoes_admin").insert({
        tipo:     "erro_entrega",
        titulo:   "⚠️ ERRO — Sem estoque!",
        mensagem: `Pedido ${pedidoId} pago mas sem chave disponível. Entrega manual necessária!`,
        dados:    { pedido_id: pedidoId, email: pedido.cliente_email },
      });
    }

    return new Response("ok", { status: 200 });

  } catch (err) {
    console.error("Webhook error:", err);
    return new Response(String(err), { status: 500 });
  }
});

// ── Template de email ──
function montarEmailChaves(email: string, chaves: any[], valor: number): string {
  const itensHtml = chaves.map(c => {
    if (c.tipo === "login_senha") {
      const [login, senha] = c.conteudo.split("|");
      return `
        <div style="background:#1a1a20;border:1px solid #e8421a;border-radius:12px;padding:20px;margin-bottom:16px">
          <div style="color:#888;font-size:11px;font-weight:700;letter-spacing:2px;margin-bottom:12px">
            🎮 ${c.produto_nome}
          </div>
          <div style="margin-bottom:8px">
            <span style="color:#666;font-size:11px">Login:</span>
            <div style="font-family:monospace;font-size:15px;font-weight:700;color:#00ff55;
                        background:#0a0a0e;padding:8px 12px;border-radius:6px;margin-top:4px">
              ${login}
            </div>
          </div>
          <div>
            <span style="color:#666;font-size:11px">Senha:</span>
            <div style="font-family:monospace;font-size:15px;font-weight:700;color:#00ff55;
                        background:#0a0a0e;padding:8px 12px;border-radius:6px;margin-top:4px">
              ${senha}
            </div>
          </div>
        </div>`;
    } else {
      return `
        <div style="background:#1a1a20;border:1px solid #e8421a;border-radius:12px;padding:20px;margin-bottom:16px">
          <div style="color:#888;font-size:11px;font-weight:700;letter-spacing:2px;margin-bottom:12px">
            🎮 ${c.produto_nome}
          </div>
          <div>
            <span style="color:#666;font-size:11px">Chave de ativação:</span>
            <div style="font-family:monospace;font-size:16px;font-weight:700;color:#00ff55;
                        background:#0a0a0e;padding:10px 14px;border-radius:6px;margin-top:4px;
                        letter-spacing:2px">
              ${c.conteudo}
            </div>
          </div>
        </div>`;
    }
  }).join("");

  return `
    <!DOCTYPE html>
    <html>
    <body style="background:#0a0a0e;font-family:'Helvetica Neue',sans-serif;padding:0;margin:0">
      <div style="max-width:560px;margin:0 auto;padding:40px 20px">
        <!-- Header -->
        <div style="text-align:center;margin-bottom:40px">
          <div style="font-family:monospace;font-size:28px;font-weight:900;letter-spacing:4px;color:#fff">
            Mars<span style="color:#e8421a">Games</span>
          </div>
          <div style="color:#555;font-size:12px;margin-top:6px;letter-spacing:2px">
            ENTREGA DIGITAL IMEDIATA
          </div>
        </div>

        <!-- Banner -->
        <div style="background:linear-gradient(135deg,rgba(232,66,26,.15),rgba(0,255,85,.05));
                    border:1px solid rgba(232,66,26,.3);border-radius:16px;
                    padding:28px;text-align:center;margin-bottom:32px">
          <div style="font-size:40px;margin-bottom:12px">🎮</div>
          <div style="font-size:22px;font-weight:900;color:#fff;margin-bottom:8px">
            Seus jogos chegaram!
          </div>
          <div style="color:#888;font-size:13px">
            Pagamento confirmado • R$ ${Number(valor).toFixed(2).replace(".", ",")}
          </div>
        </div>

        <!-- Chaves -->
        <div style="margin-bottom:32px">
          <div style="color:#888;font-size:11px;font-weight:700;letter-spacing:2px;
                      text-transform:uppercase;margin-bottom:16px">
            Suas credenciais de acesso:
          </div>
          ${itensHtml}
        </div>

        <!-- Instrução Steam Offline -->
        <div style="background:#131318;border:1px solid #252530;border-radius:12px;
                    padding:20px;margin-bottom:32px">
          <div style="color:#fff;font-weight:700;margin-bottom:10px">
            ⚙️ Como ativar no Steam (modo Offline)
          </div>
          <ol style="color:#888;font-size:12px;line-height:2;padding-left:18px;margin:0">
            <li>Abra o Steam e vá em <strong style="color:#ccc">Conta → Entrar com outra conta</strong></li>
            <li>Use o login e senha fornecidos acima</li>
            <li>Ative o <strong style="color:#ccc">Modo Offline</strong> em Steam → Ir Offline</li>
            <li>Abra o jogo normalmente — funciona sem internet!</li>
          </ol>
        </div>

        <!-- Suporte -->
        <div style="text-align:center;padding:24px;border-top:1px solid #252530">
          <div style="color:#555;font-size:11px;margin-bottom:12px">
            Problema com sua compra?
          </div>
          <a href="https://discord.gg/bKnR9accnw"
             style="display:inline-block;padding:10px 24px;background:#7289da;
                    border-radius:8px;color:#fff;font-weight:700;font-size:12px;
                    text-decoration:none">
            💬 Suporte no Discord
          </a>
          <div style="color:#333;font-size:10px;margin-top:20px">
            © MarsGames • Suas credenciais ficam salvas na aba Pedidos do seu perfil
          </div>
        </div>
      </div>
    </body>
    </html>`;
}
