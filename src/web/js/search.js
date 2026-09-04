/**
 * search.js — AI 搜索视图编排与交互状态机
 * 编排首页、处理中动画与结果展示，输入事件与历史记录管理。
 */

import { switchView } from './state.js';
import { announceStatus } from './ui-helpers.js';
import { openDetail, setToolsViewMode, clearToolFilters } from './tools.js';
import { getSearchMatches } from './search-index.js';
import {
  renderSearchHome as renderHome,
  renderSearchResults,
  renderSearchProcessing as renderProcessing,
} from './search-render.js';

const SEARCH_PROCESSING_STAGES = Object.freeze([
  '正在整理你的问题',
  '匹配已收录资料',
  '准备示例摘要'
]);

let searchProcessingRun = 0;
let searchProcessingTimer = null;

export const searchState = {
  mode: 'home',
  query: '',
  demoKey: null,
  processing: false,
  processingStage: null,
  recent: [],
  feedback: null,
  editing: false,
  lastQuery: null
};

export function renderSearchHome() {
  renderHome();
}

export function clearSearchHomeStates() {
  const input = document.getElementById('aiSearchInput');
  const emptyState = document.getElementById('searchEmptyState');
  const unsupportedState = document.getElementById('searchUnsupportedState');
  const status = document.getElementById('searchFormStatus');
  if (input) input.setAttribute('aria-invalid', 'false');
  if (emptyState) emptyState.hidden = true;
  if (unsupportedState) unsupportedState.hidden = true;
  if (status) status.textContent = '';
}

export function selectSearchExample(query) {
  const input = document.getElementById('aiSearchInput');
  if (input) input.value = query;
  clearSearchHomeStates();
  submitSearchHome(query);
}

export function openSearchToolDetail(id, trigger) {
  openDetail(id, null, trigger || null);
}

export function openSearchMoreTools() {
  const input = document.getElementById('searchInput');
  if (input) input.value = searchState.query;
  const clear = document.getElementById('searchClear');
  if (clear && searchState.query) clear.style.display = 'block';
  clearToolFilters();
  setToolsViewMode('tool');
  switchView('tools');
  announceStatus('已跳转到工具库，并按「' + searchState.query + '」过滤');
}

export function renderSearchView() {
  const home = document.getElementById('searchHomePanel');
  const results = document.getElementById('searchResultsPanel');
  const queryTitle = document.getElementById('searchResultQuery');
  const readonly = document.getElementById('searchQueryReadonly');
  const editForm = document.getElementById('searchEditForm');
  const editInput = document.getElementById('searchEditInput');
  if (!home || !results || !queryTitle || !readonly || !editForm || !editInput) return;

  const showingResults = searchState.mode === 'results';
  home.hidden = showingResults;
  results.hidden = !showingResults;
  queryTitle.textContent = searchState.query;
  readonly.hidden = searchState.editing;
  editForm.hidden = !searchState.editing;
  if (searchState.editing) editInput.value = searchState.query;
  if (showingResults) renderSearchResults(searchState.query, searchState);
}

function showSearchResults() {
  searchState.mode = 'results';
  searchState.editing = false;
  renderSearchView();
  document.getElementById('searchResultQuery')?.focus?.();
  announceStatus('静态资料整理完成，正在查看当前问题。');
}

export function returnToSearchHome() {
  resetSearchProcessing();
  searchState.mode = 'home';
  searchState.editing = false;
  const input = document.getElementById('aiSearchInput');
  if (input) input.value = searchState.query;
  renderSearchView();
  clearSearchEditState();
  input?.focus();
}

export function clearSearchEditState() {
  const input = document.getElementById('searchEditInput');
  const status = document.getElementById('searchEditStatus');
  if (input) input.setAttribute('aria-invalid', 'false');
  if (status) status.textContent = '';
}

export function startSearchEditing() {
  searchState.editing = true;
  clearSearchEditState();
  renderSearchView();
  const input = document.getElementById('searchEditInput');
  input?.focus();
  input?.select();
}

export function cancelSearchEditing() {
  searchState.editing = false;
  clearSearchEditState();
  renderSearchView();
  document.getElementById('searchEditButton')?.focus();
}

