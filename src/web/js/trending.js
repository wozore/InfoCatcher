/**
 * 知览 KnowView MVP — AI 热点视图 (trending)：
 * 内容类型筛选 + 最近/热度排序, 按唯一内容发布时间分组
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */

import { state, dataLoadFailures } from './state.js';
import { showModal, closeModal, setModalScrollPosition } from './modal.js';
import { getFilteredTrending, getHotspotHeat } from './data-filters.js';
import {
  escapeHtml,
  safeExternalUrl,
  timeAgo,
  formatMetric,
  renderState,
  setRegionBusy,
  announceStatus,
} from './ui-helpers.js';
import { ICON_CLOSE, ICON_EXTERNAL } from './ui-icons.js';
import { getToolCardItem, getToolLevel3Item } from './data-catalog.js';
import { t, getLocalizedField } from './i18n.js';

const platformMeta = {
  youtube: { label: t('labels.platform.youtube'), icon: '▶️' },
  x: { label: t('labels.platform.x'), icon: '𝕏' },
};

const contentTypeLabels = {
  ai_tool: t('labels.contentType.ai_tool'),
  ai_product: t('labels.contentType.ai_product'),
  ai_concept: t('labels.contentType.ai_concept'),
  ai_technology: t('labels.contentType.ai_technology'),
  ai_industry: t('labels.contentType.ai_industry'),
  other: t('labels.contentType.other'),
  unclassified: t('labels.contentType.unclassified')
};

const SOURCE_TYPE_LABELS = {
  youtube_video: t('labels.sourceType.youtube_video'),
  x_post: t('labels.sourceType.x_post'),
  unknown: t('labels.sourceType.unknown')
};

function searchConceptKey(term) {
  const normalized = String(term || '').trim().toLocaleLowerCase('zh-CN').normalize('NFKC').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/g, '');
  return normalized ? 'concept-' + normalized : 'concept-unknown';
}

export function renderTrendingTypeFilters() {
  const container = document.getElementById('trendingTypeTabs');
  if (!container) return;
  const types = [...new Set((state.hotspots.items || []).map(item => item.content_type).filter(type => type && type !== 'unclassified'))];
  const filterSet = container.closest('.trending-filter-set');
  if (filterSet) filterSet.hidden = types.length === 0;
  if (state.activeTrendingType !== 'all' && !types.includes(state.activeTrendingType)) state.activeTrendingType = 'all';
  container.innerHTML = '<button class="filter-chip' + (state.activeTrendingType === 'all' ? ' active' : '') + '" type="button" data-content-type="all" aria-pressed="' + (state.activeTrendingType === 'all') + '" data-i18n="trending.filter.allTypes">' + t('trending.filter.allTypes') + '</button>' +
    types.map(type => '<button class="filter-chip' + (state.activeTrendingType === type ? ' active' : '') + '" type="button" data-content-type="' + escapeHtml(type) + '" aria-pressed="' + (state.activeTrendingType === type) + '">' + escapeHtml(contentTypeLabels[type] || type) + '</button>').join('');
}

export function renderTrendingStatus() {
  const status = document.getElementById('trendingStatus');
  if (!status) return;
  const coverage = state.hotspots.coverage;
  if (dataLoadFailures.has('hotspots')) {
    status.innerHTML = '<div class="status-note status-error" role="alert"><strong>' + t('trending.status.loadFailed') + '</strong></div>';
    return;
  }
  if (!(state.hotspots.items || []).length && !state.hotspots.generated_at && (!coverage || coverage.status === 'not_run')) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.building') + '</strong></div>';
    return;
  }
  if (!(state.hotspots.items || []).length) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.empty') + '</strong></div>';
    return;
  }
  if (!coverage || coverage.status === 'not_run') {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.coverageUnavailable') + '</strong></div>';
    return;
  }
  const notes = [];
  const degraded = [];
  const sources = coverage.collectors || {};
  for (const [platform, info] of Object.entries(sources)) {
    if (info && (info.status === 'partial' || info.status === 'failed' || info.status === 'degraded')) {
      degraded.push(platform);
    }
  }
  if (degraded.length) {
    notes.push('<div class="status-note status-warn" role="status"><strong>' + t('trending.status.degraded', { platforms: escapeHtml([...new Set(degraded)].join('、')) }) + '</strong></div>');
  }
  status.innerHTML = notes.length
    ? notes.join('')
    : '<div class="status-note status-ok" role="status"><strong>' + t('trending.status.collectComplete') + '</strong></div>';
}

