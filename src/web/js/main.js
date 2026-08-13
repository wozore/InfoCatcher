/**
 * InfoCatcher MVP — 浏览器端应用逻辑（纯前端、零依赖、无构建工具）
 *
 * ═══════════════════════════════════════════════════════════════
 * 架构概要：
 * ═══════════════════════════════════════════════════════════════
 *
 *   数据加载(loadData) → 全局状态(tools/glossary/hotspots/compareList)
 *     → 搜索/过滤(getFilteredTools/getFilteredGlossary/getFilteredTrending)
 *       → 视图渲染(renderTools/renderScenes/renderCompare/renderGlossary/renderTrending)
 *         → 用户交互(点击/搜索/筛选/快捷键)
 *           → 事件绑定(DOMContentLoaded)
 *
 * 拆分后数据层与各视图分属独立 ES module（见 src/web/js/ 目录）：
 *   data.js    数据层（加载/状态/过滤/通用工具/平台元数据）
 *   search.js   AI 搜索视图
 *   tools.js    工具库视图 + 详情弹窗
 *   compare.js  对比模式
 *   scenes.js   场景模式
 *   trending.js AI 热点视图
 *   featured.js 推荐视图
 *   glossary.js AI 概念视图
 *   main.js    本文件：导航(switchView) + 全部事件绑定 + window 全局暴露 + 入口
 *
 * ═══════════════════════════════════════════════════════════════
 * 八个视图：
 * ═══════════════════════════════════════════════════════════════
 *   AI搜索 (search)     — B16 静态搜索入口与结果主线（P1-A 接入）
 *   工具库 (tools)      — 搜索 + 分类/访问/价格筛选 + 卡片网格 + 详情弹窗
 *   场景模式 (scenes)   — 12 个场景入口，可展开子任务并查看匹配工具卡片
 *   对比模式 (compare)  — 2-5 个工具并排比较 10+ 维度
 *   AI热点 (trending)   — 内容类型筛选 + 最近/热度排序, 按唯一内容发布时间分组
 *   推荐 (featured)     — 编辑精选与热门模型分类视图
 *   AI概念 (glossary)   — 43 条术语, 分类筛选 + 搜索 + 可展开详情
 *   关于 (about)        — 评测方法论和项目介绍 (纯 HTML, 无专属渲染函数)
 *
 * ═══════════════════════════════════════════════════════════════
 * 安全约束：
 * ═══════════════════════════════════════════════════════════════
 *   - 所有渲染的外部文本通过 escapeHtml() 转义，防止 XSS
 *   - 所有外部链接通过 safeExternalUrl() 校验，只允许 http/https 协议
 *   - API Key 不存在于前端代码或静态 JSON 中，浏览器不直接调用平台 API
 *   - 用户偏好仅存储在浏览器 localStorage，不上传服务器
 *
 * ═══════════════════════════════════════════════════════════════
 * 扩展模式（新增功能时参考）：
 * ═══════════════════════════════════════════════════════════════
 *   新增视图：
 *     1. index.html → 加 nav-btn + section 容器
 *     2. 对应视图模块 → 加 renderXxx() 函数
 *     3. main.js switchView() → 加 if (view === 'xxx') 分支
 *     4. main.js DOMContentLoaded → 加事件绑定
 *   新增筛选维度：
 *     1. index.html → 加 filter-chip
 *     2. data.js getFilteredTools() → 加过滤分支 (AND 叠加)
 *   新增数据源：
 *     1. data/ 目录 → 加 JSON 文件
 *     2. data.js loadData() → 加 fetch, 失败时降级为空状态
 *
 * ═══════════════════════════════════════════════════════════════
 * 渲染约束：
 * ═══════════════════════════════════════════════════════════════
 *   - 所有搜索/筛选为前端内存过滤, 不发起网络请求
 *   - 对比按钮状态变更后必须同步 updateCompareCount() + renderTools()
 *   - 数据文件日期统一使用 ISO 格式 (YYYY-MM-DD)
 *   - 视图切换靠 CSS class .view.active, 不使用前端路由库
 *
 * ES module 注意：各视图模块的顶层函数声明不会挂到 window，而卡片/弹窗
 * 渲染出的 HTML 字符串里的 onclick="..." 在点击时才按 window 解析，
 * 因此下方把 9 个被内联引用的函数显式挂到 window（openDetail 等）。
 */
