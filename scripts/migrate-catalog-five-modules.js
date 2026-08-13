'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogDir = path.join(root, 'data', 'catalog');
const FILES = {
  vendorCards: 'vendor-cards.json',
  toolCards: 'tool-cards.json',
  level1: 'vendor-preview-level1.json',
  level2: 'vendor-preview-level2.json',
  details: 'tool-preview-level3.json',
};

function readItems(file) {
  const payload = JSON.parse(fs.readFileSync(path.join(catalogDir, file), 'utf8'));
  return Array.isArray(payload) ? payload : payload.items;
}

function writeItems(file, items) {
  fs.writeFileSync(path.join(catalogDir, file), JSON.stringify({ schema_version: 1, items }, null, 2) + '\n', 'utf8');
}

function ref(kind, id) {
  return { kind, id };
}

function unique(values) {
  return [...new Set(values.filter(value => value != null && String(value).trim()))];
}

function normalizeContext(context) {
  if (!context || typeof context !== 'object') return context ?? null;
  const conditions = unique([context.conditions, context.note]).join('；');
  const result = { status: context.status };
  if (context.tokens != null) result.tokens = context.tokens;
  if (conditions) result.conditions = conditions;
  return result;
}

function normalizePricing(pricing) {
  if (!pricing || typeof pricing !== 'object') return pricing ?? null;
  const result = { status: pricing.status };
  if (Array.isArray(pricing.rate_cards)) {
    result.rate_cards = pricing.rate_cards.map(rate => {
      const copy = { ...rate };
      delete copy.source_refs;
      return copy;
    });
  }
  if (Array.isArray(pricing.additional_charges)) {
    result.additional_charges = pricing.additional_charges.map(charge => {
      const copy = { ...charge };
      delete copy.source_refs;
      return copy;
    });
  }
  if (pricing.note) result.note = pricing.note;
  return result;
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== 'object') return plan ?? null;
  const result = { ...plan };
  delete result.source_refs;
  return result;
}

function normalizeSources(sources) {
  return (Array.isArray(sources) ? sources : []).map(source => ({
    title: source.title || source.publisher || source.url || '官方来源',
    url: source.url || '',
  }));
}

function normalizeDetail(detail, cardByDetail) {
  const detailKind = detail.detail_kind || detail.kind;
  const card = cardByDetail.get(detail.id);
  return {
    id: detail.id,
    vendor_key: detail.vendor_key,
    detail_kind: detailKind,
    ...(detailKind !== 'subscription_plan' && card?.theme ? { theme: card.theme } : {}),
    title: detail.title,
    vendor_label: detail.vendor_label,
    icon: detail.icon,
    official_url: detail.official_url,
    status: detail.status,
    summary: detail.summary,
    one_m_context: normalizeContext(detail.one_m_context),
    api_pricing: normalizePricing(detail.api_pricing),
    plan: normalizePlan(detail.plan),
    applicable_scenarios: Array.isArray(detail.applicable_scenarios) ? detail.applicable_scenarios : [],
    inapplicable_scenarios: Array.isArray(detail.inapplicable_scenarios) ? detail.inapplicable_scenarios : [],
    sources: normalizeSources(detail.sources),
    official_date: null,
  };
}

function createProductDetail(card, level1) {
  const title = level1?.entry_label || level1?.title || card.title;
  const officialUrl = level1?.official_url || '';
  return {
    id: `tool-level3:${card.vendor_key}`,
    vendor_key: card.vendor_key,
    detail_kind: 'tool',
    theme: card.vendor_key === 'hailuo' ? 'media' : 'general',
    title,
    vendor_label: card.title,
    icon: level1?.icon || card.icon,
    official_url: officialUrl,
    status: level1?.status || 'unavailable',
    summary: level1?.description || card.summary || '',
    one_m_context: null,
    api_pricing: null,
    plan: null,
    applicable_scenarios: unique(card.scenes).map(title => ({ title, description: '' })),
    inapplicable_scenarios: [],
    sources: officialUrl ? [{ title: '官方产品页', url: officialUrl }] : [],
    official_date: null,
  };
}