export function submitSearchEdit(query) {
  const normalizedQuery = String(query || '').trim();
  const input = document.getElementById('searchEditInput');
  const status = document.getElementById('searchEditStatus');
  clearSearchEditState();

  if (!normalizedQuery) {
    input?.setAttribute('aria-invalid', 'true');
    if (status) status.textContent = '请输入问题后再重新整理。';
    input?.focus();
    return false;
  }

  const matches = getSearchMatches(normalizedQuery);
  if (!matches.demoKey) {
    input?.setAttribute('aria-invalid', 'true');
    if (status) status.textContent = '暂无匹配的场景或工具资料，请换用论文、代码、配图、视频等关键词。';
    input?.focus();
    return false;
  }

  searchState.query = normalizedQuery;
  searchState.demoKey = matches.demoKey;
  searchState.mode = 'home';
  searchState.editing = false;
  searchState.feedback = null;
  searchState.recent = [{ query: normalizedQuery, ts: Date.now() }, ...searchState.recent.filter(item => item.query !== normalizedQuery)].slice(0, 3);
  const homeInput = document.getElementById('aiSearchInput');
  if (homeInput) homeInput.value = normalizedQuery;
  renderSearchHome();
  renderSearchView();
  startSearchProcessing();
  return true;
}

export function renderSearchProcessing() {
  renderProcessing(searchState);
}

function finishSearchProcessing(runId) {
  if (runId !== searchProcessingRun || !searchState.processing) return;
  searchState.processing = false;
  searchState.processingStage = SEARCH_PROCESSING_STAGES.length - 1;
  searchState.lastQuery = searchState.query;
  renderSearchProcessing();
  const status = document.getElementById('searchFormStatus');
  if (status) status.textContent = '静态资料已整理完成，正在打开当前问题。';
  window.setTimeout(() => {
    if (runId === searchProcessingRun && !searchState.processing) showSearchResults();
  }, 0);
}

function startSearchProcessing() {
  const runId = ++searchProcessingRun;
  clearTimeout(searchProcessingTimer);
  searchState.processing = true;
  searchState.processingStage = 0;
  renderSearchProcessing();

  const status = document.getElementById('searchFormStatus');
  if (status) status.textContent = '正在整理固定静态示例。';

  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) {
    searchState.processingStage = SEARCH_PROCESSING_STAGES.length - 1;
    finishSearchProcessing(runId);
    return;
  }

  if (searchState.lastQuery === searchState.query) {
    searchState.processingStage = SEARCH_PROCESSING_STAGES.length - 1;
    finishSearchProcessing(runId);
    return;
  }

  const advance = () => {
    if (runId !== searchProcessingRun || !searchState.processing) return;
    if (searchState.processingStage >= SEARCH_PROCESSING_STAGES.length - 1) {
      finishSearchProcessing(runId);
      return;
    }
    searchState.processingStage += 1;
    renderSearchProcessing();
    searchProcessingTimer = window.setTimeout(advance, 450);
  };
  searchProcessingTimer = window.setTimeout(advance, 450);
}

function resetSearchProcessing() {
  searchProcessingRun += 1;
  clearTimeout(searchProcessingTimer);
  searchProcessingTimer = null;
  searchState.processing = false;
  searchState.processingStage = null;
  renderSearchProcessing();
}

export function cancelSearchProcessing() {
  if (!searchState.processing) return;
  resetSearchProcessing();
  const status = document.getElementById('searchFormStatus');
  if (status) status.textContent = '已中止静态资料整理，可以修改问题或重新开始。';
  document.getElementById('aiSearchInput')?.focus();
}

export function submitSearchHome(query) {
  const normalizedQuery = String(query || '').trim();
  const input = document.getElementById('aiSearchInput');
  const status = document.getElementById('searchFormStatus');
  const emptyState = document.getElementById('searchEmptyState');
  const unsupportedState = document.getElementById('searchUnsupportedState');
  clearSearchHomeStates();

  if (!normalizedQuery) {
    resetSearchProcessing();
    input?.setAttribute('aria-invalid', 'true');
    if (emptyState) emptyState.hidden = false;
    if (status) status.textContent = '请输入问题后再搜索。';
    input?.focus();
    return false;
  }

  const matches = getSearchMatches(normalizedQuery);
  searchState.query = normalizedQuery;
  searchState.demoKey = matches.demoKey;
  searchState.mode = 'home';

  if (!matches.demoKey) {
    resetSearchProcessing();
    if (unsupportedState) unsupportedState.hidden = false;
    if (status) status.textContent = '暂无匹配的场景或工具资料，请换用论文、代码、配图、视频等关键词。';
    return false;
  }

  searchState.feedback = null;
  searchState.recent = [{ query: normalizedQuery, ts: Date.now() }, ...searchState.recent.filter(item => item.query !== normalizedQuery)].slice(0, 3);
  renderSearchHome();
  startSearchProcessing();
  return true;
}
