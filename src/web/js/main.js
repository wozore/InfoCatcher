/**
 * 知览 KnowView MVP — 浏览器端应用逻辑入口
 * 负责应用初始化、路由调度与全局事件编排。
 */

import { loadData, renderSkeletons } from './data-loader.js';
import { state, setViewChangeHandler, onCompareChange } from './state.js';
import { announceStatus, setRegionBusy, copyTextWithFeedback } from './ui-helpers.js';
import { renderTools, openDetail, closeModal, clearToolFilters, toggleToolsViewMode, getModalFocusableElements } from './tools.js';
import {
  updateCompareCount, renderCompare, renderCompareView, setCompareTab,
  toggleCompareRef, renderAddCompare, openAddComparePanel,
  compareGroupLeaves, removeCompare, quickCompare
} from './compare.js';
import { bindModelCompareEvents } from './compare-models.js';
import { renderScenes, setActiveSceneId, toggleSceneToolCard } from './scenes.js';
import { renderTrending, clearTrendingFilters, reloadHotspots, openHotspotDetail } from './trending.js';
import { renderGlossary, openGlossaryConcept, setActiveGlossaryId } from './glossary.js';
import { applyStaticTranslations } from './i18n.js';
import { loadIcons } from './brand-icons.js';
import { renderFeatured, setActiveEditorCat, setActiveHotCat } from './featured.js';
import {
  searchState, renderSearchHome, renderSearchProcessing, renderSearchView,
  submitSearchHome, clearSearchHomeStates, cancelSearchProcessing, returnToSearchHome,
  startSearchEditing, cancelSearchEditing, submitSearchEdit, clearSearchEditState,
  selectSearchExample, openSearchToolDetail, openSearchMoreTools
} from './search.js';
import {
  focusSearchSource, setSearchFeedback, closeSearchConcept, openSearchConcept,
  scheduleSearchConceptOpen, scheduleSearchConceptClose
} from './search-render.js';

export let currentView = 'search';

const VIEW_TITLES = {
  search: 'AI 搜索', tools: '工具库', scenes: '场景', compare: '对比',
  trending: 'AI 热点', featured: '编辑精选', glossary: 'AI 概念', about: '关于'
};

const VIEW_GROUPS = {
  discover: ['tools', 'scenes', 'compare', 'featured'],
  knowledge: ['trending', 'glossary']
};

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
  const first = mobileNav.querySelector('button, a[href], [tabindex]:not([tabindex="-1"])');
  if (first) first.focus({ preventScroll: true });
}

function closeAllNavDropdowns() {
  document.querySelectorAll('.nav-dropdown-menu').forEach(m => { m.hidden = true; });
  document.querySelectorAll('.nav-dropdown .nav-trigger').forEach(t => t.setAttribute('aria-expanded', 'false'));
}

function syncNavigationState(view) {
  document.querySelectorAll('[data-view]').forEach(c => {
    const isAct = c.dataset.view === view;
    c.classList.toggle('active', isAct);
    if (isAct) c.setAttribute('aria-current', 'page');
    else c.removeAttribute('aria-current');
  });
  document.querySelectorAll('.nav-dropdown').forEach(d => {
    const trigger = d.querySelector('.nav-trigger');
    if (trigger) trigger.classList.toggle('active', Boolean(VIEW_GROUPS[d.dataset.group]?.includes(view)));
  });
}

