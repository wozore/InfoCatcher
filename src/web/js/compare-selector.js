/**
 * compare-selector.js — 模型对比左侧选择树、厂商分组与筛选面板
 */

import { t } from './i18n.js';
import { escapeHtml } from './ui-helpers.js';
import { brandIconHtml } from './brand-icons.js';
import { getVendorCardItem } from './data-catalog.js';

const CMP_SELECTOR_MIN_WIDTH = 220;
const CMP_SELECTOR_MAX_WIDTH = 480;
const CMP_SELECTOR_DEFAULT_WIDTH = 300;
const CMP_MAIN_MIN_WIDTH = 480;
const CMP_SPLITTER_WIDTH = 12;

let cmpSelectorWidth = CMP_SELECTOR_DEFAULT_WIDTH;
let cmpSplitterDrag = null;
let cmpSplitterBound = false;
let treeAnchorFrame = 0;

const THEME_LABELS = { general: '通用', image: '图像生成', video: '视频生成', vision: '纯视觉理解', media: '媒体', dev: '开发者' };
const VENDOR_ICONS = {
  openai: '🤖', anthropic: '✦', google: '✨', meta: '🦙', deepseek: '🐋',
  qwen: '🐉', mistral: '🌀', moonshot: '🌙', midjourney: '🎨', xai: '🕳️', glm: '🧊',
};

function themeLabel(theme) {
  return THEME_LABELS[theme] || theme || '通用';
}

function comparisonSeriesIconKey(value) {
  return String(value || '').split('--').pop().replace(/\./g, '-');
}

function modelIconHtml(model) {
  const meta = { vendorKey: model.vendor, toolKey: model.canonical, modelKey: model.canonical, emoji: '✦' };
  return brandIconHtml(meta);
}

function humanizeVendorKey(vendorKey) {
  return String(vendorKey || 'unknown')
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.length <= 3 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Unknown';
}

function vendorLabel(vendorKey) {
  return getVendorCardItem(vendorKey)?.title || humanizeVendorKey(vendorKey);
}

function vendorIconHtml(vendorKey) {
  const card = getVendorCardItem(vendorKey);
  return brandIconHtml({ vendorKey, emoji: card?.icon || VENDOR_ICONS[vendorKey] || '🧠' });
}

function selectedCountForSeries(series, selected) {
  return series.members.reduce((count, member) => count + (member.variants.some(variant => selected.includes(variant.canonical)) ? 1 : 0), 0);
}

function cmpLayoutOf() {
  return document.getElementById('compareModelPanel')?.querySelector('.cmp-layout');
}

function cmpWidthBounds(layout = cmpLayoutOf()) {
  if (!layout) return { min: CMP_SELECTOR_MIN_WIDTH, max: CMP_SELECTOR_MAX_WIDTH };
  const styles = getComputedStyle(layout);
  const gap = Number.parseFloat(styles.columnGap) || 0;
  const width = layout.getBoundingClientRect().width || layout.clientWidth;
  if (!width) return { min: CMP_SELECTOR_MIN_WIDTH, max: CMP_SELECTOR_MAX_WIDTH };
  const availableMax = width - (gap * 2) - CMP_SPLITTER_WIDTH - CMP_MAIN_MIN_WIDTH;
  return {
    min: CMP_SELECTOR_MIN_WIDTH,
    max: Math.max(CMP_SELECTOR_MIN_WIDTH, Math.min(CMP_SELECTOR_MAX_WIDTH, availableMax)),
  };
}

