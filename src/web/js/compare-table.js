/**
 * compare-table.js — 模型对比表格视图渲染
 * 负责许可、开源状态、上下文长度、定价等维度表格组装。
 */

import { t } from './i18n.js';
import { escapeHtml } from './ui-helpers.js';

export function formatPricing(model) {
  const parts = [];
  const or = model.pricing?.openrouter;
  if (or && or.currency === 'USD') {
    const inPerM = Number(or.prompt) * 1e6;
    const outPerM = Number(or.completion) * 1e6;
    parts.push('$' + Number(inPerM).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输入 · $' + Number(outPerM).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输出' + (or.is_listed_price ? '（挂牌参考价）' : ''));
  }
  const ls = model.pricing?.llm_stats;
  if (ls && (ls.input_per_m != null || ls.output_per_m != null)) {
    parts.push('$' + Number(ls.input_per_m ?? '—').toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输入 · $' + Number(ls.output_per_m ?? '—').toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' / 1M 输出');
  }
  return parts.length ? parts.join('<br>') : t('compare.table.noPricing');
}

export function renderTable(models, generatedAt = '—') {
  const header = '<th>' + escapeHtml(t('compare.table.row')) + '</th>' + models.map(model => '<th>' + escapeHtml(model.display) + '</th>').join('');
  const boolCell = value => value == null ? escapeHtml(t('compare.table.unknown')) : escapeHtml(value ? t('compare.table.yes') : t('compare.table.no'));
  const rows = [
    [t('compare.table.license'), model => escapeHtml(model.license || t('compare.table.unknown'))],
    [t('compare.table.openSource'), model => boolCell(model.open_source)],
    [t('compare.table.vendor'), model => escapeHtml(model.vendor || '—')],
    [t('compare.table.modalities'), model => Array.isArray(model.modalities) && model.modalities.length ? escapeHtml(model.modalities.join('、')) : escapeHtml(t('compare.table.unknown'))],
    [t('compare.table.isMoe'), model => boolCell(model.is_moe)],
    [t('compare.table.context'), model => model.context_length ? escapeHtml(Number(model.context_length).toLocaleString('zh-CN') + ' tokens') : escapeHtml(t('compare.table.unknown'))],
    [t('compare.table.pricing'), model => formatPricing(model)],
  ];
  const body = rows.map(row => '<tr><td class="dim">' + escapeHtml(row[0]) + '</td>' + models.map(model => '<td>' + row[1](model) + '</td>').join('')).join('');
  return '<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr>' + header + '</tr></thead><tbody>' + body + '</tbody></table>' +
    '<p class="faint cmp-generated">' + escapeHtml(t('compare.generatedAt', { time: generatedAt || '—' })) + '</p></div>';
}
