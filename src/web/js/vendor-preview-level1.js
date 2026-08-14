import { escapeHtml, safeExternalUrl, ICON_EXTERNAL } from './data.js';

function renderVendorLevel1(request = {}) {
  const { vendor, preview, level2 = [] } = request;
  if (!preview) return '<div class="intelligence-unavailable">厂商一级预览暂不可用。</div>';
  const statusText = { verified: '已核实', partial: '部分核实', conflict: '资料冲突', unavailable: '资料不可用', unknown: '官方资料待核验' }[preview.status] || '资料状态待核验';
  return '<section class="openai-root vendor-preview-level1">' +
    '<h2>' + escapeHtml((preview.icon || vendor?.icon || '') + ' ' + (preview.title || vendor?.title || '')) + '</h2>' +
    '<div class="vendor"><a href="' + escapeHtml(safeExternalUrl(preview.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
    '<p class="vendor-description">' + escapeHtml(preview.description || '') + '</p>' +
    '<section class="model-tool-panel"><div class="intelligence-heading"><h3>模型与工具</h3><span class="intelligence-status status-' + escapeHtml(preview.status === 'unknown' ? 'partial' : preview.status) + '">' + escapeHtml(statusText) + '</span></div>' +
    '<div class="model-tree-grid">' + level2.map(item =>
      '<button class="model-tree-card" type="button" onclick="openDetail(\'' + escapeHtml(item.id) + '\')">' +
        '<span class="node-kind-badge group">分类</span><strong>' + escapeHtml(item.title) + '</strong>' +
        '<p>' + escapeHtml(item.summary || '') + '</p>' +
        '<small class="intelligence-status status-' + escapeHtml(item.status === 'unknown' ? 'partial' : item.status) + '">' + escapeHtml(item.status === 'active' ? '已核实' : item.status === 'partial' ? '部分核实' : item.status === 'unknown' ? '官方资料待核验' : '资料状态未知') + '</small>' +
        '<span class="model-tree-action">进入分类 ›</span></button>'
    ).join('') + '</div></section>' +
    '<section class="vendor-features"><h4>特点</h4>' + (preview.features || []).map(feature =>
      '<p class="vendor-feature ' + (feature.tone === 'negative' ? 'negative' : 'positive') + '">' + escapeHtml(feature.text) + '</p>'
    ).join('') + '</section>' +
  '</section>';
}

export default renderVendorLevel1;
