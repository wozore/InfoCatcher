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
  getToolDirectoryItem,
  getFilteredToolDirectoryItems,
  getVendorCardItems,
  getToolCardItems,
  getFilteredVendorCardItems,
  getFilteredToolCardItems,
  getVendorLevel1Item,
  getVendorLevel2Item,
  getVendorLevel2Items,
  getToolLevel3Item,
  getItemLatestQueriedAt,
  getToolPublishedDate,
  formatPrice,
  escapeHtml,
  safeExternalUrl,
  renderTimelinessBadge,
  hasFree,
  renderState,
  setRegionBusy,
  ICON_CLOSE,
  ICON_ARROW_LEFT,
  ICON_EXTERNAL,
} from './data.js';
import { isComparableRootTool, isComparableLeaf, isCompareSelected } from './compare.js';
import vendorCards from './vendor-cards.js';
import toolCards from './tool-cards.js';
import renderVendorLevel1 from './vendor-preview-level1.js';
import renderVendorLevel2 from './vendor-preview-level2.js';
import renderToolLevel3 from './tool-preview-level3.js';

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

let toolsViewMode = 'vendor';

// 工具视图四类固定分组（分类名只作为区块大标题，卡片本身不写分类文字，分类由颜色表达）
const TOOL_GROUPS = [
  { type: 'general', title: '通用对话与大模型入口' },
  { type: 'dev', title: 'AI 编程与开发工具' },
  { type: 'vision', title: '图像与视觉生成' },
  { type: 'media', title: '视频、音乐与音频生成' },
];

// 双视图文案：厂商视图以厂商为信息中心，工具视图以单个工具为信息中心
const TOOLS_COPY = {
  vendor: {
    eyebrow: '厂商全景',
    title: '从厂商出发，了解完整 AI 产品体系',
    lead: '集中查看各厂商旗下的 AI 工具、模型与套餐，快速了解产品布局、主要优势、使用门槛和价格体系。',
    searchTitle: '查找已收录厂商',
    searchLead: '输入厂商、产品名称或核心能力，定位相关厂商及其产品体系。',
    searchPlaceholder: '例如：OpenAI、Claude、API 模型',
    directoryTitle: '当前匹配的厂商',
    directoryLead: '点击厂商卡片查看旗下模型与工具详情。',
    countLabel: '个厂商',
  },
  tool: {
    eyebrow: '发现工具',
    title: '直接查找适合你的 AI 工具',
    lead: '无需先选择厂商，可按名称、任务、访问方式和价格直接查找，也可以按分类浏览发现新工具。',
    searchTitle: '查找已收录工具',
    searchLead: '输入工具名、任务或功能，再按使用条件缩小范围。',
    searchPlaceholder: '例如：写论文、生成图片、免费编程',
    directoryTitle: '当前匹配的工具',
    directoryLead: '点击工具查看优势、限制、价格、访问门槛和详细资料。',
    countLabel: '个工具',
  },
};

function getToolsViewMode() {
  return toolsViewMode;
}

function syncToolsViewControls() {
  const toggle = document.getElementById('toolsViewToggle');
  if (!toggle) return;
  const isToolView = toolsViewMode === 'tool';
  toggle.setAttribute('aria-checked', String(isToolView));
  toggle.dataset.mode = toolsViewMode;

  // 同步两块视图的标题/说明/搜索区/目录文案
  const copy = TOOLS_COPY[toolsViewMode];
  const textMap = {
    toolsViewEyebrow: copy.eyebrow,
    toolsViewTitle: copy.title,
    toolsViewLead: copy.lead,
    toolsSearchTitle: copy.searchTitle,
    toolsSearchLead: copy.searchLead,
    toolsDirectoryTitle: copy.directoryTitle,
    toolsDirectoryLead: copy.directoryLead,
    toolCountLabel: copy.countLabel,
  };
  for (const [id, text] of Object.entries(textMap)) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.placeholder = copy.searchPlaceholder;

  const status = document.getElementById('toolsViewToggleStatus');
  if (status) status.textContent = '当前为' + (isToolView ? '工具' : '厂商') + '视图';
}

function toggleToolsViewMode() {
  toolsViewMode = toolsViewMode === 'vendor' ? 'tool' : 'vendor';
  renderTools();
  return toolsViewMode;
}

