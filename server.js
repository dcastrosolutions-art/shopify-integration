// server.js - Servidor com Produtos Pré-Conectados
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({
  origin: '*', // Em produção: 'https://uzj9me-zs.myshopify.com'
  credentials: true
}));

app.use(express.json());

// Configurações das Lojas
const BLACK_STORE = {
  shop: process.env.uzj9me-zs.myshopify.com,
  accessToken: process.env.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
};

const WHITE_STORE = {
  shop: process.env.b6wypa-1t.myshopify.com,
  accessToken: process.env.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
};

// Cache para melhorar performance
const productCache = new Map();
const CACHE_DURATION = 3600000; // 1 hora

// Função para fazer requisições à API Shopify
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

  const response = await fetch(url, options);
  
  if (!response.ok) {
    throw new Error(`Shopify API Error: ${response.status} - ${await response.text()}`);
  }
  
  return await response.json();
}

// Buscar produto na loja White pelo SKU (produto já existe)
async function findWhiteProductBySKU(sku) {
  try {
    // Verificar cache primeiro
    const cacheKey = `sku_${sku}`;
    if (productCache.has(cacheKey)) {
      const cached = productCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log(`📦 Usando cache para SKU: ${sku}`);
        return cached.data;
      }
    }

    console.log(`🔍 Buscando produto com SKU: ${sku} na loja White...`);
    
    // Buscar todos os produtos (pode paginar se tiver muitos)
    const data = await shopifyRequest(WHITE_STORE, 'products.json?limit=250');
    
    // Procurar produto que tenha variante com este SKU
    for (const product of data.products) {
      const variant = product.variants.find(v => v.sku === sku);
      if (variant) {
        console.log(`✅ Produto encontrado: ${product.title} (ID: ${product.id})`);
        
        // Salvar no cache
        productCache.set(cacheKey, {
          data: { product, variant },
          timestamp: Date.now()
        });
        
        return { product, variant };
      }
    }

    console.log(`⚠️ Produto não encontrado com SKU: ${sku}`);
    return null;
  } catch (error) {
    console.error('❌ Erro ao buscar produto:', error);
    throw error;
  }
}

// Buscar variante específica na loja White pelo Variant ID da Black
async function findWhiteProductByBlackVariantId(blackVariantId) {
  try {
    console.log(`🔍 Buscando produto para variant ID da Black: ${blackVariantId}`);
    
    // Buscar variante na Black para pegar o SKU
    const blackVariant = await shopifyRequest(
      BLACK_STORE,
      `variants/${blackVariantId}.json`
    );
    
    const sku = blackVariant.variant.sku;
    
    if (!sku) {
      throw new Error(`Variante ${blackVariantId} não tem SKU definido`);
    }

    // Buscar na White pelo SKU
    return await findWhiteProductBySKU(sku);
  } catch (error) {
    console.error('❌ Erro ao buscar produto:', error);
    throw error;
  }
}

// Endpoint principal: Criar checkout na loja White
app.post('/api/create-checkout', async (req, res) => {
  try {
    console.log('\n🛒 ===== NOVA REQUISIÇÃO DE CHECKOUT =====');
    const { cartItems } = req.body;

    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Carrinho vazio'
      });
    }

    console.log(`📋 Total de itens: ${cartItems.length}`);

    // Mapear itens do carrinho Black para White
    const lineItems = [];
    const errors = [];
    
    for (let i = 0; i < cartItems.length; i++) {
      const item = cartItems[i];
      console.log(`\n[${i + 1}/${cartItems.length}] Processando item:`);
      console.log(`  - Variant ID (Black): ${item.variantId}`);
      console.log(`  - SKU: ${item.sku || 'não informado'}`);
      console.log(`  - Quantidade: ${item.quantity}`);

      try {
        let whiteProduct;

        // Tentar buscar por SKU primeiro (mais rápido)
        if (item.sku) {
          whiteProduct = await findWhiteProductBySKU(item.sku);
        }

        // Se não encontrou por SKU, tentar por Variant ID
        if (!whiteProduct && item.variantId) {
          whiteProduct = await findWhiteProductByBlackVariantId(item.variantId);
        }

        if (whiteProduct && whiteProduct.variant) {
          lineItems.push({
            variant_id: whiteProduct.variant.id,
            quantity: item.quantity
          });
          console.log(`  ✅ Mapeado para: ${whiteProduct.product.title}`);
          console.log(`     Variant ID (White): ${whiteProduct.variant.id}`);
        } else {
          const errorMsg = `Produto não encontrado na loja White (SKU: ${item.sku || 'N/A'})`;
          console.log(`  ❌ ${errorMsg}`);
          errors.push(errorMsg);
        }
      } catch (error) {
        console.error(`  ❌ Erro ao processar item:`, error.message);
        errors.push(`Erro no item ${i + 1}: ${error.message}`);
      }
    }

    // Se nenhum item foi mapeado
    if (lineItems.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Nenhum produto encontrado na loja White',
        details: errors
      });
    }

    // Avisar sobre itens não encontrados
    if (errors.length > 0) {
      console.log(`\n⚠️ Avisos: ${errors.length} item(ns) não mapeado(s)`);
    }

    // Criar Draft Order na loja White
    console.log('\n💳 Criando Draft Order na loja White...');
    console.log(`   Itens: ${lineItems.length}`);
    
    const draftOrderData = {
      draft_order: {
        line_items: lineItems,
        use_customer_default_address: true,
        note: 'Pedido criado via integração Black → White'
      }
    };

    const draftOrderResult = await shopifyRequest(
      WHITE_STORE,
      'draft_orders.json',
      'POST',
      draftOrderData
    );

    const invoiceUrl = draftOrderResult.draft_order.invoice_url;
    
    console.log('✅ Draft Order criado com sucesso!');
    console.log(`   URL: ${invoiceUrl}`);
    console.log('========================================\n');

    res.json({
      success: true,
      checkoutUrl: invoiceUrl,
      itemsProcessed: lineItems.length,
      warnings: errors.length > 0 ? errors : null
    });

  } catch (error) {
    console.error('\n❌ ERRO CRÍTICO:', error);
    console.error('Stack:', error.stack);
    console.log('========================================\n');
    
    res.status(500).json({
      success: false,
      error: error.message || 'Erro ao processar checkout'
    });
  }
});

