/**
 * InfoCatcher MVP — 工具库 (tools)：搜索 + 分类/访问/价格筛选 + 卡片网格 + 详情弹窗
 *
 * 本模块同时承载详情弹窗（openDetail / showModal / closeModal）：
 * 弹窗为全站复用（热点、添加对比、搜索匹配都通过它打开），因此
 * modalTrigger / modalScrollPosition / detailPanelState 等弹窗状态也归本模块。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  tools,
  activeFilters,
  dataLoadFailures,
  getFilteredTools,
  getToolIntelligence,
  getCollectionNode,
  getItemLatestQueriedAt,
  getToolPublishedDate,
  formatPrice,
  escapeHtml,
  safeExternalUrl,
  renderTimelinessBadge,
  scoreClass,
  hasFree,
  renderState,
  setRegionBusy,
  ICON_CLOSE,
  ICON_ARROW_LEFT,
  ICON_EXTERNAL,
} from './data.js';
import { isComparableRootTool, isComparableLeaf, isCompareSelected } from './compare.js';

// ═══════════════════════════════════════════════════════════════
// 详情弹窗状态（全站复用）
// ═══════════════════════════════════════════════════════════════
let detailPanelState = new Map(); // collection toolId → 当前模型/工具节点路径
let modalTrigger = null;           // 详情弹窗打开前的焦点，用于关闭后回焦
let modalScrollPosition = null;    // 热点等列表详情关闭时保持原列表滚动位置

// 跨模块状态 setter（ESM：导入绑定只读，改值必须回到本模块）
function setModalScrollPosition(value) { modalScrollPosition = value; }

// ═══════════════════════════════════════════════════════════════
// 工具库 —— 筛选、卡片渲染
// ═══════════════════════════════════════════════════════════════

// 决策 94：工具库已选筛选条件的低权重标签与一键清除
function renderSelectedFilters() {
  const section = document.getElementById('toolsSelected');
  const tagEl = document.getElementById('toolsSelectedTags');
  if (!section || !tagEl) return;
  const tags = [];
  if (activeFilters.category !== 'all') tags.push('分类：' + activeFilters.category);
  if (activeFilters.access !== 'all') tags.push('访问：' + (activeFilters.access === '开放' ? '国内可访问' : '需科学上网'));
  if (activeFilters.price !== 'all') tags.push(activeFilters.price === 'free' ? '价格：有免费层' : '价格：仅付费');
  section.hidden = tags.length === 0;
  tagEl.innerHTML = tags.map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
}

function clearToolFilters() {
  activeFilters.category = 'all';
  activeFilters.access = 'all';
  activeFilters.price = 'all';
  document.querySelectorAll('.tools-filters .filter-chip').forEach(chip => {
    const isAll = (chip.dataset.category || chip.dataset.access || chip.dataset.price) === 'all';
    chip.classList.toggle('active', isAll);
    chip.setAttribute('aria-pressed', String(isAll));
  });
  renderSelectedFilters();
  renderTools();
}

/**
 * 渲染工具卡片网格。
 * 1. 获取过滤后的工具列表
 * 2. 更新工具计数和筛选提示
 * 3. 空结果时显示空状态占位
 * 4. 正常结果时渲染卡片（名称/图标/评分/场景标签/价格/访问/对比按钮）
 *
 * 注意：对比按钮在卡片 DOM 字符串中使用了 onclick 属性;
 * event.stopPropagation() 防止点击对比按钮同时触发卡片的 openDetail。
 * EXTENSION POINT: 方案一——>方案三变迁中时，实现在对比页面也能自定义添加工具
 * EXTENSION POINT: 方案一——>方案三变迁中时，卡片实现动态效果-描述：默认显示工具大头照，悬停时工具照向左迁移，右边显示简略的信息，点击进入详情
 */
