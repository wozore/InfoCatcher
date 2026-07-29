/**
 * news-registry.js — 持久视频发现/处理状态与批量防重索引
 *
 * 在热点管线中的位置：被 build-news.js、news-youtube.js 和 news-bilibili.js
 * 共同使用，是所有"检测过的视频"的唯一真相来源。
 *
 * 职责：
 *   1. 唯一键管理：首选 platform:native_id，无原生 ID 时使用 platform:url-<sha256>；
 *      不同平台相同 native ID 不会冲突（键包含平台前缀）。
 *   2. 内存索引：构建时从 news-registry.json 一次性构造三份 Map：
 *      - byKey    → Map(key, record)
 *      - byUrl    → Map(platform:canonicalUrl, record)  用于 URL 级去重
 *      - bySource → Map(source_id, Set(key))             用于按来源统计
 *   3. 双轴状态机：
 *      discovery_status  —— 这个视频在"搜索发现"阶段处于什么状态
 *        discovered / backfill_candidate / filtered_non_ai / duplicate_observation
 *        / quota_paused / waiting_authorization / temporarily_failed / permanently_failed
 *      processing_status —— 这个视频在"处理分析"阶段处于什么状态
 *        pending / details_fetched / analysis_pending / assessed / published / failed
 *   4. 高成本步骤保护：needsExpensiveProcessing() 在以下情况返回 true 才允许
 *      进入详情抓取或 AI 分析：尚未拉详情、尚未分析、或分析版本已升级。
 *
 * 数据规模假设：
 *   当前 96 来源、每来源数百条视频 = 数万条记录；
 *   单文件 JSON + 启动时全量构造 Map 在此规模下足够；
 *   不宣称任意规模的性能，未来超阈值再考虑分片或迁移数据库。
 *
 * 使用示例：
 *   const { createRegistry, bulkDiscover, updateLifecycle } = require('./news-registry');
 *   const index = createRegistry(readJson('news-registry.json', null));
 *   const results = bulkDiscover(index, candidates, { now: new Date().toISOString() });
 *   // 只处理 isNew 或 needsExpensiveProcessing 为 true 的记录
 *   const registry = finalizeRegistry(index);
 */

'use strict';

const crypto = require('crypto');

// ── 状态机定义 ──────────────────────────────────────────────
// 这两个 Set 同时用于值校验（updateLifecycle 会检查传入的状态是否合法）

/** 发现阶段状态：描述视频在搜索/列表/Feed 中被检测到后的分类结果 */
const DISCOVERY = new Set([
  'discovered',              // 首次发现，待处理
  'backfill_candidate',      // 历史回溯中发现，与最新 Feed 发现区分
  'filtered_non_ai',         // 已检测但被判为非 AI 内容，不进入热点
  'duplicate_observation',   // 跨来源重复观察，保留溯源关系
  'quota_paused',            // 处理被额度不足中断
  'waiting_authorization',   // 超出时间范围，等待用户授权
  'temporarily_failed',      // 临时失败（网络等），可重试
  'permanently_failed',      // 永久失败（如频道不存在），不再重试
]);

/** 处理阶段状态：描述视频在详情抓取、分析和发布流程中的进度 */
const PROCESSING = new Set([
  'pending',           // 尚未处理
  'details_fetched',   // 已通过 API 获取详情（标题/描述/统计）
  'analysis_pending',  // 已排队等待分析
  'assessed',          // 已完成规则评分
  'published',         // 已进入热点输出
  'failed',            // 处理失败
]);

// ── 键值生成 ──────────────────────────────────────────────

/**
 * 生成 Registry 唯一键。
 * 规则：有原生 ID → platform:native_id；无 → platform:url-<sha256前24位>
 * 拒绝同时缺少 platform、native_id 和 canonical_url 的调用。
 */
function registryKey(platform, nativeId, canonicalUrl = '') {
  if (!platform) throw new Error('registry key 缺少 platform');
  if (nativeId) return `${platform}:${nativeId}`;
  if (!canonicalUrl) throw new Error('缺少 native_id 时必须提供 canonical_url');
  const hash = crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 24);
  return `${platform}:url-${hash}`;
}

/**
 * 生成 URL 索引键。必须带平台前缀，防止不同平台相同 URL 被误合并。
 */
function urlKey(platform, canonicalUrl) {
  return `${platform}:${canonicalUrl}`;
}

// ── Registry 生命周期 ──────────────────────────────────────

/**
 * 创建（或恢复）视频 Registry 及其内存索引。
 * 从 news-registry.json 反序列化后，一次性构造 byKey/byUrl/bySource 三份 Map。
 *
 * @param {object|null} data 反序列化后的 JSON，为 null 时创建空 Registry
 * @returns {{ registry, byKey, byUrl, bySource }}
 */
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

/**
 * 发现或更新单个视频记录。
 * 如果已存在：更新 last_seen_at、times_seen，合并 source_layers。
 * 如果不存在：创建新记录并写入 registry 和三个索引。
 *
 * @returns {{ key, record, isNew: boolean }}
 */
function discoverVideo(index, candidate, options = {}) {
  const now = options.now || new Date().toISOString();
  const canonicalUrl = candidate.canonical_url || candidate.url || '';
  const key = registryKey(candidate.platform, candidate.native_id, canonicalUrl);
  // 先按原生键查，再按 URL 索引查（以平台隔离的 URL 键匹配）
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

/** 批量发现，等价于 candidates.map(c => discoverVideo(index, c, options)) */
function bulkDiscover(index, candidates, options = {}) {
  return candidates.map(candidate => discoverVideo(index, candidate, options));
}

/**
 * 更新记录的生命周期状态。
 * 会校验 discovery_status 和 processing_status 是否合法，
 * 防止写入无效状态导致后续逻辑错误。
 */
function updateLifecycle(record, changes, now = new Date().toISOString()) {
  if (changes.discovery_status && !DISCOVERY.has(changes.discovery_status)) throw new Error(`无效 discovery_status: ${changes.discovery_status}`);
  if (changes.processing_status && !PROCESSING.has(changes.processing_status)) throw new Error(`无效 processing_status: ${changes.processing_status}`);
  Object.assign(record, changes, { last_processed_at: now });
  return record;
}

/**
 * 判断一条视频是否需要重新进入高成本处理（详情抓取、AI 分析）。
 * 三个条件任一满足即返回 true：
 *   1. 尚未拉取详情
 *   2. 尚未完成分析
 *   3. 分析版本已升级（如评分规则变更）
 */
function needsExpensiveProcessing(record, analysisVersion) {
  if (!record.details_fetched) return true;
  if (!record.analysis_completed) return true;
  return Boolean(analysisVersion && record.analysis_version !== analysisVersion);
}

/**
 * 完结 Registry，写入 updated_at 并同步 stats.count。
 * 应在所有发现和处理操作结束后、写入 JSON 文件前调用。
 */
function finalizeRegistry(index, now = new Date().toISOString()) {
  index.registry.updated_at = now;
  index.registry.stats.count = index.byKey.size;
  return index.registry;
}

module.exports = {
  DISCOVERY, PROCESSING, registryKey, createRegistry, discoverVideo, bulkDiscover,
  updateLifecycle, needsExpensiveProcessing, finalizeRegistry,
};
