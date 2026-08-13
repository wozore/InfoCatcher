'use strict';

const fs = require('fs');
const { CATALOG_FILES } = require('../shared/paths');
const { catalog } = require('../catalog-interface');

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
  'applicable_scenarios', 'inapplicable_scenarios', 'sources', 'official_date',
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
  const vendorCards = readItems('vendor-cards.json', CATALOG_FILES.vendorCards);
  const toolCards = readItems('tool-cards.json', CATALOG_FILES.toolCards);
  const level1 = readItems('vendor-preview-level1.json', CATALOG_FILES.vendorPreviewLevel1);
  const level2 = readItems('vendor-preview-level2.json', CATALOG_FILES.vendorPreviewLevel2);
  const level3 = readItems('tool-preview-level3.json', CATALOG_FILES.toolPreviewLevel3);
  [
    ['vendor-cards.json', vendorCards],
    ['tool-cards.json', toolCards],
    ['vendor-preview-level1.json', level1],
    ['vendor-preview-level2.json', level2],
    ['tool-preview-level3.json', level3],
  ].forEach(([area, items]) => checkUnique(area, items));
  checkAllowedFields('vendor-cards.json', vendorCards, VENDOR_CARD_FIELDS);
  checkAllowedFields('tool-cards.json', toolCards, TOOL_CARD_FIELDS);
  checkAllowedFields('vendor-preview-level1.json', level1, VENDOR_LEVEL1_FIELDS);
  checkAllowedFields('vendor-preview-level2.json', level2, VENDOR_LEVEL2_FIELDS);
  checkAllowedFields('tool-preview-level3.json', level3, TOOL_LEVEL3_FIELDS);

  const level1Ids = new Set(level1.map(item => item.id));
  const level2Ids = new Set(level2.map(item => item.id));
  const level3Ids = new Set(level3.map(item => item.id));
  checkRef('vendor-cards.json', vendorCards, 'vendor-preview-level1.json', level1Ids, 'level1_ref');
  checkRef('vendor-preview-level1.json', level1, 'vendor-preview-level2.json', level2Ids, 'level2_refs');
  checkRef('vendor-preview-level2.json', level2, 'tool-preview-level3.json', level3Ids, 'detail_refs');
  checkRef('tool-cards.json', toolCards, 'tool-preview-level3.json', level3Ids, 'detail_ref');

  const cardsByDetail = new Map(toolCards.map(item => [item.detail_ref?.id, item]));
  level3.forEach(item => {
    if (!DETAIL_KINDS.has(item.detail_kind)) fail(`tool-preview-level3.json ${item.id} detail_kind 无效: ${item.detail_kind}`);
    if (!item.title || !item.detail_kind || !item.vendor_key) fail(`tool-preview-level3.json ${item.id} 缺少 title/detail_kind/vendor_key`);
    if (item.official_url && !isHttpUrl(item.official_url)) fail(`tool-preview-level3.json ${item.id}.official_url 仅允许 HTTP/HTTPS`);
    if (item.official_date !== null && item.official_date !== undefined && !/^\\d{4}-\\d{2}-\\d{2}$/.test(item.official_date)) fail(`tool-preview-level3.json ${item.id}.official_date 格式无效`);
    if (item.detail_kind !== 'subscription_plan' && (!item.theme || !THEMES.has(item.theme))) fail(`tool-preview-level3.json ${item.id} 缺少有效 theme`);
    if (item.detail_kind === 'subscription_plan' && cardsByDetail.has(item.id)) fail(`tool-preview-level3.json ${item.id} 套餐不应生成工具卡`);
    if (item.detail_kind !== 'subscription_plan' && !cardsByDetail.has(item.id)) fail(`tool-preview-level3.json ${item.id} 没有对应工具卡片`);
    const card = cardsByDetail.get(item.id);
    if (card && (!TOOL_CARD_KINDS.has(card.detail_kind) || card.detail_kind !== item.detail_kind || card.theme !== item.theme)) fail(`tool-preview-level3.json ${item.id} 与工具卡 detail_kind/theme 不一致`);
    if (item.sources?.some(source => !source.title || !isHttpUrl(source.url))) fail(`tool-preview-level3.json ${item.id}.sources 存在无效来源`);
    if (item.one_m_context?.source_refs || item.api_pricing?.rate_cards?.some(rate => rate.source_refs) || item.api_pricing?.additional_charges?.some(charge => charge.source_refs) || item.plan?.source_refs) fail(`tool-preview-level3.json ${item.id} 包含已删除的嵌套 source_refs`);
  });

  vendorCards.forEach(item => {
    if (!item.title || !item.vendor_key || !item.summary) fail(`vendor-cards.json ${item.id} 缺少 title/vendor_key/summary`);
  });
  toolCards.forEach(item => {
    if (!item.title || !item.tool_key || !item.detail_ref) fail(`tool-cards.json ${item.id} 缺少 title/tool_key/detail_ref`);
    if (!TOOL_CARD_KINDS.has(item.detail_kind)) fail(`tool-cards.json ${item.id} 不允许作为工具卡: ${item.detail_kind}`);
    if (!THEMES.has(item.theme)) fail(`tool-cards.json ${item.id} 缺少有效 theme`);
  });
  console.log(`  五模块目录: 厂商卡 ${vendorCards.length} · 工具卡 ${toolCards.length} · 一级 ${level1.length} · 二级 ${level2.length} · 三级 ${level3.length}，通过`);
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
