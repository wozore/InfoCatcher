'use strict';

const { generateOgImage } = require('../src/content/generate-og-image');

if (require.main === module) {
  const bytes = generateOgImage();
  console.log('og-image.png generated (1200×630, %d bytes)', bytes);
}

module.exports = { generateOgImage };
