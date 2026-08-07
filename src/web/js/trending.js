/**
 * InfoCatcher MVP — AI 热点视图 (trending)：
 * 内容类型筛选 + 最近/热度排序, 按唯一内容发布时间分组
 *
 * 安全设计：
 *   所有来自外部平台（YouTube/X/Bilibili）的文本字段（标题、描述、
 *   作者名、来源名）在渲染前都通过 escapeHtml() 转义，防止 XSS。
 *   所有外部链接通过 safeExternalUrl() 校验协议，只允许 http/https。
 *   这两个函数是安全边界——如果去掉，恶意内容可注入 <script> 或
 *   javascript: 链接。
 *
 * 筛选与展示：
 *   getFilteredTrending() — 按内容类型筛选，按唯一内容发布时间倒序（实现在 data.js）
 *   renderTrendingStatus() — 渲染采集覆盖状态（降级/未运行/人工收录）
 *   renderTrending() — 渲染热点卡片（公开字段，按“今天/昨天/近7天/更早”分组）
 *   openHotspotDetail() — 热点详情对话框（摘要 + 来源核验 + 关联资料三段式；平台只在来源层展示）
 * 架构概要、八个视图与扩展模式见 main.js 顶部维护文档。
 */
import {
  tools,
  glossary,
  scenes,
  hotspots,
  activeTrendingType,
  dataLoadFailures,
  setHotspots,
  setActiveTrendingType,
  getFilteredTrending,
  getHotspotHeat,
  platformMeta,
  contentTypeLabels,
  SOURCE_TYPE_LABELS,
  escapeHtml,
  safeExternalUrl,
  timeAgo,
  formatMetric,
  renderState,
  setRegionBusy,
  announceStatus,
  searchConceptKey,
  getCollectionNode,
  ICON_CLOSE,
  ICON_EXTERNAL,
} from './data.js';
import { showModal, closeModal, setModalScrollPosition } from './tools.js';
import { t, getLocalizedField } from './i18n.js';

// ═══════════════════════════════════════════════════════════════
// 筛选、排序与状态
// ═══════════════════════════════════════════════════════════════

function renderTrendingTypeFilters() {
  const container = document.getElementById('trendingTypeTabs');
  if (!container) return;
  // B16 决策 65/79：只把真实内容类型作为筛选维度；unclassified（AI 分类+审核未上线）
  // 与未知值不作为筛选标签。无真实类型时隐藏整个“内容类型”筛选区（决策 80 空状态）。
  const types = [...new Set((hotspots.items || []).map(item => item.content_type).filter(type => type && type !== 'unclassified'))];
  const filterSet = container.closest('.trending-filter-set');
  if (filterSet) filterSet.hidden = types.length === 0;
  if (activeTrendingType !== 'all' && !types.includes(activeTrendingType)) setActiveTrendingType('all');
  container.innerHTML = '<button class="filter-chip' + (activeTrendingType === 'all' ? ' active' : '') + '" type="button" data-content-type="all" aria-pressed="' + (activeTrendingType === 'all') + '" data-i18n="trending.filter.allTypes">' + t('trending.filter.allTypes') + '</button>' +
    types.map(type => '<button class="filter-chip' + (activeTrendingType === type ? ' active' : '') + '" type="button" data-content-type="' + escapeHtml(type) + '" aria-pressed="' + (activeTrendingType === type) + '">' + escapeHtml(contentTypeLabels[type] || type) + '</button>').join('');
}

