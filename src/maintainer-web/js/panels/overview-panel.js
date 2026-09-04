import { request, unwrap, countFrom, ApiError } from '../api.js';
import {
  state,
  $,
  first,
  addText,
  clearChildren,
  showNotice,
} from '../state.js';

export function updateWorkspaceClearState(workspace) {
  const button = $('#clearWorkbenchButton');
  const stateNode = $('#workspaceClearState');
  if (!button || !stateNode) return;
  const clearable = workspace?.clearable === true;
  button.disabled = !clearable;
  if (clearable) {
    stateNode.textContent = '全部审核已完成，可清空';
    stateNode.dataset.state = 'success';
    stateNode.title = '仅清理临时审核工作区，不删除正式知识库和历史记录。';
    return;
  }
  const blockers = Array.isArray(workspace?.blockers) ? workspace.blockers : [];
  stateNode.textContent = blockers.length ? `不可清空：${blockers[0].message}${blockers.length > 1 ? `（另有 ${blockers.length - 1} 项）` : ''}` : '等待完成态';
  stateNode.dataset.state = blockers.length ? 'warning' : 'loading';
  stateNode.title = blockers.map(item => item.message).join('；') || '请先刷新数据。';
}

export function renderOverview(payload) {
  const root = $('#overviewCards');
  clearChildren(root);
  const data = unwrap(payload) || {};
  const cards = [
    { label: '新闻首审', keys: ['news_pending', 'pending_news', 'news'], fallback: state.items.news.length, tone: 'attention' },
    { label: '关键词候选', keys: ['keyword_candidates', 'keywords_pending', 'keywords'], fallback: state.items.keywords.length, tone: 'attention' },
    { label: 'Top 待选', keys: ['top_candidates', 'top_pending', 'top'], fallback: state.items.top.length, tone: 'ready' },
    { label: '工具更新', keys: ['tool_updates_pending', 'updates_pending', 'tool_updates'], fallback: state.items.toolUpdates.length, tone: 'attention' },
  ];
  for (const card of cards) {
    const element = document.createElement('article');
    element.className = 'overview-card';
    element.dataset.tone = card.tone;
    const number = countFrom(data, card.keys);
    addText(element, 'span', number === null ? card.fallback : number, 'value');
    addText(element, 'span', card.label, 'label');
    const detail = first(data, [`${card.keys[0]}_detail`, `${card.keys[0]}_label`], '待工作台处理');
    addText(element, 'p', detail, 'detail');
    root.appendChild(element);
  }
}

export async function clearWorkbench(button, refreshAll) {
  if (!window.confirm('确认清空工作台？\n\n仅清理已完成审核的临时队列、预览和当日人工清单；不会删除正式 Catalog、概念库或历史记录。')) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '清理中…';
  try {
    const result = await request('workbench/clear', { method: 'POST', body: JSON.stringify({}) });
    if (!result?.ok) throw new Error(result?.message || result?.code || '工作台清理被阻断');
    state.catalogPlan = null;
    state.catalogBatch = null;
    state.catalogRecovery.clear();
    state.conceptPlan = null;
    state.conceptPreview = null;
    showNotice('工作台已清空；正式知识库与历史记录已保留。', 'success');
    if (typeof refreshAll === 'function') await refreshAll();
  } catch (error) {
    updateWorkspaceClearState(null);
    showNotice(error.message || '工作台清理失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  } finally {
    button.textContent = original;
  }
}

export function setupOverviewPanel(refreshAll) {
  const clearBtn = $('#clearWorkbenchButton');
  if (clearBtn) {
    clearBtn.addEventListener('click', (event) => clearWorkbench(event.currentTarget, refreshAll));
  }
}
