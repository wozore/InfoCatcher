/**
 * InfoCatcher MVP — 推荐视图 (featured)：编辑精选 + 热门模型
 *
 * 五个分类（无"全部"），编辑精选和热门模型各带独立分类 tab。
 * 编辑精选来自 featured.json（手动维护 tool_id + item_id）。
 * 热门模型从 tool-intelligence.json 自动取 leaf 模型，按 active + 有定价排序取 top-3。
 * 分类 tab 点击由 main.js 在 #editorPicksTabs / #hotRankingTabs 上委托监听。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  tools,
  toolIntelligence,
  featuredPicks,
  dataLoadFailures,
  getToolIntelligence,
  getCollectionNode,
  getItemLatestQueriedAt,
  renderTimelinessBadge,
  renderState,
  escapeHtml,
} from './data.js';

const FEATURED_CATEGORIES = [
  { key: 'llm', label: 'LLM 模型', toolCats: ['对话', '推理', '写作', '翻译', '搜索', '研究', '长文档', '长文档分析', '多模态', 'AI搜索', 'AI研究'] },
  { key: 'coding', label: 'AI 编程', toolCats: ['AI编程', '编程', 'IDE', 'IDE插件', '命令行'] },
  { key: 'image', label: '图像生成', toolCats: ['AI图像', 'AI绘画', '图像'] },
  { key: 'video', label: '视频生成', toolCats: ['AI视频'] },
  { key: 'audio', label: '音频与音乐', toolCats: ['AI音频', 'AI音乐', 'AI语音', '语音'] },
];

let activeEditorCat = 'llm';
let activeHotCat = 'llm';

// 跨模块状态 setter（ESM：导入绑定只读，改值必须回到本模块）
function setActiveEditorCat(value) { activeEditorCat = value; }
function setActiveHotCat(value) { activeHotCat = value; }

function isToolInCat(tool, toolCats) {
  return (tool.category || []).some(c => toolCats.includes(c));
}

function getCategoryToolIds(catKey) {
  const cat = FEATURED_CATEGORIES.find(c => c.key === catKey);
  if (!cat) return [];
  let matched = tools.filter(t => isToolInCat(t, cat.toolCats)).map(t => t.id);
  // 非 LLM 分类排除已在 LLM 分类中的工具，避免模型列表重复
  if (catKey !== 'llm') {
    const llmCat = FEATURED_CATEGORIES.find(c => c.key === 'llm');
    const llmIds = new Set(tools.filter(t => isToolInCat(t, llmCat.toolCats)).map(t => t.id));
    matched = matched.filter(id => !llmIds.has(id));
  }
  return matched;
}

function getCategoryLeaves(catKey) {
  const toolIds = new Set(getCategoryToolIds(catKey));
  const leaves = [];
  const cols = Array.isArray(toolIntelligence.collections) ? toolIntelligence.collections : [];
  cols.forEach(col => {
    if (!col || !col.tool_id) return;
    if (!toolIds.has(col.tool_id)) return;
    (col.items || []).forEach(item => {
      if (item.node_type !== 'leaf' || item.display_in_tree === false) return;
      if (item.kind !== 'api_model') return;
      leaves.push({ ...item, _tool_id: col.tool_id, _tool: tools.find(t => t.id === col.tool_id) });
    });
  });
  // Sort: active first, then by pricing completeness
  leaves.sort((a, b) => {
    const scoreA = (a.status === 'active' ? 2 : a.status === 'partial' ? 1 : 0) + (a.api_pricing?.rate_cards?.length ? 1 : 0);
    const scoreB = (b.status === 'active' ? 2 : b.status === 'partial' ? 1 : 0) + (b.api_pricing?.rate_cards?.length ? 1 : 0);
    return scoreB - scoreA;
  });
  return leaves;
}

function getFeaturedDisplayName(toolId, itemId) {
  if (!itemId) {
    const tool = tools.find(t => t.id === toolId);
    return tool ? (tool.icon + ' ' + tool.name) : toolId;
  }
  const col = getToolIntelligence(toolId);
  const item = col?.items?.find(i => i.id === itemId);
  const tool = tools.find(t => t.id === toolId);
  if (item && tool) return tool.icon + ' ' + item.name;
  return toolId + '/' + itemId;
}

function getFeaturedVendor(toolId) {
  const tool = tools.find(t => t.id === toolId);
  return tool ? tool.vendor : '';
}

function getFeaturedSummary(toolId, itemId) {
  if (!itemId) {
    const tool = tools.find(t => t.id === toolId);
    return tool ? tool.strengths : '';
  }
  const col = getToolIntelligence(toolId);
  const item = col?.items?.find(i => i.id === itemId);
  return item?.summary || '';
}

function getFeaturedPricing(toolId, itemId) {
  if (!itemId) return '';
  const col = getToolIntelligence(toolId);
  const item = col?.items?.find(i => i.id === itemId);
  const rate = item?.api_pricing?.rate_cards?.[0];
  if (!rate) return '';
  const symbol = rate.currency === 'USD' ? '$' : rate.currency === 'CNY' ? '¥' : '';
  return symbol + rate.input_uncached + '/' + symbol + rate.output;
}

function getFeaturedDetailUrl(toolId, itemId) {
  if (itemId) return "openDetail('" + toolId + "','" + itemId + "')";
  return "openDetail('" + toolId + "')";
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
  const picks = featuredPicks
    .filter(p => p.category === activeEditorCat)
    .map(p => ({ ...p, tool: tools.find(t => t.id === p.tool_id) }))
    .filter(p => p.tool);
  if (dataLoadFailures.has('featured')) {
    grid.innerHTML = renderState({ icon: '⚠️', title: '精选数据加载失败', message: '请刷新页面重试；热门模型仍按已收录工具资料独立显示。', type: 'error' });
    return;
  }
  if (!picks.length) {
    grid.innerHTML = renderState({ icon: '○', title: '暂无精选推荐', message: escapeHtml(cat.label) + '分类的人工精选正在筹备中。', type: 'unavailable' });
    return;
  }
  grid.innerHTML = picks.map(pick => {
    const name = getFeaturedDisplayName(pick.tool_id, pick.item_id);
    const vendor = getFeaturedVendor(pick.tool_id);
    const pricing = getFeaturedPricing(pick.tool_id, pick.item_id);
    const summary = getFeaturedSummary(pick.tool_id, pick.item_id);
    const onclick = getFeaturedDetailUrl(pick.tool_id, pick.item_id);
    const latestQ = pick.item_id ? getItemLatestQueriedAt(getToolIntelligence(pick.tool_id), getCollectionNode(pick.tool_id, pick.item_id)) : null;
    const badge = renderTimelinessBadge(latestQ);
    return '<article class="featured-card featured-pick" tabindex="0" role="button" aria-label="查看 ' + escapeHtml(name) + ' 详情" onclick="' + onclick + '" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();' + onclick + '}">' +
      '<div class="featured-pick-badge">编辑精选</div>' +
      '<div class="featured-pick-header">' +
        '<div><h3>' + escapeHtml(name) + '</h3><span class="featured-pick-vendor">' + escapeHtml(vendor) + '</span>' + badge + '</div>' +
        (pricing ? '<div class="featured-pick-pricing">API ' + escapeHtml(pricing) + '</div>' : '') +
      '</div>' +
      '<p class="featured-pick-reason">' + escapeHtml(pick.reason) + '</p>' +
      '<div class="featured-pick-tags">' +
        (pick.tool.scenes || []).slice(0, 3).map(s => '<span class="tag scene">' + escapeHtml(s) + '</span>').join('') +
        '<span class="tag ' + (pick.tool.access_level === '开放' ? 'open' : 'restricted') + '">' + (pick.tool.access_level === '开放' ? '国内可用' : '需科学上网') + '</span>' +
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
    const pricing = getFeaturedPricing(leaf._tool_id, leaf.id);
    const latestQ = getItemLatestQueriedAt(getToolIntelligence(leaf._tool_id), leaf);
    const badge = renderTimelinessBadge(latestQ);
    const onclick = getFeaturedDetailUrl(leaf._tool_id, leaf.id);
    return '<article class="featured-card featured-hot" tabindex="0" role="button" aria-label="查看 ' + escapeHtml(leaf.name) + ' 详情" onclick="' + onclick + '" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();' + onclick + '}">' +
      '<div class="featured-hot-rank">' + rankEmoji[i] + '</div>' +
      '<div class="featured-hot-body">' +
        '<div class="featured-hot-header"><h4>' + escapeHtml(tool.icon + ' ' + leaf.name) + '</h4>' + badge + '<span class="featured-hot-vendor">' + escapeHtml(tool.vendor) + '</span></div>' +
        '<p class="featured-hot-desc">' + escapeHtml(leaf.summary || '') + '</p>' +
        '<div class="featured-hot-meta">' +
          (pricing ? '<span>API ' + escapeHtml(pricing) + '</span>' : '') +
          '<span class="tag ' + (leaf.status === 'active' ? 'open' : 'restricted') + '">' + (leaf.status === 'active' ? '已核实' : '部分核实') + '</span>' +
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
