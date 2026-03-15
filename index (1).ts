// ══════════════════════════════════════════════════════
// SUPABASE EDGE FUNCTION: criar-preferencia
// Deploy: supabase functions deploy criar-preferencia
//
// Variáveis de ambiente necessárias (supabase secrets set):
//   MP_ACCESS_TOKEN = seu access token do Mercado Pago
//   SITE_URL = https://marsgames1.github.io/sitemarsgames
// ══════════════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const MP_TOKEN  = Deno.env.get("MP_ACCESS_TOKEN")!;
    const SITE_URL  = Deno.env.get("SITE_URL") || "https://marsgames1.github.io/sitemarsgames";
    const SUPA_URL  = Deno.env.get("SUPABASE_URL")!;
    const SUPA_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const sb = createClient(SUPA_URL, SUPA_KEY);

    // Pega o usuário autenticado
    const authHeader = req.headers.get("Authorization")!;
    const { data: { user }, error: authErr } = await sb.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Não autenticado" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    const { itens } = body; // [{ id, nome, preco, quantidade }]

    if (!itens?.length) {
      return new Response(JSON.stringify({ error: "Carrinho vazio" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    // Verifica estoque disponível para cada item
    for (const item of itens) {
      const { data: estoque } = await sb.rpc("estoque_disponivel", {
        p_produto_id: item.id
      });
      if ((estoque || 0) < (item.quantidade || 1)) {
        return new Response(JSON.stringify({
          error: `Sem estoque para: ${item.nome}`
        }), { status: 400, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    const total = itens.reduce((s: number, i: any) =>
      s + Number(i.preco) * (i.quantidade || 1), 0
    );

    // Cria pedido no banco com status pendente
    const { data: pedido, error: pedErr } = await sb
      .from("pedidos")
      .insert({
        user_id:       user.id,
        cliente_email: user.email,
        valor:         total,
        status:        "pendente",
        mp_status:     "pending",
        itens:         itens,
      })
      .select()
      .single();

    if (pedErr) throw pedErr;

    // Cria preferência no Mercado Pago
    const prefPayload = {
      items: itens.map((i: any) => ({
        id:          i.id,
        title:       i.nome,
        quantity:    i.quantidade || 1,
        unit_price:  Number(i.preco),
        currency_id: "BRL",
      })),
      payer: {
        email: user.email,
      },
      back_urls: {
        success: `${SITE_URL}/checkout-sucesso.html?pedido=${pedido.id}`,
        failure: `${SITE_URL}/index.html?pagamento=falhou`,
        pending: `${SITE_URL}/index.html?pagamento=pendente`,
      },
      auto_return:          "approved",
      external_reference:   pedido.id,
      notification_url:     `${SUPA_URL}/functions/v1/mp-webhook`,
      statement_descriptor: "MARSGAMES",
      payment_methods: {
        excluded_payment_types: [],
        installments: 1, // sem parcelamento por padrão
      },
      expires:    true,
      expiration_date_to: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30min
    };

    const mpRes = await fetch(
      "https://api.mercadopago.com/checkout/preferences",
      {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${MP_TOKEN}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify(prefPayload),
      }
    );

    const mpData = await mpRes.json();
    if (!mpRes.ok) {
      console.error("MP Error:", mpData);
      throw new Error(mpData.message || "Erro no Mercado Pago");
    }

    // Salva o preference_id no pedido
    await sb.from("pedidos")
      .update({ mp_preference_id: mpData.id })
      .eq("id", pedido.id);

    return new Response(JSON.stringify({
      preference_id: mpData.id,
      init_point:    mpData.init_point,    // URL do checkout MP (produção)
      sandbox_url:   mpData.sandbox_init_point, // URL do sandbox (testes)
      pedido_id:     pedido.id,
    }), {
      headers: { ...CORS, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" }
    });
  }
});