// Endpoint para sincronizar/listar produtos
app.get('/api/products/sync', async (req, res) => {
  try {
    console.log('🔄 Sincronizando produtos...');

    // Buscar produtos das duas lojas
    const [blackProducts, whiteProducts] = await Promise.all([
      shopifyRequest(BLACK_STORE, 'products.json?limit=250'),
      shopifyRequest(WHITE_STORE, 'products.json?limit=250')
    ]);

    // Mapear produtos por SKU
    const mapping = [];
    const unmapped = {
      black: [],
      white: []
    };

    for (const blackProduct of blackProducts.products) {
      for (const blackVariant of blackProduct.variants) {
        if (!blackVariant.sku) continue;

        let found = false;
        for (const whiteProduct of whiteProducts.products) {
          const whiteVariant = whiteProduct.variants.find(
            v => v.sku === blackVariant.sku
          );
          
          if (whiteVariant) {
            mapping.push({
              sku: blackVariant.sku,
              black: {
                productId: blackProduct.id,
                productTitle: blackProduct.title,
                variantId: blackVariant.id,
                variantTitle: blackVariant.title
              },
              white: {
                productId: whiteProduct.id,
                productTitle: whiteProduct.title,
                variantId: whiteVariant.id,
                variantTitle: whiteVariant.title
              }
            });
            found = true;
            break;
          }
        }

        if (!found) {
          unmapped.black.push({
            sku: blackVariant.sku,
            product: blackProduct.title,
            variant: blackVariant.title
          });
        }
      }
    }

    // Produtos White sem correspondente
    for (const whiteProduct of whiteProducts.products) {
      for (const whiteVariant of whiteProduct.variants) {
        if (!whiteVariant.sku) continue;

        const isMapped = mapping.some(m => m.sku === whiteVariant.sku);
        if (!isMapped) {
          unmapped.white.push({
            sku: whiteVariant.sku,
            product: whiteProduct.title,
            variant: whiteVariant.title
          });
        }
      }
    }

    res.json({
      success: true,
      stats: {
        totalMapped: mapping.length,
        unmappedBlack: unmapped.black.length,
        unmappedWhite: unmapped.white.length
      },
      mapping,
      unmapped
    });

  } catch (error) {
    console.error('Erro ao sincronizar:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint de teste
app.get('/api/test', async (req, res) => {
  try {
    // Testar conexão com as lojas
    const blackTest = await shopifyRequest(BLACK_STORE, 'shop.json');
    const whiteTest = await shopifyRequest(WHITE_STORE, 'shop.json');

    res.json({
      success: true,
      message: 'Servidor funcionando perfeitamente!',
      stores: {
        black: {
          status: '✅ Conectada',
          shop: blackTest.shop.name,
          domain: blackTest.shop.domain
        },
        white: {
          status: '✅ Conectada',
          shop: whiteTest.shop.name,
          domain: whiteTest.shop.domain
        }
      },
      cache: {
        entries: productCache.size
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stores: {
        black: BLACK_STORE.shop ? '❓ Erro ao conectar' : '❌ Não configurada',
        white: WHITE_STORE.shop ? '❓ Erro ao conectar' : '❌ Não configurada'
      }
    });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Shopify Black → White Integration',
    version: '2.0.0',
    features: ['Pre-mapped products', 'SKU-based matching', 'Cache system']
  });
});

// Limpar cache periodicamente
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of productCache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      productCache.delete(key);
    }
  }
}, CACHE_DURATION);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════════════════════╗
  ║   🚀 Servidor Shopify Integration Online!      ║
  ║   📡 Porta: ${PORT}                               ║
  ║   🔗 Modo: Produtos Pré-Conectados             ║
  ╚════════════════════════════════════════════════╝
  `);
  
  console.log('\n📋 Configurações:');
  console.log(`  🏪 Loja Black: ${BLACK_STORE.shop || '❌ Não configurada'}`);
  console.log(`  🏪 Loja White: ${WHITE_STORE.shop || '❌ Não configurada'}`);
  console.log('\n🔗 Endpoints disponíveis:');
  console.log(`  GET  / - Status do servidor`);
  console.log(`  GET  /api/test - Testar conexões`);
  console.log(`  GET  /api/products/sync - Ver produtos conectados`);
  console.log(`  POST /api/create-checkout - Criar checkout`);
  console.log('\n');
});