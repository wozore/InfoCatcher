import { escapeHtml } from './data.js';
import { brandIconHtml } from './brand-icons.js';

// 兼容已带「优点：/限制：」前缀的旧数据：标签由渲染端统一加，前缀先剥离避免重复
function stripTonePrefix(text) {
  return String(text || '').replace(/^(优点|优势|缺点|劣势|限制|不足)\s*[:：]\s*/, '');
}

function vendorCards(request = {}) {
  if (request.operation === 'list') return request.items || [];
  const { card, quickItems = [], leafCount = 0 } = request;
  if (!card) return '';
  const description = card.summary || '';
  const features = card.feature_preview || [];
  // 优点/缺点各取一条（第一个 positive / 第一个 negative），卡片只显示一行优点 + 一行缺点
  const positive = (features.find(feature => feature.tone !== 'negative')?.text) || '';
  const negative = (features.find(feature => feature.tone === 'negative')?.text) || '';
  const collectionSummary = '<div class="collection-summary"><span class="collection-label">厂商模型与工具</span><span>' + leafCount + ' 个可查看叶节点</span></div>' +
    '<div class="collection-quick-list">' + quickItems.slice(0, 5).map(item =>
      '<button type="button" onclick="event.stopPropagation();openDetail(\'' + escapeHtml(item.id) + '\')">' + escapeHtml(item.title) + '</button>'
    ).join('') + '</div>';
  const featurePreview = (positive || negative)
    ? '<div class="vendor-feature-preview">' +
      (positive ? '<div class="vendor-feature-slot"><p class="vendor-feature positive"><b>优点：</b>' + escapeHtml(stripTonePrefix(positive)) + '</p></div>' : '') +
      (negative ? '<div class="vendor-feature-slot"><p class="vendor-feature negative"><b>缺点：</b>' + escapeHtml(stripTonePrefix(negative)) + '</p></div>' : '') +
      '</div>'
    : '';
  return `<div class="tool-card collection-card" onclick="openDetail('${escapeHtml(card.level1_ref.id)}',null,this)">
    <div class="tool-card-header"><div>
      <div class="tool-card-name">${brandIconHtml({ vendorKey: card.vendor_key, emoji: card.icon, cls: 'brand-icon' })} ${escapeHtml(card.title || '')}</div>
      <div class="tool-card-vendor">厂商总览</div>
    </div></div>
    <div class="tool-card-desc">${escapeHtml(description)}</div>
    ${collectionSummary}
    ${featurePreview}
  </div>`;
}

export default vendorCards;
