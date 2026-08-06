/**
 * scripts/generate-og-image.js — OG 图生成入口（薄包装）
 * 直接运行时写出 og-image.png；被 require 时透传 generateOgImage 导出。
 */
'use strict';

const { generateOgImage } = require('../src/content/generate-og-image');

if (require.main === module) {
  const bytes = generateOgImage();
  console.log('og-image.png generated (1200×630, %d bytes)', bytes);
}

module.exports = { generateOgImage };