class VendorDirectoryView {
  constructor() {
    this.root = document.getElementById('vendorDirectoryView');
    this.grid = document.getElementById('vendorGrid');
  }

  show() {
    if (this.root) this.root.hidden = false;
  }

  hide() {
    if (this.root) this.root.hidden = true;
  }

  render(items) {
    if (this.grid) {
      this.grid.innerHTML = items.map(item => {
        const level2Items = getVendorLevel2Items(item.vendor_key);
        const quickItems = level2Items.slice(0, 5).map(level2 => ({ id: level2.id.split(':').pop(), title: level2.title }));
        const leafCount = level2Items.reduce((count, level2) => count + level2.detail_refs.length, 0);
        return vendorCards({ card: item, quickItems, leafCount });
      }).join('');
    }
  }

  renderState(state) {
    if (this.grid) this.grid.innerHTML = renderState(state);
  }
}

class ToolDirectoryView {
  constructor() {
    this.root = document.getElementById('toolDirectoryView');
    this.grid = document.getElementById('toolGrid');
    this.index = document.getElementById('toolsCategoryIndex');
    this.indexList = document.getElementById('toolsCategoryIndexList');
    this.indexObserver = null;
    this.intersectingGroups = new Map();
    this.bindIndex();
  }

  show() {
    if (this.root) this.root.hidden = false;
  }

  hide() {
    this.disconnectIndexObserver();
    if (this.root) this.root.hidden = true;
  }

  setActiveGroup(type) {
    if (!this.indexList) return;
    const targetGroup = 'tool-group-' + type;
    this.indexList.querySelectorAll('[aria-current]').forEach(link => link.removeAttribute('aria-current'));
    const button = Array.from(this.indexList.querySelectorAll('[data-tool-group]'))
      .find(link => link.dataset.toolGroup === targetGroup);
    if (button) button.setAttribute('aria-current', 'location');
  }

  bindIndex() {
    if (!this.indexList || this.indexList.dataset.bound === 'true') return;
    this.indexList.dataset.bound = 'true';
    this.indexList.addEventListener('click', event => {
      const button = event.target.closest('[data-tool-group]');
      const target = button && document.getElementById(button.dataset.toolGroup);
      if (!target) return;
      this.setActiveGroup(button.dataset.toolGroup.replace(/^tool-group-/, ''));
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  disconnectIndexObserver() {
    if (this.indexObserver) this.indexObserver.disconnect();
    this.indexObserver = null;
    this.intersectingGroups.clear();
  }

  observeGroups() {
    this.disconnectIndexObserver();
    if (!this.grid || !this.indexList || this.index.hidden || typeof IntersectionObserver !== 'function') return;

    const sections = Array.from(this.grid.querySelectorAll('.tool-group[id]'));
    if (sections.length === 0) return;

    this.indexObserver = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        this.intersectingGroups.set(entry.target.id, entry.isIntersecting);
      });

      const active = sections
        .filter(section => this.intersectingGroups.get(section.id))
        .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0];
      if (active) this.setActiveGroup(active.id.replace(/^tool-group-/, ''));
    }, {
      rootMargin: '-112px 0px -62% 0px',
      threshold: [0, .1, .35],
    });

    sections.forEach(section => this.indexObserver.observe(section));
  }

  syncIndex(visibleTypes) {
    if (!this.index || !this.indexList) return;
    this.index.hidden = visibleTypes.length === 0;
    this.indexList.innerHTML = TOOL_GROUPS.filter(group => visibleTypes.includes(group.type)).map(group =>
      '<button type="button" class="tools-category-index-link" data-tool-group="tool-group-' + escapeHtml(group.type) + '" aria-controls="tool-group-' + escapeHtml(group.type) + '">' + escapeHtml(group.title) + '</button>'
    ).join('');
    this.setActiveGroup(visibleTypes[0]);
  }

  render(items) {
    if (!this.grid) return;
    const visibleTypes = [];
    this.grid.classList.add('tool-groups');
    this.grid.innerHTML = TOOL_GROUPS.map(group => {
      const groupItems = items.filter(tool => tool.theme === group.type);
      if (groupItems.length === 0) return '';
      visibleTypes.push(group.type);
      return '<section class="tool-group" id="tool-group-' + escapeHtml(group.type) + '">' +
        '<h3 class="tool-group-title">' + escapeHtml(group.title) +
          ' <span class="tool-group-count">' + groupItems.length + '</span></h3>' +
        '<div class="tool-group-divider" aria-hidden="true"></div>' +
        '<div class="tool-grid">' + groupItems.map(item => toolCards({ card: item })).join('') + '</div>' +
        '</section>';
    }).join('');
    this.syncIndex(visibleTypes);
    this.observeGroups();
  }

  renderState(state) {
    this.disconnectIndexObserver();
    if (this.grid) this.grid.innerHTML = renderState(state);
    if (this.index) this.index.hidden = true;
  }
}