import {
  renderSkeletons,
  loadData,
  announceStatus,
  setRegionBusy,
  setPressedState,
  copyTextWithFeedback,
  activeFilters,
  setActiveGlossaryCategory,
  setActiveTrendingType,
  setActiveTrendingSort,
} from './data.js';
import {
  renderTools,
  openDetail,
  closeModal,
  clearToolFilters,
  toggleToolsViewMode,
  getModalFocusableElements,
} from './tools.js';
import {
  updateCompareCount,
  renderCompare,
  toggleCompareRef,
  renderAddCompare,
  openAddComparePanel,
  compareList,
  compareGroupLeaves,
  removeCompare,
  quickCompare,
} from './compare.js';
import { renderScenes, setActiveSceneId, toggleSceneToolCard } from './scenes.js';
import {
  renderTrending,
  renderTrendingSortHelp,
  clearTrendingFilters,
  reloadHotspots,
  openHotspotDetail,
} from './trending.js';
import { renderGlossary, openGlossaryConcept, setActiveGlossaryId } from './glossary.js';
import { applyStaticTranslations } from './i18n.js';
import {
  renderFeatured,
  activeEditorCat,
  activeHotCat,
  setActiveEditorCat,
  setActiveHotCat,
} from './featured.js';
import {
  searchState,
  searchMatchExpanded,
  searchConceptTrigger,
  searchConceptCloseTimer,
  renderSearchHome,
  renderSearchProcessing,
  renderSearchView,
  submitSearchHome,
  clearSearchHomeStates,
  cancelSearchProcessing,
  returnToSearchHome,
  openSearchMatch,
  startSearchEditing,
  cancelSearchEditing,
  submitSearchEdit,
  clearSearchEditState,
  focusSearchSource,
  focusSearchCitation,
  renderSearchMatches,
  getSearchMatches,
  markSearchConcepts,
  setSearchFeedback,
  scheduleSearchConceptOpen,
  scheduleSearchConceptClose,
  openSearchConcept,
  closeSearchConcept,
  selectSearchExample,
} from './search.js';

// ═══════════════════════════════════════════════════════════════
// 全局状态 —— 导航与当前视图
// ═══════════════════════════════════════════════════════════════
let currentView = 'search';   // 当前激活的视图
// B16 决策 84：移动端顶栏“当前页面名称”映射（同步到 #mobileCurrentPage）
const VIEW_TITLES = {
  search: 'AI 搜索',
  tools: '工具库',
  scenes: '场景',
  compare: '对比',
  trending: 'AI 热点',
  featured: '推荐',
  glossary: 'AI 概念',
  about: '关于'
};

// ═══════════════════════════════════════════════════════════════
// 视图切换
// ═══════════════════════════════════════════════════════════════

/**
 * 切换当前显示的视图。
 * 实现方式：通过 CSS class .view.active 控制显隐（非路由），
 * 切换后触发对应视图的渲染函数（首次渲染或重新渲染）。
 * 1. 先清 → 所有面板消失，按钮变灰
 * 2. 再加 → 新面板出现，新按钮高亮
 * 3. 再渲染 → 往面板里填数据
 *
 * EXTENSION POINT: 新增视图时在末尾加 if (view === 'xxx') renderXxx();
 */
function closeMobileNav({ restoreFocus = false } = {}) {
  const menuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mobileNav');
  if (!menuToggle || !mobileNav) return;
  mobileNav.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', '打开导航菜单');
  if (restoreFocus) menuToggle.focus();
}

function openMobileNav() {
  const menuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mobileNav');
  if (!menuToggle || !mobileNav) return;
  mobileNav.hidden = false;
  menuToggle.setAttribute('aria-expanded', 'true');
  menuToggle.setAttribute('aria-label', '关闭导航菜单');
  // 决策 84：菜单打开后焦点移入菜单内第一个可聚焦项，键盘用户不丢失当前位置
  const firstFocusable = mobileNav.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])');
  if (firstFocusable) firstFocusable.focus({ preventScroll: true });
}

// B16 决策 83：桌面分组下拉菜单的视图归属映射（父级菜单联动当前状态）
const VIEW_GROUPS = {
  discover: ['tools', 'scenes', 'compare', 'featured'],
  knowledge: ['trending', 'glossary']
};

