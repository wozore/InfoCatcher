import { escapeHtml } from './data.js';

function vendorCards(request = {}) {
  if (request.operation === 'list') return request.items || [];
  const { card, quickItems = [], leafCount = 0 } = request;
  if (!card) return '';
  const description = card.summary || '';
  const features = card.feature_preview || [];
  const collectionSummary = '<div class="collection-summary"><span class="collection-label">厂商模型与工具</span><span>' + leafCount + ' 个可查看叶节点</span></div>' +
    '<div class="collection-quick-list">' + quickItems.slice(0, 5).map(item =>
      '<button type="button" onclick="event.stopPropagation();openDetail(\'' + escapeHtml(item.id) + '\')">' + escapeHtml(item.title) + '</button>'
    ).join('') + '</div>';
  const featurePreview = features.length
    ? '<div class="vendor-feature-preview">' + features.map(feature =>
      '<div class="vendor-feature-slot"><p class="vendor-feature ' + escapeHtml(feature.tone) + '">' + escapeHtml(feature.text) + '</p></div>'
    ).join('') + '</div>'
    : '';
  return `<div class="tool-card collection-card" onclick="openDetail('${escapeHtml(card.level1_ref.id)}',null,this)">
    <div class="tool-card-header"><div>
      <div class="tool-card-name">${card.icon || ''} ${escapeHtml(card.title || '')}</div>
      <div class="tool-card-vendor">厂商总览</div>
    </div></div>
    <div class="tool-card-desc">${escapeHtml(description)}</div>
    ${collectionSummary}
    ${featurePreview}
  </div>`;
}

export default vendorCards;
