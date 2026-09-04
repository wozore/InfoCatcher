import { tokenFromFragment } from './auth.js';

export const state = {
  token: tokenFromFragment(),
  revisions: Object.create(null),
  items: { news: [], keywords: [], top: [], toolUpdates: [], concepts: [] },
  selected: { news: new Set(), keywords: new Set(), top: new Set() },
  uploads: new Map(),
  uploading: new Set(),
  refreshTail: Promise.resolve(),
  toolPreview: null,
  catalogBatch: null,
  catalogRecovery: new Map(),
  conceptPreview: null,
  conceptPlan: null,
  loading: new Set(),
};

export const $ = (selector) => document.querySelector(selector);
export const text = (value) => (value === null || value === undefined ? '' : String(value));
export const first = (object, keys, fallback = '') => {
  if (!object || typeof object !== 'object') return fallback;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return fallback;
};

export function setLoadState(id, label, kind = '') {
  const element = $(`#${id}`);
  if (!element) return;
  element.textContent = label;
  if (kind) element.dataset.state = kind;
  else delete element.dataset.state;
}

export function showNotice(message, kind = 'success') {
  const notice = $('#appNotice');
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = false;
}

export function clearNotice() {
  const notice = $('#appNotice');
  if (!notice) return;
  notice.textContent = '';
  notice.hidden = true;
  delete notice.dataset.kind;
}

export function updateRevisionNote() {
  const revisions = Object.values(state.revisions).filter(Boolean);
  const note = $('#revisionNote');
  if (!note) return;
  if (!revisions.length) {
    note.textContent = '等待连接工作台 API';
    return;
  }
  const unique = [...new Set(revisions)];
  note.textContent = unique.length === 1
    ? `当前数据 revision：${unique[0]}`
    : `当前载入 ${unique.length} 个数据 revision；每个写操作绑定所属队列 revision。`;
}

export function clearChildren(element) {
  if (!element) return;
  while (element.firstChild) element.removeChild(element.firstChild);
}

export function addText(parent, tagName, value, className = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  node.textContent = text(value);
  parent.appendChild(node);
  return node;
}

export function addBadge(parent, value, tone = '') {
  if (!value) return null;
  const badge = addText(parent, 'span', value, 'badge');
  if (tone) badge.dataset.tone = tone;
  return badge;
}

function safeHttpUrl(value) {
  const raw = text(value).trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, window.location.origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch (_) { return ''; }
}

function addSourceLink(parent, value, label = '') {
  const url = safeHttpUrl(value);
  if (!url) return;
  const link = document.createElement('a');
  link.className = 'source-link';
  link.href = url;
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
  link.textContent = label || url;
  parent.appendChild(link);
}

export function itemId(item) {
  const value = first(item, ['id', 'item_id', 'candidate_id', 'key', 'candidate_key', 'word'], '');
  return value === '' ? '' : String(value);
}

export function zhLocalized(item, field) {
  const zh = item && item.localizations && item.localizations.zh;
  if (!zh) return '';
  const value = zh[field];
  return value == null ? '' : String(value);
}

export const VERDICT_ZH = { approve: '建议通过', discard: '建议丢弃', hold: '需人工细看', rejected: '建议拒绝', approved: '建议通过' };

const BLOCKED_REASON_ZH = Object.freeze({
  AI_REVIEW_REQUIRED: '需要 AI 复核',
  AI_OUTPUT_INVALID: 'AI 复核结果无效',
  AI_FALLBACK_FAILED: 'AI 复核调用失败',
  AI_VERDICT_NOT_APPROVE: 'AI 建议未通过',
  AI_CONFIDENCE_LOW: 'AI 建议把握度不足',
  EVIDENCE_DATE_MISSING: '官方证据缺少发布日期',
  PROPOSED_DATE_MISSING: '无法形成可应用的更新日期',
  PROPOSED_DATE_NOT_AFTER_CURRENT: '拟定日期没有晚于当前日期',
  EVIDENCE_DATE_AMBIGUOUS: '官方日期存在歧义，需核验',
  CURRENT_DATE_MISSING: '缺少当前目录日期',
  PRODUCT_SURFACE_MISMATCH: '证据对应的产品表面不匹配',
  EVIDENCE_HASH_CHANGED: '官方证据已变化，需重新核验',
});

export const uiHelpers = {
  clearChildren,
  addText,
  addBadge,
  safeHttpUrl,
  addSourceLink,
  blockedReasonText(reason) {
    return BLOCKED_REASON_ZH[reason] || `需要核验：${String(reason || '未知原因')}`;
  },
  addBlockedReasons(content, reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) return;
    const summary = reasons.slice(0, 2).map(r => BLOCKED_REASON_ZH[r] || `需要核验：${String(r || '未知原因')}`).join('；');
    addText(content, 'p', `当前不能批准：${summary}${reasons.length > 2 ? `（另有 ${reasons.length - 2} 项）` : ''}`, 'item-blocked');
    if (reasons.length > 2) {
      const detail = document.createElement('details');
      detail.className = 'item-blocked-detail';
      addText(detail, 'summary', '查看完整核验项');
      addText(detail, 'p', reasons.map(r => BLOCKED_REASON_ZH[r] || `需要核验：${String(r || '未知原因')}`).join('；'));
      content.appendChild(detail);
    }
  },
  confidenceDisplay(value, range, options = {}) {
    const confidence = (() => {
      if (typeof range === 'string') {
        const match = range.match(/^(\d{1,3})-\d{1,3}%$/);
        if (match) return Number(match[1]) / 100;
      }
      const num = Number(value);
      return Number.isFinite(num) && num >= 0 && num <= 1 ? num : null;
    })();
    const verdict = options.verdict || '';
    if (confidence === null) return { prefix: '', value: '模型未提供把握度，需人工判断', suffix: '', tone: 'unknown' };
    const level = confidence < 0.6 ? '有限' : confidence < 0.8 ? '中等' : '较高';
    const tone = confidence < 0.6 || verdict === 'hold' ? 'medium' : (verdict === 'discard' || verdict === 'rejected' ? 'low' : 'high');
    if (typeof range === 'string' && /^\d{1,3}-\d{1,3}%$/.test(range)) {
      return { prefix: '模型自评：', value: `${level}（${range}）`, suffix: '，非统计准确率', tone };
    }
    if (options.tool) {
      return { prefix: '模型置信度：', value: `${level}（${Math.round(confidence * 100)}%）`, suffix: '，非统计准确率', tone };
    }
    return { prefix: '历史模型自评：', value: `${level}（原始值 ${Math.round(confidence * 100)}%）`, suffix: '，非统计准确率；尚未提供区间', tone };
  },
  reviewMaterials(item) {
    const fields = [
      ['title', '标题'],
      ['description', '描述'],
      ['transcript', '字幕'],
      ['summary', '内容总结'],
    ];
    const present = fields.filter(([field]) => {
      const val = item && item[field];
      return val !== undefined && val !== null && String(val).trim() !== '';
    }).map(([, label]) => label);
    const missing = fields.filter(([field]) => {
      const val = item && item[field];
      return val === undefined || val === null || String(val).trim() === '';
    }).map(([, label]) => label);
    return { present, missing };
  },
};