export function renderTrendingSortHelp() {
  const help = document.getElementById('trendingSortHelp');
  if (!help) return;
  const hasHeat = (state.hotspots.items || []).some(item => getHotspotHeat(item) !== null);
  help.textContent = hasHeat ? t('trending.sort.helpWithHeat') : t('trending.sort.helpWithoutHeat');
}

export function clearTrendingFilters() {
  const changed = state.activeTrendingType !== 'all';
  state.activeTrendingType = 'all';
  setRegionBusy(document.getElementById('trendingGrid'), true);
  renderTrending();
  if (changed) announceStatus(t('trending.filter.cleared'));
}

export async function reloadHotspots() {
  const grid = document.getElementById('trendingGrid');
  const status = document.getElementById('trendingStatus');
  setRegionBusy(grid, true);
  if (status) status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.reloading') + '</strong></div>';
  try {
    const resp = await fetch('data/news/output/hotspots.json');
    if (!resp.ok) throw new Error('hotspots HTTP ' + resp.status);
    state.hotspots = await resp.json();
    dataLoadFailures.delete('hotspots');
    renderTrending();
    announceStatus(t('trending.status.reloaded'));
  } catch (error) {
    dataLoadFailures.add('hotspots');
    renderTrending();
    announceStatus(t('trending.status.reloadFailed'));
  } finally {
    setRegionBusy(grid, false);
  }
}

export function formatHotspotDate(value) {
  if (!value) return t('timeAgo.unknown');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' +
    d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function getTrendingGroupLabel(item) {
  const time = new Date(item.published_at).getTime();
  if (!Number.isFinite(time)) return t('labels.group.unknown');
  const now = new Date();
  const itemDate = new Date(time);
  const isSameDay = (d1, d2) => d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
  if (isSameDay(now, itemDate)) return t('labels.group.today');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameDay(yesterday, itemDate)) return t('labels.group.yesterday');
  const diffDays = (now.getTime() - time) / 86400000;
  if (diffDays <= 7) return t('labels.group.last7d');
  return t('labels.group.earlier');
}

export function renderHotspotMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return '';
  const parts = [];
  if (metrics.views != null) parts.push(formatMetric(metrics.views) + ' 播放');
  if (metrics.likes != null) parts.push(formatMetric(metrics.likes) + ' 点赞');
  if (metrics.replies != null) parts.push(formatMetric(metrics.replies) + ' 回复');
  if (metrics.reposts != null) parts.push(formatMetric(metrics.reposts) + ' 转发');
  return parts.length ? '<span class="trending-metrics">' + escapeHtml(parts.join(' · ')) + '</span>' : '';
}

