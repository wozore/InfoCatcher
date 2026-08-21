/**
 * InfoCatcher MVP — 工具库 (tools)：搜索 + 分类/访问/价格筛选 + 卡片网格 + 详情弹窗
 *
 * 本模块同时承载详情弹窗（openDetail / showModal / closeModal）：
 * 弹窗为全站复用（热点、添加对比、搜索匹配都通过它打开），因此
 * modalTrigger / modalScrollPosition 等弹窗状态也归本模块。
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  activeFilters,
  dataLoadFailures,
  getVendorCardItem,
  getVendorLevel2Items,
  getToolCardItems,
  getFilteredVendorCardItems,
  getFilteredToolCardItems,
  getVendorLevel1Item,
  getToolLevel3Item,
  getCatalogItems,
  escapeHtml,
  renderState,
  setRegionBusy,
  ICON_CLOSE,
} from './data.js';
import { isComparableLeaf, isCompareSelected } from './compare.js';
import vendorCards from './vendor-cards.js';
import toolCards from './tool-cards.js';
import renderVendorLevel1 from './vendor-preview-level1.js';
import renderVendorLevel2 from './vendor-preview-level2.js';
import renderToolLevel3 from './tool-preview-level3.js';

// ═══════════════════════════════════════════════════════════════
// 详情弹窗状态（全站复用）
// ═══════════════════════════════════════════════════════════════
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

// 决策（搜索结果页 v2）：外部（AI 搜索“了解更多”）强制切换到指定视图模式，
// 不触发 renderTools（由调用方随后 switchView('tools') 渲染），只同步 toggle 控件。
function setToolsViewMode(value) {
  if (value !== 'vendor' && value !== 'tool') return toolsViewMode;
  toolsViewMode = value;
  syncToolsViewControls();
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
        const quickItems = level2Items.slice(0, 5).map(level2 => ({ id: level2.id, title: level2.title }));
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
        '<div class="tool-grid">' + groupItems.map(item => toolCards({
          card: item,
          compareSelected: isCompareSelected(item.detail_ref.id, item.detail_ref.id),
        })).join('') + '</div>' +
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
  if (activeFilters.access !== 'all') tags.push('访问：' + (activeFilters.access === '开放' ? '国内可访问' : '需科学上网'));
  if (activeFilters.price !== 'all') tags.push(activeFilters.price === 'free' ? '价格：有免费层' : '价格：仅付费');
  section.hidden = tags.length === 0;
  tagEl.innerHTML = tags.map(tag => '<span class="tag">' + escapeHtml(tag) + '</span>').join('');
}

function clearToolFilters() {
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
    (activeFilters.access !== 'all' || activeFilters.price !== 'all' || document.getElementById('searchInput').value)
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
function renderConcreteToolLeaf(card, backRef = null) {
  const detail = getToolLevel3Item(card.vendor_key, card.detail_ref.id);
  if (!detail) return '<div class="intelligence-unavailable">该工具详情不存在。</div>';
  const comparable = detail.detail_kind !== 'subscription_plan';
  const selected = comparable && isCompareSelected(detail.id, detail.id);
  return renderToolLevel3({ detail, toolKey: card.tool_key, showCompare: comparable, compareSelected: selected, backRef });
}

function openDetail(id, selectedItemId = null, trigger = null, backRef = null) {
  const content = document.getElementById('modalContent');
  if (!content) return;
  const level1 = id.startsWith('vendor-level1:') ? getVendorLevel1Item(id.split(':').slice(1).join(':')) : null;
  const level2 = id.startsWith('vendor-level2:') ? getCatalogItems('vendor-level2').find(item => item.id === id) : null;
  const detail = id.startsWith('tool-level3:') ? getToolLevel3Item('', id) : null;
  if (level1) {
    content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button><div id="openaiDetailBody" class="openai-detail"></div>';
    content.querySelector('#openaiDetailBody').innerHTML = renderVendorLevel1({ vendor: getVendorCardItem(level1.vendor_key), preview: level1, level2: getVendorLevel2Items(level1.vendor_key) });
    showModal(trigger);
    return;
  }
  if (level2) {
    content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' + renderVendorLevel2({ preview: level2, detailCards: level2.detail_refs.map(ref => getToolLevel3Item(level2.vendor_key, ref.id)).filter(Boolean) });
    showModal(trigger);
    return;
  }
  if (detail) {
    const card = getToolCardItems().find(item => item.detail_ref?.id === detail.id) || null;
    const detailHtml = card
      ? renderConcreteToolLeaf(card, backRef)
      : renderToolLevel3({ detail, showCompare: false, backRef });
    content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' + detailHtml;
    showModal(trigger);
    return;
  }
  const card = getToolCardItems().find(item => item.tool_key === id);
  if (card) {
    content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' + renderConcreteToolLeaf(card);
    showModal(trigger);
  }
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
  setModalScrollPosition,
  getModalFocusableElements,
  configureModalAccessibility,
  showModal,
  openDetail,
  closeModal,
  renderSelectedFilters,
  clearToolFilters,
  getToolsViewMode,
  toggleToolsViewMode,
  setToolsViewMode,
  renderTools,
};
