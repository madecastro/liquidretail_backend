/**
 * Fallback search logic for unknown or low-confidence products.
 * Returns a best-guess product object from mock or real catalog data.
 */

async function fallbackAmazonSearch(query) {
  console.log(`🟡 Fallback triggered: searching for "${query}"...`);

  // Simulated matches — can be replaced with a real API call
  const matches = [
    {
      product_name: "Hydraulic Gear Pump",
      product_title: "16cc Hydraulic Gear Pump (250 bar)",
      description: "Compact hydraulic gear pump suitable for light to heavy-duty applications. 250 bar operating pressure.",
      condition: "used",
      price_estimate: 139.99,
      confidence: 0.65,
      marketing_images: [
        "https://via.placeholder.com/1024x1024?text=Hydraulic+Pump"
      ]
    },
    {
      product_name: "Axial Piston Pump",
      product_title: "Bosch Rexroth A10VO Axial Pump",
      description: "Original Bosch Rexroth axial piston pump for industrial hydraulics.",
      condition: "lightly used",
      price_estimate: 199.99,
      confidence: 0.72,
      marketing_images: [
        "https://via.placeholder.com/1024x1024?text=Axial+Pump"
      ]
    }
  ];

  // Just return the first match for now (simulate AI decision)
  return matches[0];
}

module.exports = { fallbackAmazonSearch };