export function renderTrendingCard(item) {
  const meta = platformMeta[item.platform] || { label: item.platform || t('labels.fallback.platform'), icon: '📰' };
  const typeLabel = contentTypeLabels[item.content_type] || item.content_type || t('labels.fallback.type');
  const sourceTypeLabel = SOURCE_TYPE_LABELS[item.source_type] || item.source_type || t('labels.fallback.sourceType');
  const sourceName = item.author_name || item.source_id || t('labels.fallback.author');
  const sourceEvidence = item.evidence || t('labels.fallback.evidence');
  const sourceUrl = safeExternalUrl(item.url);
  const sourceDetailId = 'source-detail-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  const localizedTitle = getLocalizedField(item, 'title') || item.title || t('labels.fallback.title');
  const localizedSummary = getLocalizedField(item, 'summary') || item.summary || item.description || t('labels.fallback.summary');
  return '<article class="trending-card" tabindex="0" role="button" data-hotspot-id="' + escapeHtml(item.id) + '" aria-label="查看热点详情：' + escapeHtml(localizedTitle) + '">' +
    '<div class="trending-card-meta">' +
      '<span class="trending-platform" aria-hidden="true">' + meta.icon + '</span>' +
      '<span class="trending-type-tag">' + escapeHtml(typeLabel) + '</span>' +
      '<span class="trending-time">' + escapeHtml(timeAgo(item.published_at)) + '</span>' +
    '</div>' +
    '<h3 class="trending-title">' + escapeHtml(localizedTitle) + '</h3>' +
    '<p class="trending-summary">' + escapeHtml(localizedSummary) + '</p>' +
    '<div class="trending-card-footer">' +
      '<button class="btn-link trending-source-toggle" type="button" data-hotspot-source-toggle aria-expanded="false" aria-controls="' + escapeHtml(sourceDetailId) + '">' + t('trending.card.viewSource') + '</button>' +
      '<button class="btn-link trending-open-hint" type="button" data-hotspot-open>' + t('trending.card.openDetail') + '</button>' +
    '</div>' +
    '<div class="trending-card-source-detail" id="' + escapeHtml(sourceDetailId) + '" data-hotspot-card-source hidden>' +
      '<dl class="trending-source-meta">' +
        '<div><dt>' + t('trending.card.sourcePlatform') + '</dt><dd>' + escapeHtml(meta.label) + '</dd></div>' +
        '<div><dt>' + t('trending.card.sourceType') + '</dt><dd>' + escapeHtml(sourceTypeLabel) + '</dd></div>' +
        '<div><dt>' + t('trending.card.sourceName') + '</dt><dd>' + escapeHtml(sourceName) + '</dd></div>' +
        '<div><dt>' + t('trending.card.contentTime') + '</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
        '<div><dt>' + t('trending.card.updatedAt') + '</dt><dd>' + escapeHtml(formatHotspotDate(item.fetched_at)) + '</dd></div>' +
      '</dl>' +
      '<p class="trending-source-evidence"><strong>' + t('trending.card.evidence') + '</strong>' + escapeHtml(sourceEvidence) + '</p>' +
      (sourceUrl !== '#' ? '<a class="btn-link trending-source-link" href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">' + t('trending.card.openOriginal') + ' ' + ICON_EXTERNAL + '</a>' : '<p class="trending-source-unavailable">' + t('labels.fallback.sourceLink') + '</p>') +
    '</div>' +
  '</article>';
}

export function renderTrending() {
  renderTrendingTypeFilters();
  renderTrendingSortHelp();
  renderTrendingStatus();
  const items = getFilteredTrending();
  const grid = document.getElementById('trendingGrid');
  setRegionBusy(grid, false);
  document.getElementById('trendingCount').textContent = items.length;
  document.getElementById('trendingGenerated').textContent = state.hotspots.generated_at
    ? t('trending.generated', { time: timeAgo(state.hotspots.generated_at) })
    : t('trending.notCollected');

  if (!items.length) {
    const hasPublicItems = (state.hotspots.items || []).length > 0;
    const stateHtml = dataLoadFailures.has('hotspots')
      ? renderState({
          icon: '⚠️', title: t('trending.empty.loadFailedTitle'),
          message: t('trending.empty.loadFailedMsg'),
          type: 'error',
          actions: [{ label: t('common.reload'), dataKey: 'trending-action', dataValue: 'reload', primary: true }]
        })
      : hasPublicItems
        ? renderState({
            icon: '⌕', title: t('trending.empty.noMatchTitle'),
            message: t('trending.empty.noMatchMsg'),
            type: 'no-match',
            actions: [{ label: t('trending.empty.clearFilters'), dataKey: 'trending-action', dataValue: 'clear-filters', primary: true }]
          })
        : state.hotspots.generated_at
          ? renderState({
              icon: '○', title: t('trending.empty.noPublicTitle'),
              message: t('trending.empty.noPublicMsg'),
              type: 'unavailable',
              actions: [
                { label: t('trending.empty.gotoAbout'), dataKey: 'trending-action', dataValue: 'goto-about' },
                { label: t('trending.empty.gotoTools'), dataKey: 'trending-action', dataValue: 'goto-tools' }
              ]
            })
          : renderState({
              icon: '○', title: t('trending.empty.buildingTitle'),
              message: t('trending.empty.buildingMsg'),
              type: 'unavailable',
              actions: [
                { label: t('trending.empty.gotoAbout'), dataKey: 'trending-action', dataValue: 'goto-about' },
                { label: t('trending.empty.gotoTools'), dataKey: 'trending-action', dataValue: 'goto-tools' }
              ]
            });
    grid.innerHTML = stateHtml;
    return;
  }

  const groupOrder = [t('labels.group.today'), t('labels.group.yesterday'), t('labels.group.last7d'), t('labels.group.earlier'), t('labels.group.unknown')];
  const groups = new Map();
  items.forEach(item => {
    const label = getTrendingGroupLabel(item);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  });
  grid.innerHTML = [...groups.entries()]
    .sort((a, b) => groupOrder.indexOf(a[0]) - groupOrder.indexOf(b[0]))
    .map(([label, groupItems]) =>
      '<div class="trending-group">' +
        '<h3 class="trending-group-title">' + escapeHtml(label) + '</h3>' +
        groupItems.map(renderTrendingCard).join('') +
      '</div>'
    ).join('');
}

