const axios = require('axios');

async function pushProductToShopify(product) {
  const SHOPIFY_BASE_URL = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2023-07`;

  const payload = {
    product: {
      title: product.product_title || product.product_name,
      body_html: `<p>${product.description}</p>`,
      vendor: "LiquidRetail",
      product_type: product.category || "Miscellaneous",
      tags: [product.condition, product.category, "AI-detected"],
      status: "draft",
      images: (product.marketing_images || []).map(url => ({ src: url })),
      variants: [
        {
          price: product.price_estimate || 0,
          inventory_management: "shopify",
          inventory_quantity: 1,
          option1: "Default"
        }
      ]
    }
  };

  const response = await axios.post(
    `${SHOPIFY_BASE_URL}/products.json`,
    payload,
    {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.product;
}

module.exports = { pushProductToShopify };
