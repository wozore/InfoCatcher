import { escapeHtml, safeExternalUrl } from '../ui/ui-helpers.js';
import { ICON_ARROW_LEFT, ICON_EXTERNAL } from '../ui/ui-icons.js';

function renderVendorLevel2(request = {}) {
  const { preview, detailCards = [] } = request;
  if (!preview) return '<div class="intelligence-unavailable">厂商二级预览暂不可用。</div>';
  const statusText = { active: '已核实', partial: '部分核实', unknown: '官方资料待核验', legacy_supported: '仍受支持', deprecated: '已弃用', retired: '已停用' }[preview.status] || '资料状态未知';
  const comparableKinds = new Set(['api_model', 'subscription_plan']);
  const comparableCards = detailCards.filter(item => comparableKinds.has(item.detail_kind));
  const canCompareGroup = comparableCards.length >= 2 && comparableCards.every(item => item.detail_kind === comparableCards[0].detail_kind);
  const compareLabel = comparableCards[0]?.detail_kind === 'subscription_plan' ? '对比本组套餐' : '对比本组模型';
  return '<div class="model-index-page vendor-preview-level2">' +
    '<button class="model-index-back" type="button" aria-label="返回上一级" title="返回上一级" onclick="openDetail(\'' + escapeHtml(preview.level1_ref.id) + '\')">' + ICON_ARROW_LEFT + '</button>' +
    '<section class="node-overview model-index-overview"><h2>' + escapeHtml(preview.title) + '</h2>' +
    '<div class="vendor"><a href="' + escapeHtml(safeExternalUrl(preview.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div>' +
    '<p class="node-description">' + escapeHtml(preview.summary || '') + '</p></section>' +
    '<div class="model-index-divider" aria-hidden="true"></div>' +
    '<section class="model-tool-panel"><div class="model-index-actions"><div>' + (canCompareGroup ? '<button class="btn btn-small" type="button" onclick="compareGroupLeaves(\'' + escapeHtml(preview.vendor_key) + '\',\'' + escapeHtml(preview.id) + '\')">' + compareLabel + '</button>' : '') + '</div><span class="intelligence-status status-' + escapeHtml(preview.status === 'unknown' ? 'partial' : preview.status) + '">' + escapeHtml(statusText) + '</span></div>' +
    '<div class="model-tree-grid">' + detailCards.map(item =>
      '<button class="model-tree-card leaf" type="button" onclick="openDetail(\'' + escapeHtml(item.id) + '\',null,this,\'' + escapeHtml(preview.id) + '\')">' +
        '<span class="node-kind-badge leaf">具体</span><strong>' + escapeHtml(item.title) + '</strong>' +
        '<p>' + escapeHtml(item.summary || '') + '</p>' +
        '<small class="intelligence-status status-' + escapeHtml(item.status === 'unknown' ? 'partial' : item.status) + '">' + escapeHtml(item.status === 'active' ? '已核实' : item.status === 'partial' ? '部分核实' : '资料状态未知') + '</small>' +
        '<span class="model-tree-action">查看详情 ›</span></button>'
    ).join('') + '</div></section></div>';
}

export default renderVendorLevel2;
