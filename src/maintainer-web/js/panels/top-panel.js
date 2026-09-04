import { request, writeRequest, unwrap, listFrom, revisionFrom, ApiError } from '../api.js';
import {
  state,
  $,
  first,
  itemId,
  addText,
  addBadge,
  clearChildren,
  setLoadState,
  showNotice,
  updateRevisionNote,
  uiHelpers,
} from '../state.js';
import {
  queueItem,
  itemTitle,
  renderQueue,
  bindSelection,
  handleMutationError,
  runAction,
} from './common.js';

const TRANSCRIPT_STATUS_ZH = Object.freeze({ none: '无字幕', uploaded: '已上传，待总结', summarized: '已总结' });

export function renderTop(payload) {
  const all = listFrom(payload, ['items', 'candidates', 'top']);
  const selected = all.filter(item => item.top_selected === true);
  const controls = $('#topSelectionControls');
  if (!selected.length) {
    if (controls) controls.hidden = false;
    renderQueue('top', 'topList', all, 'topState', {
      selectable: true,
      titleKeys: ['summary', 'description'],
      empty: (payload && payload.note) || '当前没有可选 Top 项目。',
    });
    return;
  }
  if (controls) controls.hidden = true;
  state.items.top = selected;
  const root = $('#topList');
  clearChildren(root);
  addText(root, 'p', `Top 审核已完成：已选 ${selected.length} 条。公开发布预览位于右侧；如需写入公开投影，请显式点击「重建公开投影」。`, 'panel-note');
  for (const item of selected) root.appendChild(queueItem(item, 'top', { titleKeys: ['summary', 'description'] }));
  setLoadState('topState', `已完成 · ${selected.length} 条`, 'success');
}

export function renderPreview(payload) {
  const root = $('#publishPreview');
  clearChildren(root);
  const items = listFrom(payload, ['items', 'top', 'hotspots', 'preview']);
  if (!items.length) {
    const value = unwrap(payload);
    const message = value && typeof value === 'object' ? first(value, ['message', 'summary'], '') : '';
    addText(root, 'p', message || '当前没有可展示的公开投影。', 'muted');
  } else {
    const heading = first(unwrap(payload), ['title', 'name'], '当前公开投影');
    addText(root, 'h4', heading);
    const list = document.createElement('ol');
    list.className = 'preview-list';
    for (const item of items) {
      const row = document.createElement('li');
      addText(row, 'span', itemTitle(item));
      const id = itemId(item);
      const detail = first(item, ['summary', 'description', 'source'], id ? `ID ${id}` : '');
      if (detail) addText(row, 'small', detail);
      list.appendChild(row);
    }
    root.appendChild(list);
  }
  setLoadState('previewState', '已加载', 'success');
}

export function renderTranscripts(payload, onRefreshAll) {
  const value = unwrap(payload) || {};
  const items = Array.isArray(value.items) ? value.items : [];
  const root = $('#transcriptList');
  clearChildren(root);
  const selectedYoutube = items.filter(item => item.top_selected === true && String(item.platform || '').toLowerCase() === 'youtube');
  const selectedKeys = new Set(selectedYoutube.map(item => String(item.id)));
  for (const key of state.uploads.keys()) {
    if (!selectedKeys.has(key) && !state.uploading.has(key)) state.uploads.delete(key);
  }
  if (!selectedYoutube.length) {
    addText(root, 'p', '尚未选择 Top YouTube 条目；保存 Top 选择后可在此上传字幕。', 'muted');
    setLoadState('transcriptState', '0 条', 'success');
    return;
  }
  for (const item of selectedYoutube) {
    const row = document.createElement('div');
    row.className = 'transcript-row';
    addText(row, 'span', itemTitle(item), 'item-title');
    addBadge(row, TRANSCRIPT_STATUS_ZH[item.transcript_status] || item.transcript_status || '无字幕', String(item.transcript_status || 'none'));
    uiHelpers.addSourceLink(row, item.url, '打开原视频 ↗');
    if (item.transcript_file) addText(row, 'span', item.transcript_file, 'muted');
    const key = String(item.id);
    const status = String(item.transcript_status || 'none');
    if (status !== 'none') {
      state.uploads.delete(key);
      state.uploading.delete(key);
      root.appendChild(row);
      continue;
    }
    const pendingFile = state.uploads.get(key) || null;
    const uploading = state.uploading.has(key);
    const pick = document.createElement('label');
    pick.className = 'file-pick';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt,.vtt,.txt';
    input.dataset.candidateId = key;
    pick.appendChild(input);
    pick.appendChild(document.createTextNode('选择字幕文件'));
    row.appendChild(pick);
    if (pendingFile) addText(row, 'span', `已选择：${pendingFile.name}`, 'muted');
    const upload = document.createElement('button');
    upload.type = 'button';
    upload.className = 'button button-primary';
    upload.textContent = uploading ? '上传中…' : '上传字幕';
    upload.dataset.candidateId = key;
    upload.disabled = !pendingFile || uploading;
    upload.addEventListener('click', () => uploadTranscriptFile(key, upload, onRefreshAll));
    row.appendChild(upload);
    root.appendChild(row);
  }
  setLoadState('transcriptState', `${selectedYoutube.length} 条`, 'success');
}

