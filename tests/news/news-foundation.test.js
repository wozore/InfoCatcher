/**
 * news-foundation.test.js — 持久基础设施与运维安全测试（29 项）
 *
 * 测试原理：
 *   这些测试验证热点管线的"底盘"——存储安全、状态转换、额度控制和运维 CLI。
 *   与 news-tests.test.js 不同，这些测试不依赖采集内容语义，
 *   而是直接测试原子写、锁、Registry、Quota、Scheduler、平台适配器
 *   和 CLI 在边界条件下的正确性。
 *
 * 为什么需要这些测试：
 *   如果存储层损坏（半写 JSON）或锁失效（并发覆盖），采集到再多内容也没用。
 *   这些测试模拟极端场景：构建中断、额度耗尽、历史不可分页、授权参数为零、
 *   锁被占用——确保系统在这些情况下不损坏数据、不超额调用、不吞掉显式零值。
 *
 * 测试分组（按模块依赖顺序）：
 *   第 1 组 — 存储与并发（4 项）
 *     原子写、排他锁、归属校验、审计解锁、缺锁状态
 *   第 2 组 — Registry 生命周期（7 项）
 *     唯一性/防重、URL fallback隔离、发现/处理状态分离、裁剪（N-P2：dry-run/索引同步/半开边界/审计）
 *   第 3 组 — 额度账本（3 项）
 *     预留→消费→暂停，失败请求计费，未发送不计费，低水位早停（N-P3）
 *   第 4 组 — 时间调度与回溯（3 项）
 *     五层半开边界、同层终态才推进、低频回溯资格
 *   第 5 组 — 平台历史适配（3 项）
 *     YouTube 防重→详情、游标恢复、B站 history_unsupported
 *   第 6 组 — 授权与 CLI 安全（5 项）
 *     授权防重复、四种决策边界、来源校验、原子导入、显式零值
 *
 * 运行方式：node --test tests/news/news-foundation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeJsonAtomic, acquireLock, releaseLock, inspectLock, forceUnlock,
} = require('../../src/news/core/news-storage');
const {
  createRegistry, discoverVideo, bulkDiscover, updateLifecycle,
  needsExpensiveProcessing, finalizeRegistry, pruneRegistry,
} = require('../../src/news/core/news-registry');
const {
  createQuotaLedger, reserveQuota, consumeQuota, withQuota, finishQuotaLedger,
} = require('../../src/news/core/news-quota');
const {
  validateTimeLayers, classifyTimeLayer, createSchedulerState, initializeLayer,
  updateSourceProgress, advanceLayer, eligibleForLowFrequencyBackfill,
} = require('../../src/news/core/news-scheduler');
const { collectYouTubeLayerStep } = require('../../src/news/collectors/news-youtube');
const { collectBilibiliLayerStep } = require('../../src/news/collectors/news-bilibili');
const { createAuthorizationStore, createAuthorizationTask, decideAuthorization } = require('../../src/news/core/news-authorization');
const { historicalPageToken } = require('../../src/news/pipeline/build-news');
const { validateSource, importSources, parseArgs, optionalNumber } = require('../../src/news/cli/news-cli');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'infocatcher-news-'));
}

const layers = [
  { id: 'recent-1d', min_age_days: 0, max_age_days: 1 },
  { id: 'recent-7d', min_age_days: 1, max_age_days: 7 },
  { id: 'recent-30d', min_age_days: 7, max_age_days: 30 },
  { id: 'recent-90d', min_age_days: 30, max_age_days: 90 },
  { id: 'recent-270d', min_age_days: 90, max_age_days: 270 },
];

// ── 第 1 组：存储与并发（4 项）─────────────────────────────
// 原子写：临时文件不残留、旧文件不受破坏
// 锁：排他创建、归属校验、审计解锁、缺锁状态

test('原子 JSON 写入替换目标且不遗留临时文件', () => {
  const directory = temporaryDirectory();
  const file = path.join(directory, 'state.json');
  fs.writeFileSync(file, '{"old":true}\n');
  writeJsonAtomic(file, { current: true }, 'test');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { current: true });
  assert.deepEqual(fs.readdirSync(directory), ['state.json']);
});

test('构建锁拒绝第二个任务并校验所属 run', () => {
  const directory = temporaryDirectory();
  const lock = path.join(directory, '.lock');
  acquireLock(lock, { run_id: 'first' });
  assert.equal(inspectLock(lock).status, 'locked');
  assert.throws(() => acquireLock(lock, { run_id: 'second' }), error => error.code === 'EEXIST');
  assert.throws(() => releaseLock(lock, 'second'), /另一个构建任务/);
  assert.equal(releaseLock(lock, 'first'), true);
});

test('强制解锁必须提供理由并写入审计', () => {
  const directory = temporaryDirectory();
  const lock = path.join(directory, '.lock');
  const audit = path.join(directory, 'audit.json');
  acquireLock(lock, { run_id: 'stale' });
  assert.throws(() => forceUnlock(lock, '', audit), /reason/);
  assert.equal(forceUnlock(lock, '确认任务已终止', audit), true);
  assert.equal(JSON.parse(fs.readFileSync(audit, 'utf8')).events[0].previous_lock.run_id, 'stale');
});

// ── 第 2 组：Registry 生命周期（7 项）───────────────────────
// 唯一键：不同平台相同 native ID 不冲突
// URL fallback：按平台隔离，无标识符拒绝
// 状态分离：发现状态 vs 处理状态，分析版本升级触发重新处理
// 裁剪（N-P2）：dry-run 不修改、apply 同步三份索引、半开边界、无超期不写审计

test('Registry 以平台和原生 ID 唯一并批量防重', () => {
  const index = createRegistry();
  const candidates = [
    { platform: 'youtube', native_id: 'same', source_id: 'yt', canonical_url: 'https://youtube.test/same' },
    { platform: 'bilibili', native_id: 'same', source_id: 'bili', canonical_url: 'https://bilibili.test/same' },
    { platform: 'youtube', native_id: 'same', source_id: 'yt', canonical_url: 'https://youtube.test/same' },
  ];
  const results = bulkDiscover(index, candidates, { now: '2026-07-23T00:00:00Z' });
  assert.deepEqual(results.map(result => result.isNew), [true, true, false]);
  assert.equal(index.byKey.size, 2);
  assert.equal(results[0].record.times_seen, 2);
});

test('Registry 的 URL fallback 按平台隔离且拒绝空标识', () => {
  const index = createRegistry();
  const first = discoverVideo(index, { platform: 'youtube', source_id: 'a', canonical_url: 'https://example.test/item' });
  const second = discoverVideo(index, { platform: 'bilibili', source_id: 'b', canonical_url: 'https://example.test/item' });
  assert.notEqual(first.key, second.key);
  assert.throws(() => discoverVideo(index, { platform: 'youtube', source_id: 'a' }), /canonical_url/);
});

test('Registry 分离发现与处理状态并支持分析版本升级', () => {
  const index = createRegistry();
  const { record } = discoverVideo(index, { platform: 'youtube', native_id: 'v1', source_id: 'yt' });
  assert.equal(needsExpensiveProcessing(record, 'rules-v1'), true);
  updateLifecycle(record, {
    processing_status: 'published', details_fetched: true,
    analysis_completed: true, analysis_version: 'rules-v1',
  }, '2026-07-23T01:00:00Z');
  assert.equal(needsExpensiveProcessing(record, 'rules-v1'), false);
  assert.equal(needsExpensiveProcessing(record, 'rules-v2'), true);
  assert.equal(finalizeRegistry(index).stats.count, 1);
  assert.throws(() => updateLifecycle(record, { discovery_status: 'invalid' }), /无效/);
});

test('pruneRegistry dry-run 识别超期记录但不修改任何索引', () => {
  const now = '2026-07-23T00:00:00Z';
  const index = createRegistry({
    schema_version: 1, updated_at: now, stats: { count: 3 },
    videos: {
      'youtube:old': { key: 'youtube:old', platform: 'youtube', native_id: 'old', source_id: 'yt', canonical_url: 'https://y.test/old', last_seen_at: '2025-06-01T00:00:00Z' },
      'youtube:recent': { key: 'youtube:recent', platform: 'youtube', native_id: 'recent', source_id: 'yt', canonical_url: 'https://y.test/recent', last_seen_at: '2026-07-20T00:00:00Z' },
      'youtube:nodate': { key: 'youtube:nodate', platform: 'youtube', native_id: 'nodate', source_id: 'yt', canonical_url: 'https://y.test/nodate', last_seen_at: null },
    },
  });
  const result = pruneRegistry(index, { now, retentionDays: 270, dryRun: true });
  assert.equal(result.pruned_count, 1);
  assert.equal(result.pruned[0].native_id, 'old');
  assert.equal(index.byKey.size, 3);
  assert.equal(index.registry.stats.count, 3);
  assert.equal(result.stats.oldest_kept_last_seen_at, '2026-07-20T00:00:00Z');
});

test('pruneRegistry 应用时同步三份索引并更新计数与审计', () => {
  const now = '2026-07-23T00:00:00Z';
  const index = createRegistry({
    schema_version: 1, updated_at: now, stats: { count: 2 },
    videos: {
      'youtube:old': { key: 'youtube:old', platform: 'youtube', native_id: 'old', source_id: 'yt', canonical_url: 'https://y.test/old', last_seen_at: '2025-06-01T00:00:00Z' },
      'youtube:recent': { key: 'youtube:recent', platform: 'youtube', native_id: 'recent', source_id: 'yt', canonical_url: 'https://y.test/recent', last_seen_at: '2026-07-20T00:00:00Z' },
    },
  });
  const result = pruneRegistry(index, { now, retentionDays: 270, runId: 'run-test', dryRun: false });
  assert.equal(result.pruned_count, 1);
  assert.equal(result.pruned[0].native_id, 'old');
  assert.equal(index.byKey.size, 1);
  assert.equal(index.byKey.has('youtube:old'), false);
  assert.equal(index.byUrl.has('youtube:https://y.test/old'), false);
  assert.equal(index.bySource.get('yt').has('youtube:old'), false);
  assert.equal(index.registry.videos['youtube:old'], undefined);
  assert.equal(index.registry.stats.count, 1);
  assert.equal(index.registry.stats.last_prune.run_id, 'run-test');
  assert.equal(index.registry.stats.last_prune.retention_days, 270);
  assert.equal(index.registry.stats.last_prune.count, 1);
});

test('pruneRegistry 边界半开：恰好 retention 天保留，超过才裁剪，无效日期保留', () => {
  const now = Date.parse('2026-07-23T00:00:00Z');
  const at = days => new Date(now - days * 86400000).toISOString();
  const index = createRegistry({
    schema_version: 1, stats: { count: 4 },
    videos: {
      'youtube:exact': { key: 'youtube:exact', platform: 'youtube', native_id: 'exact', source_id: 'yt', last_seen_at: at(270) },
      'youtube:over': { key: 'youtube:over', platform: 'youtube', native_id: 'over', source_id: 'yt', last_seen_at: at(271) },
      'youtube:invalid': { key: 'youtube:invalid', platform: 'youtube', native_id: 'invalid', source_id: 'yt', last_seen_at: 'not-a-date' },
      'youtube:missing': { key: 'youtube:missing', platform: 'youtube', native_id: 'missing', source_id: 'yt', last_seen_at: null },
    },
  });
  const result = pruneRegistry(index, { now: new Date(now).toISOString(), retentionDays: 270 });
  assert.equal(result.pruned_count, 1);
  assert.equal(result.pruned[0].native_id, 'over');
  assert.equal(index.byKey.size, 3);
});

test('pruneRegistry 无超期记录时不写入 last_prune 审计', () => {
  const now = '2026-07-23T00:00:00Z';
  const index = createRegistry({
    schema_version: 1, stats: { count: 1 },
    videos: {
      'youtube:recent': { key: 'youtube:recent', platform: 'youtube', native_id: 'recent', source_id: 'yt', last_seen_at: '2026-07-22T00:00:00Z' },
    },
  });
  const result = pruneRegistry(index, { now, retentionDays: 270 });
  assert.equal(result.pruned_count, 0);
  assert.equal(index.registry.stats.last_prune, undefined);
  assert.equal(index.byKey.size, 1);
});

// ── 第 3 组：额度账本（3 项）────────────────────────────────
// reserve → consume 三步流程：已发送但失败的请求仍消耗额度
// 未发送的请求不消耗额度；余额为 0 时 exhausted
// 低水位早停（N-P3）：remaining ≤ quota_low_watermark 时拒绝新预留

test('额度预留、发送后消费与不足暂停均可审计', () => {
  const ledger = createQuotaLedger({ youtube_quota_units_per_run: 2, bilibili_rsshub_requests_per_run: 1 }, 'run');
  const reserved = reserveQuota(ledger, 'youtube', { operation: 'channels.list', cost: 1 });
  assert.equal(reserved.accepted, true);
  consumeQuota(ledger, 'youtube', reserved.reservation_id, 'failed');
  assert.equal(ledger.platforms.youtube.consumed, 1);
  assert.equal(reserveQuota(ledger, 'youtube', { operation: 'search.list', cost: 100 }).accepted, false);
  assert.equal(ledger.platforms.youtube.status, 'quota_paused');
});

test('失败的实际请求仍消费额度，未发送请求不消费', async () => {
  const ledger = createQuotaLedger({ youtube_quota_units_per_run: 1, bilibili_rsshub_requests_per_run: 1 }, 'run');
  await assert.rejects(() => withQuota(ledger, 'bilibili', { operation: 'rsshub', cost: 1 }, async () => { throw new Error('network'); }), /network/);
  assert.equal(ledger.platforms.bilibili.consumed, 1);
  const blocked = await withQuota(ledger, 'bilibili', { operation: 'rsshub', cost: 1 }, async () => 'never');
  assert.equal(blocked.sent, false);
  assert.equal(ledger.platforms.bilibili.consumed, 1);
  assert.equal(finishQuotaLedger(ledger).platforms.bilibili.status, 'exhausted');
});

test('额度低水位：remaining ≤ quota_low_watermark 时拒绝新预留（N-P3）', () => {
  const ledger = createQuotaLedger({ youtube_quota_units_per_run: 3, bilibili_rsshub_requests_per_run: 1, quota_low_watermark: 2 }, 'run');
  const first = reserveQuota(ledger, 'youtube', { operation: 'videos.list', cost: 1 });
  assert.equal(first.accepted, true);
  const second = reserveQuota(ledger, 'youtube', { operation: 'videos.list', cost: 1 });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, 'low_watermark');
  assert.equal(ledger.platforms.youtube.status, 'low_watermark');
  assert.equal(ledger.platforms.youtube.remaining, 3);
  // 未配置 quota_low_watermark 时低水位禁用（保持既有语义）
  const plain = createQuotaLedger({ youtube_quota_units_per_run: 3, bilibili_rsshub_requests_per_run: 1 }, 'run');
  assert.equal(reserveQuota(plain, 'youtube', { operation: 'videos.list', cost: 1 }).accepted, true);
  assert.equal(reserveQuota(plain, 'youtube', { operation: 'videos.list', cost: 1 }).accepted, true);
  assert.equal(reserveQuota(plain, 'youtube', { operation: 'videos.list', cost: 1 }).accepted, true);
});

// ── 第 4 组：时间调度与回溯（3 项）──────────────────────────
// UTC 半开区间：恰好 1/7/30/90/270 天进入后一层
// 时间层优先：同层全部终态后才推进，阻断态阻止推进
// 低频回溯：只在质量和 AI 相关度达到阈值且近期内容不足时触发

test('UTC 半开时间层在 1/7/30/90/270 天边界无重叠', () => {
  validateTimeLayers(layers);
  const now = Date.parse('2026-07-23T00:00:00Z');
  const atAge = days => new Date(now - days * 86400000).toISOString();
  assert.equal(classifyTimeLayer(atAge(0), layers, now), 'recent-1d');
  assert.equal(classifyTimeLayer(atAge(1), layers, now), 'recent-7d');
  assert.equal(classifyTimeLayer(atAge(7), layers, now), 'recent-30d');
  assert.equal(classifyTimeLayer(atAge(30), layers, now), 'recent-90d');
  assert.equal(classifyTimeLayer(atAge(90), layers, now), 'recent-270d');
  assert.equal(classifyTimeLayer(atAge(270), layers, now), null);
});

test('classifyTimeLayer 策略参数：调度默认（边界 null）与统计策略（未来 recent / 超窗·无效 older）', () => {
  const now = Date.parse('2026-07-23T00:00:00Z');
  const atAge = days => new Date(now - days * 86400000).toISOString();
  const stats = { future: 'recent', overflow: 'older', invalid: 'older' };
  // 默认（采集器调度语义，N-P1 决策）：未来 / 超窗 / 无效 → null，不进入调度层
  assert.equal(classifyTimeLayer(new Date(now + 3600000).toISOString(), layers, now), null);
  assert.equal(classifyTimeLayer(atAge(270), layers, now), null);
  assert.equal(classifyTimeLayer('not-a-date', layers, now), null);
  // 统计策略（build-news coverage/registry，保持历史行为）：未来→第一层、超窗→older、无效→older
  assert.equal(classifyTimeLayer(new Date(now + 3600000).toISOString(), layers, now, stats), 'recent-1d');
  assert.equal(classifyTimeLayer(atAge(270), layers, now, stats), 'older');
  assert.equal(classifyTimeLayer('not-a-date', layers, now, stats), 'older');
  // 正常层内边界不受策略影响
  assert.equal(classifyTimeLayer(atAge(1), layers, now, stats), 'recent-7d');
  assert.equal(classifyTimeLayer(atAge(90), layers, now, stats), 'recent-270d');
});

test('Scheduler 仅在同层所有来源终态后推进', () => {
  const state = createSchedulerState();
  const sources = [{ id: 'a' }, { id: 'b' }];
  initializeLayer(state, layers[0], sources);
  updateSourceProgress(state, layers[0].id, 'a', { status: 'complete' });
  assert.equal(advanceLayer(state, layers, ['a', 'b']).advanced, false);
  updateSourceProgress(state, layers[0].id, 'b', { status: 'quota_paused' });
  assert.equal(advanceLayer(state, layers, ['a', 'b']).reason, 'blocked');
  updateSourceProgress(state, layers[0].id, 'b', { status: 'observed_empty' });
  assert.equal(advanceLayer(state, layers, ['a', 'b']).next_layer, 'recent-7d');
});

test('Scheduler 只持久化进度，不保留采集临时载荷', () => {
  const state = createSchedulerState();
  initializeLayer(state, layers[0], [{ id: 'youtube' }]);
  const changes = {
    status: 'partial', uploads_playlist_id: 'UU-test', page_token: 'next-page',
    resume_page_token: 'resume-page', new_video_count: 2, duplicate_count: 3,
    filtered_count: 4, details: [{ id: 'video-1' }], items: [{ id: 'item-1' }],
    routes: [{ type: 'video', status: 'success' }],
  };
  const original = structuredClone(changes);
  const progress = updateSourceProgress(state, layers[0].id, 'youtube', changes, '2026-07-23T00:00:00Z');
  assert.deepEqual(changes, original);
  assert.deepEqual(progress, {
    layer_id: 'recent-1d', source_id: 'youtube', status: 'partial',
    page_token: 'next-page', resume_page_token: 'resume-page', pages_fetched: 0,
    items_observed: 0, items_contributed: 0, oldest_observed_at: null, new_video_count: 2,
    duplicate_count: 3, filtered_count: 4, stop_reason: null,
    checked_at: '2026-07-23T00:00:00Z', uploads_playlist_id: 'UU-test',
  });
});

test('Scheduler 恢复旧状态时清理所有层的临时采集载荷', () => {
  const existing = {
    schema_version: 1, active_layer: 'recent-30d', layer_coverage: {},
    sources: {
      'recent-1d:youtube': { status: 'complete', details: [{ id: 'video-1' }], future_field: 'keep' },
      'recent-30d:bilibili': { status: 'partial', items: [{ id: 'item-1' }], routes: [{ type: 'video' }], page_token: 'next' },
    },
  };
  const state = createSchedulerState(existing);
  assert.equal(state, existing);
  assert.deepEqual(state.sources['recent-1d:youtube'], { status: 'complete', future_field: 'keep' });
  assert.deepEqual(state.sources['recent-30d:bilibili'], { status: 'partial', page_token: 'next' });
});

test('低频高质量来源仅在近期新内容不足时受控回溯', () => {
  const config = { low_frequency_backfill: {
    enabled: true, cadence_classes: ['low_frequency'], min_quality_prior: 70,
    min_ai_relevance: 0.6, min_recent_new_videos: 1,
  } };
  const source = { cadence_class: 'low_frequency', quality_prior: 80, ai_relevance: 0.8 };
  assert.equal(eligibleForLowFrequencyBackfill(source, 0, config), true);
  assert.equal(eligibleForLowFrequencyBackfill(source, 1, config), false);
  assert.equal(eligibleForLowFrequencyBackfill({ ...source, quality_prior: 60 }, 0, config), false);
});

function jsonResponse(value) {
  return { ok: true, status: 200, json: async () => value };
}

// ── 第 5 组：平台历史适配（3 项）────────────────────────────
// YouTube：先 Registry 防重再批量补详情，效率优先
// YouTube 游标：额度暂停保留游标供下一批恢复
// B站历史：RSSHub 无分页时 history_unsupported，不伪装为空

test('YouTube uploads playlist 先防重再批量获取新视频详情', async () => {
  const nowUtcMs = Date.parse('2026-07-23T00:00:00Z');
  const registry = createRegistry();
  const oldRecord = discoverVideo(registry, { platform: 'youtube', native_id: 'old', source_id: 'yt' }).record;
  updateLifecycle(oldRecord, {
    processing_status: 'published', details_fetched: true,
    analysis_completed: true, analysis_version: 'rules-v1',
  });
  const calls = [];
  const result = await collectYouTubeLayerStep({
    source: { id: 'yt', external_id: 'UC-test' }, layer: layers[1], timeLayers: layers,
    nowUtcMs, nowIso: new Date(nowUtcMs).toISOString(), registry,
    quota: createQuotaLedger({ youtube_quota_units_per_run: 10 }, 'run'), apiKey: 'fixture-key',
    analysisVersion: 'rules-v1', uploadsPlaylistId: 'UU-test', stopAfterNew: 2,
    fetch: async url => {
      calls.push(url);
      if (url.includes('/playlistItems')) return jsonResponse({ items: [
        { contentDetails: { videoId: 'old', videoPublishedAt: '2026-07-20T00:00:00Z' }, snippet: { title: 'old' } },
        { contentDetails: { videoId: 'new', videoPublishedAt: '2026-07-19T00:00:00Z' }, snippet: { title: 'new' } },
      ] });
      return jsonResponse({ items: [{ id: 'new', snippet: { title: 'new' } }] });
    },
  });
  assert.equal(result.new_video_count, 1);
  assert.equal(result.duplicate_count, 1);
  assert.equal(calls.filter(url => url.includes('/videos')).length, 1);
  assert.match(calls.find(url => url.includes('/videos')), /id=new/);
});

test('YouTube 额度不足时保留当前 pageToken 供恢复', async () => {
  const result = await collectYouTubeLayerStep({
    source: { id: 'yt', external_id: 'UC-test' }, layer: layers[1], timeLayers: layers,
    nowUtcMs: Date.parse('2026-07-23T00:00:00Z'), nowIso: '2026-07-23T00:00:00Z',
    registry: createRegistry(), quota: createQuotaLedger({ youtube_quota_units_per_run: 1 }, 'run'),
    apiKey: 'fixture-key', uploadsPlaylistId: 'UU-test', pageToken: 'resume-me',
    fetch: async () => jsonResponse({ items: [{ contentDetails: { videoId: 'new', videoPublishedAt: '2026-07-19T00:00:00Z' } }] }),
  });
  assert.equal(result.status, 'quota_paused');
  assert.equal(result.resume_page_token, 'resume-me');
});

test('B站历史 feed 无对应层内容时标记 history_unsupported', async () => {
  const result = await collectBilibiliLayerStep({
    source: { id: 'bili' }, layer: layers[3], timeLayers: layers,
    nowUtcMs: Date.parse('2026-07-23T00:00:00Z'), nowIso: '2026-07-23T00:00:00Z',
    registry: createRegistry(), quota: createQuotaLedger({ bilibili_rsshub_requests_per_run: 3 }, 'run'),
    routes: [{ type: 'bilibili_dynamic', url: 'https://rsshub.test/dynamic' }],
    fetch: async () => ({ ok: true, status: 200, text: async () => '<xml />' }),
    parseFeed: () => [{ native_id: 'd1', published_at: '2026-07-22T00:00:00Z', title: 'recent' }],
  });
  assert.equal(result.status, 'history_unsupported');
  assert.equal(result.stop_reason, 'rsshub_feed_has_no_historical_pagination');
  assert.match(result.coverage_limitation, /visible_feed/);
});

test('B站历史新内容计数仅检查当前时间层', async () => {
  const nowUtcMs = Date.parse('2026-07-23T00:00:00Z');
  const result = await collectBilibiliLayerStep({
    source: { id: 'bili' }, layer: layers[3], timeLayers: layers, nowUtcMs,
    nowIso: new Date(nowUtcMs).toISOString(), registry: createRegistry(),
    quota: createQuotaLedger({ bilibili_rsshub_requests_per_run: 3 }, 'run'),
    routes: [{ type: 'bilibili_dynamic', url: 'https://rsshub.test/dynamic' }],
    fetch: async () => ({ ok: true, status: 200, text: async () => '<xml />' }),
    parseFeed: () => [
      { native_id: 'in-layer', published_at: '2026-06-01T00:00:00Z', title: 'historical' },
      { native_id: 'out-of-layer', published_at: '2026-07-22T00:00:00Z', title: 'recent' },
    ],
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.new_video_count, 1);
  assert.equal(result.duplicate_count, 0);
});

// ── 第 6 组：授权与 CLI 安全（5 项）─────────────────────────
// 授权：任务防重复、四种决策的安全边界、缺参数拒绝
// CLI：来源 ID/HTTPS/标签/重复校验、原子导入、
//   暂停游标优先恢复、显式零值不被吞掉

test('不存在的锁文件返回 unlocked', () => {
  const directory = temporaryDirectory();
  assert.equal(inspectLock(path.join(directory, '.missing-lock')).status, 'unlocked');
});

test('授权任务防重复并校验四类决定的安全边界', () => {
  const store = createAuthorizationStore();
  const task = createAuthorizationTask(store, { platform: 'youtube', source_id: 'yt', source_name: 'YT' }, '2026-07-23T00:00:00Z');
  assert.equal(createAuthorizationTask(store, { platform: 'youtube', source_id: 'yt' }).id, task.id);
  assert.throws(() => decideAuthorization(store, task.id, 'until-first', { earliest_days: 365 }), /max_pages/);
  const decided = decideAuthorization(store, task.id, 'until-first', { earliest_days: 365, max_pages: 3, max_quota: 200 });
  assert.equal(decided.status, 'authorized');
  assert.equal(decided.decision.max_pages, 3);
  const skip = createAuthorizationTask(store, { platform: 'bilibili', source_id: 'bili' });
  assert.equal(decideAuthorization(store, skip.id, 'skip').status, 'skipped');
});

test('来源 CLI 校验 ID、HTTPS、标签和同平台重复', () => {
  const source = validateSource({
    platform: 'youtube', external_id: 'UC1234567890123456789012', name: 'Example',
    profile_url: 'https://youtube.com/@example', language: 'en', content_tags: ['深度解读'],
  });
  assert.equal(source.collector, 'youtube_rss');
  assert.throws(() => validateSource({ ...source, profile_url: 'http://example.com' }), /HTTPS/);
  assert.throws(() => validateSource({ ...source }, [source]), /已存在/);
  assert.throws(() => validateSource({ ...source, content_tags: ['未知'] }), /未知标签/);
});

test('批量来源导入默认全有或全无，allow-partial 才写有效项', () => {
  const payload = { schema_version: 1, sources: [] };
  const valid = {
    platform: 'bilibili', external_id: '12345', name: 'Bili',
    profile_url: 'https://space.bilibili.com/12345', content_tags: ['教程实践'],
  };
  const invalid = { ...valid, external_id: 'bad' };
  const atomic = importSources(payload, [valid, invalid]);
  assert.equal(atomic.committed, false);
  assert.equal(payload.sources.length, 0);
  const partial = importSources(payload, [valid, invalid], true);
  assert.equal(partial.committed, true);
  assert.equal(payload.sources.length, 1);
  assert.deepEqual(parseArgs(['source', 'import', '--dry-run']).positional, ['source', 'import']);
});

test('YouTube 暂停游标在下一批优先恢复', () => {
  assert.equal(historicalPageToken({ page_token: null, resume_page_token: 'resume-me' }), 'resume-me');
  assert.equal(historicalPageToken({ page_token: 'next', resume_page_token: 'old' }), 'next');
});

test('CLI 保留显式零值供授权层拒绝', () => {
  assert.equal(optionalNumber({ max_quota: '0' }, 'max_quota'), 0);
  assert.equal(optionalNumber({ max_pages: '0' }, 'max_pages'), 0);
  assert.equal(optionalNumber({ until: '0d' }, 'until', 'd'), 0);
  const store = createAuthorizationStore();
  const task = createAuthorizationTask(store, { platform: 'youtube', source_id: 'zero' });
  assert.throws(() => decideAuthorization(store, task.id, 'continue', { until_days: 365, max_quota: 0 }), /max_quota/);
});
