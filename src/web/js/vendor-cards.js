import { escapeHtml } from './data.js';

function vendorCards(request = {}) {
  if (request.operation === 'list') return request.items || [];
  const card = request.card;
  if (!card) return '';
  const quickItems = (card.quick_level2 || []).slice(0, 5).map(item => ({ id: item.id.split(':').pop(), name: item.title }));
  const collectionItems = Array.from({ length: card.leaf_count || 0 });
  const description = card.overview?.description || card.strengths || card.summary || '';
  const features = card.overview?.features || card.feature_preview || [];
  const collectionSummary = '<div class="collection-summary"><span class="collection-label">厂商模型与工具</span><span>' + collectionItems.length + ' 个可查看叶节点</span></div>' +
    '<div class="collection-quick-list">' + quickItems.map(item =>
      '<button type="button" onclick="event.stopPropagation();openDetail(\'' + escapeHtml(card.vendor_key) + '\',\'' + escapeHtml(item.id) + '\')">' + escapeHtml(item.name) + '</button>'
    ).join('') + '</div>';
  const featurePreview = features.length
    ? '<div class="vendor-feature-preview">' + features.map(feature =>
      '<div class="vendor-feature-slot"><p class="vendor-feature ' + escapeHtml(feature.tone) + '">' + escapeHtml(feature.text) + '</p></div>'
    ).join('') + '</div>'
    : '';
  return `<div class="tool-card collection-card" onclick="openDetail('${escapeHtml(card.vendor_key)}',null,this)">
    <div class="tool-card-header"><div>
      <div class="tool-card-name">${card.icon || ''} ${escapeHtml(card.vendor || card.title || '')}</div>
      <div class="tool-card-vendor">厂商总览</div>
    </div></div>
    <div class="tool-card-desc">${escapeHtml(description)}</div>
    ${collectionSummary}
    ${featurePreview}
  </div>`;
}

export default vendorCards;
