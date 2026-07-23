'use strict';

const TERMINAL_STATUSES = new Set(['complete', 'observed_empty', 'partial', 'history_unsupported', 'skipped_by_user']);
const BLOCKING_STATUSES = new Set(['quota_paused', 'running', 'temporarily_failed', 'waiting_authorization']);

function validateTimeLayers(layers) {
  if (!Array.isArray(layers) || layers.length === 0) throw new Error('time_layers 不能为空');
  let previousMax = 0;
  for (const layer of layers) {
    if (!layer.id || layer.min_age_days !== previousMax || layer.max_age_days <= layer.min_age_days) {
      throw new Error(`时间层不连续或无效: ${layer.id || 'unknown'}`);
    }
    previousMax = layer.max_age_days;
  }
  return true;
}

function classifyTimeLayer(publishedAt, layers, nowUtcMs = Date.now()) {
  validateTimeLayers(layers);
  const publishedMs = new Date(publishedAt).getTime();
  if (!Number.isFinite(publishedMs)) return null;
  const ageDays = (nowUtcMs - publishedMs) / 86400000;
  if (ageDays < 0) return null;
  return layers.find(layer => ageDays >= layer.min_age_days && ageDays < layer.max_age_days)?.id || null;
}

function sourceLayerKey(layerId, sourceId) {
  return `${layerId}:${sourceId}`;
}

function createSchedulerState(existing = null) {
  const state = existing || { schema_version: 1, active_layer: null, layer_coverage: {}, sources: {} };
  state.layer_coverage ||= {};
  state.sources ||= {};
  return state;
}

function initializeLayer(state, layer, sources, now = new Date().toISOString()) {
  state.active_layer ||= layer.id;
  state.layer_coverage[layer.id] ||= { status: 'running', started_at: now, completed_at: null };
  for (const source of sources) {
    const key = sourceLayerKey(layer.id, source.id);
    state.sources[key] ||= {
      layer_id: layer.id,
      source_id: source.id,
      status: 'running',
      page_token: null,
      pages_fetched: 0,
      items_observed: 0,
      oldest_observed_at: null,
      new_video_count: 0,
      duplicate_count: 0,
      filtered_count: 0,
      stop_reason: null,
      checked_at: null,
    };
  }
  return state;
}

function updateSourceProgress(state, layerId, sourceId, changes, now = new Date().toISOString()) {
  const key = sourceLayerKey(layerId, sourceId);
  if (!state.sources[key]) throw new Error(`来源层状态不存在: ${key}`);
  Object.assign(state.sources[key], changes, { checked_at: now });
  return state.sources[key];
}

function layerStatus(state, layerId, sourceIds) {
  const statuses = sourceIds.map(id => state.sources[sourceLayerKey(layerId, id)]?.status || 'running');
  if (statuses.some(status => BLOCKING_STATUSES.has(status))) return 'blocked';
  if (statuses.every(status => TERMINAL_STATUSES.has(status))) return 'complete';
  return 'running';
}

function advanceLayer(state, layers, sourceIds, now = new Date().toISOString()) {
  const currentIndex = layers.findIndex(layer => layer.id === state.active_layer);
  if (currentIndex < 0) return { advanced: false, reason: 'no_active_layer' };
  const status = layerStatus(state, state.active_layer, sourceIds);
  state.layer_coverage[state.active_layer].status = status;
  if (status !== 'complete') return { advanced: false, reason: status };
  state.layer_coverage[state.active_layer].completed_at = now;
  const next = layers[currentIndex + 1];
  if (!next) {
    state.active_layer = null;
    return { advanced: true, complete: true, next_layer: null };
  }
  state.active_layer = next.id;
  return { advanced: true, complete: false, next_layer: next.id };
}

function eligibleForLowFrequencyBackfill(source, recentNewCount, config) {
  const rule = config.low_frequency_backfill;
  if (!rule?.enabled) return false;
  return rule.cadence_classes.includes(source.cadence_class)
    && Number(source.quality_prior || 0) >= rule.min_quality_prior
    && Number(source.ai_relevance ?? 1) >= rule.min_ai_relevance
    && recentNewCount < rule.min_recent_new_videos;
}

module.exports = {
  TERMINAL_STATUSES, BLOCKING_STATUSES, validateTimeLayers, classifyTimeLayer,
  sourceLayerKey, createSchedulerState, initializeLayer, updateSourceProgress,
  layerStatus, advanceLayer, eligibleForLowFrequencyBackfill,
};
