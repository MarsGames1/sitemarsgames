// ══════════════════════════════════════════════════════
// SUPABASE EDGE FUNCTION: mercadopago-criar-preferencia
// Deploy: supabase functions deploy mercadopago-criar-preferencia
// ══════════════════════════════════════════════════════

// @ts-ignore
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
// @ts-ignore
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

declare const Deno: any;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const MP_TOKEN = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN");
    const SITE_URL = Deno.env.get("SITE_URL") || "https://marsgames1.github.io/sitemarsgames";
    const WEBHOOK_URL = Deno.env.get("WEBHOOK_URL") || "https://rzjtlghpsygxkivgwgws.supabase.co/functions/v1/mercadopago-webhook";
    const SUPA_URL = Deno.env.get("SUPABASE_URL");
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!MP_TOKEN) {
      console.error("MERCADOPAGO_ACCESS_TOKEN não configurado");
      return new Response(JSON.stringify({ error: "Token Mercado Pago não configurado" }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const sb = createClient(SUPA_URL, SUPA_KEY);

    // Extrai token do header
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
      return new Response(JSON.stringify({ error: "Token não fornecido" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    // Valida usuário
    const { data: { user }, error: authErr } = await sb.auth.getUser(token);
    
    if (authErr || !user) {
      console.error("Auth error:", authErr);
      return new Response(JSON.stringify({ error: "Usuário não autenticado" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const body = await req.json();
    const { itens, external_reference } = body;

    if (!itens?.length) {
      return new Response(JSON.stringify({ error: "Carrinho vazio" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    const reference = external_reference || ("PED-" + Date.now() + "-" + Math.random().toString(36).substring(2, 8));

    // Valor total
    const totalCentavos = Math.round(
      itens.reduce((acc: number, i: any) => acc + Number(i.preco) * (i.quantidade || 1), 0) * 100
    );

    // Cria preferência no Mercado Pago
    const mpPayload = {
      items: itens.map((i: any) => ({
        id: String(i.id),
        title: i.nome,
        description: i.nome,
        quantity: i.quantidade || 1,
        unit_price: Number(i.preco),
        currency_id: "BRL",
      })),
      payer: {
        email: user.email,
      },
      back_urls: {
        success: `${SITE_URL}/sucesso.html?ref=${reference}`,
        failure: `${SITE_URL}/aguardando-pagamento.html?ref=${reference}`,
        pending: `${SITE_URL}/aguardando-pagamento.html?ref=${reference}`,
      },
      auto_return: "approved",
      external_reference: reference,
      notification_url: WEBHOOK_URL,
    };

    console.log("Criando preferência MP com payload:", JSON.stringify(mpPayload));

    const mpRes = await fetch("https://api.mercadopago.com/checkout/preferences", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mpPayload),
    });

    const mpData = await mpRes.json();
    
    if (!mpRes.ok) {
      console.error("Mercado Pago error:", mpData);
      return new Response(JSON.stringify({ error: mpData.message || "Erro no Mercado Pago" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" }
      });
    }

    // Salva pedido_temp
    const { error: insertErr } = await sb.from("pedidos_temp").insert({
      user_id: user.id,
      user_email: user.email,
      reference: reference,
      valor: totalCentavos / 100,
      itens: itens,
      mp_preference_id: mpData.id,
    });

    if (insertErr) {
      console.error("Insert error:", insertErr);
      throw insertErr;
    }

    return new Response(JSON.stringify({
      preference_id: mpData.id,
      init_point: mpData.init_point,
      reference: reference,
    }), {
      headers: { ...CORS, "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" }
    });
  }
});
