'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const catalogDir = path.join(root, 'data', 'catalog');
const tools = JSON.parse(fs.readFileSync(path.join(catalogDir, 'tools.json'), 'utf8'));
const intelligence = JSON.parse(fs.readFileSync(path.join(catalogDir, 'tool-intelligence.json'), 'utf8'));
const toolById = new Map(tools.map(tool => [tool.id, tool]));
const collectionByToolId = new Map((intelligence.collections || []).map(collection => [collection.tool_id, collection]));

const ref = (kind, id) => ({ kind, id });
const level1Id = toolId => `vendor-level1:${toolId}`;
const level2Id = (toolId, nodeId) => `vendor-level2:${toolId}:${nodeId}`;
const level3Id = itemId => `tool-level3:${itemId}`;
const level3ConcreteId = toolId => `tool-level3:${toolId}`;

function sourceRecord(source) {
  return {
    id: source.id,
    title: source.title,
    url: source.url,
    publisher: source.publisher,
    source_type: source.source_type,
    queried_at: source.queried_at,
  };
}

function sourceRecords(collection, refs) {
  const wanted = new Set(refs || []);
  return (collection?.sources || []).filter(source => wanted.has(source.id)).map(sourceRecord);
}

function scenarios(items) {
  return (items || []).map(item => typeof item === 'string'
    ? { title: item, description: '' }
    : { title: item.title || '', description: item.description || '' });
}

function textScenario(items) {
  return scenarios(items).map(item => [item.title, item.description].filter(Boolean).join('：')).filter(Boolean);
}

function priceStatus(tool) {
  if (!tool.free_tier) return 'unknown';
  if (!tool.free_tier.includes('无免费') && !tool.free_tier.startsWith('无(')) return 'free';
  return 'paid';
}

function makeVendorCard(tool, collection) {
  const overview = tool.overview || {};
  const features = Array.isArray(overview.features) && overview.features.length
    ? overview.features.map(feature => ({ tone: feature.tone, text: feature.text }))
    : [
      { tone: 'positive', text: `优点：${tool.strengths || ''}` },
      { tone: 'negative', text: `限制：${tool.weaknesses || ''}` },
    ];
  return {
    id: `vendor-card:${tool.id}`,
    vendor_key: tool.id,
    title: tool.vendor,
    icon: tool.icon,
    summary: overview.description || tool.strengths || '',
    feature_preview: features,
    categories: [...(tool.category || [])],
    scenes: [...(tool.scenes || [])],
    access_level: tool.access_level,
    price_status: priceStatus(tool),
    search_terms: [tool.vendor, tool.name, ...(tool.category || []), ...(tool.scenes || [])].filter(Boolean),
    level1_ref: ref('vendor-level1', level1Id(tool.id)),
  };
}

function makeLevel1(tool, collection) {
  const groups = (collection?.items || []).filter(item => item.node_type === 'group' && item.display_in_tree !== false);
  const overview = tool.overview || {};
  const features = Array.isArray(overview.features) && overview.features.length
    ? overview.features.map(feature => ({ tone: feature.tone, text: feature.text }))
    : [
      { tone: 'positive', text: `优点：${tool.strengths || ''}` },
      { tone: 'negative', text: `限制：${tool.weaknesses || ''}` },
    ];
  return {
    id: level1Id(tool.id),
    vendor_key: tool.id,
    title: tool.vendor,
    entry_label: tool.name,
    display_title: `${tool.vendor}（${tool.name}）`,
    icon: tool.icon,
    official_url: tool.url,
    description: overview.description || tool.strengths || '',
    status: collection?.status || 'unavailable',
    features,
    level2_refs: groups.map(item => ref('vendor-level2', level2Id(tool.id, item.id))),
    citations: sourceRecords(collection, overview.source_refs),
  };
}

function leafDescendants(items, parentId) {
  return (items || []).filter(item => item.node_type === 'leaf' && item.display_in_tree !== false && item.parent_id === parentId);
}

function makeLevel2(toolId, collection, item) {
  const children = leafDescendants(collection.items, item.id);
  return {
    id: level2Id(toolId, item.id),
    level1_ref: ref('vendor-level1', level1Id(toolId)),
    vendor_key: toolId,
    title: item.name,
    kind: item.kind,
    official_url: item.official_url,
    summary: item.summary || '',
    status: item.status,
    detail_refs: children.map(child => ref('tool-level3', level3Id(child.id))),
    citations: sourceRecords(collection, item.source_refs),
  };
}

function makeIntelligenceLevel3(tool, collection, item) {
  return {
    id: level3Id(item.id),
    tool_key: item.id,
    vendor_key: tool.id,
    kind: item.kind,
    title: item.name,
    vendor_label: tool.vendor,
    icon: tool.icon,
    official_url: item.official_url || tool.url,
    status: item.status,
    summary: item.summary || '',
    one_m_context: item.one_m_context || null,
    api_pricing: item.api_pricing || null,
    cache_hit_rate: item.cache_hit_rate || null,
    plan: item.plan || null,
    applicable_scenarios: scenarios(item.applicable_scenarios),
    inapplicable_scenarios: scenarios(item.inapplicable_scenarios),
    source_refs: [...(item.source_refs || [])],
    sources: sourceRecords(collection, item.source_refs),
    category: [...(tool.category || [])],
    scenes: [...new Set([...textScenario(item.applicable_scenarios), ...textScenario(item.inapplicable_scenarios)])],
    access_level: tool.access_level,
    access_barrier: tool.access_barrier,
    last_updated: sourceRecords(collection, item.source_refs).map(source => source.queried_at).filter(Boolean).sort().reverse()[0]?.slice(0, 10) || null,
  };
}

