import { escapeHtml } from './data.js';

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
    (card.price_badge === 'free' ? '<span class="tag free">免费可用</span>' : '<span class="tag paid">仅付费</span>') +
    '<span class="tag ' + (card.access_level === '开放' ? 'open' : 'restricted') + '">' + (card.access_level === '开放' ? '国内可用' : '需科学上网') + '</span>' +
    '</div>';
  const openCard = 'openDetail(\'' + escapeHtml(card.detail_ref.id) + '\',null,this)';
  return `<div class="tool-card tool-card--${escapeHtml(card.theme || 'general')}" onclick="${openCard}">
    <div class="tool-card-header"><div>
      <div class="tool-card-name">${card.icon || ''} ${escapeHtml(card.title || '')}</div>
      <div class="tool-card-vendor">${escapeHtml(card.vendor_label || '')}</div>
    </div></div>
    <div class="tool-card-desc">${escapeHtml(card.summary || '')}</div>
    ${fitLines}
    ${tags}
  </div>`;
}

export default toolCards;
