import { API_ROOT, tokenFromFragment, request, revisionFrom, listFrom } from './api.js';
import {
  state,
  $,
  text,
  clearChildren,
  addText,
  setLoadState,
  showNotice,
  clearNotice,
  updateRevisionNote,
} from './state.js';
import { loadResource } from './panels/common.js';
import { renderOverview, updateWorkspaceClearState, setupOverviewPanel } from './panels/overview-panel.js';
import { loadNewsReview, setupNewsPanel } from './panels/news-panel.js';
import { loadKeywords, setupKeywordsPanel } from './panels/keywords-panel.js';
import { loadTopAndTranscripts, loadPreview, setupTopPanel } from './panels/top-panel.js';
import { renderPendingCards, setupKnowledgePanel } from './panels/knowledge-panel.js';
import { renderCatalogDrafts, setupCatalogPanel } from './panels/catalog-panel.js';
import { renderConcepts, renderKnowledgeConceptPreview, setupConceptPanel } from './panels/concept-panel.js';
import { renderToolUpdates, setupToolUpdatePanel } from './panels/tool-update-panel.js';

export async function loadOverview() {
  setLoadState('overviewState', '加载中…', 'loading');
  try {
    const payload = await request('overview');
    const revision = revisionFrom(payload);
    if (revision) state.revisions.overview = revision;
    renderOverview(payload);
    updateWorkspaceClearState(payload?.workspace);
    setLoadState('overviewState', '已加载', 'success');
    updateRevisionNote();
  } catch (error) {
    updateWorkspaceClearState(null);
    setLoadState('overviewState', '加载失败', 'error');
    showNotice('待办概览加载失败。', 'error');
  }
}

export async function loadKnowledgeLoop() {
  setLoadState('knowledgeLoopState', '加载中…', 'loading');
  try {
    const [toolsPayload, conceptsPayload, draftsPayload] = await Promise.all([
      request('feedback/tools'),
      request('feedback/concepts'),
      request('catalog/drafts'),
    ]);
    state.revisions.pendingTools = revisionFrom(toolsPayload);
    state.revisions.pendingConcepts = revisionFrom(conceptsPayload);
    renderPendingCards('tools', toolsPayload, refreshAll);
    renderPendingCards('concepts', conceptsPayload, refreshAll);
    renderCatalogDrafts(draftsPayload, refreshAll);
    state.catalogBatch = null;
    clearChildren($('#catalogBatchPreview'));
    addText($('#catalogBatchPreview'), 'p', '准备 Draft 后，可预览整批变更。', 'muted');
    const batchBtn = $('#catalogBatchPreviewButton');
    if (batchBtn) batchBtn.disabled = !state.catalogDrafts.length;
    const applyBtn = $('#catalogApplyButton');
    if (applyBtn) applyBtn.disabled = true;
    setLoadState('knowledgeLoopState', '已加载', 'success');
    updateRevisionNote();
    const source = $('#knowledgeSourceStats');
    if (source) {
      source.textContent = `来源统计：新闻 revision ${text(state.revisions.news || '未加载')}；工具待补 ${state.items.pendingTools.length}；概念待补 ${state.items.pendingConcepts.length}`;
    }
  } catch (error) {
    setLoadState('knowledgeLoopState', '加载失败', 'error');
    showNotice('知识闭环数据加载失败。', 'error');
  }
}

export async function loadConceptPreviewLoop() {
  try {
    renderKnowledgeConceptPreview(await request('concepts/preview'));
  } catch (_) {}
}

export async function refreshAllNow() {
  clearNotice();
  const refreshButton = $('#refreshButton');
  const originalLabel = refreshButton?.textContent || '刷新数据';
  if (refreshButton) {
    refreshButton.textContent = '刷新中…';
    refreshButton.disabled = true;
  }
  try {
    await Promise.all([
      loadOverview(),
      loadNewsReview(refreshAll),
      loadKeywords(),
      loadTopAndTranscripts(refreshAll),
      loadResource('toolUpdates', 'tool-updates', (payload) => renderToolUpdates(payload, refreshAll), { rootId: 'toolUpdatesList', stateId: 'toolUpdatesState' }),
      loadResource('concepts', 'concepts/preview', (payload) => renderConcepts(listFrom(payload, ['items', 'previews', 'concepts'])), { rootId: 'conceptsList', stateId: 'conceptsState' }),
      loadKnowledgeLoop(),
      loadConceptPreviewLoop(),
      loadPreview(),
    ]);
  } finally {
    if (refreshButton) {
      refreshButton.textContent = originalLabel;
      refreshButton.disabled = false;
    }
  }
}

export function refreshAll() {
  const queued = state.refreshTail.then(refreshAllNow, refreshAllNow);
  state.refreshTail = queued.catch(() => {});
  return queued;
}

export function start() {
  setupOverviewPanel(refreshAll);
  setupNewsPanel(refreshAll);
  setupKeywordsPanel(refreshAll);
  setupTopPanel(refreshAll);
  setupKnowledgePanel(refreshAll);
  setupCatalogPanel(refreshAll);
  setupConceptPanel(refreshAll);
  setupToolUpdatePanel(refreshAll);

  const refreshButton = $('#refreshButton');
  if (refreshButton) refreshButton.addEventListener('click', refreshAll);

  if (!state.token) {
    const tokenGate = $('#tokenGate');
    if (tokenGate) tokenGate.hidden = false;
    const appNotice = $('#appNotice');
    if (appNotice) appNotice.hidden = false;
    showNotice('缺少 token，未发起 API 请求。', 'error');
    return;
  }
  refreshAll();
}

window.addEventListener('DOMContentLoaded', start, { once: true });
window.KnowViewMaintainerWorkbench = Object.freeze({ API_ROOT, tokenFromFragment });