export function switchView(view) {
  const target = document.getElementById('view-' + view);
  if (!target) return;
  const mobileNav = document.getElementById('mobileNav');
  const fromMobile = Boolean(mobileNav && !mobileNav.hidden && mobileNav.contains(document.activeElement));
  currentView = view;
  state.currentView = view;
  const titleEl = document.getElementById('mobileCurrentPage');
  if (titleEl && VIEW_TITLES[view]) titleEl.textContent = VIEW_TITLES[view];
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  target.classList.add('active');
  syncNavigationState(view);
  closeMobileNav();
  announceStatus((target.querySelector('h1')?.textContent || '页面') + '已显示');

  if (view === 'scenes') renderScenes();
  if (view === 'compare') renderCompareView();
  if (view === 'tools') renderTools();
  if (view === 'glossary') renderGlossary();
  if (view === 'trending') renderTrending();
  if (view === 'featured') renderFeatured();

  if (fromMobile) {
    const h = target.querySelector('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
}

setViewChangeHandler(switchView);

if (typeof window !== 'undefined') {
  window.openDetail = openDetail;
  window.closeModal = closeModal;
  window.toggleCompareRef = toggleCompareRef;
  window.compareGroupLeaves = compareGroupLeaves;
  window.removeCompare = removeCompare;
  window.quickCompare = quickCompare;
  window.toggleSceneToolCard = toggleSceneToolCard;
  window.openAddComparePanel = openAddComparePanel;
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', async () => {
  applyStaticTranslations();
  renderSkeletons();
  await Promise.all([loadData(), loadIcons()]);
  renderTools();
  renderScenes();
  updateCompareCount();
  renderTrending();
  renderSearchHome();
  renderSearchProcessing();
  renderSearchView();
  document.getElementById('app').setAttribute('aria-busy', 'false');
  announceStatus('静态资料加载完成');

  // 搜索事件
  const aiSearchForm = document.getElementById('aiSearchShellForm');
  const aiSearchInput = document.getElementById('aiSearchInput');
  if (aiSearchForm && aiSearchInput) {
    aiSearchForm.addEventListener('submit', e => { e.preventDefault(); submitSearchHome(aiSearchInput.value); });
    aiSearchInput.addEventListener('input', clearSearchHomeStates);
    document.getElementById('searchCancelProcessing')?.addEventListener('click', cancelSearchProcessing);
    document.getElementById('searchBackButton')?.addEventListener('click', returnToSearchHome);
    document.getElementById('searchEditButton')?.addEventListener('click', startSearchEditing);
    document.getElementById('searchEditCancel')?.addEventListener('click', cancelSearchEditing);
    document.getElementById('searchCopyQuery')?.addEventListener('click', () => {
      const q = searchState.query || '';
      if (!q) { announceStatus('暂无可复制的查询'); return; }
      copyTextWithFeedback(document.getElementById('searchCopyQuery'), q, '查询');
    });
    document.getElementById('searchCopySummary')?.addEventListener('click', () => {
      const s = document.getElementById('searchSummaryContent')?.innerText?.trim() || '';
      if (!s) { announceStatus('暂无可复制的摘要'); return; }
      copyTextWithFeedback(document.getElementById('searchCopySummary'), s, '摘要');
    });
    const editForm = document.getElementById('searchEditForm');
    const editInput = document.getElementById('searchEditInput');
    editForm?.addEventListener('submit', e => { e.preventDefault(); submitSearchEdit(editInput?.value); });
    editInput?.addEventListener('input', clearSearchEditState);
    editInput?.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); cancelSearchEditing(); } });
    document.getElementById('searchResultContent')?.addEventListener('click', event => {
      const c = event.target.closest('[data-search-citation]');
      if (c) { focusSearchSource(c.dataset.searchCitation, c); return; }
      if (event.target.closest('a') || event.target.closest('[data-search-concept]')) return;
      const tc = event.target.closest('[data-search-tool]');
      if (tc) { openSearchToolDetail(tc.dataset.searchTool, tc); return; }
      const more = event.target.closest('[data-search-more-tools]');
      if (more) { openSearchMoreTools(); return; }
      const hs = event.target.closest('[data-hotspot-id]');
      if (hs) { openHotspotDetail(hs.dataset.hotspotId, hs); return; }
      const cr = event.target.closest('[data-search-concept-rail]');
      if (cr) { openGlossaryConcept(cr.dataset.searchConceptRail); return; }
    });
    document.getElementById('searchFeedbackSection')?.addEventListener('click', event => {
      const fb = event.target.closest('[data-search-feedback]');
      if (fb) setSearchFeedback(fb.dataset.searchFeedback, searchState);
    });
  }

  // 概念联动
  document.addEventListener('pointerover', event => {
    if (event.pointerType === 'touch') return;
    const t = event.target.closest('[data-search-concept]');
    if (t) scheduleSearchConceptOpen(t);
    else if (!event.target.closest('#searchConceptPopover')) scheduleSearchConceptClose();
  });
  document.addEventListener('click', event => {
    const t = event.target.closest('[data-search-concept]');
    if (t) {
      if (window.innerWidth <= 768) openGlossaryConcept(t.dataset.searchConcept);
      else openSearchConcept(t);
      return;
    }
    if (!event.target.closest('#searchConceptPopover')) closeSearchConcept();
    const ex = event.target.closest('[data-search-example]');
    if (ex) selectSearchExample(ex.dataset.searchExample);
  });
  document.getElementById('searchConceptOpen')?.addEventListener('click', e => openGlossaryConcept(e.currentTarget.dataset.term));
  document.getElementById('searchConceptClose')?.addEventListener('click', () => closeSearchConcept({ restoreFocus: true }));

  // 工具库
  document.getElementById('toolsViewToggle')?.addEventListener('click', () => {
    const m = toggleToolsViewMode();
    announceStatus('已切换到' + (m === 'tool' ? '工具' : '厂商') + '视图');
  });
  const searchInput = document.getElementById('searchInput');
  const searchClear = document.getElementById('searchClear');
  let sTimer;
  searchInput?.addEventListener('input', () => {
    clearTimeout(sTimer);
    setRegionBusy(document.getElementById('toolGrid'), true);
    sTimer = setTimeout(renderTools, 150);
    if (searchClear) searchClear.style.display = searchInput.value ? 'block' : 'none';
  });
  searchClear?.addEventListener('click', () => {
    if (searchInput) searchInput.value = '';
    searchClear.style.display = 'none';
    renderTools();
    searchInput?.focus();
  });

  // 场景
  const scSearch = document.getElementById('sceneSearch');
  const scClear = document.getElementById('sceneSearchClear');
  let scTimer;
  if (scSearch) {
    scSearch.addEventListener('input', () => {
      clearTimeout(scTimer);
      setRegionBusy(document.getElementById('sceneDetail'), true);
      scTimer = setTimeout(renderScenes, 150);
      if (scClear) scClear.style.display = scSearch.value ? 'flex' : 'none';
    });
    scClear?.addEventListener('click', () => {
      scSearch.value = ''; scClear.style.display = 'none'; renderScenes(); scSearch.focus();
    });
  }
  document.getElementById('scenePicker')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-scene-pick]');
    if (chip) { setActiveSceneId(chip.dataset.scenePick); renderScenes(); }
  });
  document.getElementById('sceneDetail')?.addEventListener('click', e => {
    if (e.target.closest('[data-scene-back-tools]')) switchView('tools');
  });

  // 导航
  document.querySelectorAll('.nav-btn, .mobile-nav [data-view], .footer [data-view]').forEach(btn => {
    btn.addEventListener('click', () => { if (btn.dataset.view) switchView(btn.dataset.view); });
  });
  document.getElementById('homeBtn')?.addEventListener('click', e => { e.preventDefault(); switchView('search'); });
  document.querySelectorAll('.nav-dropdown').forEach(dropdown => {
    const t = dropdown.querySelector('.nav-trigger');
    if (!t) return;
    t.addEventListener('click', () => {
      const menu = document.getElementById(t.getAttribute('aria-controls'));
      if (!menu) return;
      const shouldOpen = menu.hidden;
      closeAllNavDropdowns();
      if (shouldOpen) { menu.hidden = false; t.setAttribute('aria-expanded', 'true'); }
    });
    dropdown.addEventListener('click', e => { if (e.target.closest('[data-view]')) closeAllNavDropdowns(); });
  });
  document.addEventListener('click', e => { if (!e.target.closest('.nav-dropdown')) closeAllNavDropdowns(); });
  const menuToggle = document.getElementById('menuToggle');
  const mobileNav = document.getElementById('mobileNav');
  if (menuToggle && mobileNav) {
    menuToggle.addEventListener('click', () => { if (mobileNav.hidden) openMobileNav(); else closeMobileNav(); });
    document.addEventListener('click', e => {
      if (!mobileNav.hidden && !mobileNav.contains(e.target) && !menuToggle.contains(e.target)) closeMobileNav();
    });
  }

  // 筛选与对比
  document.querySelectorAll('.tools-filters').forEach(bar => {
    bar.addEventListener('click', event => {
      const chip = event.target.closest('.filter-chip');
      if (!chip) return;
      const group = chip.closest('[data-filter-group]');
      const filterType = group?.dataset.filterGroup;
      const value = chip.dataset.access || chip.dataset.price;
      if (filterType && value) {
        state.activeFilters[filterType] = value;
        group.querySelectorAll('.filter-chip').forEach(c => {
          c.classList.toggle('active', c === chip); c.setAttribute('aria-pressed', String(c === chip));
        });
        renderTools();
      }
    });
  });
  document.getElementById('toolsClearSelected')?.addEventListener('click', clearToolFilters);
  document.getElementById('addCompareBtn')?.addEventListener('click', () => openAddComparePanel());
  document.getElementById('compareTabModel')?.addEventListener('click', () => setCompareTab('model'));
  document.getElementById('compareTabTool')?.addEventListener('click', () => setCompareTab('tool'));
  bindModelCompareEvents();
  onCompareChange(() => updateCompareCount());
  window.addEventListener('compare-models:change', () => renderTools());

  // 热点
  document.getElementById('trendingContent')?.addEventListener('click', event => {
    const b = event.target.closest('[data-trending-action]');
    if (!b) return;
    const act = b.dataset.trendingAction;
    if (act === 'reload') reloadHotspots();
    else if (act === 'clear-filters') clearTrendingFilters();
    else if (act === 'goto-tools') switchView('tools');
    else if (act === 'goto-about') switchView('about');
  });
  document.getElementById('trendingTypeTabs')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-content-type]');
    if (chip) {
      state.activeTrendingType = chip.dataset.contentType;
      chip.parentElement.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c === chip));
      renderTrending();
    }
  });

  // 精选 & 概念
  document.getElementById('editorPicksTabs')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-cat]');
    if (chip) { setActiveEditorCat(chip.dataset.cat); renderFeatured(); }
  });
  document.getElementById('hotRankingTabs')?.addEventListener('click', event => {
    const chip = event.target.closest('[data-cat]');
    if (chip) { setActiveHotCat(chip.dataset.cat); renderFeatured(); }
  });
  const glSearch = document.getElementById('glossarySearch');
  const glClear = document.getElementById('glossarySearchClear');
  let glTimer;
  glSearch?.addEventListener('input', () => {
    clearTimeout(glTimer);
    setRegionBusy(document.getElementById('glossaryDetail'), true);
    glTimer = setTimeout(renderGlossary, 150);
    if (glClear) glClear.style.display = glSearch.value ? 'block' : 'none';
  });
  glClear?.addEventListener('click', () => {
    if (glSearch) glSearch.value = '';
    glClear.style.display = 'none';
    renderGlossary();
    glSearch?.focus();
  });
  document.getElementById('glossaryIndexList')?.addEventListener('click', event => {
    const item = event.target.closest('[data-glossary-pick]');
    if (item) { setActiveGlossaryId(item.dataset.glossaryPick); renderGlossary(); }
  });

  // 快捷键
  document.addEventListener('keydown', e => {
    const overlay = document.getElementById('modalOverlay');
    if (overlay && !overlay.hidden) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
      if (e.key === 'Tab') {
        const focusable = getModalFocusableElements();
        if (!focusable.length) { e.preventDefault(); document.getElementById('modalContent')?.focus(); return; }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
      return;
    }
    if (e.key === 'Escape') {
      if (!document.getElementById('searchConceptPopover')?.hidden) { e.preventDefault(); closeSearchConcept({ restoreFocus: true }); return; }
      if (mobileNav && !mobileNav.hidden) { e.preventDefault(); closeMobileNav({ restoreFocus: true }); return; }
      if (document.querySelector('.nav-dropdown-menu:not([hidden])')) { e.preventDefault(); closeAllNavDropdowns(); return; }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      const target = currentView === 'tools'
        ? document.getElementById('searchInput')
        : currentView === 'search'
          ? (searchState.mode === 'results' ? (searchState.editing ? document.getElementById('searchEditInput') : null) : document.getElementById('aiSearchInput'))
          : null;
      if (target && !target.disabled) { e.preventDefault(); target.focus(); }
    }
  });
});
}