export function getHotspotRelatedResources(item) {
  const resources = Array.isArray(item.related_resources) ? item.related_resources : [];
  return resources.map(resource => {
    if (!resource || typeof resource !== 'object') return null;
    const rawType = resource.type;
    const type = { tool: 'tools', concept: 'concepts', scene: 'scenes' }[rawType] || rawType;
    const id = resource.id || resource.tool_id || resource.concept_id || resource.scene_id;
    if (!id || !['tools', 'concepts', 'scenes'].includes(type)) return null;
    if (type === 'tools') {
      const card = getToolCardItem(id);
      if (!card) return null;
      const detail = card.detail_ref ? getToolLevel3Item(card.vendor_key, card.detail_ref.id) : null;
      return { type, id: card.tool_key, title: card.title, subtitle: detail?.summary || card.summary || '', actionLabel: t('trending.detail.viewDetail'), icon: card.icon || '' };
    }
    if (type === 'concepts') {
      const concept = (state.glossary || []).find(entry => entry.term === id || searchConceptKey(entry.term) === id);
      if (!concept) return null;
      return { type, id: concept.term, title: concept.term, subtitle: concept.summary || '', actionLabel: t('trending.detail.viewConcept'), icon: '💡' };
    }
    if (type === 'scenes') {
      const scene = (state.scenes || []).find(entry => entry.id === id);
      if (!scene) return null;
      return { type, id: scene.id, title: scene.name, subtitle: scene.description || '', actionLabel: t('trending.detail.viewScene'), icon: '🎯' };
    }
    return null;
  }).filter(Boolean);
}

export function renderHotspotRelatedResources(item) {
  const items = getHotspotRelatedResources(item);
  if (!items.length) return '<p class="hotspot-detail-empty">' + t('trending.detail.noRelated') + '</p>';
  return '<div class="hotspot-detail-grid">' + items.map(r =>
    '<div class="hotspot-detail-card" data-resource-type="' + escapeHtml(r.type) + '" data-resource-id="' + escapeHtml(r.id) + '">' +
      '<div class="hotspot-detail-card-head">' +
        '<span class="hotspot-detail-card-icon" aria-hidden="true">' + escapeHtml(r.icon) + '</span>' +
        '<h4>' + escapeHtml(r.title) + '</h4>' +
      '</div>' +
      (r.subtitle ? '<p>' + escapeHtml(r.subtitle) + '</p>' : '') +
      '<button class="btn btn-small" type="button" data-open-resource="' + escapeHtml(r.type) + '" data-resource-id="' + escapeHtml(r.id) + '">' + escapeHtml(r.actionLabel) + '</button>' +
    '</div>'
  ).join('') + '</div>';
}

export function renderHotspotSummary(item) {
  const summary = item && typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : null;
  if (summary) {
    const keyPoints = Array.isArray(item.summary_key_points) && item.summary_key_points.length
      ? item.summary_key_points.filter(point => typeof point === 'string' && point.trim())
      : [];
    return '<p class="hotspot-detail-description">' + escapeHtml(summary) + '</p>' +
      (keyPoints.length
        ? '<ul class="hotspot-detail-key-points">' + keyPoints.map(point => '<li>' + escapeHtml(point) + '</li>').join('') + '</ul>'
        : '');
  }
  return '<p class="hotspot-detail-description">' + escapeHtml(getLocalizedField(item, 'description') || item.description || t('labels.fallback.summary')) + '</p>';
}