function makeConcreteLevel3(tool) {
  const sourceId = `${tool.id}-catalog-source`;
  return {
    id: level3ConcreteId(tool.id),
    tool_key: tool.id,
    vendor_key: tool.id,
    kind: 'tool',
    title: tool.name,
    vendor_label: tool.vendor,
    icon: tool.icon,
    official_url: tool.url,
    status: 'active',
    summary: tool.strengths || '',
    weaknesses: tool.weaknesses || '',
    one_m_context: null,
    api_pricing: null,
    cache_hit_rate: null,
    plan: null,
    applicable_scenarios: scenarios(tool.best_for),
    inapplicable_scenarios: scenarios(tool.not_for),
    source_refs: [sourceId],
    sources: [{ id: sourceId, title: tool.source || tool.name, url: tool.url, publisher: tool.vendor, source_type: 'official', queried_at: tool.last_updated ? `${tool.last_updated}T00:00:00.000Z` : null }],
    category: [...(tool.category || [])],
    scenes: [...(tool.scenes || [])],
    access_level: tool.access_level,
    access_barrier: tool.access_barrier,
    free_tier: tool.free_tier || '',
    paid_tiers: [...(tool.paid_tiers || [])],
    last_updated: tool.last_updated || null,
  };
}

function makeToolCardFromLevel3(detail, tool) {
  const applicable = textScenario(detail.applicable_scenarios);
  const inapplicable = textScenario(detail.inapplicable_scenarios);
  const isConcrete = detail.kind === 'tool';
  return {
    id: `tool-card:${detail.tool_key}`,
    tool_key: detail.tool_key,
    vendor_key: detail.vendor_key,
    title: detail.title,
    vendor_label: detail.vendor_label,
    icon: detail.icon,
    summary: detail.summary || '',
    theme: tool?.card_type || 'general',
    categories: [...(detail.category || [])],
    scenes: [...new Set([...(detail.scenes || []), ...applicable, ...inapplicable])],
    best_for_preview: applicable[0] || '',
    not_for_preview: inapplicable[0] || '',
    price_badge: isConcrete ? (detail.free_tier && !detail.free_tier.includes('无免费') && !detail.free_tier.startsWith('无(') ? 'free' : 'paid') : 'paid',
    access_level: detail.access_level,
    search_terms: [detail.title, detail.vendor_label, ...(detail.category || []), ...(detail.scenes || []), detail.summary].filter(Boolean),
    detail_ref: ref('tool-level3', detail.id),
    detail_kind: detail.kind,
  };
}

const collections = tools.filter(tool => tool.card_kind === 'collection');
const vendorCards = collections.map(tool => makeVendorCard(tool, collectionByToolId.get(tool.id)));
const level1 = collections.map(tool => makeLevel1(tool, collectionByToolId.get(tool.id)));
const level2 = collections.flatMap(tool => {
  const collection = collectionByToolId.get(tool.id);
  return (collection?.items || []).filter(item => item.node_type === 'group' && item.display_in_tree !== false).map(item => makeLevel2(tool.id, collection, item));
});
const intelligenceDetails = collections.flatMap(tool => {
  const collection = collectionByToolId.get(tool.id);
  return (collection?.items || []).filter(item => item.node_type === 'leaf').map(item => makeIntelligenceLevel3(tool, collection, item));
});
const concreteDetails = tools.filter(tool => tool.card_kind !== 'collection').map(makeConcreteLevel3);
const details = [...concreteDetails, ...intelligenceDetails];
const detailById = new Map(details.map(item => [item.id, item]));
const toolCards = details.map(detail => makeToolCardFromLevel3(detail, toolById.get(detail.vendor_key)));

function write(name, value) {
  fs.writeFileSync(path.join(catalogDir, name), JSON.stringify({ schema_version: 1, items: value }, null, 2) + '\n', 'utf8');
}

write('vendor-cards.json', vendorCards);
write('tool-cards.json', toolCards);
write('vendor-preview-level1.json', level1);
write('vendor-preview-level2.json', level2);
write('tool-preview-level3.json', details);

const report = {
  vendorCards: vendorCards.length,
  toolCards: toolCards.length,
  vendorLevel1: level1.length,
  vendorLevel2: level2.length,
  toolLevel3: details.length,
  missingLevel1: vendorCards.filter(card => !level1.some(item => item.id === card.level1_ref.id)).map(card => card.id),
  missingLevel2: level1.flatMap(item => item.level2_refs).filter(item => !level2.some(level => level.id === item.id)),
  missingLevel3: [...level2.flatMap(item => item.detail_refs), ...toolCards.map(card => card.detail_ref)].filter(item => !detailById.has(item.id)),
};
fs.writeFileSync(path.join(catalogDir, 'catalog-five-modules-migration-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(report, null, 2));
