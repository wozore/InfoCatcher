'use strict';

const crypto = require('crypto');

const DISCOVERY = new Set([
  'discovered', 'backfill_candidate', 'filtered_non_ai', 'duplicate_observation',
  'quota_paused', 'waiting_authorization', 'temporarily_failed', 'permanently_failed',
]);
const PROCESSING = new Set(['pending', 'details_fetched', 'analysis_pending', 'assessed', 'published', 'failed']);

function registryKey(platform, nativeId, canonicalUrl = '') {
  if (!platform) throw new Error('registry key 缺少 platform');
  if (nativeId) return `${platform}:${nativeId}`;
  if (!canonicalUrl) throw new Error('缺少 native_id 时必须提供 canonical_url');
  const hash = crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24);
  return `${platform}:url-${hash}`;
}

function urlKey(platform, canonicalUrl) {
  return `${platform}:${canonicalUrl}`;
}

function createRegistry(data = null) {
  const registry = data || { schema_version: 1, updated_at: null, videos: {}, stats: { count: 0 } };
  registry.videos ||= {};
  registry.stats ||= { count: Object.keys(registry.videos).length };
  const byKey = new Map(Object.entries(registry.videos));
  const byUrl = new Map();
  const bySource = new Map();
  for (const [key, record] of byKey) {
    record.key ||= key;
    if (record.canonical_url) byUrl.set(urlKey(record.platform, record.canonical_url), record);
    if (!bySource.has(record.source_id)) bySource.set(record.source_id, new Set());
    bySource.get(record.source_id).add(key);
  }
  return { registry, byKey, byUrl, bySource };
}

function discoverVideo(index, candidate, options = {}) {
  const now = options.now || new Date().toISOString();
  const canonicalUrl = candidate.canonical_url || candidate.url || '';
  const key = registryKey(candidate.platform, candidate.native_id, canonicalUrl);
  const existing = index.byKey.get(key) || (canonicalUrl ? index.byUrl.get(urlKey(candidate.platform, canonicalUrl)) : null);
  if (existing) {
    existing.last_seen_at = now;
    existing.times_seen = (existing.times_seen || 1) + 1;
    existing.source_layers = [...new Set([...(existing.source_layers || []), candidate.layer_id].filter(Boolean))];
    return { key: existing.key || key, record: existing, isNew: false };
  }
  const record = {
    key,
    platform: candidate.platform,
    native_id: candidate.native_id || null,
    id_fallback: candidate.native_id ? null : 'canonical_url_hash',
    source_id: candidate.source_id,
    canonical_url: canonicalUrl,
    title: candidate.title || '',
    published_at: candidate.published_at || null,
    first_seen_at: now,
    last_seen_at: now,
    last_processed_at: null,
    source_layers: candidate.layer_id ? [candidate.layer_id] : [],
    discovery_status: candidate.discovery_status || 'discovered',
    processing_status: 'pending',
    details_fetched: false,
    analysis_completed: false,
    analysis_version: null,
    duplicate_skipped: false,
    times_seen: 1,
    failure: null,
  };
  index.registry.videos[key] = record;
  index.byKey.set(key, record);
  if (canonicalUrl) index.byUrl.set(urlKey(candidate.platform, canonicalUrl), record);
  if (!index.bySource.has(record.source_id)) index.bySource.set(record.source_id, new Set());
  index.bySource.get(record.source_id).add(key);
  index.registry.stats.count = index.byKey.size;
  return { key, record, isNew: true };
}

function bulkDiscover(index, candidates, options = {}) {
  return candidates.map(candidate => discoverVideo(index, candidate, options));
}

function updateLifecycle(record, changes, now = new Date().toISOString()) {
  if (changes.discovery_status && !DISCOVERY.has(changes.discovery_status)) throw new Error(`无效 discovery_status: ${changes.discovery_status}`);
  if (changes.processing_status && !PROCESSING.has(changes.processing_status)) throw new Error(`无效 processing_status: ${changes.processing_status}`);
  Object.assign(record, changes, { last_processed_at: now });
  return record;
}

function needsExpensiveProcessing(record, analysisVersion) {
  if (!record.details_fetched) return true;
  if (!record.analysis_completed) return true;
  return Boolean(analysisVersion && record.analysis_version !== analysisVersion);
}

function finalizeRegistry(index, now = new Date().toISOString()) {
  index.registry.updated_at = now;
  index.registry.stats.count = index.byKey.size;
  return index.registry;
}

module.exports = {
  DISCOVERY, PROCESSING, registryKey, createRegistry, discoverVideo, bulkDiscover,
  updateLifecycle, needsExpensiveProcessing, finalizeRegistry,
};
