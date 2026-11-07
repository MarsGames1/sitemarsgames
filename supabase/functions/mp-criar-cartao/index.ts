// Edge Function: mp-criar-cartao
// Deploy: supabase functions deploy mp-criar-cartao

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Descontos por plano MarsPass (mesma tabela do marspass.html) — fonte autoritativa no servidor
const MARSPASS_PCT: Record<string, number> = {
  andromeda: 3, triangulo: 5, centaurus: 10, sombrero: 15,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Não autenticado" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    const { itens, cardData, cupom } = body;

    if (!itens?.length || !cardData) {
      return new Response(JSON.stringify({ error: "Dados incompletos" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }
    if (!cardData.token) {
      return new Response(JSON.stringify({ error: "Token do cartão ausente" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const ACCESS_TOKEN = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN")!;
    const tipoPedido: string = body.tipo || "loja";
    const TIPOS_SEM_ESTOQUE = ["pvp", "marspoints", "cambio"];
    const ehProdutoFisico = !TIPOS_SEM_ESTOQUE.includes(tipoPedido) &&
      itens.every((i: any) => i.tipo !== "marspoints" && i.tipo !== "cambio" && i.tipo !== "pvp");

    // ════════════════════════════════════════════════════════════════
    //  PREÇO AUTORITATIVO (SERVIDOR) — nunca confia no valor do cliente
    // ════════════════════════════════════════════════════════════════
    let itensServidor: any[];
    let descontoValor = 0;
    let descontoInfo: any = null;

    if (ehProdutoFisico) {
      const ids = itens.map((i: any) => i.id || i.produto_id).filter(Boolean);
      const { data: prods } = await sb
        .from("produtos").select("id, nome, preco, ativo, imagem").in("id", ids);
      const mapa = new Map((prods || []).map((p: any) => [String(p.id), p]));

      itensServidor = [];
      for (const i of itens) {
        const pid = String(i.id || i.produto_id || "");
        const prod = mapa.get(pid);
        if (!prod) {
          return new Response(JSON.stringify({ error: `Produto não encontrado: ${i.nome || pid}` }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" },
          });
        }
        if (prod.ativo === false) {
          return new Response(JSON.stringify({ error: `Produto indisponível: ${prod.nome}` }), {
            status: 400, headers: { ...CORS, "Content-Type": "application/json" },
          });
        }
        itensServidor.push({
          id: prod.id, produto_id: prod.id, nome: prod.nome,
          imagem: prod.imagem || i.imagem || "",
          tipo: i.tipo || null,
          quantidade: Math.max(1, Number(i.quantidade || 1)),
          preco: Number(prod.preco),
        });
      }

      const precosUnit = itensServidor.map((x) => Number(x.preco));
      const menor = Math.min(...precosUnit);
      const hoje = new Date().toISOString().slice(0, 10);

      const codigoCupom = cupom?.codigo;
      if (codigoCupom) {
        const { data: c } = await sb
          .from("cupons").select("*")
          .ilike("codigo", String(codigoCupom)).eq("ativo", true).maybeSingle();
        if (c) {
          const validoData = !c.validade || String(c.validade) >= hoje;
          const dentroGlobal = !(c.max_usos != null && (c.usos || 0) >= c.max_usos);
          const okExcl = !c.user_email_exclusivo ||
            String(c.user_email_exclusivo).toLowerCase() === String(user.email).toLowerCase();
          const usosEmail = Array.isArray(c.emails_usados)
            ? c.emails_usados.filter((e: any) => (e?.email || e) === user.email).length : 0;
          const dentroEmail = usosEmail < (c.max_usos_por_email || 1);
          if (validoData && dentroGlobal && okExcl && dentroEmail) {
            descontoValor = Math.round(menor * (Number(c.desconto) || 0) / 100 * 100) / 100;
            descontoInfo = { tipo: "cupom", codigo: c.codigo, cupom_id: c.id, pct: Number(c.desconto) || 0 };
          }
        }
      }

      if (descontoValor === 0 && body?.desconto_marspass) {
        const { data: sub } = await sb
          .from("marspass_assinaturas")
          .select("plano, status, data_vencimento")
          .eq("user_email", user.email).eq("status", "ativa")
          .gte("data_vencimento", new Date().toISOString())
          .order("data_vencimento", { ascending: false }).maybeSingle();
        if (sub && MARSPASS_PCT[sub.plano]) {
          descontoValor = Math.round(menor * MARSPASS_PCT[sub.plano] / 100 * 100) / 100;
          descontoInfo = { tipo: "marspass", plano: sub.plano, pct: MARSPASS_PCT[sub.plano] };
        }
      }
    } else {
      // pvp / marspoints / cambio → preço dinâmico, comportamento INALTERADO
      itensServidor = itens.map((i: any) => ({
        ...i, quantidade: Number(i.quantidade || 1), preco: Number(i.preco || 0),
      }));
    }

    const subtotal = itensServidor.reduce((s: number, i: any) => s + i.preco * i.quantidade, 0);
    const total = Math.max(0, Math.round((subtotal - descontoValor) * 100) / 100);

    if (total < 1) {
      return new Response(JSON.stringify({ error: "Valor mínimo para cartão é R$ 1,00." }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const reference = `MG-CARD-${Date.now()}-${user.id.slice(0, 8)}`;

    // Itens para o MP (desconto aplicado no mais barato p/ a soma bater com o total)
    const itensMp = itensServidor.map((x) => ({ ...x }));
    if (descontoValor > 0) {
      let idxMenor = 0;
      for (let k = 1; k < itensMp.length; k++)
        if (Number(itensMp[k].preco) < Number(itensMp[idxMenor].preco)) idxMenor = k;
      itensMp[idxMenor].preco = Math.round(Math.max(0, Number(itensMp[idxMenor].preco) - descontoValor) * 100) / 100;
    }
    const mpItens = itensMp.map((p: any) => ({
      id: String(p.id || p.nome || "item").slice(0, 256),
      title: String(p.nome || "Produto").slice(0, 256),
      description: String(p.nome || "Produto").slice(0, 256),
      category_id: "games",
      quantity: Number(p.quantidade || 1),
      unit_price: Math.max(0.01, Math.round(Number(p.preco) * 100) / 100),
    }));

    // ── Payer ──
    const identification = cardData.payer?.identification;
    const payer: any = { email: user.email };
    if (identification?.type && identification?.number) {
      payer.identification = {
        type: String(identification.type).toUpperCase(),
        number: String(identification.number).replace(/\D/g, ""),
      };
    }

    // ── Body do MP — transaction_amount é o TOTAL AUTORITATIVO, não o do cliente ──
    const mpBody: any = {
      transaction_amount: total,
      token: String(cardData.token),
      installments: parseInt(String(cardData.installments || 1), 10),
      payment_method_id: String(cardData.payment_method_id),
      payer,
      description: `MarsGames — ${itensServidor.map((p: any) => p.nome).join(", ")}`.slice(0, 256),
      external_reference: reference,
      additional_info: { items: mpItens },
      statement_descriptor: "MARSGAMES",
      capture: true,
    };

    const cardholderName = (cardData.cardholder?.name || "").trim();
    if (cardholderName) {
      mpBody.additional_info.payer = {
        first_name: cardholderName.split(" ")[0] || "",
        last_name: cardholderName.split(" ").slice(1).join(" ") || "",
      };
    }

    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${ACCESS_TOKEN}`,
        "X-Idempotency-Key": reference,
      },
      body: JSON.stringify(mpBody),
    });

    const mpData = await mpRes.json();
    console.log("[mp-criar-cartao] status:", mpData.status, "detail:", mpData.status_detail);

    if (!mpRes.ok || mpData.error) {
      const cause = mpData.cause?.[0];
      const msg = cause?.description || mpData.message || mpData.error || "Erro no Mercado Pago";
      console.error("[mp-criar-cartao] MP error:", JSON.stringify(mpData));
      return new Response(JSON.stringify({ error: msg, status_detail: mpData.status_detail, cause: mpData.cause }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    // ── Salva pedido ──
    const pedido: any = {
      cliente_email: user.email,
      user_id: user.id,
      itens: itensServidor,
      total: total,
      valor: total,
      metodo: "cartao",
      status: mpData.status === "approved" ? "pago" : "pendente",
      reference: reference,
      mp_payment_id: String(mpData.id),
      created_at: new Date().toISOString(),
    };
    if (descontoInfo) pedido.desconto_info = descontoInfo;

    const { data: pedidoSalvo, error: dbErr } = await sb
      .from("pedidos").insert(pedido).select().single();

    if (dbErr) console.error("[mp-criar-cartao] db err:", dbErr.message);

    if (mpData.status === "approved" && pedidoSalvo) {
      try {
        await sb.functions.invoke("entregar-chaves", {
          body: { pedido_id: pedidoSalvo.id, user_email: user.email },
        });
      } catch (e) { console.error("[mp-criar-cartao] entregar-chaves:", e); }

      try {
        const mpBonus = Math.floor(total);
        const { data: mpRow } = await sb.from("marspoints").select("pontos, pontos_historico").eq("user_email", user.email).maybeSingle();
        const atual = mpRow?.pontos || 0;
        const novoSaldo = atual + mpBonus;
        const novoHistorico = Math.max(novoSaldo, mpRow?.pontos_historico || 0);
        await sb.from("marspoints").upsert({ user_email: user.email, pontos: novoSaldo, pontos_historico: novoHistorico, updated_at: new Date().toISOString() }, { onConflict: "user_email" });
      } catch (e) { console.error("[mp-criar-cartao] marspoints:", e); }

      try {
        const { data: plRow } = await sb.from("planetas").select("xp, atividades, log").eq("user_email", user.email).maybeSingle();
        const xpAtual = plRow?.xp || 0;
        const logAtual = plRow?.log || [];
        logAtual.unshift({ label: "Compra com cartão", xp: 50, icon: "💳", t: new Date().toLocaleTimeString("pt-BR") });
        await sb.from("planetas").upsert({ user_email: user.email, xp: xpAtual + 50, atividades: (plRow?.atividades || 0) + 1, log: logAtual.slice(0, 20), updated_at: new Date().toISOString() }, { onConflict: "user_email" });
      } catch (e) { console.error("[mp-criar-cartao] planetas:", e); }
    }

    return new Response(
      JSON.stringify({
        status: mpData.status,
        status_detail: mpData.status_detail,
        payment_id: String(mpData.id),
        pedido_id: pedidoSalvo?.id || "",
        reference,
      }),
      { headers: { ...CORS, "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("[mp-criar-cartao] catch:", err);
    return new Response(JSON.stringify({ error: err.message || "Erro interno" }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" }
    });
  }
});
