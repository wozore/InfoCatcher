/**
 * ui-helpers.js — 通用 UI 与安全辅助函数
 * 包含 HTML 转义、安全链接校验、无障碍状态通知、时效与度量展示。
 */

import { t } from './i18n.js';

export function hasFree(t) {
  return t?.price_badge === 'free';
}

export function getTimelinessInfo(queriedAt) {
  if (!queriedAt) return null;
  const diff = Date.now() - new Date(queriedAt).getTime();
  if (!Number.isFinite(diff) || diff < 0) return null;
  const days = diff / 86400000;
  if (days < 7) return { level: 'green', emoji: '🟢', label: '一周内' };
  if (days < 30) return { level: 'yellow', emoji: '🟡', label: '一个月内' };
  if (days < 90) return { level: 'orange', emoji: '🟠', label: '三个月内' };
  return { level: 'red', emoji: '🔴', label: '三个月以上', stale: true };
}

export function renderTimelinessBadge(queriedAt) {
  const info = getTimelinessInfo(queriedAt);
  if (!info) return '';
  return '<span class="timeliness-badge ' + info.level + '">' + info.emoji + ' ' + info.label + '</span>';
}

export function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

export function safeExternalUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '#';
  } catch (e) {
    return '#';
  }
}

export function timeAgo(value) {
  if (!value) return t('timeAgo.unknown');
  const diff = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(diff)) return t('timeAgo.unknown');
  const minutes = Math.max(0, Math.floor(diff / 60000));
  if (minutes < 1) return t('timeAgo.justNow');
  if (minutes < 60) return t('timeAgo.minutes', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('timeAgo.hours', { n: hours });
  const days = Math.floor(hours / 24);
  return days < 30 ? t('timeAgo.days', { n: days }) : new Date(value).toLocaleDateString('zh-CN');
}

export function formatMetric(value) {
  if (value == null) return null;
  if (value >= 10000) return t('metric.tenThousand', { n: (value / 10000).toFixed(1) });
  if (value >= 1000) return t('metric.thousand', { n: (value / 1000).toFixed(1) });
  return String(value);
}

export function formatPrice(value, currency) {
  if (value === null || value === undefined) return '未提供';
  const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : currency + ' ';
  return symbol + Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
}

export function renderState({ icon, title, message, type = 'empty', actions }) {
  const role = type === 'error' ? 'alert' : 'status';
  const actionHtml = Array.isArray(actions) && actions.length
    ? '<div class="empty-state-actions">' + actions.map(action =>
        '<button class="btn btn-small' + (action.primary ? ' btn-primary' : '') + '" type="button" data-' + action.dataKey + '="' + escapeHtml(action.dataValue) + '">' + escapeHtml(action.label) + '</button>'
      ).join('') + '</div>'
    : '';
  return '<div class="empty-state state-' + type + '" role="' + role + '" data-state="' + type + '">' +
    '<div class="empty-icon" aria-hidden="true">' + icon + '</div>' +
    '<h3>' + title + '</h3><p>' + message + '</p>' + actionHtml + '</div>';
}

export function announceStatus(message) {
  const status = document.getElementById('appStatus');
  if (!status) return;
  status.textContent = '';
  window.requestAnimationFrame(() => { status.textContent = message; });
}

export function setRegionBusy(element, busy) {
  if (!element) return;
  element.setAttribute('aria-busy', String(busy));
  element.classList.toggle('is-updating', busy);
  const live = element.querySelector(':scope > .region-updating-sr');
  if (busy) {
    if (!live) {
      const el = document.createElement('span');
      el.className = 'region-updating-sr sr-only';
      el.setAttribute('role', 'status');
      el.textContent = '正在更新…';
      element.prepend(el);
    }
  } else if (live) {
    live.remove();
  }
}

export function setPressedState(controls, activeControl) {
  controls.forEach(control => {
    const selected = control === activeControl;
    control.classList.toggle('active', selected);
    control.setAttribute('aria-pressed', String(selected));
  });
}

export function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand('copy')) resolve();
      else reject(new Error('copy failed'));
    } catch (error) {
      reject(error);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}

export function copyTextWithFeedback(button, text, label) {
  copyTextToClipboard(text)
    .then(() => {
      const original = button.textContent;
      button.textContent = '已复制';
      button.setAttribute('aria-label', label + '已复制');
      window.setTimeout(() => { button.textContent = original; }, 1600);
      announceStatus(label + '已复制');
    })
    .catch(() => {
      announceStatus(label + '复制失败，请手动选择复制');
    });
}