export async function uploadTranscriptFile(candidateId, button, onRefreshAll) {
  const key = String(candidateId);
  if (state.uploading.has(key)) return;
  const file = state.uploads.get(key) || null;
  if (!file) {
    showNotice('请先选择字幕文件。', 'error');
    return;
  }
  state.uploading.add(key);
  button.textContent = '上传中…';
  button.disabled = true;
  try {
    const content = await file.text();
    const contentBase64 = btoa(unescape(encodeURIComponent(content)));
    const result = await writeRequest('news/transcripts/upload', 'transcripts', { candidate_id: key, filename: file.name, content_base64: contentBase64 });
    state.uploads.delete(key);
    showNotice(`字幕已保存（${Number(result?.transcript_chars || 0)} 字符）。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'transcripts', 'transcriptState', button);
  } finally {
    state.uploading.delete(key);
    button.textContent = '上传字幕';
  }
}

export async function summarizeTranscripts(button, onRefreshAll) {
  if (!$('#transcriptCostConfirm').checked) {
    showNotice('请先勾选外部 AI 费用确认。', 'error');
    return;
  }
  const items = state.items.top.filter(item => item.top_selected === true && item.transcript_status === 'uploaded');
  const ids = items.map(item => item.id);
  if (!ids.length) {
    showNotice('没有已上传、待总结的字幕。', 'error');
    return;
  }
  button.textContent = '总结中…';
  button.disabled = true;
  try {
    const result = await writeRequest('news/transcripts/summarize', 'transcripts', { ids, confirm_cost: true }, { timeoutMs: 100000 });
    const summarizedCount = Number(result?.summarized?.length || 0);
    const failed = Array.isArray(result?.failed) ? result.failed : [];
    if (typeof onRefreshAll === 'function') await onRefreshAll();
    if (failed.length) {
      const reasons = failed.map(item => `${item.id}: ${item.error || '总结失败'}`).join('；');
      showNotice(`字幕总结完成：成功 ${summarizedCount} 条，失败 ${failed.length} 条。失败原因——${reasons}`, 'error');
    } else {
      showNotice(`已用 AI 总结 ${summarizedCount} 条字幕。`);
    }
  } catch (error) {
    handleMutationError(error, 'transcripts', 'transcriptState', button);
  } finally {
    button.textContent = '总结选中字幕（AI）';
    button.disabled = !$('#transcriptCostConfirm').checked;
  }
}

export async function saveTop(button, onRefreshAll) {
  const ids = [...state.selected.top];
  if (!ids.length) return;
  state.loading.add('top');
  const originalLabel = button.textContent;
  button.textContent = '处理中…';
  button.disabled = true;
  try {
    await writeRequest('news/top', 'top', { ids, selected: true });
    state.selected.top.clear();
    showNotice(`已保存 ${ids.length} 条 Top 选择。`);
    if (typeof onRefreshAll === 'function') await onRefreshAll();
  } catch (error) {
    handleMutationError(error, 'top', 'topState', button);
  } finally {
    button.textContent = originalLabel;
  }
}

export async function generateTop(button, onRefreshAll) {
  await runAction('news/top/generate', button, '生成中…', result => {
    const count = Number(result?.candidates?.length || result?.count || 0);
    const input = Number(result?.ai_input_count || 0);
    const total = Number(result?.approved_count || 0);
    return `已生成 ${count} 条 Top 待选项${input ? `（基于评分前 ${input} 条 / 共 ${total || '?'} 条 approved）。` : '。'}`;
  }, onRefreshAll);
}

export async function publishNews(button, onRefreshAll) {
  await runAction('news/publish', button, '发布中…', result => {
    const count = Number(result?.items || 0);
    return `已更新公开投影（${count} 条）。`;
  }, onRefreshAll);
}

export async function loadPreview() {
  setLoadState('previewState', '加载中…', 'loading');
  try {
    const payload = await request('news/publish-preview');
    renderPreview(payload);
  } catch (error) {
    showNotice(error instanceof ApiError && error.status === 409 ? '公开预览已变化，请刷新后确认。' : '公开发布预览加载失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  }
}

export async function loadTopAndTranscripts(onRefreshAll) {
  setLoadState('topState', '加载中…', 'loading');
  setLoadState('transcriptState', '加载中…', 'loading');
  try {
    const payload = await request('news/top');
    const revision = revisionFrom(payload);
    if (revision) {
      state.revisions.top = revision;
      state.revisions.transcripts = revision;
    }
    renderTop(payload);
    renderTranscripts(payload, onRefreshAll);
    updateRevisionNote();
  } catch (error) {
    const message = error instanceof ApiError && error.status === 409
      ? 'Top 数据已变化，请刷新后再确认。'
      : 'Top 数据加载失败，请检查 token 与工作台 API。';
    const root = $('#topList');
    clearChildren(root);
    addText(root, 'p', message, 'error-state');
    setLoadState('topState', error instanceof ApiError && error.status === 409 ? '数据冲突' : '加载失败', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    setLoadState('transcriptState', '加载失败', 'error');
    showNotice(message, error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  }
}

export function setupTopPanel(onRefreshAll) {
  bindSelection('top', 'topList', 'topSelectAll');
  const genBtn = $('#topGenerateButton');
  if (genBtn) genBtn.addEventListener('click', (event) => generateTop(event.currentTarget, onRefreshAll));
  const saveBtn = $('#topSaveButton');
  if (saveBtn) saveBtn.addEventListener('click', (event) => saveTop(event.currentTarget, onRefreshAll));
  const pubBtn = $('#publishNewsButton');
  if (pubBtn) pubBtn.addEventListener('click', (event) => publishNews(event.currentTarget, onRefreshAll));
  const prevRefBtn = $('#previewRefreshButton');
  if (prevRefBtn) prevRefBtn.addEventListener('click', loadPreview);

  const transList = $('#transcriptList');
  if (transList) {
    transList.addEventListener('change', (event) => {
      const target = event.target;
      if (!target.matches('input[type=file][data-candidate-id]')) return;
      const key = String(target.dataset.candidateId);
      const file = target.files && target.files[0];
      if (file) state.uploads.set(key, file);
      else state.uploads.delete(key);
      const row = target.closest('.transcript-row');
      const button = row && row.querySelector('button[data-candidate-id]');
      if (button) button.disabled = !file || state.uploading.has(key);
    });
  }

  const costConfirm = $('#transcriptCostConfirm');
  if (costConfirm) {
    costConfirm.addEventListener('change', (event) => {
      const summarizeBtn = $('#transcriptSummarizeButton');
      if (summarizeBtn) summarizeBtn.disabled = !event.currentTarget.checked;
    });
  }
  const sumBtn = $('#transcriptSummarizeButton');
  if (sumBtn) {
    sumBtn.addEventListener('click', (event) => summarizeTranscripts(event.currentTarget, onRefreshAll));
  }
}