export function openHotspotDetail(id, trigger = null) {
  const item = (state.hotspots.items || []).find(entry => entry.id === id);
  const content = document.getElementById('modalContent');
  if (!item || !content) return;
  const meta = platformMeta[item.platform] || { label: item.platform || t('labels.fallback.platform'), icon: '📰' };
  const typeLabel = contentTypeLabels[item.content_type] || item.content_type || t('labels.fallback.type');
  const sourceTypeLabel = SOURCE_TYPE_LABELS[item.source_type] || item.source_type || t('labels.fallback.sourceType');
  const url = safeExternalUrl(item.url);
  const hasUrl = url !== '#';
  const sourceDetailId = 'hotspot-source-detail-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  const localizedTitle = getLocalizedField(item, 'title') || item.title || t('labels.fallback.title');
  setModalScrollPosition(window.scrollY);
  content.innerHTML = '<button class="modal-close" type="button" aria-label="' + t('trending.detail.close') + '" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
    '<article class="hotspot-detail" data-hotspot-detail="' + escapeHtml(item.id) + '">' +
      '<span class="eyebrow">' + escapeHtml(typeLabel) + '</span>' +
      '<h2>' + escapeHtml(localizedTitle) + '</h2>' +
      '<section class="hotspot-detail-section hotspot-detail-summary" aria-labelledby="hotspotSummaryTitle">' +
        '<h3 id="hotspotSummaryTitle">' + t('trending.detail.summary') + '</h3>' +
        renderHotspotSummary(item) +
        '<dl class="hotspot-detail-meta">' +
          '<div><dt>' + t('trending.card.contentTime') + '</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
          '<div><dt>' + t('trending.detail.author') + '</dt><dd>' + escapeHtml(item.author_name || t('labels.fallback.author')) + '</dd></div>' +
        '</dl>' +
      '</section>' +
      '<section class="hotspot-detail-section hotspot-detail-sources" aria-labelledby="hotspotSourcesTitle">' +
        '<div class="hotspot-detail-section-heading"><h3 id="hotspotSourcesTitle">' + t('trending.detail.sources') + '</h3>' +
          '<button class="btn-link hotspot-source-toggle" type="button" data-hotspot-source-toggle aria-expanded="false" aria-controls="' + escapeHtml(sourceDetailId) + '">' + t('trending.card.viewSource') + '</button>' +
        '</div>' +
        '<div class="hotspot-source-detail" id="' + escapeHtml(sourceDetailId) + '" hidden>' +
          '<dl class="hotspot-source-meta">' +
            '<div><dt>' + t('trending.card.sourcePlatform') + '</dt><dd>' + escapeHtml(meta.label) + '</dd></div>' +
            '<div><dt>' + t('trending.card.sourceType') + '</dt><dd>' + escapeHtml(sourceTypeLabel) + '</dd></div>' +
            '<div><dt>' + t('trending.card.contentTime') + '</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
            '<div><dt>' + t('trending.card.updatedAt') + '</dt><dd>' + escapeHtml(formatHotspotDate(item.fetched_at)) + '</dd></div>' +
            '<div><dt>' + t('trending.card.sourceName') + '</dt><dd>' + escapeHtml(item.author_name || item.source_id || t('labels.fallback.author')) + '</dd></div>' +
          '</dl>' +
          '<p class="hotspot-source-evidence"><strong>' + t('trending.card.evidence') + '</strong>' + escapeHtml(item.evidence || t('labels.fallback.evidence')) + '</p>' +
          (hasUrl
            ? '<a class="btn-link hotspot-source-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + t('trending.card.openOriginal') + ' ' + ICON_EXTERNAL + '</a>'
            : '<p class="hotspot-detail-unavailable">' + t('labels.fallback.sourceLink') + '</p>') +
        '</div>' +
      '</section>' +
      '<section class="hotspot-detail-section hotspot-detail-related" aria-labelledby="hotspotRelatedTitle">' +
        '<h3 id="hotspotRelatedTitle">' + t('trending.detail.related') + '</h3>' +
        renderHotspotRelatedResources(item) +
      '</section>' +
    '</article>';
  showModal(trigger);
}
