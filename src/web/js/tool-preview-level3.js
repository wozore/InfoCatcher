import { escapeHtml, safeExternalUrl, formatPrice, renderTimelinessBadge } from './ui-helpers.js';
import { getToolDateDisplay } from './date-display.mjs';
import { ICON_ARROW_LEFT, ICON_EXTERNAL } from './ui-icons.js';
import { brandIconHtml } from './brand-icons.js';

function notApplicableHtml(title, value) {
  return value?.status === 'not_applicable'
    ? '<div class="intelligence-not-applicable"><b>' + escapeHtml(title) + '：</b>不适用<p>' + escapeHtml(value.reason || '未提供原因') + '</p></div>'
    : '';
}

function renderScenario(title, items) {
  if (items?.status === 'not_applicable') return notApplicableHtml(title, items);
  if (!Array.isArray(items) || !items.length) return '';
  const invalid = items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || !item.title || !item.description);
  if (invalid) return '<div class="intelligence-scenarios data-invalid"><h5>' + escapeHtml(title) + '</h5><p>资料结构异常，需重新生成后才能展示。</p></div>';
  return '<div class="intelligence-scenarios"><h5>' + escapeHtml(title) + '</h5>' + items.map(item =>
    '<div><b>' + escapeHtml(item.title) + '：</b>' + escapeHtml(item.description) + '</div>'
  ).join('') + '</div>';
}

function renderRateCard(rate) {
  if (Array.isArray(rate.metrics) && rate.metrics.length) {
    return '<div class="rate-card"><b>' + escapeHtml(rate.label) + '</b><div class="rate-grid">' + rate.metrics.map(metric =>
      '<span>' + escapeHtml(metric.label) + '<strong>' + formatPrice(metric.amount, rate.currency) + '</strong><small> / ' + escapeHtml(metric.unit) + '</small></span>'
    ).join('') + '</div><small>' + escapeHtml(rate.pricing_basis || '') + ' · ' + escapeHtml(rate.conditions || '') + '</small></div>';
  }
  return '<div class="rate-card"><b>' + escapeHtml(rate.label) + '</b><div class="rate-grid"><span>输入（缓存命中）<strong>' + formatPrice(rate.input_cached, rate.currency) + '</strong></span><span>输入（缓存未命中）<strong>' + formatPrice(rate.input_uncached, rate.currency) + '</strong></span><span>输出<strong>' + formatPrice(rate.output, rate.currency) + '</strong></span></div><small>单位：每百万 tokens · ' + escapeHtml(rate.conditions || '') + '</small></div>';
}

function renderToolLevel3(request = {}) {
  const { detail, toolKey = null, showCompare = false, compareSelected = false, backRef = null } = request;
  if (!detail) return '<div class="intelligence-unavailable">工具详情暂不可用。</div>';
  const kindLabel = detail.detail_kind === 'api_model' ? '模型' : detail.detail_kind === 'subscription_plan' ? '套餐' : detail.detail_kind === 'product_variant' ? '变体' : '工具';
  const dateDisplay = getToolDateDisplay(detail);
  const showCompareAction = showCompare && detail.detail_kind !== 'subscription_plan';
  const sourceHtml = (detail.sources || []).length
    ? '<div class="intelligence-sources"><b>资料来源：</b>' + detail.sources.map(source =>
      '<a href="' + escapeHtml(safeExternalUrl(source.url)) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(source.title) + '</a>'
    ).join(' · ') + (dateDisplay ? '<span>' + dateDisplay.label + ' ' + escapeHtml(dateDisplay.value) + '</span>' : '') + '</div>'
    : '';
  const context = detail.one_m_context;
  const contextHtml = context?.status === 'not_applicable'
    ? notApplicableHtml('上下文窗口', context)
    : context
      ? '<div class="intelligence-context"><b>1M 上下文：</b>' + escapeHtml({ native: '原生支持 1M', conditional: '特定条件支持 1M', not_supported: '不支持 1M', unknown: '1M 支持情况待核验' }[context.status] || '资料待核验') + (context.tokens ? '（' + Number(context.tokens).toLocaleString('zh-CN') + ' tokens）' : '') + (context.conditions ? '<p>' + escapeHtml(context.conditions) + '</p>' : '') + '</div>'
      : '';
  const pricing = detail.api_pricing;
  const rates = pricing?.status === 'not_applicable' ? [] : pricing?.rate_cards || [];
  const pricingHtml = pricing?.status === 'not_applicable'
    ? notApplicableHtml('API 价格', pricing)
    : rates.length
      ? '<div class="intelligence-pricing"><h5>API 价格</h5>' + rates.map(renderRateCard).join('') + '</div>'
      : '';
  const plan = detail.plan;
  const planHtml = plan?.status === 'not_applicable'
    ? notApplicableHtml('套餐信息', plan)
    : plan
      ? '<div class="plan-card"><h5>套餐信息</h5><p><b>' + formatPrice(plan.amount, plan.currency) + ' / ' + escapeHtml({ month: '月', year: '年', usage: '按量', custom: '定制', unknown: '周期待核验' }[plan.billing_period] || plan.billing_period) + '</b></p><p>' + escapeHtml(plan.conditions || '') + '</p><p><b>主要模型：</b>' + (plan.included_models_status === 'not_listed' ? '官方未列出' : plan.included_models?.length ? plan.included_models.map(escapeHtml).join('、') : '官方资料待核验') + '</p></div>'
      : '';
  const compareHtml = showCompareAction
    ? '<div class="leaf-actions"><button class="compare-toggle ' + (compareSelected ? 'selected' : '') + '" onclick="toggleCompareRef(\'' + escapeHtml(detail.id) + '\',\'' + escapeHtml(detail.id) + '\',this)">' + (compareSelected ? '已选' : '+对比') + '</button></div>'
    : '';
  const backHtml = backRef
    ? '<button class="model-index-back" type="button" aria-label="返回上一级" title="返回上一级" onclick="openDetail(\'' + escapeHtml(backRef) + '\')">' + ICON_ARROW_LEFT + '</button>'
    : '';
  const vendorHtml = detail.vendor_label
    ? escapeHtml(detail.vendor_label) + ' · '
    : '';
  const detailIcon = brandIconHtml({
    vendorKey: detail.vendor_key,
    toolKey,
    detailId: detail.id,
    detailKind: detail.detail_kind,
    emoji: detail.icon,
  });
  return '<div class="model-index-page model-leaf-page">' + backHtml +
    '<section class="node-overview model-index-overview"><h2>' + detailIcon + ' ' + escapeHtml(detail.title) + '</h2><div class="vendor">' + vendorHtml + '<a href="' + escapeHtml(safeExternalUrl(detail.official_url)) + '" target="_blank" rel="noopener noreferrer">官网 ' + ICON_EXTERNAL + '</a></div></section>' +
    '<div class="model-leaf-panel"><div class="model-panel-heading"><div><span class="node-kind-badge leaf">具体' + kindLabel + '</span><h4>' + escapeHtml(detail.title) + '</h4>' + (dateDisplay?.freshnessEligible ? renderTimelinessBadge(dateDisplay.value) : '') + '</div>' + compareHtml + '</div>' +
    '<div class="intelligence-item-body"><p>' + escapeHtml(detail.summary || '') + '</p>' + contextHtml + pricingHtml + planHtml + renderScenario('适用场景及说明', detail.applicable_scenarios) + renderScenario('不适用场景及说明', detail.inapplicable_scenarios) + sourceHtml + '</div></div></div>';
}

export { renderToolLevel3, renderScenario, renderRateCard, notApplicableHtml };
export default renderToolLevel3;