let directoryViews = null;
function getDirectoryViews() {
  if (!directoryViews) {
    directoryViews = {
      vendor: new VendorDirectoryView(),
      tool: new ToolDirectoryView(),
    };
  }
  return directoryViews;
}

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
 * 渲染单张工具卡片。
 * - 工具视图（tool 模式）：所有记录按 card_type 加四类主题色；具体工具含适合/不适合行；
 * - 厂商视图（vendor 模式）：只渲染 collection 厂商卡，保持中性视觉（不加主题色），
 *   标题只显示厂商名，含产品体系计数 + 快捷入口 + 优点/限制。
 */
function renderToolCard(t) {
  const isCollection = t.card_kind === 'collection';
  const isIntelligenceLeaf = t.card_kind === 'intelligence_leaf';
  const overview = t.overview;
  const title = isCollection ? t.vendor : t.name;
  const description = isCollection
    ? (overview?.description || t.strengths)
    : t.strengths;
  const isToolView = toolsViewMode === 'tool';
  const typeClass = isToolView && t.card_type ? ' tool-card--' + escapeHtml(t.card_type) : '';
  const intelligenceKindLabel = t.intelligenceKind === 'api_model'
    ? 'API 模型'
    : t.intelligenceKind === 'subscription_plan'
      ? '订阅套餐'
      : t.intelligenceKind === 'product_variant' ? '产品变体' : '';
  const openCard = isIntelligenceLeaf
    ? 'openDirectoryDetail(\'' + escapeHtml(t.collectionToolId) + '\',\'' + escapeHtml(t.intelligenceItemId) + '\',this)'
    : 'openDetail(\'' + escapeHtml(t.id) + '\',null,this)';

  // 厂商产品体系（collection 卡）：计数 + 快捷入口，点击直达详情对应分组
  const intelligence = getToolIntelligence(t.id);
  const collectionItems = (intelligence?.items || []).filter(item => item.node_type !== 'group' && item.display_in_tree !== false);
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

  // 厂商优点/限制
  const featurePreview = isCollection && overview?.features?.length
    ? '<div class="vendor-feature-preview">' + overview.features.map(feature =>
        '<div class="vendor-feature-slot"><p class="vendor-feature ' + escapeHtml(feature.tone) + '">' + escapeHtml(feature.text) + '</p></div>'
      ).join('') + '</div>'
    : '';

  // 具体工具：适合/不适合行（无该字段则不显示）
  const fitLines = !isCollection && (t.best_for?.length || t.not_for?.length)
    ? '<div class="tool-card-fit">' +
      (intelligenceKindLabel ? '<p class="tool-card-kind">' + escapeHtml(intelligenceKindLabel) + '</p>' : '') +
      (t.best_for?.[0] ? '<p class="fit-pos">适合：' + escapeHtml(t.best_for[0]) + '</p>' : '') +
      (t.not_for?.[0] ? '<p class="fit-neg">不适合：' + escapeHtml(t.not_for[0]) + '</p>' : '') +
      '</div>'
    : intelligenceKindLabel ? '<div class="tool-card-fit"><p class="tool-card-kind">' + escapeHtml(intelligenceKindLabel) + '</p></div>' : '';

  // 具体工具标签（免费/付费 + 访问）与页脚；厂商卡不展示这两块
  const tagsHtml = !isCollection
    ? '<div class="tool-card-tags">' +
      (hasFree(t) ? '<span class="tag free">免费可用</span>' : '<span class="tag paid">仅付费</span>') +
      '<span class="tag ' + (t.access_level === '开放' ? 'open' : 'restricted') + '">' + (t.access_level === '开放' ? '国内可用' : '需科学上网') + '</span>' +
      '</div>'
    : '';

  const isSelected = isIntelligenceLeaf
    ? isCompareSelected(t.collectionToolId, t.intelligenceItemId)
    : isCompareSelected(t.id, null);
  const comparable = isIntelligenceLeaf
    ? isComparableLeaf(t.collectionToolId, t.intelligenceItemId)
    : isComparableRootTool(t);
  const compareRef = isIntelligenceLeaf
    ? 'toggleCompareRef(\'' + escapeHtml(t.collectionToolId) + '\',\'' + escapeHtml(t.intelligenceItemId) + '\',this)'
    : 'toggleCompareRef(\'' + escapeHtml(t.id) + '\',null,this)';
  const compareHtml = !isCollection && comparable
    ? '<div class="tool-card-actions tool-card-actions-only" onclick="event.stopPropagation()">' +
      '<button class="compare-toggle ' + (isSelected ? 'selected' : '') + '" aria-pressed="' + isSelected + '" onclick="' + compareRef + '">' + (isSelected ? '已选' : '+对比') + '</button>' +
      '</div>'
    : '';

  return `
    <div class="tool-card${isCollection ? ' collection-card' : ''}${typeClass}" onclick="${openCard}">
      <div class="tool-card-header">
        <div>
          <div class="tool-card-name">${t.icon} ${escapeHtml(title)}</div>
          <div class="tool-card-vendor">${isCollection ? '厂商总览' : escapeHtml(t.vendor)}</div>
        </div>
        ${isCollection ? '' : '' /* 决策 98：工具卡片默认区不显示评分，评分保留在详情模态 */}
      </div>

      <div class="tool-card-desc">${escapeHtml(description)}</div>
      ${isCollection ? collectionSummary : ''}
      ${isCollection ? featurePreview : ''}
      ${fitLines}
      ${tagsHtml}
      ${compareHtml}
    </div>`;
}

