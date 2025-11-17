// server.js - Servidor com Produtos Pré-Conectados
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// ===============================================
// Compatibilidade do fetch (Node 16 / 17 / 18+)
// ===============================================
let fetchFunction;

if (typeof fetch === "function") {
  // Node 18+ já tem fetch nativo
  fetchFunction = fetch;
  console.log("🌐 fetch nativo detectado (Node 18+).");
} else {
  // Node <= 17 precisa do node-fetch
  console.log("📦 Carregando fetch via node-fetch (Node 16/17).");
  fetchFunction = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));
}

const fetchApi = fetchFunction;

// ===============================================
// Inicialização do App Express
// ===============================================
const app = express();

app.use(cors({
  origin: '*',         // Em produção: coloque o domínio da loja Black
  credentials: false   // Deve ser false quando origin = '*'
}));

app.use(express.json());

// ===============================================
// Carregar variáveis de ambiente
// ===============================================
const BLACK_STORE = {
  shop: process.env.BLACK_STORE_DOMAIN,
  accessToken: process.env.BLACK_STORE_TOKEN
};

const WHITE_STORE = {
  shop: process.env.WHITE_STORE_DOMAIN,
  accessToken: process.env.WHITE_STORE_TOKEN
};

// Validar ENV
function validateEnv(store, name) {
  if (!store.shop) {
    console.error(`❌ ERRO: ${name}_DOMAIN não foi definido no .env`);
    process.exit(1);
  }
  if (!store.accessToken) {
    console.error(`❌ ERRO: ${name}_TOKEN não foi definido no .env`);
    process.exit(1);
  }
}

validateEnv(BLACK_STORE, "BLACK_STORE");
validateEnv(WHITE_STORE, "WHITE_STORE");

// ===============================================
// Cache
// ===============================================
const productCache = new Map();
const CACHE_DURATION = 3600000; // 1h

// ===============================================
// Função Shopify Request
// ===============================================
async function shopifyRequest(store, endpoint, method = 'GET', body = null) {
  const url = `https://${store.shop}/admin/api/2024-01/${endpoint}`;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': store.accessToken
    }
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const response = await fetchApi(url, options);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Shopify API Error ${response.status}: ${errorText}`);
  }

  return await response.json();
}

// ===============================================
// Buscar produto White pela SKU
// ===============================================
async function findWhiteProductBySKU(sku) {
  try {
    if (!sku) return null;

    const cacheKey = `sku_${sku}`;

    if (productCache.has(cacheKey)) {
      const cached = productCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log(`📦 Cache usado para SKU: ${sku}`);
        return cached.data;
      }
    }

    console.log(`🔍 Buscando produto na White via SKU: ${sku}`);

    const data = await shopifyRequest(WHITE_STORE, 'products.json?limit=250');

    for (const product of data.products) {
      const variant = product.variants.find(v => v.sku === sku);
      if (variant) {
        productCache.set(cacheKey, {
          data: { product, variant },
          timestamp: Date.now()
        });

        return { product, variant };
      }
    }

    return null;

  } catch (err) {
    console.error("❌ Erro ao buscar SKU na White:", err.message);
    throw err;
  }
}

// ===============================================
// Buscar produto White pelo Variant ID da Black
// ===============================================
async function findWhiteProductByBlackVariantId(blackVariantId) {
  console.log(`🔍 Buscando variant Black → SKU → White: ${blackVariantId}`);

  const blackVariant = await shopifyRequest(
    BLACK_STORE,
    `variants/${blackVariantId}.json`
  );

  const sku = blackVariant.variant.sku;

  if (!sku) throw new Error(`A variante ${blackVariantId} não tem SKU`);

  return await findWhiteProductBySKU(sku);
}

// ===============================================
// Criar Checkout (Draft Order na White)
// ===============================================
app.post('/api/create-checkout', async (req, res) => {
  try {
    const { cartItems } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ success: false, error: "Carrinho vazio" });
    }

    console.log(`🛒 Itens recebidos: ${cartItems.length}`);

    const lineItems = [];
    const errors = [];

    for (const item of cartItems) {
      let white;

      if (item.sku) white = await findWhiteProductBySKU(item.sku);
      if (!white && item.variantId)
        white = await findWhiteProductByBlackVariantId(item.variantId);

      if (!white) {
        errors.push(`Não encontrado na White → SKU: ${item.sku}`);
        continue;
      }

      lineItems.push({
        variant_id: white.variant.id,
        quantity: item.quantity
      });
    }

    if (lineItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Nenhum item encontrado na loja White",
        details: errors
      });
    }

    const draftOrderResult = await shopifyRequest(
      WHITE_STORE,
      "draft_orders.json",
      "POST",
      { draft_order: { line_items: lineItems, note: "Pedido via Black → White" } }
    );

    res.json({
      success: true,
      checkoutUrl: draftOrderResult.draft_order.invoice_url,
      itemsProcessed: lineItems.length,
      warnings: errors.length ? errors : null
    });

  } catch (err) {
    console.error("❌ Erro crítico:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===============================================
// Listar & mapear produtos
// ===============================================
app.get('/api/products/sync', async (req, res) => {
  try {
    const [black, white] = await Promise.all([
      shopifyRequest(BLACK_STORE, 'products.json?limit=250'),
      shopifyRequest(WHITE_STORE, 'products.json?limit=250')
    ]);

    const mapping = [];
    const unmappedBlack = [];
    const unmappedWhite = [];

    for (const b of black.products) {
      for (const bv of b.variants) {
        if (!bv.sku) continue;
        let found = false;

        for (const w of white.products) {
          const wv = w.variants.find(v => v.sku === bv.sku);
          if (wv) {
            mapping.push({
              sku: bv.sku,
              black: { productId: b.id, variantId: bv.id },
              white: { productId: w.id, variantId: wv.id }
            });
            found = true;
            break;
          }
        }

        if (!found) unmappedBlack.push(bv.sku);
      }
    }

    for (const w of white.products) {
      for (const wv of w.variants) {
        if (!wv.sku) continue;

        const exists = mapping.some(m => m.sku === wv.sku);
        if (!exists) unmappedWhite.push(wv.sku);
      }
    }

    res.json({
      success: true,
      totalMapped: mapping.length,
      unmappedBlack,
      unmappedWhite,
      mapping
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ===============================================
// Teste rápido
// ===============================================
app.get('/api/test', async (req, res) => {
  try {
    const black = await shopifyRequest(BLACK_STORE, 'shop.json');
    const white = await shopifyRequest(WHITE_STORE, 'shop.json');

    res.json({
      success: true,
      message: "Servidor OK",
      stores: {
        black: black.shop.name,
        white: white.shop.name
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===============================================
app.get('/', (req, res) => {
  res.json({
    status: "online",
    service: "Shopify Black → White Integration"
  });
});

// ===============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor online na porta ${PORT}`);
  console.log(`🛒 Loja Black: ${BLACK_STORE.shop}`);
  console.log(`⚪ Loja White: ${WHITE_STORE.shop}`);
});
