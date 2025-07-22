async function processImage(imageUrl) {
  return {
    product_name: 'Hydraulic Pump',
    product_title: 'Heavy-Duty Hydraulic Pump',
    category: 'Hydraulics > Pumps',
    description: 'A durable hydraulic pump for fluid transfer.',
    condition: 'lightly used',
    confidence: 0.92,
    price_estimate: 150,
    marketing_images: [
      'https://example.com/generated-image1.jpg',
      'https://example.com/generated-image2.jpg'
    ]
  };
}

module.exports = { processImage };