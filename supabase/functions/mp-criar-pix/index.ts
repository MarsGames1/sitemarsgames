import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Descontos por plano MarsPass (mesma tabela do marspass.html) — fonte autoritativa no servidor
const MARSPASS_PCT: Record<string, number> = {
  andromeda: 3, triangulo: 5, centaurus: 10, sombrero: 15,
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const MP_TOKEN    = Deno.env.get("MERCADOPAGO_ACCESS_TOKEN")!;
    const SUPA_URL    = Deno.env.get("SUPABASE_URL")!;
    const ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ── Autentica o usuário ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Não autenticado" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }
    const sbUser = createClient(SUPA_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await sbUser.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Sessão inválida" }), {
        status: 401, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { itens } = body;

    // ── Tipo do pedido (root-level): 'loja' | 'pvp' | 'marspoints' | 'cambio' ──
    const tipoPedido: string = body.tipo || "loja";

    if (!itens?.length) {
      return new Response(JSON.stringify({ error: "Carrinho vazio" }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const sbAdmin = createClient(SUPA_URL, SERVICE_KEY);

    // ── Tipos que NÃO têm estoque físico na tabela estoque_chaves ──
    const TIPOS_SEM_ESTOQUE = ["pvp", "marspoints", "cambio"];
    const ehProdutoFisico = !TIPOS_SEM_ESTOQUE.includes(tipoPedido) &&
      itens.every((i: any) => i.tipo !== "marspoints" && i.tipo !== "cambio" && i.tipo !== "pvp");

    if (ehProdutoFisico) {
      const semEstoque: string[] = [];
      for (const item of itens) {
        const produtoId = item.id || item.produto_id;
        const qtd = Number(item.quantidade || 1);
        let query = sbAdmin
          .from("estoque_chaves")
          .select("id", { count: "exact", head: true })
          .eq("status", "disponivel");
        query = produtoId
          ? query.eq("produto_id", produtoId)
          : query.eq("produto_nome", item.nome);
        const { count } = await query;
        if ((count ?? 0) < qtd) semEstoque.push(item.nome || "Produto");
      }
      if (semEstoque.length > 0) {
        return new Response(JSON.stringify({
          error: "sem_estoque", produtos: semEstoque,
          message: `Produto(s) sem estoque suficiente: ${semEstoque.join(", ")}. Tente novamente mais tarde.`,
        }), { status: 409, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    // ════════════════════════════════════════════════════════════════
    //  PREÇO AUTORITATIVO (SERVIDOR) — nunca confia no preço do cliente
    // ════════════════════════════════════════════════════════════════
    let itensServidor: any[];
    let descontoValor = 0;
    let descontoInfo: any = null;

    if (ehProdutoFisico) {
      // 1) Busca o preço REAL de cada produto em `produtos` (por id)
      const ids = itens.map((i: any) => i.id || i.produto_id).filter(Boolean);
      const { data: prods } = await sbAdmin
        .from("produtos")
        .select("id, nome, preco, ativo, imagem, categoria, tipo_key, preco_original, desconto")
        .in("id", ids);
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
          categoria: prod.categoria || null,
          tipo_key: prod.tipo_key || null,
          em_promo: (Number(prod.desconto) > 0) ||
            (prod.preco_original != null && Number(prod.preco_original) > Number(prod.preco)),
          quantidade: Math.max(1, Number(i.quantidade || 1)),
          preco: Number(prod.preco),
        });
      }

      // 2) Desconto SERVER-SIDE (cupom tem prioridade; senão MarsPass) — espelha o front
      const precosUnit = itensServidor.map((x) => Number(x.preco));
      const menor = Math.min(...precosUnit);
      const hoje = new Date().toISOString().slice(0, 10);

      const codigoCupom = body?.cupom?.codigo;
      if (codigoCupom) {
        const { data: c } = await sbAdmin
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
          // Travas da roleta: valor mínimo + não vale em CD Keys/Chaves/Combos/promoções
          const subtotalItens = itensServidor.reduce(
            (s: number, x: any) => s + Number(x.preco) * Number(x.quantidade || 1), 0);
          const ehRoleta = ["roda_fortuna", "roleta"].includes(String(c.origem || "").toLowerCase());
          const atingeMin = Number(c.valor_minimo || 0) <= 0 || subtotalItens >= Number(c.valor_minimo);
          const temItemBloqueado = itensServidor.some((x: any) =>
            x.tipo_key === "key" ||
            x.categoria === "Combos e Bundles" ||
            x.categoria === "Steam Key / Outros" ||
            x.em_promo === true);
          const passaRoleta = !ehRoleta || (atingeMin && !temItemBloqueado);
          if (validoData && dentroGlobal && okExcl && dentroEmail && atingeMin && passaRoleta) {
            descontoValor = Math.round(menor * (Number(c.desconto) || 0) / 100 * 100) / 100;
            descontoInfo = { tipo: "cupom", codigo: c.codigo, cupom_id: c.id, pct: Number(c.desconto) || 0 };
          }
        }
      }

      if (descontoValor === 0 && body?.desconto_marspass) {
        const { data: sub } = await sbAdmin
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

    // ── Total autoritativo ──
    const subtotal = itensServidor.reduce((s: number, i: any) => s + i.preco * i.quantidade, 0);
    const valorTotal = Math.max(0, Math.round((subtotal - descontoValor) * 100) / 100);

    if (valorTotal < 0.5) {
      return new Response(JSON.stringify({ error: "Valor inválido para pagamento." }), {
        status: 400, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // Aplica o desconto no item mais barato (p/ exibição no MP), mantendo a soma = valorTotal
    if (descontoValor > 0) {
      let idxMenor = 0;
      for (let k = 1; k < itensServidor.length; k++)
        if (Number(itensServidor[k].preco) < Number(itensServidor[idxMenor].preco)) idxMenor = k;
      itensServidor[idxMenor] = {
        ...itensServidor[idxMenor],
        preco: Math.round(Math.max(0, Number(itensServidor[idxMenor].preco) - descontoValor) * 100) / 100,
      };
    }

    // ── Gera reference único ──
    const prefix    = tipoPedido === "pvp" ? "PVP" : "MGS";
    const reference = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const nomeProduto = itensServidor.length === 1
      ? itensServidor[0].nome
      : `${itensServidor[0].nome} +${itensServidor.length - 1}`;

    // ── Cria pedido no Supabase ANTES do Pix ──
    const pedidoPayload: any = {
      reference,
      cliente_email:    user.email,
      produto_nome:     nomeProduto,
      valor:            valorTotal,
      itens:            itensServidor,
      status:           "pendente",
      chaves_entregues: [],
      created_at:       new Date().toISOString(),
    };
    if (descontoInfo) pedidoPayload.desconto_info = descontoInfo;
    if (tipoPedido === "pvp") {
      pedidoPayload.tipo = "pvp";
      pedidoPayload.sala = body.sala || null;
    }

    const { data: pedido, error: pedidoErr } = await sbAdmin
      .from("pedidos").insert(pedidoPayload).select("id").single();

    if (pedidoErr) {
      console.error("Erro ao criar pedido:", pedidoErr.message);
      return new Response(JSON.stringify({ error: pedidoErr.message }), {
        status: 500, headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    // ── Cria pagamento Pix na API do Mercado Pago ──
    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        Authorization:       `Bearer ${MP_TOKEN}`,
        "Content-Type":      "application/json",
        "X-Idempotency-Key": reference,
      },
      body: JSON.stringify({
        transaction_amount: valorTotal,
        description:        nomeProduto.substring(0, 256),
        payment_method_id:  "pix",
        external_reference: reference,
        notification_url:   `${SUPA_URL}/functions/v1/mp-webhook`,
        payer: {
          email:          user.email,
          first_name:     "MarsGames",
          last_name:      "Store",
          identification: { type: "CPF", number: "00000000000" },
        },
        date_of_expiration: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      }),
    });

    const mp = await mpRes.json();
    if (!mpRes.ok) {
      await sbAdmin.from("pedidos").delete().eq("id", pedido.id);
      console.error("Erro MP Pix:", JSON.stringify(mp));
      throw new Error(mp.message || mp.error || `Erro MP ${mpRes.status}`);
    }

    await sbAdmin.from("pedidos").update({ mp_payment_id: String(mp.id) }).eq("id", pedido.id);

    const pixData = mp.point_of_interaction?.transaction_data;

    return new Response(JSON.stringify({
      ok:             true,
      payment_id:     mp.id,
      reference,
      pedido_id:      pedido.id,
      qr_code:        pixData?.qr_code        ?? null,
      qr_code_base64: pixData?.qr_code_base64 ?? null,
      valor:          valorTotal,
      expira_em:      30,
    }), { headers: { ...CORS, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("Erro geral:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
