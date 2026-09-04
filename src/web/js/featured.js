/**
 * 知览 KnowView MVP — 编辑精选视图 (featured)：编辑精选 + 热门模型
 *
 * 五个分类（无"全部"），编辑精选和热门模型各带独立分类 tab。
 * 编辑精选来自 featured.json（手动维护 tool_id + detail_ref）。
 * 热门模型从三级详情自动取 API 模型，按 active + 有定价排序取 top-3。
 * 分类 tab 点击由 main.js 在 #editorPicksTabs / #hotRankingTabs 上委托监听。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  getToolCardItems,
  getToolLevel3Item,
  getToolCardItem,
} from './data-catalog.js';
import { state, dataLoadFailures } from './state.js';
import { renderState, escapeHtml } from './ui-helpers.js';
import { renderAccessTag } from './tool-cards.js';
import { brandIconHtml } from './brand-icons.js';

const FEATURED_CATEGORIES = [
  { key: 'llm', label: 'LLM 模型' },
  { key: 'coding', label: 'AI 编程' },
  { key: 'image', label: '图像生成' },
  { key: 'video', label: '视频生成' },
  { key: 'audio', label: '音频与音乐' },
];

const HOT_CATEGORY_MATCHERS = {
  llm: card => card.detail_kind === 'api_model' && card.theme === 'general',
  coding: card => card.detail_kind === 'api_model' && card.theme === 'dev',
  image: card => card.detail_kind === 'api_model' && card.theme === 'vision',
  video: card => card.detail_kind === 'api_model' && card.theme === 'media' && (card.scenes || []).some(scene => /视频/.test(scene)),
  audio: card => card.detail_kind === 'api_model' && card.theme === 'media' && (card.scenes || []).some(scene => /音频|音乐|语音|配音/.test(scene)),
};

let activeEditorCat = 'llm';
let activeHotCat = 'llm';

// 跨模块状态 setter（ESM：导入绑定只读，改值必须回到本模块）
function setActiveEditorCat(value) { activeEditorCat = value; }
function setActiveHotCat(value) { activeHotCat = value; }

function getCategoryLeaves(catKey) {
  const matcher = HOT_CATEGORY_MATCHERS[catKey] || (() => false);
  const leaves = getToolCardItems()
    .filter(matcher)
    .map(card => {
      const detail = getToolLevel3Item(card.vendor_key, card.detail_ref.id);
      return detail ? { ...detail, _tool: card } : null;
    })
    .filter(Boolean);
  leaves.sort((a, b) => {
    const scoreA = (a.status === 'active' ? 2 : a.status === 'partial' ? 1 : 0) + (a.api_pricing?.rate_cards?.length ? 1 : 0);
    const scoreB = (b.status === 'active' ? 2 : b.status === 'partial' ? 1 : 0) + (b.api_pricing?.rate_cards?.length ? 1 : 0);
    return scoreB - scoreA;
  });
  return leaves;
}

function resolveFeaturedDetail(toolId, itemId = null) {
  const tool = getToolCardItem(toolId);
  if (!tool) return null;
  if (!itemId) return getToolLevel3Item(tool.vendor_key, tool.detail_ref.id);
  return getToolLevel3Item(tool.vendor_key, String(itemId).startsWith('tool-level3:') ? itemId : 'tool-level3:' + itemId);
}

function getFeaturedDisplayName(toolId, itemId) {
  const tool = getToolCardItem(toolId);
  const detail = resolveFeaturedDetail(toolId, itemId);
  if (tool && detail) return tool.icon + ' ' + detail.title;
  return itemId ? toolId + '/' + itemId : toolId;
}

function getFeaturedVendor(toolId) {
  const tool = getToolCardItem(toolId);
  return tool ? tool.vendor_label : '';
}

function getFeaturedSummary(toolId, itemId) {
  return resolveFeaturedDetail(toolId, itemId)?.summary || '';
}

function getFeaturedPricing(toolId, itemId) {
  const item = resolveFeaturedDetail(toolId, itemId);
  if (item?.api_pricing?.status === 'not_applicable') return '';
  const rate = item?.api_pricing?.rate_cards?.[0];
  if (!rate) return '';
  const symbol = rate.currency === 'USD' ? '$' : rate.currency === 'CNY' ? '¥' : rate.currency + ' ';
  if (Array.isArray(rate.metrics) && rate.metrics.length) {
    const metric = rate.metrics[0];
    return symbol + metric.amount + '/' + metric.unit;
  }
  return symbol + rate.input_uncached + '/' + symbol + rate.output;
}

function getFeaturedDetailUrl(toolId, itemId) {
  const detail = resolveFeaturedDetail(toolId, itemId);
  return detail ? "openDetail('" + detail.id + "')" : '';
}

function renderFeatured() {
  renderFeaturedTabs('editorPicksTabs', activeEditorCat);
  renderEditorPicksForCat();
  renderFeaturedTabs('hotRankingTabs', activeHotCat);
  renderHotRankingForCat();
}

function renderFeaturedTabs(containerId, activeCat) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = FEATURED_CATEGORIES.map(cat =>
    '<button class="featured-tab' + (cat.key === activeCat ? ' active' : '') + '" type="button" data-cat="' + cat.key + '" aria-pressed="' + (cat.key === activeCat ? 'true' : 'false') + '">' + cat.label + '</button>'
  ).join('');
}

function renderEditorPicksForCat() {
  const grid = document.getElementById('featuredPicksGrid');
  if (!grid) return;
  const cat = FEATURED_CATEGORIES.find(c => c.key === activeEditorCat);
  const picks = state.featuredPicks
    .filter(p => p.category === activeEditorCat)
    .map(p => ({ ...p, tool: getToolCardItem(p.tool_id) }))
    .filter(p => p.tool);
  if (dataLoadFailures.has('featured')) {
    grid.innerHTML = renderState({ icon: '⚠️', title: '精选数据加载失败', message: '请刷新页面重试；热门模型仍按已收录工具资料独立显示。', type: 'error' });
    return;
  }
  if (!picks.length) {
    grid.innerHTML = renderState({ icon: '○', title: '暂无编辑精选', message: escapeHtml(cat.label) + '分类的人工精选正在筹备中。', type: 'unavailable' });
    return;
  }
  grid.innerHTML = picks.map(pick => {
    const name = getFeaturedDisplayName(pick.tool_id, pick.detail_ref);
    const detail = resolveFeaturedDetail(pick.tool_id, pick.detail_ref);
    const nameHtml = detail
      ? brandIconHtml({ vendorKey: pick.tool.vendor_key, toolKey: pick.tool.tool_key, modelKey: detail.id.split(':').pop(), emoji: pick.tool.icon }) + ' ' + escapeHtml(detail.title)
      : escapeHtml(name);
    const vendor = getFeaturedVendor(pick.tool_id);
    const pricing = getFeaturedPricing(pick.tool_id, pick.detail_ref);
    const summary = getFeaturedSummary(pick.tool_id, pick.detail_ref);
    const onclick = getFeaturedDetailUrl(pick.tool_id, pick.detail_ref);
    const badge = '';
    return '<article class="featured-card featured-pick" tabindex="0" role="button" aria-label="查看 ' + escapeHtml(name) + ' 详情" onclick="' + onclick + '" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();' + onclick + '}">' +
      '<div class="featured-pick-badge">编辑精选</div>' +
      '<div class="featured-pick-header">' +
        '<div><h3>' + nameHtml + '</h3><span class="featured-pick-vendor">' + escapeHtml(vendor) + '</span>' + badge + '</div>' +
        (pricing ? '<div class="featured-pick-pricing">API ' + escapeHtml(pricing) + '</div>' : '') +
      '</div>' +
      '<p class="featured-pick-reason">' + escapeHtml(pick.reason) + '</p>' +
      '<div class="featured-pick-tags">' +
        (pick.tool.scenes || []).slice(0, 3).map(s => '<span class="tag scene">' + escapeHtml(s) + '</span>').join('') +
        renderAccessTag(pick.tool.access_level) +
      '</div>' +
    '</article>';
  }).join('');
}

function renderHotRankingForCat() {
  const grid = document.getElementById('featuredHotGrid');
  if (!grid) return;
  const cat = FEATURED_CATEGORIES.find(c => c.key === activeHotCat);
  const leaves = getCategoryLeaves(activeHotCat).slice(0, 3);
  if (!leaves.length) {
    grid.innerHTML = renderState({ icon: '○', title: '暂无排行数据', message: escapeHtml(cat.label) + '分类暂无已核实的模型资料。', type: 'unavailable' });
    return;
  }
  const rankEmoji = ['🥇', '🥈', '🥉'];
  grid.innerHTML = leaves.map((leaf, i) => {
    const tool = leaf._tool;
    const pricing = getFeaturedPricing(tool.tool_key, leaf.id);
    const badge = '';
    const onclick = getFeaturedDetailUrl(tool.tool_key, leaf.id);
    return '<article class="featured-card featured-hot" tabindex="0" role="button" aria-label="查看 ' + escapeHtml(leaf.title) + ' 详情" onclick="' + onclick + '" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();' + onclick + '}">' +
      '<div class="featured-hot-rank">' + rankEmoji[i] + '</div>' +
      '<div class="featured-hot-body">' +
        '<div class="featured-hot-header"><h4>' + brandIconHtml({ vendorKey: tool.vendor_key, toolKey: tool.tool_key, modelKey: leaf.id.split(':').pop(), emoji: tool.icon }) + ' ' + escapeHtml(leaf.title) + '</h4>' + badge + '<span class="featured-hot-vendor">' + escapeHtml(tool.vendor_label) + '</span></div>' +
        '<p class="featured-hot-desc">' + escapeHtml(leaf.summary || '') + '</p>' +
        '<div class="featured-hot-meta">' +
          (pricing ? '<span>API ' + escapeHtml(pricing) + '</span>' : '') +
          '<span class="tag ' + (leaf.status === 'active' ? 'open' : 'neutral') + '">' + escapeHtml({ active: '已核实', partial: '部分核实', deprecated: '已弃用', retired: '已停用' }[leaf.status] || '资料待核验') + '</span>' +
        '</div>' +
      '</div>' +
    '</article>';
  }).join('');
}

export {
  activeEditorCat,
  activeHotCat,
  setActiveEditorCat,
  setActiveHotCat,
  getCategoryLeaves,
  getFeaturedDetailUrl,
  renderFeatured,
  renderFeaturedTabs,
  renderEditorPicksForCat,
  renderHotRankingForCat,
};
