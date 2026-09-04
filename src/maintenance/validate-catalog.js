'use strict';

const fs = require('fs');
const { CATALOG_FILES } = require('../shared/paths');
const { catalog } = require('../catalog/interface');
const { validateCatalogSnapshot } = require('../catalog/core/index');
const { AREAS } = require('../catalog/core/index');

let failed = false;

function fail(message) {
  console.error('❌', message);
  failed = true;
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); }
  catch { return false; }
}

function readItems(area, file) {
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(payload) ? payload : payload.items;
    if (!Array.isArray(items)) fail(`${area} items 应为数组`);
    return items || [];
  } catch (error) {
    fail(`${area} 解析失败：${error.message}`);
    return [];
  }
}

function checkUnique(area, items) {
  const ids = new Set();
  items.forEach((item, index) => {
    if (!item.id) fail(`${area}[${index}] 缺少 id`);
    else if (ids.has(item.id)) fail(`${area} 重复 id: ${item.id}`);
    ids.add(item.id);
  });
}

function checkRef(area, source, target, targetIds, field) {
  for (const item of source) {
    const refs = Array.isArray(item[field]) ? item[field] : item[field] ? [item[field]] : [];
    for (const ref of refs) {
      if (!ref || !ref.kind || !ref.id || !targetIds.has(ref.id)) fail(`${area} ${item.id}.${field} 引用了不存在的 ${target}: ${ref?.id || 'unknown'}`);
    }
  }
}

const VENDOR_CARD_FIELDS = new Set([
  'id', 'vendor_key', 'title', 'icon', 'summary', 'feature_preview',
  'access_level', 'price_badge', 'search_terms', 'level1_ref',
]);
const TOOL_CARD_FIELDS = new Set([
  'id', 'tool_key', 'vendor_key', 'title', 'vendor_label', 'icon', 'summary', 'theme',
  'scenes', 'best_for_preview', 'not_for_preview', 'price_badge',
  'access_level', 'search_terms', 'detail_ref', 'detail_kind',
]);
const VENDOR_LEVEL1_FIELDS = new Set([
  'id', 'vendor_key', 'title', 'icon', 'official_url',
  'description', 'status', 'features', 'level2_refs',
]);
const VENDOR_LEVEL2_FIELDS = new Set([
  'id', 'level1_ref', 'vendor_key', 'title', 'official_url', 'summary', 'status',
  'detail_refs',
]);
const TOOL_LEVEL3_FIELDS = new Set([
  'id', 'vendor_key', 'detail_kind', 'theme', 'title', 'vendor_label', 'icon', 'official_url',
  'status', 'summary', 'one_m_context', 'api_pricing', 'plan',
  'applicable_scenarios', 'inapplicable_scenarios', 'sources', 'release_date', 'last_updated_date',
]);
const DETAIL_KINDS = new Set(['tool', 'api_model', 'subscription_plan', 'product_variant']);
const TOOL_CARD_KINDS = new Set(['tool', 'api_model', 'product_variant']);
const THEMES = new Set(['general', 'dev', 'vision', 'media']);

function checkAllowedFields(area, items, allowedFields) {
  items.forEach(item => {
    Object.keys(item).filter(field => !allowedFields.has(field)).forEach(field => {
      fail(`${area} ${item.id} 包含未允许字段: ${field}`);
    });
  });
}

function validateFiveModules() {
  const snapshot = {
    'vendor-card': readItems('vendor-cards.json', CATALOG_FILES.vendorCards),
    'tool-card': readItems('tool-cards.json', CATALOG_FILES.toolCards),
    'vendor-level1': readItems('vendor-preview-level1.json', CATALOG_FILES.vendorPreviewLevel1),
    'vendor-level2': readItems('vendor-preview-level2.json', CATALOG_FILES.vendorPreviewLevel2),
    'tool-level3': readItems('tool-preview-level3.json', CATALOG_FILES.toolPreviewLevel3),
  };
  const result = validateCatalogSnapshot(snapshot);
  result.errors.forEach(item => fail(`${item.path}: ${item.message}`));
  if (result.ok) {
    console.log(`  五模块目录: 厂商卡 ${snapshot['vendor-card'].length} · 工具卡 ${snapshot['tool-card'].length} · 一级 ${snapshot['vendor-level1'].length} · 二级 ${snapshot['vendor-level2'].length} · 三级 ${snapshot['tool-level3'].length}，通过`);
  }
  return result;
}

function validateGlossary(data) {
  if (!Array.isArray(data)) return fail('glossary.json 应为数组');
  if (data.length < 10) fail(`glossary.json 仅有 ${data.length} 条术语，预期至少 10 条`);
  const terms = new Set();
  data.forEach((entry, index) => {
    if (!entry.term || !entry.category || !entry.summary || !entry.source) fail(`glossary.json[${index}] 缺少必填字段`);
    const key = String(entry.term || '').toLowerCase();
    if (terms.has(key)) fail(`glossary.json 重复术语: ${entry.term}`);
    terms.add(key);
  });
  console.log(`  glossary.json: ${data.length} 条术语，通过`);
}

function validateCatalog() {
  validateFiveModules();
  try { validateGlossary(JSON.parse(fs.readFileSync(CATALOG_FILES.glossary, 'utf8'))); }
  catch (error) { fail(`glossary.json 解析失败：${error.message}`); }
  return readItems('tool-cards.json', CATALOG_FILES.toolCards);
}

function validateHtml(html) {
  const expected = ['view-tools', 'view-scenes', 'view-compare', 'view-glossary', 'view-trending', 'view-featured', 'view-about', 'searchInput', 'toolGrid', 'sceneSearch', 'scenePicker', 'sceneDetail', 'trendingGrid', 'modalOverlay'];
  expected.forEach(id => { if (!new RegExp(`id=["']${id}["']`).test(html)) fail(`index.html 缺少 id="${id}"`); });
  const epCount = (html.match(/EXTENSION POINT/g) || []).length;
  if (epCount < 3) fail(`index.html 中 EXTENSION POINT 不足 ${epCount} 处`);
  console.log(`  index.html: ${epCount} 处扩展点，通过`);
}

module.exports = { validateCatalog, validateHtml, validateFiveModules, get failed() { return failed; } };
