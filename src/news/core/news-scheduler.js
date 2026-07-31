/**
 * news-scheduler.js — 统一五层 UTC 时间窗口与时间层优先编排
 *
 * 在热点管线中的位置：被 build-news.js 的 runHistoricalLayerPass() 使用，
 * 在最新 Feed 采集完成后，决定当前应处理哪一层、哪些来源、是否可以推进。
 *
 * 核心规则：
 *   1. 五层固定 UTC 半开区间（config.time_layers）：
 *      [0,1) → [1,7) → [7,30) → [30,90) → [90,270) 天
 *      恰好 1/7/30/90 天内容进入后一个层，270天及以上为授权范围外。
 *   2. 时间层优先（layer-first）：当前层所有适用来源达到终态后才推进。
 *      终态 = complete / observed_empty / partial / history_unsupported / skipped_by_user。
 *      非终态 = quota_paused / running / temporarily_failed / waiting_authorization，
 *      这些会阻止自动推进。
 *   3. 状态持久化：每个来源×时间层的进度保存在 news-state.json 的
 *      history_scheduler 段，包含 pageToken、页数、观察数、新增数、停止原因。
 *      下次构建从同一位置恢复。
 *   4. 低频高质量回溯资格由 eligibleForLowFrequencyBackfill() 判断，
 *      只在近期新内容不够且质量/相关性/节奏分类满足配置时才允许进入更深历史层。
 *
 * 扩展点：
 *   - 新增平台：只需在 build-news.js 的 runHistoricalLayerPass() 中增加分支，
 *     复用本模块的状态保存和推进逻辑。
 *   - 调整时间层：修改 news-config.json 的 time_layers 数组即可，
 *     但必须保持连续且 max_age_days 递增，validate.js 会检查。
 *   - 调整回溯资格：修改 news-config.json 的 low_frequency_backfill 段。
 */

'use strict';

/** 可自动推进的终态 */
const TERMINAL_STATUSES = new Set(['complete', 'observed_empty', 'partial', 'history_unsupported', 'skipped_by_user']);

/** 会阻止推进的非终态 */
const BLOCKING_STATUSES = new Set(['quota_paused', 'running', 'temporarily_failed', 'waiting_authorization']);

const TRANSIENT_RESULT_FIELDS = ['details', 'items', 'routes'];

function removeTransientResultFields(entry) {
  for (const field of TRANSIENT_RESULT_FIELDS) delete entry[field];
  return entry;
}

/**
 * 校验时间层数组的连续性。
 * 每一层的 min_age_days 必须等于上一层的 max_age_days，
 * 且 max_age_days > min_age_days。
 */
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

/**
 * 将一条内容的发布时间归入对应时间层。
 * 计算公式：ageDays = (nowUtcMs - publishedMs) / 86400000
 * 返回匹配的 layer.id，超出所有层时返回 null。
 *
 * @param {string} publishedAt ISO 日期字符串
 * @param {Array} layers 时间层配置数组
 * @param {number} nowUtcMs 基准时间（毫秒），测试时可注入固定值
 * @returns {string|null} 层 ID 或 null
 */
function classifyTimeLayer(publishedAt, layers, nowUtcMs = Date.now()) {
  validateTimeLayers(layers);
  const publishedMs = new Date(publishedAt).getTime();
  if (!Number.isFinite(publishedMs)) return null;
  const ageDays = (nowUtcMs - publishedMs) / 86400000;
  if (ageDays < 0) return null; // 未来时间，归入 null
  return layers.find(layer => ageDays >= layer.min_age_days && ageDays < layer.max_age_days)?.id || null;
}

/** 生成"层ID:来源ID"形式的复合键，用于 state.sources 索引 */
function sourceLayerKey(layerId, sourceId) {
  return `${layerId}:${sourceId}`;
}

/**
 * 创建或恢复调度状态。
 * 如果已有跨批次保存的 history_scheduler，传入 existing 恢复。
 */
function createSchedulerState(existing = null) {
  const state = existing || { schema_version: 1, active_layer: null, layer_coverage: {}, sources: {} };
  state.layer_coverage ||= {};
  state.sources ||= {};
  for (const entry of Object.values(state.sources)) removeTransientResultFields(entry);
  return state;
}

/**
 * 初始化当前时间层和来源进度。
 * 只在首次进入该层时调用；已存在的进度不会被覆盖。
 *
 * @param {object} state 调度状态
 * @param {object} layer 当前时间层配置
 * @param {Array} sources 该层适用的来源列表
 * @param {string} now ISO 时间戳
 */
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
      resume_page_token: null,
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

/**
 * 更新单个来源×层的进度。
 * changes 可以包含 partial result 的任何字段（status、page_token、stop_reason 等）。
 */
function updateSourceProgress(state, layerId, sourceId, changes, now = new Date().toISOString()) {
  const key = sourceLayerKey(layerId, sourceId);
  if (!state.sources[key]) throw new Error(`来源层状态不存在: ${key}`);
  const persistedChanges = { ...changes };
  removeTransientResultFields(persistedChanges);
  removeTransientResultFields(state.sources[key]);
  Object.assign(state.sources[key], persistedChanges, { checked_at: now });
  return state.sources[key];
}

/**
 * 判断当前层的整体状态。
 * 任一来源处于阻断状态 → 'blocked'
 * 所有来源处于终态   → 'complete'
 * 其他               → 'running'
 */
function layerStatus(state, layerId, sourceIds) {
  const statuses = sourceIds.map(id => state.sources[sourceLayerKey(layerId, id)]?.status || 'running');
  if (statuses.some(status => BLOCKING_STATUSES.has(status))) return 'blocked';
  if (statuses.every(status => TERMINAL_STATUSES.has(status))) return 'complete';
  return 'running';
}

/**
 * 尝试推进到下一时间层。
 * 当前层 complete 且存在下一层 → 推进并返回 next_layer
 * 当前层 complete 且已是最后一层 → 返回 complete=true
 * 当前层未完成 → 返回 reason
 */
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

/**
 * 判断某个来源是否具备低频高质量回溯资格。
 * 条件（全部满足）：
 *   - low_frequency_backfill.enabled === true
 *   - 来源的 cadence_class 在允许列表中
 *   - quality_prior >= 最低质量阈值
 *   - ai_relevance >= 最低相关度阈值（未设置时默认 1）
 *   - 近期新视频数 < min_recent_new_videos
 *
 * 注意：低频本身不降低长期质量分，这里只在额度层面控制是否进入深历史层。
 */
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