function migrate() {
  const vendorCards = readItems(FILES.vendorCards);
  const existingToolCards = readItems(FILES.toolCards);
  const level1 = readItems(FILES.level1);
  const level2 = readItems(FILES.level2);
  const rawDetails = readItems(FILES.details);
  const level1ByVendor = new Map(level1.map(item => [item.vendor_key, item]));
  const vendorByKey = new Map(vendorCards.map(item => [item.vendor_key, item]));
  const cardByDetail = new Map(existingToolCards.map(item => [item.detail_ref?.id, item]));
  const productDetails = vendorCards.map(card => createProductDetail(card, level1ByVendor.get(card.vendor_key)));
  const details = [...productDetails, ...rawDetails.map(item => normalizeDetail(item, cardByDetail))];
  const detailsById = new Map(details.map(item => [item.id, item]));

  const nextVendorCards = vendorCards.map(card => {
    const level1Item = level1ByVendor.get(card.vendor_key);
    const product = detailsById.get(`tool-level3:${card.vendor_key}`);
    return {
      id: card.id,
      vendor_key: card.vendor_key,
      title: card.title,
      icon: card.icon,
      summary: card.summary,
      feature_preview: card.feature_preview,
      access_level: card.access_level,
      price_badge: card.price_status,
      search_terms: unique([card.title, card.vendor_key, level1Item?.entry_label, product?.title]),
      level1_ref: card.level1_ref,
    };
  });

  const nextLevel1 = level1.map(item => ({
    id: item.id,
    vendor_key: item.vendor_key,
    title: item.title,
    icon: item.icon,
    official_url: item.official_url,
    description: item.description,
    status: item.status,
    features: item.features,
    level2_refs: item.level2_refs,
  }));

  const nextLevel2 = level2.map(item => ({
    id: item.id,
    level1_ref: item.level1_ref,
    vendor_key: item.vendor_key,
    title: item.title,
    official_url: item.official_url,
    summary: item.summary,
    status: item.status,
    detail_refs: item.detail_refs,
  }));

  const nextToolCards = [
    ...existingToolCards
      .filter(card => card.detail_kind !== 'subscription_plan')
      .map(card => {
        const detail = detailsById.get(card.detail_ref.id);
        return {
          id: card.id,
          tool_key: card.tool_key,
          vendor_key: card.vendor_key,
          title: card.title,
          vendor_label: card.vendor_label,
          icon: card.icon,
          summary: card.summary,
          theme: detail?.theme || card.theme || 'general',
          scenes: card.scenes,
          best_for_preview: card.best_for_preview,
          not_for_preview: card.not_for_preview,
          price_badge: card.price_badge,
          access_level: card.access_level,
          search_terms: card.search_terms,
          detail_ref: card.detail_ref,
          detail_kind: card.detail_kind,
        };
      }),
    ...productDetails.map(detail => {
      const vendor = vendorByKey.get(detail.vendor_key);
      return {
        id: `tool-card:${detail.vendor_key}`,
        tool_key: detail.vendor_key,
        vendor_key: detail.vendor_key,
        title: detail.title,
        vendor_label: detail.vendor_label,
        icon: detail.icon,
        summary: detail.summary,
        theme: detail.theme,
        scenes: detail.applicable_scenarios.map(item => item.title),
        best_for_preview: detail.applicable_scenarios[0]?.title || '',
        not_for_preview: '',
        price_badge: vendor?.price_status || 'paid',
        access_level: vendor?.access_level || '受限',
        search_terms: unique([detail.title, detail.vendor_label, detail.vendor_key, ...detail.applicable_scenarios.map(item => item.title), detail.summary]),
        detail_ref: ref('tool-level3', detail.id),
        detail_kind: detail.detail_kind,
      };
    }),
  ];

  return {
    files: {
      [FILES.vendorCards]: nextVendorCards,
      [FILES.toolCards]: nextToolCards,
      [FILES.level1]: nextLevel1,
      [FILES.level2]: nextLevel2,
      [FILES.details]: details,
    },
    report: {
      vendorCards: nextVendorCards.length,
      toolCards: nextToolCards.length,
      level1: nextLevel1.length,
      level2: nextLevel2.length,
      details: details.length,
      detailKinds: Object.fromEntries([...new Set(details.map(item => item.detail_kind))].map(kind => [kind, details.filter(item => item.detail_kind === kind).length])),
      removedSubscriptionCards: existingToolCards.filter(item => item.detail_kind === 'subscription_plan').length,
      addedProductTools: productDetails.length,
    },
  };
}

function main() {
  const result = migrate();
  console.log(JSON.stringify(result.report, null, 2));
  if (!process.argv.includes('--apply')) return;
  for (const [file, items] of Object.entries(result.files)) writeItems(file, items);
  console.log('已应用五模块目录迁移。');
}

if (require.main === module) main();

module.exports = { migrate };
