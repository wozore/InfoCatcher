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
  container.innerHTML = '<button class="filter-chip' + (activeTrendingType === 'all' ? ' active' : '') + '" type="button" data-content-type="all" aria-pressed="' + (activeTrendingType === 'all') + '">全部类型</button>' +
    types.map(type => '<button class="filter-chip' + (activeTrendingType === type ? ' active' : '') + '" type="button" data-content-type="' + escapeHtml(type) + '" aria-pressed="' + (activeTrendingType === type) + '">' + escapeHtml(contentTypeLabels[type] || type) + '</button>').join('');
}

function renderTrendingStatus() {
  const status = document.getElementById('trendingStatus');
  const coverage = hotspots.coverage;
  if (dataLoadFailures.has('hotspots')) {
    status.innerHTML = '<div class="status-note status-error" role="alert"><strong>加载失败：</strong>公开热点数据暂时无法读取。请刷新页面重试；其他资料视图仍可使用。</div>';
    return;
  }
  if (!(hotspots.items || []).length && !hotspots.generated_at && (!coverage || coverage.status === 'not_run')) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>公开投影建设中：</strong>尚未生成可供浏览器读取的热点内容，请等待公开构建完成。</div>';
    return;
  }
  if (!(hotspots.items || []).length) {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>暂无公开热点：</strong>公开投影已生成，但当前没有可展示内容。</div>';
    return;
  }
  if (!coverage || coverage.status === 'not_run') {
    status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>覆盖信息暂不可用：</strong>继续展示已生成的公开内容，不能据此推断全部来源的近期状态。</div>';
    return;
  }
  const notes = [];
  const bilibili = coverage.platforms?.bilibili;
  if (bilibili?.status === 'manual_curated') {
    notes.push('<div class="status-note status-neutral" role="status"><strong>人工收录：</strong>B站当前采用人工精选收录，自动订阅已暂停；已有内容仍保留原始链接，未收录不代表来源近期没有更新。</div>');
  } else if (bilibili?.reason === 'rsshub_provider_blocked') {
    notes.push('<div class="status-note status-warn" role="status"><strong>部分不可用：</strong>B站自动订阅入口被服务提供方拦截，本轮已快速停止后续请求；页面继续展示上一版及人工精选内容。</div>');
  }
  const degraded = [];
  for (const [platform, info] of Object.entries(coverage.platforms || {})) {
    if (info.status === 'degraded' || info.status === 'partial') degraded.push(platform);
  }
  if (coverage.platforms?.bilibili?.dynamic?.status === 'degraded') degraded.push('B站动态');
  if (degraded.length) {
    notes.push('<div class="status-note status-warn" role="status"><strong>部分数据降级：</strong>' + escapeHtml([...new Set(degraded)].join('、')) + '。缺失会降低判断置信度，不代表来源质量下降。</div>');
  }
  status.innerHTML = notes.length
    ? notes.join('')
    : '<div class="status-note status-ok" role="status"><strong>采集完成：</strong>本轮自动来源采集已完成。</div>';
}

// B16 决策 85：热度说明通过低权重信息提示查看；默认不展示热度数值或排名。
function renderTrendingSortHelp() {
  const help = document.getElementById('trendingSortHelp');
  if (!help) return;
  const hasHeat = (hotspots.items || []).some(item => getHotspotHeat(item) !== null);
  help.textContent = hasHeat
    ? '热度排序按公开投影中的热度字段倒序，只改变阅读顺序，不改变内容类型、来源与审核状态；热度数值默认不展示。'
    : '当前公开投影暂未提供可比较的热度字段，选择“热度”时仍按最近时间倒序；该字段由数据契约补充后自动生效，不会伪造排序。';
}

// 决策 80：筛选无匹配时“清除筛选”，重置内容类型筛选（平台已非列表级筛选维度），保留排序选择。
function clearTrendingFilters() {
  const changed = activeTrendingType !== 'all';
  setActiveTrendingType('all');
  setRegionBusy(document.getElementById('trendingGrid'), true);
  renderTrending();
  if (changed) announceStatus('已清除热点筛选');
}

