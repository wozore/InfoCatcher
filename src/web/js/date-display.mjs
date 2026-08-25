const DATE_LABELS = Object.freeze({
  tool: '最近更新',
  api_model: '发布日期',
  product_variant: '发布日期',
});

function isDateValue(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function getToolDateDisplay(detail) {
  if (!detail || detail.detail_kind === 'subscription_plan') return null;
  const typed = detail.detail_kind === 'tool'
    ? { value: detail.last_updated_date, kind: 'tool' }
    : detail.detail_kind === 'api_model' || detail.detail_kind === 'product_variant'
      ? { value: detail.release_date, kind: detail.detail_kind }
      : null;
  return typed && isDateValue(typed.value)
    ? { label: DATE_LABELS[detail.detail_kind], value: typed.value, kind: typed.kind, freshnessEligible: true }
    : null;
}

function getToolDetailKindLabel(detail) {
  return detail?.detail_kind === 'api_model'
    ? 'API 模型'
    : detail?.detail_kind === 'subscription_plan'
      ? '订阅套餐'
      : detail?.detail_kind === 'product_variant'
        ? '产品变体'
        : detail?.detail_kind === 'tool' ? '具体工具' : '';
}

export { getToolDateDisplay, getToolDetailKindLabel, isDateValue };