function renderTrendingStatus() {
  const status = document.getElementById('trendingStatus');
  const coverage = hotspots.coverage;
  if (dataLoadFailures.has('hotspots')) {
    status.innerHTML = '<div class="status-note status-error" role="alert"><strong>' + t('trending.status.loadFailed') + '</strong></div>';
    return;
  }
  if (!(hotspots.items || []).length && !hotspots.generated_at && (!coverage || coverage.status === 'not_run')) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.building') + '</strong></div>';
    return;
  }
  if (!(hotspots.items || []).length) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.empty') + '</strong></div>';
    return;
  }
  if (!coverage || coverage.status === 'not_run') {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.coverageUnavailable') + '</strong></div>';
    return;
  }
  const notes = [];
  const bilibili = coverage.platforms?.bilibili;
  if (bilibili?.status === 'manual_curated') {
    notes.push('<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.bilibiliManual') + '</strong></div>');
  } else if (bilibili?.reason === 'rsshub_provider_blocked') {
    notes.push('<div class="status-note status-warn" role="status"><strong>' + t('trending.status.bilibiliBlocked') + '</strong></div>');
  }
  const degraded = [];
  for (const [platform, info] of Object.entries(coverage.platforms || {})) {
    if (info.status === 'degraded' || info.status === 'partial') degraded.push(platform);
  }
  if (coverage.platforms?.bilibili?.dynamic?.status === 'degraded') degraded.push(t('trending.status.bilibiliDynamic'));
  if (degraded.length) {
    notes.push('<div class="status-note status-warn" role="status"><strong>' + t('trending.status.degraded', { platforms: escapeHtml([...new Set(degraded)].join('、')) }) + '</strong></div>');
  }
  status.innerHTML = notes.length
    ? notes.join('')
    : '<div class="status-note status-ok" role="status"><strong>' + t('trending.status.collectComplete') + '</strong></div>';
}

// B16 决策 85：热度说明通过低权重信息提示查看；默认不展示热度数值或排名。
function renderTrendingSortHelp() {
  const help = document.getElementById('trendingSortHelp');
  if (!help) return;
  const hasHeat = (hotspots.items || []).some(item => getHotspotHeat(item) !== null);
  help.textContent = hasHeat
    ? t('trending.sort.helpWithHeat')
    : t('trending.sort.helpWithoutHeat');
}

// 决策 80：筛选无匹配时“清除筛选”，重置内容类型筛选（平台已非列表级筛选维度），保留排序选择。
function clearTrendingFilters() {
  const changed = activeTrendingType !== 'all';
  setActiveTrendingType('all');
  setRegionBusy(document.getElementById('trendingGrid'), true);
  renderTrending();
  if (changed) announceStatus(t('trending.filter.cleared'));
}

// 决策 80：热点数据加载失败时“重新加载”，重新拉取公开投影；失败时保留上一版数据并保持失败状态。
async function reloadHotspots() {
  const grid = document.getElementById('trendingGrid');
  const status = document.getElementById('trendingStatus');
  setRegionBusy(grid, true);
  if (status) status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>' + t('trending.status.reloading') + '</strong></div>';
  try {
    const resp = await fetch('data/news/output/hotspots.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    setHotspots(await resp.json());
    dataLoadFailures.delete('hotspots');
    announceStatus(t('trending.status.reloaded'));
  } catch (error) {
    dataLoadFailures.add('hotspots');
    announceStatus(t('trending.status.reloadFailed'));
  }
  renderTrending();
}

// ═══════════════════════════════════════════════════════════════
// 卡片渲染
// ═══════════════════════════════════════════════════════════════

function renderHotspotMetrics(item) {
  if (!item.metrics) return [];
  return [['views', t('trending.metric.views')], ['likes', t('trending.metric.likes')], ['comments', t('trending.metric.comments')], ['reposts', t('trending.metric.reposts')], ['replies', t('trending.metric.replies')]]
    .map(([key, label]) => {
      const value = formatMetric(item.metrics[key]);
      return value === null ? null : { label, value };
    })
    .filter(Boolean);
}

function formatHotspotDate(value, fallback = t('timeAgo.unknown')) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
    : fallback;
}

// 决策 78：按热点实体唯一内容发布时间轻量分组（今天/昨天/近 7 天/更早；无效时间归“时间未知”）
function getTrendingGroupLabel(item) {
  const time = new Date(item.published_at).getTime();
  if (!Number.isFinite(time)) return t('labels.group.unknown');
  const diff = Date.now() - time;
  const day = 86400000;
  if (diff < 0 || diff < day) return t('labels.group.today');
  if (diff < 2 * day) return t('labels.group.yesterday');
  if (diff < 7 * day) return t('labels.group.last7d');
  return t('labels.group.earlier');
}