// 决策 80：热点数据加载失败时“重新加载”，重新拉取公开投影；失败时保留上一版数据并保持失败状态。
async function reloadHotspots() {
  const grid = document.getElementById('trendingGrid');
  const status = document.getElementById('trendingStatus');
  setRegionBusy(grid, true);
  if (status) status.innerHTML = '<div class="status-note status-neutral" role="status"><strong>正在重新加载：</strong>正在读取公开热点数据。</div>';
  try {
    const resp = await fetch('data/news/output/hotspots.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    setHotspots(await resp.json());
    dataLoadFailures.delete('hotspots');
    announceStatus('热点数据已重新加载');
  } catch (error) {
    dataLoadFailures.add('hotspots');
    announceStatus('热点数据重新加载失败');
  }
  renderTrending();
}

// ═══════════════════════════════════════════════════════════════
// 卡片渲染
// ═══════════════════════════════════════════════════════════════

function renderHotspotMetrics(item) {
  if (!item.metrics) return [];
  return [['views', '浏览'], ['likes', '点赞'], ['comments', '评论'], ['reposts', '转发'], ['replies', '回复']]
    .map(([key, label]) => {
      const value = formatMetric(item.metrics[key]);
      return value === null ? null : { label, value };
    })
    .filter(Boolean);
}

function formatHotspotDate(value, fallback = '时间未知') {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' })
    : fallback;
}

// 决策 78：按热点实体唯一内容发布时间轻量分组（今天/昨天/近 7 天/更早；无效时间归“时间未知”）
function getTrendingGroupLabel(item) {
  const time = new Date(item.published_at).getTime();
  if (!Number.isFinite(time)) return '时间未知';
  const diff = Date.now() - time;
  const day = 86400000;
  if (diff < 0 || diff < day) return '今天';
  if (diff < 2 * day) return '昨天';
  if (diff < 7 * day) return '近 7 天';
  return '更早';
}

// 决策 74/77/87：卡片默认只显示内容类型、标题、短摘要、时间线索与低权重详情入口；
// 平台、作者、互动、来源标签移入详情对话框，不占卡片默认区。
function renderTrendingCard(item) {
  const typeLabel = contentTypeLabels[item.content_type] || item.content_type || '类型未知';
  const published = Number.isFinite(new Date(item.published_at).getTime()) ? timeAgo(item.published_at) : '发布时间未知';
  const preview = item.description || '来源描述暂不可用';
  const sourceDetailId = 'trending-source-detail-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  const meta = platformMeta[item.platform] || { label: item.platform || '平台未知' };
  const sourceUrl = item.url ? safeExternalUrl(item.url) : '#';
  const sourceName = item.author_name || item.source_id || '来源信息待补充';
  const sourceTypeLabel = SOURCE_TYPE_LABELS[item.source_type] || item.source_type || '来源类型未知';
  const sourceEvidence = item.evidence_excerpt || item.source_excerpt || '暂无可展示的直接依据。当前公开投影未提供可定位的审核依据片段。';
  return '<article class="trending-card" data-hotspot-id="' + escapeHtml(item.id) + '" aria-labelledby="trending-title-' + escapeHtml(item.id) + '">' +
    '<div class="trending-card-head"><span class="tag scene">' + escapeHtml(typeLabel) + '</span><span>' + escapeHtml(published) + '</span></div>' +
    '<h3 id="trending-title-' + escapeHtml(item.id) + '"><span class="trending-title">' + escapeHtml(item.title || '标题暂不可用') + '</span></h3>' +
    '<div class="trending-preview-wrap">' +
      '<p class="trending-description' + (item.description ? '' : ' is-missing') + '">' + escapeHtml(preview) + '</p>' +
      (item.description
        ? '<div class="trending-secondary-preview" aria-hidden="true"><span>' + escapeHtml(item.description) + '</span></div>'
        : '') +
    '</div>' +
    '<div class="trending-card-actions">' +
      '<button class="btn-link trending-source-toggle" type="button" data-hotspot-card-source-toggle aria-expanded="false" aria-controls="' + escapeHtml(sourceDetailId) + '">查看来源</button>' +
      '<button class="btn-link trending-open-hint" type="button" data-hotspot-open>打开详情</button>' +
    '</div>' +
    '<div class="trending-card-source-detail" id="' + escapeHtml(sourceDetailId) + '" data-hotspot-card-source hidden>' +
      '<dl class="trending-source-meta">' +
        '<div><dt>来源平台</dt><dd>' + escapeHtml(meta.label) + '</dd></div>' +
        '<div><dt>来源类型</dt><dd>' + escapeHtml(sourceTypeLabel) + '</dd></div>' +
        '<div><dt>来源名称</dt><dd>' + escapeHtml(sourceName) + '</dd></div>' +
        '<div><dt>内容时间</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
        '<div><dt>数据更新于</dt><dd>' + escapeHtml(formatHotspotDate(item.fetched_at)) + '</dd></div>' +
      '</dl>' +
      '<p class="trending-source-evidence"><strong>依据片段：</strong>' + escapeHtml(sourceEvidence) + '</p>' +
      (sourceUrl !== '#' ? '<a class="btn-link trending-source-link" href="' + escapeHtml(sourceUrl) + '" target="_blank" rel="noopener noreferrer">打开原始来源（将离开当前页面） ' + ICON_EXTERNAL + '</a>' : '<p class="trending-source-unavailable">原始来源链接暂不可用。</p>') +
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
    ? '生成于 ' + timeAgo(hotspots.generated_at)
    : '尚未采集';

  if (!items.length) {
    const hasPublicItems = (hotspots.items || []).length > 0;
    // 决策 80：四类空状态各自提供“下一步操作”——筛选无匹配可清除筛选；
    // 没有公开热点/审核建设中可了解规则或返回其他视图；加载失败可重新加载。
    const state = dataLoadFailures.has('hotspots')
      ? renderState({
          icon: '⚠️', title: '热点数据加载失败',
          message: '公开热点数据暂时无法读取。采集失败不会用空结果覆盖上一版数据。',
          type: 'error',
          actions: [{ label: '重新加载', dataKey: 'trending-action', dataValue: 'reload', primary: true }]
        })
      : hasPublicItems
        ? renderState({
            icon: '⌕', title: '当前筛选没有匹配内容',
            message: '当前内容类型下没有可展示的热点，可清除筛选后查看全部。',
            type: 'no-match',
            actions: [{ label: '清除筛选', dataKey: 'trending-action', dataValue: 'clear-filters', primary: true }]
          })
        : hotspots.generated_at
          ? renderState({
              icon: '○', title: '暂无公开热点',
              message: '公开投影已生成，但当前没有可展示内容。候选内容需经 AI 处理与人工审核后才会公开。',
              type: 'unavailable',
              actions: [
                { label: '了解审核与来源规则', dataKey: 'trending-action', dataValue: 'goto-about' },
                { label: '返回工具库', dataKey: 'trending-action', dataValue: 'goto-tools' }
              ]
            })
          : renderState({
              icon: '○', title: '公开投影建设中',
              message: '热点资料正在建立中：旧资料与新采集内容正在整理与审核，通过后逐步公开。',
              type: 'unavailable',
              actions: [
                { label: '了解审核与来源规则', dataKey: 'trending-action', dataValue: 'goto-about' },
                { label: '返回工具库', dataKey: 'trending-action', dataValue: 'goto-tools' }
              ]
            });
    grid.innerHTML = state;
    return;
  }

  // 决策 78：按唯一内容发布时间分组渲染（只显示有内容的分组）
  const groupOrder = ['今天', '昨天', '近 7 天', '更早', '时间未知'];
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
    return '<p class="hotspot-detail-unavailable"><strong>关联资料暂不可用。</strong>当前公开投影没有稳定的工具、概念或场景关联 ID。</p>';
  }

  const groups = [
    { key: 'tools', label: '工具' },
    { key: 'concepts', label: '概念' },
    { key: 'scenes', label: '场景' },
  ];
  const grouped = groups.map(group => ({
    ...group,
    items: resources.filter(resource => resource.type === group.key),
  })).filter(group => group.items.length);

  return grouped.map(group => '<div class="hotspot-related-group"><h4>' + escapeHtml(group.label) + '</h4>' +
    group.items.slice(0, 3).map(resource => resource.available
      ? '<button class="hotspot-related-item" type="button" data-hotspot-related-type="' + escapeHtml(resource.type) + '" data-hotspot-related-id="' + escapeHtml(resource.id) + '"' + (resource.itemId ? ' data-hotspot-related-item="' + escapeHtml(resource.itemId) + '"' : '') + '>' + escapeHtml(resource.label) + ' →</button>'
      : '<span class="hotspot-related-item hotspot-related-unavailable">' + escapeHtml(resource.label) + '：资料暂不可用</span>'
    ).join('') + '</div>').join('');
}

