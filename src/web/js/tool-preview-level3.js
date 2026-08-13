import { escapeHtml, safeExternalUrl, formatPrice, renderTimelinessBadge, ICON_ARROW_LEFT, ICON_EXTERNAL } from './data.js';

function renderScenario(title, items) {
  if (!Array.isArray(items) || !items.length) return '';
  return '<div class="intelligence-scenarios"><h5>' + title + '</h5>' + items.map(item =>
    '<div><b>' + escapeHtml(item.title || '') + (item.description ? '：' : '') + '</b>' + escapeHtml(item.description || '') + '</div>'
  ).join('') + '</div>';
}

function renderToolLevel3(request = {}) {
  const { detail, showCompare = false, compareSelected = false, backTarget = null } = request;
  if (!detail) return '<div class="intelligence-unavailable">工具详情暂不可用。</div>';
  const kindLabel = detail.kind === 'api_model' ? '模型' : detail.kind === 'subscription_plan' ? '套餐' : detail.kind === 'product_variant' ? '变体' : '工具';
  const sourceHtml = (detail.sources || []).length
    ? '<div class="intelligence-sources"><b>资料来源：</b>' + detail.sources.map(source =>
      '<a href="' + escapeHtml(safeExternalUrl(source.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
    ).join(' · ') + (detail.last_updated ? '<span>资料更新于 ' + escapeHtml(detail.last_updated) + '</span>' : '') + '</div>'
    : '';
  const context = detail.one_m_context;
  const contextHtml = context
    ? '<div class="intelligence-context"><b>1M 上下文：</b>' + escapeHtml({ native: '原生支持 1M', conditional: '特定条件支持 1M', not_supported: '不支持 1M', unknown: '1M 支持情况未知' }[context.status] || '未知') + (context.tokens ? '（' + Number(context.tokens).toLocaleString('zh-CN') + ' tokens）' : '') + (context.conditions ? '<p>' + escapeHtml(context.conditions) + '</p>' : '') + '</div>'
    : '';
  const rates = detail.api_pricing?.rate_cards || [];
  const pricingHtml = rates.length
    ? '<div class="intelligence-pricing"><h5>API 价格</h5>' + rates.map(rate =>
      '<div class="rate-card"><b>' + escapeHtml(rate.label) + '</b><div class="rate-grid"><span>输入（缓存命中）<strong>' + formatPrice(rate.input_cached, rate.currency) + '</strong></span><span>输入（缓存未命中）<strong>' + formatPrice(rate.input_uncached, rate.currency) + '</strong></span><span>输出<strong>' + formatPrice(rate.output, rate.currency) + '</strong></span></div><small>单位：每百万 tokens · ' + escapeHtml(rate.conditions || '') + '</small></div>'
    ).join('') + '</div>' : '';
  const plan = detail.plan;
  const planHtml = plan
    ? '<div class="plan-card"><h5>套餐信息</h5><p><b>' + formatPrice(plan.amount, plan.currency) + ' / ' + escapeHtml({ month: '月', year: '年', usage: '按量', custom: '定制', unknown: '周期未知' }[plan.billing_period] || plan.billing_period) + '</b></p><p>' + escapeHtml(plan.conditions || '') + '</p><p><b>主要模型：</b>' + (plan.included_models?.length ? plan.included_models.map(escapeHtml).join('、') : '官方未明确列出全部模型') + '</p></div>'
    : '';
    const compareRef = detail.kind === 'tool' ? 'null' : '\'' + escapeHtml(detail.tool_key) + '\'';
  const compareHtml = showCompare
    ? '<div class="leaf-actions"><button class="compare-toggle ' + (compareSelected ? 'selected' : '') + '" onclick="toggleCompareRef(\'' + escapeHtml(detail.vendor_key) + '\',' + compareRef + ',this)">' + (compareSelected ? '已选' : '+对比') + '</button></div>'
    : '';
  const backHtml = backTarget?.vendorKey
    ? '<button class="model-index-back" type="button" aria-label="返回上一级" title="返回上一级" onclick="goBackModelToolPanel(\'' + escapeHtml(backTarget.vendorKey) + '\')">' + ICON_ARROW_LEFT + '</button>'
    : '';
  const vendorHtml = detail.vendor_label
    ? escapeHtml(detail.vendor_label) + ' · '
    : '';
  return '<div class="model-index-page model-leaf-page">' + backHtml +
    '<section class="node-overview model-index-overview"><h2>' + escapeHtml((detail.icon || '') + ' ' + detail.title) + '</h2><div class="vendor">' + vendorHtml + '<a href="' + escapeHtml(safeExternalUrl(detail.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div></section>' +
    '<div class="model-leaf-panel"><div class="model-panel-heading"><div><span class="node-kind-badge leaf">具体' + kindLabel + '</span><h4>' + escapeHtml(detail.title) + '</h4>' + renderTimelinessBadge(detail.last_updated) + '</div>' + compareHtml + '</div>' +
    '<div class="intelligence-item-body"><p>' + escapeHtml(detail.summary || '') + '</p>' + contextHtml + pricingHtml + planHtml + renderScenario('适用场景及说明', detail.applicable_scenarios) + renderScenario('不适用场景及说明', detail.inapplicable_scenarios) + sourceHtml + '</div></div></div>';
}

export { renderToolLevel3 };
export default renderToolLevel3;
