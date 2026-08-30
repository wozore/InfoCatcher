import { escapeHtml } from './data.js';
import { brandIconHtml } from './brand-icons.js';

function renderPriceTag(value) {
  const labels = {
    free: ['free', '免费可用'],
    paid: ['paid', '仅付费'],
    freemium: ['free', '含免费额度'],
    usage_based: ['paid', '按量计费'],
  };
  const [tone, label] = labels[value] || ['neutral', '价格待核验'];
  return '<span class="tag ' + tone + '">' + label + '</span>';
}

function renderAccessTag(value) {
  const labels = {
    '开放': ['open', '国内可用'],
    '受限': ['restricted', '访问受限'],
    '区域限制': ['restricted', '区域限制'],
  };
  const [tone, label] = labels[value] || ['neutral', '访问待核验'];
  return '<span class="tag ' + tone + '">' + label + '</span>';
}

function toolCards(request = {}) {
  if (request.operation === 'list') return request.items || [];
  const card = request.card;
  if (!card) return '';
  const detailKindLabel = card.detail_kind === 'api_model'
    ? 'API 模型'
    : card.detail_kind === 'subscription_plan'
      ? '订阅套餐'
      : card.detail_kind === 'product_variant' ? '产品变体' : '';
  const fitLines = card.best_for_preview || card.not_for_preview || detailKindLabel
    ? '<div class="tool-card-fit">' +
      (detailKindLabel ? '<p class="tool-card-kind">' + escapeHtml(detailKindLabel) + '</p>' : '') +
      (card.best_for_preview ? '<p class="fit-pos">适合：' + escapeHtml(card.best_for_preview) + '</p>' : '') +
      (card.not_for_preview ? '<p class="fit-neg">不适合：' + escapeHtml(card.not_for_preview) + '</p>' : '') +
      '</div>'
    : '';
  const tags = '<div class="tool-card-tags">' +
    renderPriceTag(card.price_badge) +
    renderAccessTag(card.access_level) +
    '</div>';
  const openCard = 'openDetail(\'' + escapeHtml(card.detail_ref.id) + '\',null,this)';
  const canCompare = ['tool', 'api_model', 'product_variant'].includes(card.detail_kind);
  const compareSelected = request.compareSelected === true;
  const compareHtml = canCompare
    ? '<div class="tool-card-actions-only"><button class="compare-toggle ' + (compareSelected ? 'selected' : '') + '" type="button" aria-pressed="' + String(compareSelected) + '" onclick="event.stopPropagation();toggleCompareRef(\'' + escapeHtml(card.detail_ref.id) + '\',\'' + escapeHtml(card.detail_ref.id) + '\',this)">' + (compareSelected ? '已选' : '+对比') + '</button></div>'
    : '';
  return `<div class="tool-card tool-card--${escapeHtml(card.theme || 'general')}" onclick="${openCard}">
    <div class="tool-card-header"><div>
      <div class="tool-card-name">${brandIconHtml({ vendorKey: card.vendor_key, toolKey: card.tool_key, detailId: card.detail_ref?.id, detailKind: card.detail_kind, emoji: card.icon })} ${escapeHtml(card.title || '')}</div>
      <div class="tool-card-vendor">${escapeHtml(card.vendor_label || '')}</div>
    </div></div>
    <div class="tool-card-desc">${escapeHtml(card.summary || '')}</div>
    ${fitLines}
    ${tags}
    ${compareHtml}
  </div>`;
}

export { renderPriceTag, renderAccessTag };
export default toolCards;