function openHotspotDetail(id, trigger = null) {
  const item = (hotspots.items || []).find(entry => entry.id === id);
  const content = document.getElementById('modalContent');
  if (!item || !content) return;
  const meta = platformMeta[item.platform] || { label: item.platform || '平台未知', icon: '📰' };
  const typeLabel = contentTypeLabels[item.content_type] || item.content_type || '类型未知';
  const sourceTypeLabel = SOURCE_TYPE_LABELS[item.source_type] || item.source_type || '来源类型未知';
  const url = safeExternalUrl(item.url);
  const hasUrl = url !== '#';
  const sourceDetailId = 'hotspot-source-detail-' + String(item.id).replace(/[^a-zA-Z0-9_-]/g, '-');
  setModalScrollPosition(window.scrollY);
  content.innerHTML = '<button class="modal-close" type="button" aria-label="关闭热点详情" onclick="closeModal()">' + ICON_CLOSE + '</button>' +
    '<article class="hotspot-detail" data-hotspot-detail="' + escapeHtml(item.id) + '">' +
      '<span class="eyebrow">' + escapeHtml(typeLabel) + '</span>' +
      '<h2>' + escapeHtml(item.title || '标题暂不可用') + '</h2>' +
      '<section class="hotspot-detail-section hotspot-detail-summary" aria-labelledby="hotspotSummaryTitle">' +
        '<h3 id="hotspotSummaryTitle">内容摘要</h3>' +
        '<p class="hotspot-detail-description">' + escapeHtml(item.description || '内容摘要暂不可用。') + '</p>' +
        '<dl class="hotspot-detail-meta">' +
          '<div><dt>内容时间</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
          '<div><dt>来源作者</dt><dd>' + escapeHtml(item.author_name || '来源信息待补充') + '</dd></div>' +
        '</dl>' +
      '</section>' +
      '<section class="hotspot-detail-section hotspot-detail-sources" aria-labelledby="hotspotSourcesTitle">' +
        '<div class="hotspot-detail-section-heading"><h3 id="hotspotSourcesTitle">来源核验</h3>' +
          '<button class="btn-link hotspot-source-toggle" type="button" data-hotspot-source-toggle aria-expanded="false" aria-controls="' + escapeHtml(sourceDetailId) + '">查看来源</button>' +
        '</div>' +
        '<div class="hotspot-source-detail" id="' + escapeHtml(sourceDetailId) + '" hidden>' +
          '<dl class="hotspot-source-meta">' +
            '<div><dt>来源平台</dt><dd>' + escapeHtml(meta.label) + '</dd></div>' +
            '<div><dt>来源类型</dt><dd>' + escapeHtml(sourceTypeLabel) + '</dd></div>' +
            '<div><dt>内容时间</dt><dd>' + escapeHtml(formatHotspotDate(item.published_at)) + '</dd></div>' +
            '<div><dt>数据更新于</dt><dd>' + escapeHtml(formatHotspotDate(item.fetched_at)) + '</dd></div>' +
            '<div><dt>来源名称</dt><dd>' + escapeHtml(item.author_name || item.source_id || '来源信息待补充') + '</dd></div>' +
          '</dl>' +
          '<p class="hotspot-source-evidence"><strong>依据片段：</strong>暂无可展示的直接依据。当前公开投影未提供可定位的审核依据片段。</p>' +
          (hasUrl
            ? '<a class="btn-link hotspot-source-link" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">打开原始来源（将离开当前页面） ' + ICON_EXTERNAL + '</a>'
            : '<p class="hotspot-detail-unavailable">原始来源链接暂不可用。</p>') +
        '</div>' +
      '</section>' +
      '<section class="hotspot-detail-section hotspot-detail-related" aria-labelledby="hotspotRelatedTitle">' +
        '<h3 id="hotspotRelatedTitle">关联资料</h3>' +
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
  openHotspotDetail,
  getTrendingGroupLabel,
};