function closeAllNavDropdowns() {
  document.querySelectorAll('.nav-dropdown-menu').forEach(menu => { menu.hidden = true; });
  document.querySelectorAll('.nav-dropdown .nav-trigger').forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
}

function syncNavigationState(view) {
  document.querySelectorAll('[data-view]').forEach(control => {
    const isActive = control.dataset.view === view;
    control.classList.toggle('active', isActive);
    if (isActive) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  });
  // 决策 83：当前位于子页面时，父级下拉菜单显示当前状态
  document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
    const trigger = dropdown.querySelector('.nav-trigger');
    if (!trigger) return;
    const groupKey = dropdown.dataset.group;
    trigger.classList.toggle('active', Boolean(groupKey && VIEW_GROUPS[groupKey]?.includes(view)));
  });
}

function switchView(view) {
  const target = document.getElementById('view-' + view);
  if (!target) return;

  // 决策 84：记录是否从打开的移动菜单进入（用于关闭菜单后把焦点移入目标视图）
  const mobileNav = document.getElementById('mobileNav');
  const fromMobileMenu = Boolean(mobileNav && !mobileNav.hidden && mobileNav.contains(document.activeElement));

  currentView = view;
  const mobilePageTitle = document.getElementById('mobileCurrentPage');
  if (mobilePageTitle && VIEW_TITLES[view]) mobilePageTitle.textContent = VIEW_TITLES[view];
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  target.classList.add('active');
  syncNavigationState(view);
  closeMobileNav();
  announceStatus((target.querySelector('h1')?.textContent || '页面') + '已显示');

  if (view === 'scenes') renderScenes();
  if (view === 'compare') renderCompare();
  if (view === 'tools') renderTools();
  if (view === 'glossary') renderGlossary();
  if (view === 'trending') renderTrending();
  if (view === 'featured') renderFeatured();

  // 决策 84：从移动菜单进入时，把焦点移入新视图标题，避免焦点停留在已隐藏的菜单项上
  if (fromMobileMenu) {
    const heading = target.querySelector('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// window 全局暴露 —— 渲染字符串内联 onclick 的解析目标
//
// ES module 顶层函数声明不会挂到 window；而工具卡/场景卡/推荐卡/弹窗
// 生成的 HTML 字符串含 onclick="openDetail(...)" 等，点击时按 window 解析。
// 此清单与各模块生成的内联 handler 一一对应，缺失会报“openDetail is not defined”。
// ═══════════════════════════════════════════════════════════════
window.openDetail = openDetail;
window.closeModal = closeModal;
window.toggleCompareRef = toggleCompareRef;
window.compareGroupLeaves = compareGroupLeaves;
window.removeCompare = removeCompare;
window.quickCompare = quickCompare;
window.toggleSceneToolCard = toggleSceneToolCard;

// ═══════════════════════════════════════════════════════════════
// 页面初始化与事件绑定
// 注册事件，在DOM树被建立完时触发运行
//
// 执行顺序：
//   1. loadData() — 异步加载所有 JSON 数据
//   2. renderTools() + renderScenes() + renderTrending() — 首次渲染
//   3. 绑定事件监听器（搜索/导航/筛选/快捷键/对比/词典/热点/模态）
//
// EXTENSION POINT: 新视图的事件监听在此区域追加
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // i18n 框架：先替换 index.html 静态文案（data-i18n 属性），早于各视图 render
  // （render 内文案用 t()，语言切换时重新 applyStaticTranslations + 重渲染即可）。
  applyStaticTranslations();
  renderSkeletons();
  await loadData();
  renderTools();
  renderScenes();
  updateCompareCount();
  renderTrending();
  renderSearchHome();
  renderSearchProcessing();
  renderSearchView();
  document.getElementById('app').setAttribute('aria-busy', 'false');
  announceStatus('静态资料加载完成');

  // AI 静态搜索首页
  const aiSearchForm = document.getElementById('aiSearchShellForm');
  const aiSearchInput = document.getElementById('aiSearchInput');
  if (aiSearchForm && aiSearchInput) {
    aiSearchForm.addEventListener('submit', event => {
      event.preventDefault();
      submitSearchHome(aiSearchInput.value);
    });
    aiSearchInput.addEventListener('input', clearSearchHomeStates);
    document.getElementById('searchCancelProcessing')?.addEventListener('click', cancelSearchProcessing);
    document.getElementById('searchBackButton')?.addEventListener('click', returnToSearchHome);
    document.getElementById('searchEditButton')?.addEventListener('click', startSearchEditing);
    document.getElementById('searchEditCancel')?.addEventListener('click', cancelSearchEditing);
    // B16 决策 10.2/100：复制查询 / 复制摘要（仅原型验证位置，不接入云端）
    document.getElementById('searchCopyQuery')?.addEventListener('click', () => {
      const text = searchState.query || '';
      if (!text) { announceStatus('暂无可复制的查询'); return; }
      copyTextWithFeedback(document.getElementById('searchCopyQuery'), text, '查询');
    });
    document.getElementById('searchCopySummary')?.addEventListener('click', () => {
      const text = document.getElementById('searchSummaryContent')?.innerText?.trim() || '';
      if (!text) { announceStatus('暂无可复制的摘要'); return; }
      copyTextWithFeedback(document.getElementById('searchCopySummary'), text, '摘要');
    });
    const searchEditForm = document.getElementById('searchEditForm');
    const searchEditInput = document.getElementById('searchEditInput');
    searchEditForm?.addEventListener('submit', event => {
      event.preventDefault();
      submitSearchEdit(searchEditInput?.value);
    });
    searchEditInput?.addEventListener('input', clearSearchEditState);
    searchEditInput?.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelSearchEditing();
    });
    document.getElementById('searchResultContent')?.addEventListener('click', event => {
      const citation = event.target.closest('[data-search-citation]');
      if (citation) {
        focusSearchSource(citation.dataset.searchCitation, citation);
        return;
      }
      const back = event.target.closest('[data-search-source-back]');
      if (back) {
        focusSearchCitation(back.dataset.searchSourceBack);
        return;
      }
      // 决策 8.2/8.4：查看全部来源折叠
      const moreToggle = event.target.closest('[data-search-sources-toggle]');
      if (moreToggle) {
        const panel = document.getElementById('searchMoreSources');
        if (panel) {
          panel.hidden = !panel.hidden;
          moreToggle.setAttribute('aria-expanded', String(!panel.hidden));
          moreToggle.textContent = panel.hidden ? '查看全部来源（' + (moreToggle.dataset.count || '') + '）' : '收起更多来源';
        }
        return;
      }
      // 决策 8.3：移动端“查看关键来源 / 返回摘要”锚点
      const anchor = event.target.closest('[data-search-anchor]');
      if (anchor) {
        const target = document.getElementById(anchor.dataset.searchAnchor === 'sources' ? 'searchSourceList' : 'searchSummaryContent');
        if (target) {
          target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        }
        return;
      }
      // 决策 8.6：来源项内联展开“来源说明”，同一时刻只展开一个
      const expand = event.target.closest('[data-search-source-expand]');
      if (expand) {
        const detail = document.getElementById('search-source-detail-' + expand.dataset.searchSourceExpand);
        if (!detail) return;
        const shouldOpen = detail.hidden;
        document.querySelectorAll('#searchSourceList .search-source-detail').forEach(item => { item.hidden = true; });
        document.querySelectorAll('#searchSourceList [data-search-source-expand]').forEach(item => item.setAttribute('aria-expanded', 'false'));
        if (shouldOpen) {
          detail.hidden = false;
          expand.setAttribute('aria-expanded', 'true');
        }
        return;
      }
    });
    document.getElementById('searchMatchesSection')?.addEventListener('click', event => {
      const open = event.target.closest('[data-search-open]');
      if (open) {
        openSearchMatch(open.dataset.searchOpen, open.dataset.searchId, open);
        return;
      }
      const expand = event.target.closest('[data-search-match-expand]');
      if (expand) {
        const key = expand.dataset.searchMatchExpand;
        if (searchMatchExpanded.has(key)) searchMatchExpanded.delete(key);
        else searchMatchExpanded.add(key);
        renderSearchMatches(getSearchMatches(searchState.query), true);
        markSearchConcepts();
      }
    });
    document.getElementById('searchFeedbackSection')?.addEventListener('click', event => {
      const feedback = event.target.closest('[data-search-feedback]');
      if (feedback) setSearchFeedback(feedback.dataset.searchFeedback);
    });
    // 决策 9.8：全站概念联动事件（搜索结果、场景详情、概念详情正文统一委托）
    document.addEventListener('pointerover', event => {
      if (event.pointerType === 'touch') return;
      const trigger = event.target.closest('[data-search-concept]');
      if (trigger) scheduleSearchConceptOpen(trigger);
    });
    document.addEventListener('pointerout', event => {
      const trigger = event.target.closest('[data-search-concept]');
      if (trigger && !trigger.contains(event.relatedTarget)) scheduleSearchConceptClose();
    });
    document.addEventListener('click', event => {
      const trigger = event.target.closest('[data-search-concept]');
      if (!trigger) return;
      event.preventDefault();
      const popover = document.getElementById('searchConceptPopover');
      // 决策 9.8.1：触屏/鼠标第二次点击同一概念词时进入 AI 概念视图
      if (searchConceptTrigger === trigger && popover && !popover.hidden) {
        openGlossaryConcept(trigger.dataset.searchConcept);
        return;
      }
      openSearchConcept(trigger);
    });
    const conceptPopover = document.getElementById('searchConceptPopover');
    conceptPopover?.addEventListener('pointerenter', () => clearTimeout(searchConceptCloseTimer));
    conceptPopover?.addEventListener('pointerleave', scheduleSearchConceptClose);
    document.getElementById('searchConceptClose')?.addEventListener('click', () => closeSearchConcept({ restoreFocus: true }));
    document.getElementById('searchConceptOpen')?.addEventListener('click', event => openGlossaryConcept(event.currentTarget.dataset.term));
    document.getElementById('view-search')?.addEventListener('click', event => {
      const example = event.target.closest('[data-search-example]');
      if (!example) return;
      selectSearchExample(example.dataset.searchExample);
      submitSearchHome(example.dataset.searchExample);
    });
  }

  // 工具库视图切换
  document.getElementById('toolsViewToggle')?.addEventListener('click', function() {
    const mode = toggleToolsViewMode();
    announceStatus('已切换到' + (mode === 'tool' ? '工具' : '厂商') + '视图');
  });

  // 搜索
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    setRegionBusy(document.getElementById('toolGrid'), true);
    searchTimer = setTimeout(renderTools, 150);
    searchClear.style.display = searchInput.value ? 'block' : 'none';
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    renderTools();
    searchInput.focus();
  });

  // 场景搜索
  const sceneSearch = document.getElementById('sceneSearch');
  const sceneSearchClear = document.getElementById('sceneSearchClear');
  let sceneTimer;
  if (sceneSearch) {
    sceneSearch.addEventListener('input', () => {
      clearTimeout(sceneTimer);
      setRegionBusy(document.getElementById('sceneDetail'), true);
      sceneTimer = setTimeout(renderScenes, 150);
      sceneSearchClear.style.display = sceneSearch.value ? 'flex' : 'none';
    });
    sceneSearchClear.addEventListener('click', () => {
      sceneSearch.value = '';
      sceneSearchClear.style.display = 'none';
      renderScenes();
      sceneSearch.focus();
    });
  }

  // 决策 9.4：场景选择器切换与“返回工具库”
  document.getElementById('scenePicker')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-scene-pick]');
    if (!chip) return;
    setActiveSceneId(chip.dataset.scenePick);
    renderScenes();
  });
  document.getElementById('sceneDetail')?.addEventListener('click', event => {
    if (event.target.closest('[data-scene-back-tools]')) switchView('tools');
  });

  // 导航按钮（桌面下拉菜单、移动菜单与页脚）
  document.querySelectorAll('.nav-btn, .mobile-nav [data-view], .footer [data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!btn.dataset.view) return;
      switchView(btn.dataset.view);
    });
  });
  document.getElementById('homeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    switchView('search');
  });

  // 决策 83：桌面分组下拉菜单（点击展开、点击菜单项后关闭、点击外部关闭、不悬停即开）
  document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
    const trigger = dropdown.querySelector('.nav-trigger');
    if (!trigger) return;
    trigger.addEventListener('click', () => {
      const menu = document.getElementById(trigger.getAttribute('aria-controls'));
      if (!menu) return;
      const shouldOpen = menu.hidden;
      closeAllNavDropdowns();
      if (shouldOpen) {
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
    dropdown.addEventListener('click', event => {
      if (event.target.closest('[data-view]')) closeAllNavDropdowns();
    });
  });
  document.addEventListener('click', event => {
    if (event.target.closest('.nav-dropdown')) return;
    closeAllNavDropdowns();
  });

  const menuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mobileNav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => {
      if (mobileNav.hidden) openMobileNav();
      else closeMobileNav();
    });
    document.addEventListener('click', event => {
      if (mobileNav.hidden || mobileNav.contains(event.target) || menuToggle.contains(event.target)) return;
      closeMobileNav();
    });
  }
  syncNavigationState(currentView);

  // 访问筛选
  document.querySelectorAll('.filter-chip[data-access]').forEach(chip => {
    chip.addEventListener('click', function() {
      const controls = [...document.querySelectorAll('.filter-chip[data-access]')];
      setPressedState(controls, this);
      activeFilters.access = this.dataset.access;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 价格筛选
  document.querySelectorAll('.filter-chip[data-price]').forEach(chip => {
    chip.addEventListener('click', function() {
      const controls = [...document.querySelectorAll('.filter-chip[data-price]')];
      setPressedState(controls, this);
      activeFilters.price = this.dataset.price;
      if (currentView !== 'tools') switchView('tools');
      else renderTools();
    });
  });

  // 决策 94：工具库筛选折叠（移动轻量面板）、已选标签一键清除
  // 决策 94：移动筛选面板关闭并回焦触发按钮（支持 Escape / 完成 / 清除全部）
  function closeToolsFilters({ restoreFocus = false } = {}) {
    const panel = document.getElementById('toolsFiltersPanel');
    const toggle = document.getElementById('toolsFilterToggle');
    if (panel) panel.classList.remove('open');
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    }
  }

  document.getElementById('toolsFilterToggle')?.addEventListener('click', function() {
    const panel = document.getElementById('toolsFiltersPanel');
    const open = panel.classList.toggle('open');
    this.setAttribute('aria-expanded', String(open));
    // 决策 94：面板打开后焦点移入面板内第一个可聚焦筛选项，键盘用户不丢失位置
    if (open) {
      const firstChip = panel.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])');
      if (firstChip) firstChip.focus({ preventScroll: true });
    }
  });
  document.getElementById('toolsFilterDone')?.addEventListener('click', () => closeToolsFilters({ restoreFocus: true }));
  document.getElementById('toolsClearFilters')?.addEventListener('click', clearToolFilters);
  document.getElementById('toolsFilterClear')?.addEventListener('click', () => {
    clearToolFilters();
    closeToolsFilters({ restoreFocus: true });
  });

  // 热点公开内容类型筛选与最近/热度排序（决策 74/79：平台属来源核验信息，非列表级筛选）
  const trendingTypeTabs = document.getElementById('trendingTypeTabs');
  trendingTypeTabs?.addEventListener('click', event => {
    const chip = event.target.closest('[data-content-type]');
    if (!chip) return;
    const controls = [...trendingTypeTabs.querySelectorAll('[data-content-type]')];
    setPressedState(controls, chip);
    setRegionBusy(document.getElementById('trendingGrid'), true);
    setActiveTrendingType(chip.dataset.contentType);
    renderTrending();
  });
  // B16 决策 78/85：热点排序（最近/热度）。热度仅在公开投影提供明确热度字段时生效。
  const trendingSortTabs = document.getElementById('trendingSortTabs');
  trendingSortTabs?.addEventListener('click', event => {
    const chip = event.target.closest('[data-trending-sort]');
    if (!chip) return;
    const controls = [...trendingSortTabs.querySelectorAll('[data-trending-sort]')];
    setPressedState(controls, chip);
    setRegionBusy(document.getElementById('trendingGrid'), true);
    setActiveTrendingSort(chip.dataset.trendingSort);
    renderTrending();
  });
  // B16 决策 85：热度定义的低权重信息提示（内联展开，aria-expanded + aria-controls）。
  document.getElementById('trendingSortHelpToggle')?.addEventListener('click', function() {
    const panel = document.getElementById('trendingSortHelp');
    if (!panel) return;
    renderTrendingSortHelp();
    const open = panel.hidden;
    panel.hidden = !open;
    this.setAttribute('aria-expanded', String(!open));
    this.textContent = open ? '收起热度说明' : '热度说明';
  });
  const trendingGrid = document.getElementById('trendingGrid');
  trendingGrid?.addEventListener('click', event => {
    // 决策 80：热点四类空状态的“下一步操作”按钮（清除筛选/重新加载/跳转）
    const emptyAction = event.target.closest('[data-trending-action]');
    if (emptyAction) {
      const action = emptyAction.dataset.trendingAction;
      if (action === 'clear-filters') clearTrendingFilters();
      else if (action === 'reload') reloadHotspots();
      else if (action === 'goto-tools') switchView('tools');
      else if (action === 'goto-about') switchView('about');
      return;
    }
    const sourceToggle = event.target.closest('[data-hotspot-card-source-toggle]');
    if (sourceToggle) {
      const card = sourceToggle.closest('[data-hotspot-id]');
      const detail = card?.querySelector('[data-hotspot-card-source]');
      if (!card || !detail) return;
      const shouldOpen = detail.hidden;
      document.querySelectorAll('#trendingGrid [data-hotspot-card-source]').forEach(item => { item.hidden = true; });
      document.querySelectorAll('#trendingGrid [data-hotspot-card-source-toggle]').forEach(item => {
        item.setAttribute('aria-expanded', 'false');
        item.textContent = '查看来源';
      });
      detail.hidden = !shouldOpen;
      sourceToggle.setAttribute('aria-expanded', String(shouldOpen));
      sourceToggle.textContent = shouldOpen ? '收起来源' : '查看来源';
      return;
    }
    const openDetailButton = event.target.closest('[data-hotspot-open]');
    if (openDetailButton) {
      const card = openDetailButton.closest('[data-hotspot-id]');
      if (card) openHotspotDetail(card.dataset.hotspotId, card);
      return;
    }
    if (event.target.closest('a')) return;
    const card = event.target.closest('[data-hotspot-id]');
    if (card) openHotspotDetail(card.dataset.hotspotId, card);
  });
  trendingGrid?.addEventListener('keydown', event => {
    const card = event.target.closest('[data-hotspot-id]');
    if (!card || event.target.closest('button, a')) return;
    if (!['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    openHotspotDetail(card.dataset.hotspotId, card);
  });

  // 概念词典分类 chip（决策 9.7：委托监听，原 renderGlossary 内绑定迁出至此）
  document.getElementById('glossaryCategories')?.addEventListener('click', event => {
    const chip = event.target.closest('.filter-chip[data-cat]');
    if (!chip) return;
    setActiveGlossaryCategory(chip.dataset.cat);
    renderGlossary();
  });

  // 推荐视图分类 tab（原 renderFeaturedTabs 内绑定迁出至此，按分区设置对应状态）
  document.getElementById('editorPicksTabs')?.addEventListener('click', event => {
    const btn = event.target.closest('.featured-tab');
    if (!btn || !btn.dataset.cat || btn.dataset.cat === activeEditorCat) return;
    setActiveEditorCat(btn.dataset.cat);
    renderFeatured();
  });
  document.getElementById('hotRankingTabs')?.addEventListener('click', event => {
    const btn = event.target.closest('.featured-tab');
    if (!btn || !btn.dataset.cat || btn.dataset.cat === activeHotCat) return;
    setActiveHotCat(btn.dataset.cat);
    renderFeatured();
  });

  // 模态层监听（原模块级绑定迁入 DOMContentLoaded，保持注册顺序）
  document.getElementById('modalOverlay').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });
  document.getElementById('modalOverlay').addEventListener('click', function(event) {
    const related = event.target.closest('[data-hotspot-related-type]');
    if (related) {
      const type = related.dataset.hotspotRelatedType;
      const id = related.dataset.hotspotRelatedId;
      const itemId = related.dataset.hotspotRelatedItem || null;
      closeModal();
      if (type === 'tools') {
        switchView('tools');
        window.requestAnimationFrame(() => openDetail(id, itemId));
      } else if (type === 'concepts') {
        openGlossaryConcept(id);
      } else if (type === 'scenes') {
        const input = document.getElementById('sceneSearch');
        if (input) input.value = '';
        setActiveSceneId(id);
        switchView('scenes');
        window.requestAnimationFrame(() => document.querySelector('.scene-pick-chip[data-scene-pick="' + CSS.escape(id) + '"]')?.focus());
      }
      return;
    }
    const toggle = event.target.closest('[data-hotspot-source-toggle]');
    if (!toggle) return;
    const detail = document.getElementById(toggle.getAttribute('aria-controls'));
    if (!detail) return;
    const expanded = detail.hidden;
    detail.hidden = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? '收起来源' : '查看来源';
  });

  // 决策 92：对比页“添加工具”选择器（委托绑定在 DOMContentLoaded，与模态监听并列）
  document.getElementById('addCompareBtn')?.addEventListener('click', () => openAddComparePanel());
  document.getElementById('modalOverlay').addEventListener('click', event => {
    const cat = event.target.closest('#addCompareCats [data-add-cat]');
    if (cat) {
      const panel = document.getElementById('modalContent');
      panel.dataset.compareCat = cat.dataset.addCat;
      document.querySelectorAll('#addCompareCats [data-add-cat]').forEach(c => {
        c.classList.toggle('active', c === cat);
        c.setAttribute('aria-pressed', String(c === cat));
      });
      renderAddCompare();
      return;
    }
    const pick = event.target.closest('[data-add-pick]');
    if (pick) {
      const before = compareList.length;
      toggleCompareRef(pick.dataset.addPick, pick.dataset.addItem || null);
      if (compareList.length !== before) {
        closeModal();
        if (currentView !== 'compare') switchView('compare');
        else renderCompare();
      } else {
        renderAddCompare();
      }
      return;
    }
  });
  document.getElementById('modalOverlay').addEventListener('input', event => {
    if (event.target.id === 'addCompareSearch') renderAddCompare();
  });

  // 模态焦点陷阱（Tab 循环 + Escape 关闭）
  document.addEventListener('keydown', function(e) {
    const overlay = document.getElementById('modalOverlay');
    if (!overlay || overlay.hidden) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeModal();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = getModalFocusableElements();
    if (!focusable.length) {
      e.preventDefault();
      document.getElementById('modalContent').focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // 键盘快捷键
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && !document.getElementById('searchConceptPopover')?.hidden) {
      e.preventDefault();
      closeSearchConcept({ restoreFocus: true });
      return;
    }
    if (e.key === 'Escape' && mobileNav && !mobileNav.hidden) {
      e.preventDefault();
      closeMobileNav({ restoreFocus: true });
      return;
    }
    // 决策 94：移动筛选面板打开时，Escape 关闭并回焦筛选按钮
    if (e.key === 'Escape' && document.getElementById('toolsFiltersPanel')?.classList.contains('open')) {
      e.preventDefault();
      closeToolsFilters({ restoreFocus: true });
      return;
    }
    if (e.key === 'Escape' && document.querySelector('.nav-dropdown-menu:not([hidden])')) {
      e.preventDefault();
      const openTrigger = document.querySelector('.nav-dropdown .nav-trigger[aria-expanded="true"]');
      closeAllNavDropdowns();
      openTrigger?.focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      const targetInput = currentView === 'tools'
        ? document.getElementById('searchInput')
        : currentView === 'search'
          ? searchState.mode === 'results'
            ? searchState.editing
              ? document.getElementById('searchEditInput')
              : null
            : document.getElementById('aiSearchInput')
          : null;
      if (!targetInput || targetInput.disabled) return;
      e.preventDefault();
      targetInput.focus();
    }
  });

  // 概念词典搜索
  const glossarySearch = document.getElementById('glossarySearch');
  const glossarySearchClear = document.getElementById('glossarySearchClear');
  let glossaryTimer;
  if (glossarySearch) {
    glossarySearch.addEventListener('input', () => {
      clearTimeout(glossaryTimer);
      setRegionBusy(document.getElementById('glossaryDetail'), true);
      glossaryTimer = setTimeout(renderGlossary, 150);
      glossarySearchClear.style.display = glossarySearch.value ? 'block' : 'none';
    });
    glossarySearchClear.addEventListener('click', () => {
      glossarySearch.value = '';
      glossarySearchClear.style.display = 'none';
      renderGlossary();
      glossarySearch.focus();
    });
  }

  // 决策 9.7：概念索引点击切换详情
  document.getElementById('glossaryIndexList')?.addEventListener('click', event => {
    const item = event.target.closest('[data-glossary-pick]');
    if (!item) return;
    setActiveGlossaryId(item.dataset.glossaryPick);
    renderGlossary();
  });
});

export { currentView, switchView };
