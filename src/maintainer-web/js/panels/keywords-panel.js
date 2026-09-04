import { writeRequest, unwrap } from '../api.js';
import {
  state,
  $,
  text,
  showNotice,
} from '../state.js';
import {
  renderQueue,
  bindSelection,
  handleMutationError,
  loadResource,
  runAction,
} from './common.js';

export function renderKeywords(payload) {
  const value = unwrap(payload) || {};
  const all = Array.isArray(value.items) ? value.items : [];
  const pending = all.filter(item => !(item && (item.adopted === true || item.discarded === true)));
  renderQueue('keywords', 'keywordList', pending, 'keywordsState', {
    selectable: true,
    titleKeys: ['word'],
    empty: all.length > 0 ? '当前关键词候选已全部处理（采纳或丢弃）。' : '当前没有关键词候选。',
  });
  const note = $('#keywordSourceNote');
  if (note) {
    const source = value.source;
    if (source && source.input_count != null) {
      if (String(source.source_basis || '').startsWith('all_approved_frequency')) {
        note.textContent = `来源：覆盖全部 ${source.source_count == null ? '?' : source.source_count} 条 approved（全局词频）生成候选。`;
      } else if (String(source.source_basis || '').startsWith('all_approved_batched')) {
        const batch = (String(source.source_basis).match(/batched_(\d+)/) || [])[1];
        note.textContent = `来源：覆盖全部 ${source.source_count == null ? '?' : source.source_count} 条 approved，分批（每批 ${batch || '?'} 条）生成候选。`;
      } else {
        note.textContent = `来源：共 ${source.source_count == null ? '?' : source.source_count} 条 approved，AI 读取评分前 ${source.input_count} 条（${text(source.source_basis || '')}）生成候选。`;
      }
    } else if (all.length === 0) {
      note.textContent = '尚未生成关键词候选；点击上方「生成关键词候选」。';
    } else {
      note.textContent = '';
    }
  }
}

export async function adoptKeywords(button, onRefreshAll) {
  const ids = [...state.selected.keywords];
  if (!ids.length) return;
  state.loading.add('keywords');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  button.disabled = true;
  try {
    await writeRequest('news/keywords', 'keywords', { ids });
    state.selected.keywords.clear();
    showNotice(`已采纳 ${ids.length} 条关键词候选。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'keywords', 'keywordsState', button);
  } finally {
    button.textContent = originalLabel;
  }
}

export async function discardKeywords(button, onRefreshAll) {
  const ids = [...state.selected.keywords];
  if (!ids.length) return;
  state.loading.add('keywords');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  button.disabled = true;
  try {
    await writeRequest('news/keywords/discard', 'keywords', { ids });
    state.selected.keywords.clear();
    showNotice(`已丢弃 ${ids.length} 条关键词候选（加入黑名单，不再建议）。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'keywords', 'keywordsState', button);
  } finally {
    button.textContent = originalLabel;
  }
}

export async function generateKeywords(button, onRefreshAll) {
  await runAction('news/keywords/generate', button, '生成中…', result => {
    const count = Number(result?.candidates?.length || result?.candidate_count || 0);
    const total = Number(result?.approvedCount ?? result?.source_count ?? 0);
    const basis = total ? `覆盖全部 ${total} 条 approved` : '';
    return `已生成 ${count} 条关键词候选${basis ? `（${basis}）。` : '。'}`;
  }, onRefreshAll);
}

export function loadKeywords() {
  return loadResource('keywords', 'news/keywords', renderKeywords, {
    rootId: 'keywordList',
    stateId: 'keywordsState',
  });
}

export function setupKeywordsPanel(onRefreshAll) {
  bindSelection('keywords', 'keywordList', 'keywordSelectAll');
  const genBtn = $('#keywordGenerateButton');
  if (genBtn) genBtn.addEventListener('click', (event) => generateKeywords(event.currentTarget, onRefreshAll));
  const adoptBtn = $('#keywordAdoptButton');
  if (adoptBtn) adoptBtn.addEventListener('click', (event) => adoptKeywords(event.currentTarget, onRefreshAll));
  const discardBtn = $('#keywordDiscardButton');
  if (discardBtn) discardBtn.addEventListener('click', (event) => discardKeywords(event.currentTarget, onRefreshAll));
}