// 决策 74/77/87：卡片默认只显示内容类型、标题、短摘要、时间线索与低权重详情入口；
// 平台、作者、互动、来源标签移入详情对话框，不占卡片默认区。
function renderTrendingCard(item) {
  const typeLabel = contentTypeLabels[item.content_type] || item.content_type || t('labels.fallback.type');
  const published = Number.isFinite(new Date(item.published_at).getTime()) ? timeAgo(item.published_at) : t('labels.fallback.published');
  // 内容本地化：摘要优先（AI 总结已中文）；无总结用本地化描述（localizations.zh），再回退原文描述
  const preview = item.summary || getLocalizedField(item, 'description') || item.description || t('labels.fallback.preview');
  const sourceDetailId = 'trending-source-detail-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  const meta = platformMeta[item.platform] || { label: item.platform || t('labels.fallback.platform') };
  const sourceUrl = item.url ? safeExternalUrl(item.url) : '#';
  const sourceName = item.author_name || item.source_id || t('labels.fallback.author');
  const sourceTypeLabel = SOURCE_TYPE_LABELS[item.source_type] || item.source_type || t('labels.fallback.sourceType');
  const sourceEvidence = item.evidence_excerpt || item.source_excerpt || t('labels.fallback.evidence');
  const localizedTitle = getLocalizedField(item, 'title') || item.title || t('labels.fallback.title');
  const localizedDescription = getLocalizedField(item, 'description') || item.description;
  return '<article class="trending-card" data-hotspot-id="' + escapeHtml(item.id) + '" aria-labelledby="trending-title-' + escapeHtml(item.id) + '">' +
    '<div class="trending-card-head"><span class="tag scene">' + escapeHtml(typeLabel) + '</span><span>' + escapeHtml(published) + '</span></div>' +
    '<h3 id="trending-title-' + escapeHtml(item.id) + '"><span class="trending-title">' + escapeHtml(localizedTitle) + '</span></h3>' +
    '<div class="trending-preview-wrap">' +
      '<p class="trending-description' + (item.description || getLocalizedField(item, 'description') ? '' : ' is-missing') + '">' + escapeHtml(preview) + '</p>' +
      (item.description
        ? '<div class="trending-secondary-preview" aria-hidden="true"><span>' + escapeHtml(localizedDescription || item.description) + '</span></div>'
        : '') +
    '</div>' +
    '<div class="trending-card-actions">' +
      '<button class="btn-link trending-source-toggle" type="button" data-hotspot-card-source-toggle aria-expanded="false" aria-controls="' + escapeHtml(sourceDetailId) + '">' + t('trending.card.viewSource') + '</button>' +
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

function renderTrending() {
  renderTrendingTypeFilters();
  renderTrendingSortHelp();
  renderTrendingStatus();
  const items = getFilteredTrending();
  const grid = document.getElementById('trendingGrid');
  setRegionBusy(grid, false);
  document.getElementById('trendingCount').textContent = items.length;
  document.getElementById('trendingGenerated').textContent = hotspots.generated_at
    ? t('trending.generated', { time: timeAgo(hotspots.generated_at) })
    : t('trending.notCollected');

  if (!items.length) {
    const hasPublicItems = (hotspots.items || []).length > 0;
    // 决策 80：四类空状态各自提供“下一步操作”——筛选无匹配可清除筛选；
    // 没有公开热点/审核建设中可了解规则或返回其他视图；加载失败可重新加载。
    const state = dataLoadFailures.has('hotspots')
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
        : hotspots.generated_at
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
    grid.innerHTML = state;
    return;
  }

  // 决策 78：按唯一内容发布时间分组渲染（只显示有内容的分组；分组标签须与
  // getTrendingGroupLabel 同源——都经 t() 取当前语言，语言切换时保持一致）
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

// ═══════════════════════════════════════════════════════════════
// 热点详情对话框
// ═══════════════════════════════════════════════════════════════

function getHotspotRelatedResources(item) {
  const resources = Array.isArray(item.related_resources) ? item.related_resources : [];
  return resources.map(resource => {
    if (!resource || typeof resource !== 'object') return null;
    const rawType = resource.type;
    const type = { tool: 'tools', concept: 'concepts', scene: 'scenes' }[rawType] || rawType;
    const id = resource.id || resource.tool_id || resource.concept_id || resource.scene_id;
    if (!id || !['tools', 'concepts', 'scenes'].includes(type)) return null;

    if (type === 'tools') {
      const tool = tools.find(entry => entry.id === id);
      const itemId = resource.item_id || null;
      const item = itemId ? getCollectionNode(id, itemId) : null;
      const available = Boolean(tool && (!itemId || item));
      return available
        ? { type, id: tool.id, itemId, label: resource.label || item?.name || tool.name, available: true }
        : { type, id, itemId, label: resource.label || id, available: false };
    }
    if (type === 'concepts') {
      const concept = glossary.find(entry => entry.term === id || searchConceptKey(entry.term) === id);
      return concept
        ? { type, id: concept.term, label: resource.label || concept.term, available: true }
        : { type, id, label: resource.label || id, available: false };
    }
    const scene = scenes.find(entry => entry.id === id);
    return scene
      ? { type, id: scene.id, label: resource.label || scene.name, available: true }
      : { type, id, label: resource.label || id, available: false };
  }).filter(Boolean);
}

function renderHotspotRelatedResources(item) {
  const resources = getHotspotRelatedResources(item);
  if (!resources.length) {
    return '<p class="hotspot-detail-unavailable"><strong>' + t('labels.fallback.related') + '</strong></p>';
  }

  const groups = [
    { key: 'tools', label: t('trending.detail.tools') },
    { key: 'concepts', label: t('trending.detail.concepts') },
    { key: 'scenes', label: t('trending.detail.scenes') },
  ];
  const grouped = groups.map(group => ({
    ...group,
    items: resources.filter(resource => resource.type === group.key),
  })).filter(group => group.items.length);

  return grouped.map(group => '<div class="hotspot-related-group"><h4>' + escapeHtml(group.label) + '</h4>' +
    group.items.slice(0, 3).map(resource => resource.available
      ? '<button class="hotspot-related-item" type="button" data-hotspot-related-type="' + escapeHtml(resource.type) + '" data-hotspot-related-id="' + escapeHtml(resource.id) + '"' + (resource.itemId ? ' data-hotspot-related-item="' + escapeHtml(resource.itemId) + '"' : '') + '>' + escapeHtml(resource.label) + ' →</button>'
      : '<span class="hotspot-related-item hotspot-related-unavailable">' + escapeHtml(resource.label) + '：' + t('trending.detail.resourceUnavailable') + '</span>'
    ).join('') + '</div>').join('');
}

// content-summarizer：摘要区渲染——优先 AI 总结（summary + 可选要点列表），
// 无 AI 总结时回退原始描述。所有文本经 escapeHtml 转义（沿用安全边界）。
function renderHotspotSummary(item) {
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

function openHotspotDetail(id, trigger = null) {
  const item = (hotspots.items || []).find(entry => entry.id === id);
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
          '<p class="hotspot-source-evidence"><strong>' + t('trending.card.evidence') + '</strong>' + t('labels.fallback.evidence') + '</p>' +
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

export {
  renderTrendingTypeFilters,
  renderTrendingStatus,
  renderTrendingSortHelp,
  clearTrendingFilters,
  reloadHotspots,
  renderTrendingCard,
  renderTrending,
  renderHotspotMetrics,
  formatHotspotDate,
  getHotspotRelatedResources,
  renderHotspotRelatedResources,
  renderHotspotSummary,
  openHotspotDetail,
  getTrendingGroupLabel,
};