function clampCmpSelectorWidth(width, layout = cmpLayoutOf()) {
  const bounds = cmpWidthBounds(layout);
  const value = Number.isFinite(width) ? width : CMP_SELECTOR_DEFAULT_WIDTH;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

export function applyCmpSelectorWidth(width) {
  const layout = cmpLayoutOf();
  if (!layout) return;
  cmpSelectorWidth = clampCmpSelectorWidth(width, layout);
  layout.style.setProperty('--cmp-selector-width', `${cmpSelectorWidth}px`);
  const splitter = document.getElementById('cmpSplitter');
  if (splitter) {
    const bounds = cmpWidthBounds(layout);
    splitter.setAttribute('aria-valuemin', String(bounds.min));
    splitter.setAttribute('aria-valuemax', String(bounds.max));
    splitter.setAttribute('aria-valuenow', String(Math.round(cmpSelectorWidth)));
  }
}

function treeAnchorOf(trigger) {
  const list = document.getElementById('cmpModelList');
  if (!list || !trigger) return null;
  let kind;
  let key;
  if (trigger.matches('[data-cmp-vendor-toggle]')) {
    kind = 'vendor';
    key = trigger.dataset.cmpVendorToggle;
  } else if (trigger.matches('[data-cmp-series-toggle]')) {
    kind = 'series';
    key = trigger.dataset.cmpSeriesToggle;
  } else if (trigger.matches('[data-cmp-pick]')) {
    kind = 'pick';
    key = trigger.dataset.cmpPick;
  } else if (trigger.matches('[data-cmp-revision]')) {
    kind = 'series';
    key = trigger.closest('[data-cmp-series]')?.dataset.cmpSeries;
  }
  if (!kind || !key) return null;
  const element = [...list.querySelectorAll(`[data-cmp-${kind}]`)].find(item => item.getAttribute(`data-cmp-${kind}`) === key);
  if (!element) return null;
  const listRect = list.getBoundingClientRect();
  return {
    list,
    kind,
    key,
    scrollTop: list.scrollTop,
    offsetTop: element.getBoundingClientRect().top - listRect.top,
  };
}

function treeAnchorElement(anchor) {
  if (!anchor?.list?.isConnected) return null;
  return [...anchor.list.querySelectorAll(`[data-cmp-${anchor.kind}]`)]
    .find(item => item.getAttribute(`data-cmp-${anchor.kind}`) === anchor.key);
}

function restoreTreeAnchor(anchor) {
  if (!anchor?.list?.isConnected) return;
  if (treeAnchorFrame) cancelAnimationFrame(treeAnchorFrame);
  treeAnchorFrame = requestAnimationFrame(() => {
    treeAnchorFrame = 0;
    anchor.list.scrollTop = anchor.scrollTop;
    const element = treeAnchorElement(anchor);
    if (!element) return;
    const currentOffset = element.getBoundingClientRect().top - anchor.list.getBoundingClientRect().top;
    const delta = currentOffset - anchor.offsetTop;
    if (Math.abs(delta) > 1) {
      anchor.list.scrollTop += delta;
    }
  });
}

export function renderWithTreeAnchor(trigger, render) {
  const anchor = treeAnchorOf(trigger);
  render();
  if (anchor) restoreTreeAnchor(anchor);
}

export function bindCmpSplitter() {
  const splitter = document.getElementById('cmpSplitter');
  if (!splitter || cmpSplitterBound) return;
  cmpSplitterBound = true;
  applyCmpSelectorWidth(cmpSelectorWidth);

  const finishDrag = event => {
    if (!cmpSplitterDrag) return;
    cmpSplitterDrag = null;
    splitter.classList.remove('is-dragging');
    document.body.classList.remove('cmp-resizing');
    if (event?.pointerId != null && splitter.hasPointerCapture?.(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
  };

  splitter.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cmpSplitterDrag = { pointerId: event.pointerId, startX: event.clientX, startWidth: cmpSelectorWidth };
    splitter.classList.add('is-dragging');
    document.body.classList.add('cmp-resizing');
    splitter.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', event => {
    if (!cmpSplitterDrag || event.pointerId !== cmpSplitterDrag.pointerId) return;
    applyCmpSelectorWidth(cmpSplitterDrag.startWidth + event.clientX - cmpSplitterDrag.startX);
  });
  splitter.addEventListener('pointerup', finishDrag);
  splitter.addEventListener('pointercancel', finishDrag);
  splitter.addEventListener('lostpointercapture', finishDrag);
  splitter.addEventListener('keydown', event => {
    const bounds = cmpWidthBounds();
    const step = event.shiftKey ? 40 : 16;
    let next;
    if (event.key === 'ArrowLeft') next = cmpSelectorWidth - step;
    else if (event.key === 'ArrowRight') next = cmpSelectorWidth + step;
    else if (event.key === 'Home') next = bounds.min;
    else if (event.key === 'End') next = bounds.max;
    else return;
    event.preventDefault();
    applyCmpSelectorWidth(next);
  });
  window.addEventListener('resize', () => applyCmpSelectorWidth(cmpSelectorWidth));
}

export function filteredSeries(filterTheme, indexSeries = [], searchQuery = '') {
  return indexSeries.filter(series => {
    const visibleMembers = visibleMembersForSeries(series, filterTheme, searchQuery);
    return visibleMembers.length > 0;
  });
}

export function visibleMembersForSeries(series, filterTheme, searchQuery = '') {
  const query = searchQuery.trim().toLowerCase();
  let members = series.members || [];
  members = members.filter(member => member.theme === filterTheme);
  if (!query) return members;
  const seriesText = [series.display, series.series_key, series.vendor, vendorLabel(series.vendor)].filter(Boolean).join(' ').toLowerCase();
  if (seriesText.includes(query)) return members;
  return members.filter(member => {
    const memberText = [member.display, member.member_key, ...(member.variants || []).flatMap(variant => [variant.display, variant.canonical])].filter(Boolean).join(' ').toLowerCase();
    return memberText.includes(query);
  });
}

export function expandSearchMatches(searchQuery, filterTheme, indexSeries, expandedVendors, expandedSeries) {
  expandedVendors.clear();
  expandedSeries.clear();
  if (!searchQuery.trim()) return;
  for (const series of filteredSeries(filterTheme, indexSeries, searchQuery)) {
    const vendorKey = series.vendor || 'unknown';
    expandedVendors.add(vendorKey);
    expandedSeries.add(series.series_key);
  }
}

export function renderFilterCats(filterTheme, indexSeries = []) {
  const box = document.getElementById('cmpFilterCats');
  if (!box) return;
  const themeOrder = ['general', 'image', 'video', 'vision'];
  const themes = [...new Set(indexSeries.flatMap(series => (series.members || []).map(member => member.theme)).filter(Boolean))]
    .sort((a, b) => (themeOrder.indexOf(a) - themeOrder.indexOf(b)) || a.localeCompare(b));
  box.innerHTML = themes.map(theme =>
    '<button class="filter-chip' + (filterTheme === theme ? ' active' : '') + '" type="button" data-cmp-cat="' + escapeHtml(theme) + '" aria-pressed="' + (filterTheme === theme) + '">' +
      escapeHtml(themeLabel(theme)) +
    '</button>'
  ).join('');
}

function vendorGroupsFromSeries(seriesList, selected) {
  const groups = new Map();
  for (const series of seriesList) {
    const vendorKey = series.vendor || 'unknown';
    const group = groups.get(vendorKey) || {
      vendor_key: vendorKey,
      display: vendorLabel(vendorKey),
      series: [],
      member_count: 0,
      selected_count: 0,
      max_composite_score: null,
    };
    group.series.push(series);
    group.member_count += series.member_count ?? series.members.length;
    group.selected_count += selectedCountForSeries(series, selected);
    if (Number.isFinite(series.max_composite_score) && (group.max_composite_score == null || series.max_composite_score > group.max_composite_score)) {
      group.max_composite_score = series.max_composite_score;
    }
    groups.set(vendorKey, group);
  }
  return [...groups.values()].sort((a, b) => {
    const scoreA = Number.isFinite(a.max_composite_score) ? a.max_composite_score : -1;
    const scoreB = Number.isFinite(b.max_composite_score) ? b.max_composite_score : -1;
    if (scoreB !== scoreA) return scoreB - scoreA;
    return String(a.display).localeCompare(String(b.display), 'zh-CN');
  });
}

function renderMemberVariantSelect(member, selected, indexMap) {
  if (member.variants.length < 2) return '';
  const selectedVariant = member.variants.find(item => selected.includes(item.canonical));
  const activeCanonical = selectedVariant?.canonical || member.default_canonical;
  return '<label class="cmp-tree-revision-wrap" onclick="event.stopPropagation()">' +
    '<select class="cmp-tree-revision" data-cmp-revision="' + escapeHtml(member.member_key) + '" aria-label="' + escapeHtml(member.display + ' 版本') + '">' +
      member.variants.map(variant =>
        '<option value="' + escapeHtml(variant.canonical) + '"' + (variant.canonical === activeCanonical ? ' selected' : '') + '>' +
          escapeHtml(variant.revision || variant.display) +
        '</option>'
      ).join('') +
    '</select>' +
  '</label>';
}

export function renderModelList({ selected, indexSeries, indexMap, filterTheme, searchQuery, expandedVendors, expandedSeries }) {
  const list = document.getElementById('cmpModelList');
  if (!list) return;
  const groups = vendorGroupsFromSeries(filteredSeries(filterTheme, indexSeries, searchQuery), selected);
  if (!groups.length) {
    list.innerHTML = '<p class="hint">' + escapeHtml(t('compare.empty.noSearchMatch')) + '</p>';
    return;
  }
  list.innerHTML = groups.map(group => {
    const vendorExpanded = expandedVendors.has(group.vendor_key);
    const seriesHtml = vendorExpanded ? group.series.map(series => {
      const seriesExpanded = expandedSeries.has(series.series_key);
      const members = visibleMembersForSeries(series, filterTheme, searchQuery);
      const seriesSelected = selectedCountForSeries(series, selected);
      const membersHtml = seriesExpanded ? members.map(member => {
        const selectedVariant = member.variants.find(item => selected.includes(item.canonical));
        const activeCanonical = selectedVariant?.canonical || member.default_canonical;
        const index = indexMap.get(activeCanonical) || member;
        const isSelected = selected.includes(activeCanonical);
        const score = index.composite_score != null ? Number(index.composite_score).toFixed(1) : '—';
        return '<div class="cmp-tree-node cmp-tree-member' + (isSelected ? ' selected' : '') + '" data-cmp-pick="' + escapeHtml(activeCanonical) + '" role="button" tabindex="0" aria-pressed="' + isSelected + '">' +
          '<span class="cmp-tree-checkbox" aria-hidden="true"></span>' +
          '<span class="cmp-tree-member-icon" aria-hidden="true">' + modelIconHtml(index) + '</span>' +
          '<span class="cmp-tree-node-name">' + escapeHtml(member.display) + '</span>' +
          renderMemberVariantSelect(member, selected, indexMap) +
          '<span class="cmp-tree-score">' + score + '</span>' +
        '</div>';
      }).join('') : '';
      return '<div class="cmp-tree-series-group" data-cmp-series="' + escapeHtml(series.series_key) + '">' +
        '<div class="cmp-tree-node cmp-tree-series" data-cmp-series-toggle="' + escapeHtml(series.series_key) + '" role="button" tabindex="0" aria-expanded="' + seriesExpanded + '">' +
          '<span class="cmp-tree-arrow' + (seriesExpanded ? ' expanded' : '') + '" aria-hidden="true">▸</span>' +
          '<span class="cmp-tree-series-icon" aria-hidden="true">' + brandIconHtml({ seriesKey: comparisonSeriesIconKey(series.series_key), vendorKey: series.vendor, emoji: '✦' }) + '</span>' +
          '<span class="cmp-tree-node-name">' + escapeHtml(series.display) + '</span>' +
          (seriesSelected > 0 ? '<span class="cmp-tree-selected-badge">' + seriesSelected + '</span>' : '') +
          '<span class="cmp-tree-badge">' + members.length + '</span>' +
        '</div>' +
        (seriesExpanded ? '<div class="cmp-tree-children">' + membersHtml + '</div>' : '') +
      '</div>';
    }).join('') : '';
    return '<div class="cmp-tree-vendor-group" data-cmp-vendor="' + escapeHtml(group.vendor_key) + '">' +
      '<div class="cmp-tree-node cmp-tree-vendor" data-cmp-vendor-toggle="' + escapeHtml(group.vendor_key) + '" role="button" tabindex="0" aria-expanded="' + vendorExpanded + '">' +
        '<span class="cmp-tree-arrow' + (vendorExpanded ? ' expanded' : '') + '" aria-hidden="true">▸</span>' +
        '<span class="cmp-tree-vendor-icon" aria-hidden="true">' + vendorIconHtml(group.vendor_key) + '</span>' +
        '<span class="cmp-tree-node-name">' + escapeHtml(group.display) + '</span>' +
        (group.selected_count > 0 ? '<span class="cmp-tree-selected-badge">' + group.selected_count + '</span>' : '') +
        '<span class="cmp-tree-badge">' + group.member_count + '</span>' +
      '</div>' +
      (vendorExpanded ? '<div class="cmp-tree-children">' + seriesHtml + '</div>' : '') +
    '</div>';
  }).join('');
}