/**
 * 渲染工具卡片网格。
 * 1. 获取过滤后的工具列表
 * 2. 更新工具计数和筛选提示
 * 3. 空结果时显示空状态占位
 * 4. 厂商视图：平铺 collection 厂商卡；工具视图：按四类固定分组渲染（每组大标题 + 横向分割线）
 *
 * 注意：对比按钮在卡片 DOM 字符串中使用了 onclick 属性;
 * event.stopPropagation() 防止点击对比按钮同时触发卡片的 openDetail。
 * EXTENSION POINT: 方案一——>方案三变迁中时，实现在对比页面也能自定义添加工具
 * EXTENSION POINT: 方案一——>方案三变迁中时，卡片实现动态效果-描述：默认显示工具大头照，悬停时工具照向左迁移，右边显示简略的信息，点击进入详情
 */
function renderTools() {
  const isToolView = toolsViewMode === 'tool';
  const filtered = isToolView ? getFilteredToolCardItems() : getFilteredVendorCardItems();
  const views = getDirectoryViews();
  const currentView = isToolView ? views.tool : views.vendor;
  const otherView = isToolView ? views.vendor : views.tool;
  const currentGrid = currentView.grid;
  setRegionBusy(currentGrid, false);
  renderSelectedFilters();
  syncToolsViewControls();

  const visibleTools = isToolView ? filtered : filtered;
  currentView.show();
  otherView.hide();

  document.getElementById('toolCount').textContent = visibleTools.length;
  document.getElementById('filteredInfo').style.display =
    (activeFilters.category !== 'all' || activeFilters.access !== 'all' || activeFilters.price !== 'all' || document.getElementById('searchInput').value)
    ? 'inline' : 'none';

  if (dataLoadFailures.has('tools')) {
    currentView.renderState({ icon: '⚠️', title: '工具数据加载失败', message: '请刷新页面重试；若问题持续，请检查公开工具数据文件是否可访问。', type: 'error' });
    return;
  }

  if (visibleTools.length === 0) {
    currentView.renderState({ icon: '⌕', title: isToolView ? '没有匹配的工具' : '没有匹配的厂商', message: '请调整筛选条件或更换搜索关键词。', type: 'no-match' });
    return;
  }
  currentView.render(visibleTools);
}

