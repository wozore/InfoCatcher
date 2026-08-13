import { escapeHtml, safeExternalUrl, ICON_ARROW_LEFT, ICON_EXTERNAL } from './data.js';

function renderVendorLevel2(request = {}) {
  const { preview, detailCards = [] } = request;
  if (!preview) return '<div class="intelligence-unavailable">厂商二级预览暂不可用。</div>';
  const statusText = { active: '已核实', partial: '部分核实', unknown: '官方资料待核验', legacy_supported: '仍受支持', deprecated: '已弃用', retired: '已停用' }[preview.status] || '资料状态未知';
  return '<div class="model-index-page vendor-preview-level2">' +
    '<button class="model-index-back" type="button" aria-label="返回上一级" title="返回上一级" onclick="goBackModelToolPanel(\'' + escapeHtml(preview.vendor_key) + '\')">' + ICON_ARROW_LEFT + '</button>' +
    '<section class="node-overview model-index-overview"><h2>' + escapeHtml(preview.title) + '</h2>' +
    '<div class="vendor"><a href="' + escapeHtml(safeExternalUrl(preview.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
    '<p class="node-description">' + escapeHtml(preview.summary || '') + '</p></section>' +
    '<div class="model-index-divider" aria-hidden="true"></div>' +
    '<section class="model-tool-panel"><div class="model-index-actions"><div></div><span class="intelligence-status status-' + escapeHtml(preview.status === 'unknown' ? 'partial' : preview.status) + '">' + escapeHtml(statusText) + '</span></div>' +
    '<div class="model-tree-grid">' + detailCards.map(item =>
      '<button class="model-tree-card leaf" type="button" onclick="navigateModelToolPanel(\'' + escapeHtml(preview.vendor_key) + '\',\'' + escapeHtml(item.tool_key) + '\')">' +
        '<span class="node-kind-badge leaf">具体</span><strong>' + escapeHtml(item.title) + '</strong>' +
        '<p>' + escapeHtml(item.summary || '') + '</p>' +
        '<small class="intelligence-status status-' + escapeHtml(item.status === 'unknown' ? 'partial' : item.status) + '">' + escapeHtml(item.status === 'active' ? '已核实' : item.status === 'partial' ? '部分核实' : '资料状态未知') + '</small>' +
        '<span class="model-tree-action">查看数据面板 ›</span></button>'
    ).join('') + '</div></section></div>';
}

export default renderVendorLevel2;