function renderTools() {
  const filtered = getFilteredTools();
  const grid = document.getElementById('toolGrid');
  setRegionBusy(grid, false);
  renderSelectedFilters();
  document.getElementById('toolCount').textContent = filtered.length;
  document.getElementById('filteredInfo').style.display =
    (activeFilters.category !== 'all' || activeFilters.access !== 'all' || activeFilters.price !== 'all' || document.getElementById('searchInput').value)
    ? 'inline' : 'none';

  if (dataLoadFailures.has('tools')) {
    grid.innerHTML = renderState({ icon: '⚠️', title: '工具数据加载失败', message: '请刷新页面重试；若问题持续，请检查公开工具数据文件是否可访问。', type: 'error' });
    return;
  }

  if (filtered.length === 0) {
    grid.innerHTML = renderState({ icon: '⌕', title: '没有匹配的工具', message: '请调整筛选条件或更换搜索关键词。', type: 'no-match' });
    return;
  }

  grid.innerHTML = filtered.map(t => {
    const intelligence = getToolIntelligence(t.id);
    const collectionItems = (intelligence?.items || []).filter(item => item.node_type !== 'group' && item.display_in_tree !== false);
    const isCollection = t.card_kind === 'collection';
    const overview = t.overview;
    const title = isCollection ? t.vendor + '（' + t.name + '）' : t.name;
    const description = isCollection
      ? (overview?.description || t.strengths)
      : t.strengths;
    const collectionSummary = isCollection
      ? '<div class="collection-summary"><span class="collection-label">厂商模型与工具</span><span>' + collectionItems.length + ' 个可查看叶节点</span></div>' +
        '<div class="collection-quick-list">' + (intelligence?.tree_mode === 'tree'
          ? (intelligence.items || []).filter(item => item.node_type === 'group').slice(0, 3).map(item =>
              '<button type="button" onclick="event.stopPropagation();openDetail(\'' + escapeHtml(t.id) + '\',\'' + escapeHtml(item.id) + '\')">' + escapeHtml(item.name) + '</button>'
            ).join('')
          : collectionItems.slice(0, 5).map(item =>
              '<button type="button" onclick="event.stopPropagation();openDetail(\'' + escapeHtml(t.id) + '\',\'' + escapeHtml(item.id) + '\')">' + escapeHtml(item.name) + '</button>'
            ).join('')) + '</div>'
      : '';
    const featurePreview = isCollection && overview?.features?.length
      ? '<div class="vendor-feature-preview">' + overview.features.map(feature =>
          '<span class="vendor-feature ' + escapeHtml(feature.tone) + '">' + escapeHtml(feature.text) + '</span>'
        ).join('') + '</div>'
      : '';
    const isSelected = isCompareSelected(t.id, null);
    const publishedDate = getToolPublishedDate(t);
    return `
    <div class="tool-card${isCollection ? ' collection-card' : ''}" onclick="openDetail('${t.id}',null,this)">
      <div class="tool-card-header">
        <div>
          <div class="tool-card-name">${t.icon} ${escapeHtml(title)}</div>
          <div class="tool-card-vendor">${isCollection ? '厂商总览' : escapeHtml(t.vendor)}</div>
        </div>
        ${isCollection ? '' : '' /* 决策 98：工具卡片默认区不显示评分，评分保留在详情模态 */}
      </div>

      <div class="tool-card-desc">${escapeHtml(description)}</div>
      ${featurePreview}
      ${collectionSummary}
      <div class="tool-card-tags">
        ${t.scenes.slice(0,3).map(s => '<span class="tag scene">' + escapeHtml(s) + '</span>').join('')}
        ${isCollection ? '' : (hasFree(t) ? '<span class="tag free">免费可用</span>' : '<span class="tag paid">仅付费</span>')}
        <span class="tag ${t.access_level === '开放' ? 'open' : 'restricted'}">${t.access_level === '开放' ? '国内可用' : '需科学上网'}</span>
      </div>

      <div class="tool-card-footer" onclick="event.stopPropagation()">
        <span class="tool-card-updated">${publishedDate ? '发布时间 ' + escapeHtml(publishedDate) : '发布时间待补充'}</span>
        <div class="tool-card-actions">
          <button class="detail-button" type="button" onclick="openDetail('${escapeHtml(t.id)}',null,this)">查看详情</button>
          ${isComparableRootTool(t) ? '<button class="compare-toggle ' + (isSelected ? 'selected' : '') + '" aria-pressed="' + isSelected + '" onclick="toggleCompareRef(\'' + escapeHtml(t.id) + '\',null,this)">' + (isSelected ? '已选' : '+对比') + '</button>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// 工具详情弹窗 —— 具体模型/套餐情报与模型工具面板
// ═══════════════════════════════════════════════════════════════

function renderScenarioExplanations(title, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return '<div class="intelligence-scenarios"><h5>' + title + '</h5>' + items.map(item =>
    '<div><b>' + escapeHtml(item.title) + '：</b>' + escapeHtml(item.description) + '</div>'
  ).join('') + '</div>';
}

function renderIntelligenceItem(item, sourceMap, selectedItemId, toolId) {
  const latestQ = (item.source_refs || []).map(ref => sourceMap.get(ref)).filter(Boolean).map(s => s.queried_at).filter(Boolean).sort().reverse()[0] || null;
  const badge = renderTimelinessBadge(latestQ);
  return '<details class="intelligence-item"' + (item.id === selectedItemId ? ' open' : '') + '>' +
    '<summary><span><b>' + escapeHtml(item.name) + '</b><small>' + escapeHtml(item.kind === 'api_model' ? 'API 模型' : item.kind === 'subscription_plan' ? '订阅套餐' : '产品变体') + '</small>' + badge + '</span><span>查看详情</span></summary>' +
    '<div class="intelligence-item-body">' + renderLeafDetails(item, sourceMap, toolId ? { toolId } : false) + '</div></details>';
}

function renderLeafDetails(item, sourceMap, showCompare) {
  const contextLabels = { native: '原生支持 1M', conditional: '特定条件支持 1M', not_supported: '不支持 1M', unknown: '1M 支持情况未知' };
  const context = item.one_m_context;
  const contextHtml = context
    ? '<div class="intelligence-context"><b>1M 上下文：</b>' + escapeHtml(contextLabels[context.status] || '未知') +
      (context.tokens ? '（' + Number(context.tokens).toLocaleString('zh-CN') + ' tokens）' : '') +
      (context.conditions ? '<p>' + escapeHtml(context.conditions) + '</p>' : '') + '</div>'
    : '';
  const rateCards = item.api_pricing?.rate_cards || [];
  const pricingHtml = rateCards.length
    ? '<div class="intelligence-pricing"><h5>API 价格</h5>' + rateCards.map(rate =>
      '<div class="rate-card"><b>' + escapeHtml(rate.label) + '</b>' +
      '<div class="rate-grid"><span>输入（缓存命中）<strong>' + formatPrice(rate.input_cached, rate.currency) + '</strong></span>' +
      '<span>输入（缓存未命中）<strong>' + formatPrice(rate.input_uncached, rate.currency) + '</strong></span>' +
      '<span>输出<strong>' + formatPrice(rate.output, rate.currency) + '</strong></span></div>' +
      '<small>单位：每百万 tokens · ' + escapeHtml(rate.conditions) + '</small></div>'
    ).join('') + '</div>'
    : '';
  const cacheHtml = item.kind === 'api_model' && item.cache_hit_rate?.status === 'provided'
    ? '<div class="cache-status"><b>平均缓存命中率区间：</b>' +
      escapeHtml(item.cache_hit_rate.min_percent + '%–' + item.cache_hit_rate.max_percent + '%') + '</div>'
    : '';
  const plan = item.plan;
  const planHtml = plan
    ? '<div class="plan-card"><h5>套餐信息</h5><p><b>' + formatPrice(plan.amount, plan.currency) +
      ' / ' + escapeHtml({ month: '月', year: '年', usage: '按量', custom: '定制', unknown: '周期未知' }[plan.billing_period] || plan.billing_period) +
      '</b></p><p>' + escapeHtml(plan.conditions || '') + '</p><p><b>主要模型：</b>' +
      (plan.included_models.length ? plan.included_models.map(escapeHtml).join('、') : '官方未明确列出全部模型') + '</p></div>'
    : '';
  const sources = (item.source_refs || []).map(ref => sourceMap.get(ref)).filter(Boolean);
  const latestQueriedAt = sources.map(s => s.queried_at).filter(Boolean).sort().reverse()[0] || null;
  const sourcesHtml = '<div class="intelligence-sources"><b>资料来源：</b>' + sources.map(source =>
    '<a href="' + escapeHtml(safeExternalUrl(source.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
  ).join(' · ') + (latestQueriedAt ? '<span>查询于 ' + escapeHtml(latestQueriedAt.slice(0, 10)) + '</span>' : '') + '</div>';
  const compareHtml = showCompare
    ? '<div class="leaf-actions"><button class="compare-toggle ' + (isCompareSelected(showCompare.toolId, item.id) ? 'selected' : '') + '" onclick="toggleCompareRef(\'' + escapeHtml(showCompare.toolId) + '\',\'' + escapeHtml(item.id) + '\',this)">' + (isCompareSelected(showCompare.toolId, item.id) ? '已选' : '+对比') + '</button></div>'
    : '';
  return '<p>' + escapeHtml(item.summary || '') + '</p>' + contextHtml + pricingHtml + cacheHtml + planHtml +
    renderScenarioExplanations('适用场景及说明', item.applicable_scenarios) +
    renderScenarioExplanations('不适用场景及说明', item.inapplicable_scenarios) + sourcesHtml + compareHtml;
}

function renderCollectionIntelligence(tool, selectedItemId) {
  const collection = getToolIntelligence(tool.id);
  if (!collection) {
    return tool.card_kind === 'collection'
      ? '<div class="intelligence-unavailable">具体型号资料暂不可用；不会根据品牌名称自动推测推荐。</div>'
      : '';
  }
  const sourceMap = new Map((collection.sources || []).map(source => [source.id, source]));
  const statusText = { verified: '已核实', partial: '部分核实', conflict: '资料冲突', unavailable: '资料不可用' }[collection.status] || collection.status;
  const displayItems = (collection.items || []).filter(item => item.node_type !== 'group');
  return '<div class="section intelligence-section"><div class="intelligence-heading"><h4>当前具体模型与套餐</h4><span class="intelligence-status status-' + escapeHtml(collection.status) + '">' + escapeHtml(statusText) + '</span></div>' +
    displayItems.map(item => renderIntelligenceItem(item, sourceMap, selectedItemId, tool.id)).join('') + '</div>';
}

function renderVendorFeatures(tool) {
  const features = tool.overview?.features?.length
    ? tool.overview.features
    : [
      { tone: 'positive', text: '优点：' + tool.strengths },
      { tone: 'negative', text: '限制：' + tool.weaknesses }
    ];
  return '<section class="vendor-features"><h4>特点</h4>' + features.map(feature =>
    '<p class="vendor-feature ' + (feature.tone === 'negative' ? 'negative' : 'positive') + '">' + escapeHtml(feature.text) + '</p>'
  ).join('') + '</section>';
}

function getTreeChildren(collection, parentId) {
  return (collection.items || []).filter(item => item.parent_id === parentId && item.display_in_tree !== false);
}

function getLeafDescendants(collection, parentId) {
  return getTreeChildren(collection, parentId).flatMap(node =>
    node.node_type === 'leaf' ? [node] : getLeafDescendants(collection, node.id)
  );
}

function getNodePath(collection, node) {
  const path = [];
  let current = node;
  while (current) {
    path.unshift(current);
    current = current.parent_id ? getCollectionNode(collection.tool_id, current.parent_id) : null;
  }
  return path;
}

function renderModelBreadcrumb(toolId, collection, node) {
  const nodes = node ? getNodePath(collection, node) : [];
  return '<div class="model-breadcrumb"><button type="button" onclick="navigateModelToolPanel(\'' + escapeHtml(toolId) + '\',null)">模型与工具</button>' +
    nodes.map((part, index) => '<span>›</span><button type="button"' + (index === nodes.length - 1 ? ' aria-current="page"' : '') + ' onclick="navigateModelToolPanel(\'' + escapeHtml(toolId) + '\',\'' + escapeHtml(part.id) + '\')">' + escapeHtml(part.name) + '</button>').join('') +
  '</div>';
}

function getNodeStatusLabel(status) {
  return { active: '已核实', partial: '部分核实', unknown: '官方资料待核验', legacy_supported: '仍受支持', deprecated: '已弃用', retired: '已停用' }[status] || '资料状态未知';
}

function renderTreeChildren(toolId, collection, parentId, options = {}) {
  const children = getTreeChildren(collection, parentId);
  const parent = parentId ? getCollectionNode(toolId, parentId) : null;
  const leaves = parent ? getLeafDescendants(collection, parent.id) : [];
  const comparableLeaves = leaves.filter(item => item.node_type === 'leaf' && ['api_model', 'subscription_plan'].includes(item.kind));
  const sameKind = comparableLeaves.length > 1 && comparableLeaves.every(item => item.kind === comparableLeaves[0].kind);
  const groupCompare = sameKind
    ? '<button class="model-bulk-compare" type="button" onclick="compareGroupLeaves(\'' + escapeHtml(toolId) + '\',\'' + escapeHtml(parent.id) + '\')">全部' + escapeHtml(comparableLeaves[0].kind === 'api_model' ? '模型' : '套餐') + '对比（' + comparableLeaves.length + '）</button>'
    : '';
  if (!children.length) {
    return '<div class="intelligence-unavailable"><b>' + escapeHtml(parent?.name || '当前分类') + '</b>：' +
      (parent?.status === 'unknown' ? '官方资料待核验，暂不展示未经证实的子项、价格或权益。' : '当前没有可展示的已核实子项。') + '</div>';
  }
  const heading = options.showHeading === false ? '' :
    '<div class="model-panel-heading"><div><h4>' + escapeHtml(parent?.name || '模型与工具') + '</h4><p>' + escapeHtml(parent?.summary || '选择分类继续查看，只有最终叶节点可比较。') + '</p></div>' + groupCompare + '</div>';
  const compareOnly = options.showHeading === false && groupCompare
    ? '<div class="model-tree-actions">' + groupCompare + '</div>'
    : '';
  return heading + compareOnly + '<div class="model-tree-grid">' + children.map(item => {
    const isLeaf = item.node_type === 'leaf';
    const treeBadge = isLeaf ? renderTimelinessBadge(getItemLatestQueriedAt(collection, item)) : '';
    return '<button class="model-tree-card' + (isLeaf ? ' leaf' : '') + '" type="button" onclick="navigateModelToolPanel(\'' + escapeHtml(toolId) + '\',\'' + escapeHtml(item.id) + '\')">' +
      '<span class="node-kind-badge ' + (isLeaf ? 'leaf' : 'group') + '">' + (isLeaf ? '具体' : '分类') + '</span>' +
      '<strong>' + escapeHtml(item.name) + '</strong>' + treeBadge + '<p>' + escapeHtml(item.summary || '') + '</p>' +
      '<small class="intelligence-status status-' + escapeHtml(item.status === 'unknown' ? 'partial' : item.status) + '">' + escapeHtml(getNodeStatusLabel(item.status)) + '</small>' +
      '<span class="model-tree-action">' + (isLeaf ? '查看数据面板' : '进入分类') + ' ›</span></button>';
  }).join('') + '</div>';
}

function renderNodeOverview(tool, node) {
  return '<section class="node-overview">' +
    '<h2>' + escapeHtml(tool.icon + ' ' + node.name) + '</h2>' +
    '<div class="vendor">' + escapeHtml(tool.vendor) + ' · <a href="' + escapeHtml(safeExternalUrl(node.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
    '<p class="node-description">' + escapeHtml(node.summary || '暂无简短说明。') + '</p>' +
  '</section>';
}

function renderOpenAIDetailBody(toolId, nodeId = null) {
  const tool = tools.find(item => item.id === toolId);
  const collection = getToolIntelligence(toolId);
  const node = nodeId ? getCollectionNode(toolId, nodeId) : null;
  if (!tool || !collection || (nodeId && !node)) return '<div class="intelligence-unavailable">该模型或工具节点不存在。</div>';

  if (!node) {
    return '<section class="openai-root">' +
      '<h2>' + escapeHtml(tool.icon + ' ' + tool.vendor + '（' + tool.name + '）') + '</h2>' +
      '<div class="vendor">厂商总览 · <a href="' + escapeHtml(safeExternalUrl(tool.url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
      renderModelBreadcrumb(toolId, collection, null) +
      '<p class="vendor-description">' + escapeHtml(tool.overview?.description || tool.strengths) + '</p>' +
      renderVendorFeatures(tool) +
      '<section class="model-tool-panel"><div class="intelligence-heading"><h3>模型与工具</h3><span class="intelligence-status status-' + escapeHtml(collection.status) + '">' + escapeHtml({ verified: '已核实', partial: '部分核实', conflict: '资料冲突', unavailable: '资料不可用' }[collection.status] || collection.status) + '</span></div>' +
      renderTreeChildren(toolId, collection, null, { showHeading: false }) +
      '</section></section>';
  }

  const breadcrumbs = renderModelBreadcrumb(toolId, collection, node);
  if (node.node_type === 'leaf') {
    const sourceMap = new Map((collection.sources || []).map(source => [source.id, source]));
    const leafBadge = renderTimelinessBadge(getItemLatestQueriedAt(collection, node));
    return renderNodeOverview(tool, node) + breadcrumbs +
      '<div class="model-leaf-panel"><div class="model-panel-heading"><div><span class="node-kind-badge leaf">具体' + escapeHtml(node.kind === 'api_model' ? '模型' : node.kind === 'subscription_plan' ? '套餐' : '工具') + '</span><h4>' + escapeHtml(node.name) + '</h4>' + leafBadge + '</div><button class="back-panel-button" type="button" onclick="goBackModelToolPanel(\'' + escapeHtml(toolId) + '\')">' + ICON_ARROW_LEFT + ' 返回</button></div>' +
      '<div class="intelligence-item-body">' + renderLeafDetails(node, sourceMap, { toolId }) + '</div></div>';
  }

  return renderNodeOverview(tool, node) + breadcrumbs +
    '<section class="model-tool-panel"><div class="intelligence-heading"><h3>模型与工具</h3><span class="intelligence-status status-' + escapeHtml(node.status === 'unknown' ? 'partial' : node.status) + '">' + escapeHtml(getNodeStatusLabel(node.status)) + '</span></div>' +
    renderTreeChildren(toolId, collection, node.id, { showHeading: false }) +
    '</section>';
}

function renderLeafPanel(toolId, collection, leaf) {
  const sourceMap = new Map((collection.sources || []).map(source => [source.id, source]));
  const leafBadge = renderTimelinessBadge(getItemLatestQueriedAt(collection, leaf));
  return '<div class="model-leaf-panel"><div class="model-panel-heading"><div><span class="node-kind-badge leaf">具体' + escapeHtml(leaf.kind === 'api_model' ? '模型' : leaf.kind === 'subscription_plan' ? '套餐' : '工具') + '</span><h4>' + escapeHtml(leaf.name) + '</h4>' + leafBadge + '</div><button class="back-panel-button" type="button" onclick="goBackModelToolPanel(\'' + escapeHtml(toolId) + '\')">' + ICON_ARROW_LEFT + ' 返回</button></div>' +
    '<div class="intelligence-item-body">' + renderLeafDetails(leaf, sourceMap, { toolId }) + '</div></div>';
}

function navigateModelToolPanel(toolId, nodeId = null) {
  detailPanelState.set(toolId, nodeId);
  const body = document.getElementById('openaiDetailBody');
  if (body) {
    body.innerHTML = renderOpenAIDetailBody(toolId, nodeId);
    configureModalAccessibility();
  }
}

function goBackModelToolPanel(toolId) {
  const node = getCollectionNode(toolId, detailPanelState.get(toolId));
  navigateModelToolPanel(toolId, node?.parent_id || null);
}

// ═══════════════════════════════════════════════════════════════
// 弹窗打开/关闭与无障碍
// ═══════════════════════════════════════════════════════════════

function getModalFocusableElements() {
  const content = document.getElementById('modalContent');
  if (!content) return [];
  return [...content.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && element.getClientRects().length > 0);
}

function configureModalAccessibility() {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  const title = content?.querySelector('h2');
  const description = content?.querySelector('.vendor-description, .node-description, .vendor, .section p');
  if (!overlay || !content) return;
  if (title) title.id = 'modalTitle';
  if (description) {
    description.id = 'modalDescription';
    overlay.setAttribute('aria-describedby', 'modalDescription');
  } else {
    overlay.removeAttribute('aria-describedby');
  }
}

function showModal(trigger = null) {
  const overlay = document.getElementById('modalOverlay');
  const content = document.getElementById('modalContent');
  if (!overlay || !content) return;
  const explicitTrigger = trigger instanceof HTMLElement
    ? (trigger.matches('a[href], button, [tabindex]:not([tabindex="-1"])') ? trigger : trigger.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])'))
    : null;
  modalTrigger = explicitTrigger || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  configureModalAccessibility();
  overlay.hidden = false;
  document.body.classList.add('modal-open');
  const focusTarget = content.querySelector('.modal-close') || content;
  focusTarget.focus();
}

function openDetail(id, selectedItemId = null, trigger = null) {
  const t = tools.find(tool => tool.id === id);
  if (!t) return;
  const collection = getToolIntelligence(id);
  const content = document.getElementById('modalContent');
  if (t.card_kind === 'collection' && collection?.tree_mode === 'tree') {
    content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
      '<div id="openaiDetailBody" class="openai-detail"></div>';
    navigateModelToolPanel(id, selectedItemId);
    showModal(trigger);
    return;
  }

  // 决策 90：具体工具模态提供“加入对比”与“打开工具页面”
  const rootComparable = isComparableRootTool(t);
  const rootSelected = rootComparable && isCompareSelected(t.id, null);
  content.innerHTML = `
    <button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">${ICON_CLOSE}</button>
    <h2>${escapeHtml(t.icon + ' ' + t.name)}</h2>
    <div class="vendor">${escapeHtml(t.vendor)} · <a href="${escapeHtml(safeExternalUrl(t.url))}" target="_blank" rel="noopener noreferrer">官网 ${ICON_EXTERNAL}</a></div>
    ${renderCollectionIntelligence(t, selectedItemId)}
    <div class="scores">
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_overall)}">${t.rating_overall.toFixed(1)}</div><div class="score-label">综合</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_chinese)}">${t.rating_chinese.toFixed(1)}</div><div class="score-label">中文支持</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_ease)}">${t.rating_ease.toFixed(1)}</div><div class="score-label">易用性</div></div>
      <div class="score-item"><div class="score-val ${scoreClass(t.rating_price)}">${t.rating_price.toFixed(1)}</div><div class="score-label">性价比</div></div>
    </div>
    <div class="section"><h4>适用场景</h4><div class="tool-card-tags">${t.scenes.map(s => '<span class="tag scene">' + escapeHtml(s) + '</span>').join(' ')}</div></div>
    <div class="section"><h4>价格</h4><p><b>免费层：</b>${escapeHtml(t.free_tier || '无')}</p>${t.paid_tiers.map(p => '<p style="margin-top:4px"><b>' + escapeHtml(p.name) + '：</b>' + escapeHtml(p.price) + ' — ' + escapeHtml(p.features) + '</p>').join('')}</div>
    <div class="section"><h4>优势</h4><p>${escapeHtml(t.strengths)}</p></div>
    <div class="section"><h4>不足</h4><p>${escapeHtml(t.weaknesses)}</p></div>
    <div class="section"><h4>适用场景及说明</h4><ul>${t.best_for.map(b => '<li>' + escapeHtml(b) + '</li>').join('')}</ul></div>
    <div class="section"><h4>不适用场景及说明</h4><ul>${t.not_for.map(n => '<li>' + escapeHtml(n) + '</li>').join('')}</ul></div>
    <div class="section"><h4>访问门槛</h4><p>${escapeHtml(t.access_barrier)}</p>${t.chinese_note ? '<p style="margin-top:4px"><b>中文支持：</b>' + escapeHtml(t.chinese_note) + '</p>' : ''}</div>
    ${rootComparable ? '<div class="modal-actions">' +
      '<button class="btn compare-toggle ' + (rootSelected ? 'selected' : '') + '" type="button" aria-pressed="' + rootSelected + '" onclick="toggleCompareRef(\'' + escapeHtml(t.id) + '\',null,this)">' + (rootSelected ? '已加入对比' : '加入对比') + '</button>' +
      '<a class="btn" href="' + escapeHtml(safeExternalUrl(t.url)) + '" target="_blank" rel="noopener noreferrer">打开工具页面</a>' +
    '</div>' : ''}
    <div class="meta">资料更新于 ${escapeHtml(t.last_updated)} · 信息来源: <a href="${escapeHtml(safeExternalUrl(t.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.source)}</a> · 利益声明: 不接收厂商赞助</div>
  `;
  showModal(trigger);
}

function closeModal() {
  const overlay = document.getElementById('modalOverlay');
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.classList.remove('modal-open');
  const returnTarget = modalTrigger;
  const scrollPosition = modalScrollPosition;
  modalTrigger = null;
  modalScrollPosition = null;
  if (scrollPosition !== null) window.scrollTo({ top: scrollPosition, behavior: 'auto' });
  if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
}

export {
  detailPanelState,
  modalTrigger,
  modalScrollPosition,
  setModalScrollPosition,
  renderScenarioExplanations,
  renderIntelligenceItem,
  renderLeafDetails,
  renderCollectionIntelligence,
  renderVendorFeatures,
  getTreeChildren,
  getLeafDescendants,
  getNodePath,
  renderModelBreadcrumb,
  getNodeStatusLabel,
  renderTreeChildren,
  renderNodeOverview,
  renderOpenAIDetailBody,
  renderLeafPanel,
  navigateModelToolPanel,
  goBackModelToolPanel,
  getModalFocusableElements,
  configureModalAccessibility,
  showModal,
  openDetail,
  closeModal,
  renderSelectedFilters,
  clearToolFilters,
  renderTools,
};
