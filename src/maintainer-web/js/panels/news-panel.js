import { request, writeRequest, unwrap, listFrom } from '../api.js';
import {
  state,
  $,
  addText,
  clearChildren,
  setLoadState,
  showNotice,
} from '../state.js';
import {
  renderQueue,
  bindSelection,
  updateSelectionControls,
  handleMutationError,
  loadResource,
} from './common.js';

export async function reviewNews(decision, button, onRefreshAll) {
  const ids = [...state.selected.news];
  if (!ids.length) return;
  state.loading.add('news');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  button.disabled = true;
  try {
    await writeRequest('news/review', 'news', { ids, decision, status: decision });
    state.selected.news.clear();
    showNotice(decision === 'approved' ? `已批准 ${ids.length} 条新闻候选。` : `已丢弃 ${ids.length} 条新闻候选。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'news', 'newsState', button);
  } finally {
    button.textContent = originalLabel;
  }
}

export function loadNewsReview(onRefreshAll) {
  return loadResource('news', 'news/review', (payload) => {
    const value = unwrap(payload) || {};
    if (value.status === 'enriching') {
      const root = $('#newsList');
      clearChildren(root);
      addText(root, 'p', `🤖 ${value.message || '本地 Bonsai 正在进行 AI 初审分流与汉化，请稍候...'}`, 'panel-note');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary-button';
      btn.style.marginTop = '8px';
      btn.textContent = '立即运行双通道自愈修复';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '正在双通道修复…';
        try {
          await request('news/repair', { method: 'POST', body: JSON.stringify({}) });
          showNotice('双通道自愈修复已完成，正在刷新…', 'success');
          if (typeof onRefreshAll === 'function') onRefreshAll();
        } catch (err) {
          showNotice(`自愈修复失败：${err.message || err}`, 'error');
          btn.disabled = false;
          btn.textContent = '重试双通道自愈修复';
        }
      });
      root.appendChild(btn);
      setLoadState('newsState', 'AI 初审中…', 'loading');
      updateSelectionControls('news');
      return;
    }
    renderQueue('news', 'newsList', listFrom(payload, ['items', 'candidates', 'queue', 'news']), 'newsState', {
      selectable: true,
      empty: '当前没有待首审新闻。',
    });
  }, { rootId: 'newsList', stateId: 'newsState' });
}

export function setupNewsPanel(onRefreshAll) {
  bindSelection('news', 'newsList', 'newsSelectAll');
  const approveBtn = $('#newsApproveButton');
  if (approveBtn) {
    approveBtn.addEventListener('click', (event) => reviewNews('approved', event.currentTarget, onRefreshAll));
  }
  const discardBtn = $('#newsDiscardButton');
  if (discardBtn) {
    discardBtn.addEventListener('click', (event) => reviewNews('discarded', event.currentTarget, onRefreshAll));
  }
}