// ═══════════════════════════════════════════════════════════════
// 工具详情弹窗 —— 具体模型/套餐情报与模型工具面板
// ═══════════════════════════════════════════════════════════════

function renderScenarioExplanations(title, items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return '<div class="intelligence-scenarios"><h5>' + title + '</h5>' + items.map(item => {
    const itemTitle = typeof item === 'string' ? item : item.title;
    const description = typeof item === 'string' ? '' : item.description;
    return '<div><b>' + escapeHtml(itemTitle) + (description ? '：' : '') + '</b>' + escapeHtml(description) + '</div>';
  }).join('') + '</div>';
}

function normalizeConcreteToolDetail(tool) {
  const sourceId = tool.id + '-catalog-source';
  return {
    id: tool.id,
    kind: 'tool',
    summary: tool.strengths || '',
    applicable_scenarios: (tool.best_for || []).map(title => ({ title, description: '' })),
    inapplicable_scenarios: (tool.not_for || []).map(title => ({ title, description: '' })),
    source_refs: [sourceId],
    sourceId,
    source: tool.source || tool.name,
    last_updated: tool.last_updated || '',
  };
}

function renderIntelligenceItem(item, sourceMap, selectedItemId, toolId) {
  const latestQ = (item.source_refs || []).map(ref => sourceMap.get(ref)).filter(Boolean).map(s => s.queried_at).filter(Boolean).sort().reverse()[0] || null;
  const badge = renderTimelinessBadge(latestQ);
  return '<details class="intelligence-item"' + (item.id === selectedItemId ? ' open' : '') + '>' +
    '<summary><span><b>' + escapeHtml(item.name) + '</b><small>' + escapeHtml(item.kind === 'api_model' ? 'API 模型' : item.kind === 'subscription_plan' ? '订阅套餐' : '产品变体') + '</small>' + badge + '</span><span>查看详情</span></summary>' +
    '<div class="intelligence-item-body">' + renderLeafDetails(item, sourceMap, toolId ? { toolId } : false) + '</div></details>';
}

