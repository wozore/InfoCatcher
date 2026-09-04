/**
 * state.js — 前端全站共享状态中心与事件总线
 * 解除 main ↔ views 及各视图间的循环依赖。
 */

export const state = {
  currentView: 'search',
  compareTab: 'model',
  compareList: [],
  tools: [],
  glossary: [],
  scenes: [],
  hotspots: { items: [], coverage: null, generated_at: null },
  featuredPicks: [],
  activeFilters: { access: 'all', price: 'all' },
  activeGlossaryCategory: 'all',
  activeTrendingType: 'all',
  activeTrendingSort: 'recent',
  activeGlossaryId: null,
  activeSceneId: null,
  activeEditorCat: 'all',
  activeHotCat: 'all',
};

export const dataLoadFailures = new Set();

let viewChangeHandler = null;

export function setViewChangeHandler(fn) {
  viewChangeHandler = fn;
}

export function switchView(view) {
  if (viewChangeHandler) {
    viewChangeHandler(view);
  }
}

export function getCurrentView() {
  return state.currentView;
}

const compareListeners = new Set();

export function onCompareChange(fn) {
  compareListeners.add(fn);
  return () => compareListeners.delete(fn);
}

export function notifyCompareChange() {
  for (const listener of compareListeners) {
    listener();
  }
}

let conceptNavigator = null;

export function setConceptNavigator(fn) {
  conceptNavigator = fn;
}

export function navigateToConcept(term) {
  if (conceptNavigator) {
    conceptNavigator(term);
  }
}