function renderLeafDetails(item, sourceMap, showCompare, options = {}) {
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
  const sourceDate = item.last_updated
    ? '<span>资料更新于 ' + escapeHtml(item.last_updated) + '</span>'
    : latestQueriedAt ? '<span>查询于 ' + escapeHtml(latestQueriedAt.slice(0, 10)) + '</span>' : '';
  const sourcesHtml = sources.length
    ? '<div class="intelligence-sources"><b>资料来源：</b>' + sources.map(source =>
      '<a href="' + escapeHtml(safeExternalUrl(source.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
    ).join(' · ') + sourceDate + '</div>'
    : '';
  const compareHtml = showCompare && !options.hideCompare
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

function renderModelBackButton(toolId) {
  return '<button class="model-index-back" type="button" aria-label="返回上一级" title="返回上一级" onclick="goBackModelToolPanel(\'' + escapeHtml(toolId) + '\')">' + ICON_ARROW_LEFT + '</button>';
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

function renderGroupCompareButton(toolId, collection, parentId) {
  const parent = parentId ? getCollectionNode(toolId, parentId) : null;
  const leaves = parent ? getLeafDescendants(collection, parent.id) : [];
  const comparableLeaves = leaves.filter(item => item.node_type === 'leaf' && ['api_model', 'subscription_plan'].includes(item.kind));
  const sameKind = comparableLeaves.length > 1 && comparableLeaves.every(item => item.kind === comparableLeaves[0].kind);
  return sameKind
    ? '<button class="model-bulk-compare" type="button" onclick="compareGroupLeaves(\'' + escapeHtml(toolId) + '\',\'' + escapeHtml(parent.id) + '\')">全部' + escapeHtml(comparableLeaves[0].kind === 'api_model' ? '模型' : '套餐') + '对比（' + comparableLeaves.length + '）</button>'
    : '';
}

function renderTreeChildren(toolId, collection, parentId, options = {}) {
  const children = getTreeChildren(collection, parentId);
  const parent = parentId ? getCollectionNode(toolId, parentId) : null;
  const groupCompare = renderGroupCompareButton(toolId, collection, parentId);
  if (!children.length) {
    return '<div class="intelligence-unavailable"><b>' + escapeHtml(parent?.name || '当前分类') + '</b>：' +
      (parent?.status === 'unknown' ? '官方资料待核验，暂不展示未经证实的子项、价格或权益。' : '当前没有可展示的已核实子项。') + '</div>';
  }
  const heading = options.showHeading === false ? '' :
    '<div class="model-panel-heading"><div><h4>' + escapeHtml(parent?.name || '模型与工具') + '</h4><p>' + escapeHtml(parent?.summary || '选择分类继续查看，只有最终叶节点可比较。') + '</p></div>' + groupCompare + '</div>';
  const compareOnly = options.showHeading === false && options.showBulkCompare !== false && groupCompare
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

function renderModelIndexOverview(node, options = {}) {
  return '<section class="node-overview model-index-overview">' +
    '<h2>' + escapeHtml(node.name) + '</h2>' +
    '<div class="vendor"><a href="' + escapeHtml(safeExternalUrl(node.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
    (options.showDescription === false ? '' : '<p class="node-description">' + escapeHtml(node.summary || '暂无简短说明。') + '</p>') +
  '</section>';
}

function renderOpenAIDetailBody(toolId, nodeId = null) {
  const vendor = getVendorCardItems().find(card => card.vendor_key === toolId);
  const level1 = getVendorLevel1Item(toolId);
  if (!vendor || !level1) return '<div class="intelligence-unavailable">该厂商不存在。</div>';
  if (!nodeId) {
    const level2 = getVendorLevel2Items(toolId).map(item => ({ ...item, legacy_id: item.id.split(':').pop() }));
    return renderVendorLevel1({ vendor, preview: level1, level2 });
  }
  const detail = getToolLevel3Item(toolId, nodeId);
  if (detail) return renderToolLevel3({ detail, showCompare: detail.kind !== 'tool', compareSelected: isCompareSelected(toolId, nodeId), backTarget: { vendorKey: toolId } });
  const level2 = getVendorLevel2Item(toolId, nodeId);
  if (!level2) return '<div class="intelligence-unavailable">该模型或工具节点不存在。</div>';
  const detailCards = getToolCardItems().filter(card => level2.detail_refs.some(ref => ref.id === card.detail_ref?.id));
  return renderVendorLevel2({ preview: { ...level2, vendor_key: toolId }, detailCards });
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
  const title = content?.querySelector('h2, .model-panel-heading h4');
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

/**
 * 具体工具详情 —— 单级叶节点样式（复用 GPT-5.6 Sol 三级预览的面板视觉）。
 * 工具内部只有一级面板：不渲染返回键，仅由模态右上角 X 关闭。
 */
function renderConcreteToolLeaf(t) {
  const vendorKey = t.collectionToolId || t.id;
  const itemKey = t.intelligenceItemId || t.id;
  const detail = getToolLevel3Item(vendorKey, itemKey);
  if (!detail) return '<div class="intelligence-unavailable">该工具详情不存在。</div>';
  const comparable = detail.kind === 'tool' ? isComparableRootTool(t) : isComparableLeaf(vendorKey, itemKey);
  const selected = detail.kind === 'tool'
    ? isCompareSelected(vendorKey, null)
    : isCompareSelected(vendorKey, itemKey);
  return renderToolLevel3({ detail, showCompare: comparable, compareSelected: selected });
}

function openDirectoryDetail(toolId, itemId, trigger = null) {
  const directoryItem = getToolDirectoryItem(toolId, itemId);
  if (!directoryItem) return;
  const content = document.getElementById('modalContent');
  if (!content) return;
  content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
    renderConcreteToolLeaf(directoryItem);
  showModal(trigger);
}

function openDetail(id, selectedItemId = null, trigger = null) {
  const tool = tools.find(item => item.id === id);
  if (!tool) return;
  const content = document.getElementById('modalContent');
  if (tool.card_kind === 'collection') {
    content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
      '<div id="openaiDetailBody" class="openai-detail"></div>';
    navigateModelToolPanel(id, selectedItemId);
    showModal(trigger);
    return;
  }
  content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
    renderConcreteToolLeaf(tool);
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
  openDirectoryDetail,
  openDetail,
  closeModal,
  renderSelectedFilters,
  clearToolFilters,
  getToolsViewMode,
  toggleToolsViewMode,
  renderTools,
};
