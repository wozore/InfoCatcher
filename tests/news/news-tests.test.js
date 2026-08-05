/**
 * news-tests.test.js — 内容语义与采集行为测试（23 项）
 *
 * 测试原理：
 *   这些测试不请求真实 API（YouTube/X/RSSHub），而是使用本地夹具文件
 *   （news-fixtures/youtube.xml、x.json、bilibili-dynamic.xml）作为输入，
 *   验证从原始数据到最终热点的每一个确定性处理步骤。
 *   夹具文件包含精心构造的样本数据，每条样本触发一种边界情况。
 *
 * 为什么需要这些测试：
 *   评分、溯源、异常检测和 coverage 逻辑包含大量条件判断和数学公式
 *   （指数衰减、MAD、加权求和）。手动验证无法保证在所有平台/内容类型/
 *   边界条件下结果正确。这些测试在每次提交和部署前自动运行，
 *   确保修改评分规则或新增平台不会破坏已有逻辑。
 *
 * 测试分组（按数据流向）：
 *   第 1 组 — 输入解析与标准化（3 项）
 *     验证三平台的原始格式能正确转换为统一内容模型
 *   第 2 组 — 评分与证据公平性（7 项）
 *     验证评分公式约束：无证据不扣分、低频不降权、小样本不误伤
 *   第 3 组 — 溯源与异常（4 项）
 *     验证溯源关系和异常检测不误删内容
 *   第 4 组 — Coverage/降级/轮转/诊断范围（5 项）
 *     验证采集覆盖状态不误报、B站降级不丢失内容、单平台诊断不调用其他 API
 *
 * 运行方式：node --test tests/news/news-tests.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parseFeed,
  normalizeRssItem,
  normalizeTweet,
  inferBilibiliType,
  scoreTimeliness,
  detectLightExperience,
  detectCommercial,
  assessItem,
  buildProvenance,
  buildEvents,
  applyAnomalyDetection,
  resolvePlatformScope,
  HEAT_DEFINITION,
  buildEvidenceExcerpt,
  buildToolUrlIndex,
  resolveRelatedResources,
  computeHotScores,
  enrichHotspotProjection,
  runCollection,
} = require('../../src/news/pipeline/build-news');
const { parseBilibiliUrl, normalizeManualItem, importManualItems } = require('../../src/content/news-manual');
const { NEWS_FILES, DIRS } = require('../../src/shared/paths');

const config = JSON.parse(fs.readFileSync(NEWS_FILES.config, 'utf8'));
const fixture = name => fs.readFileSync(path.join(DIRS.fixtures, name), 'utf8');
const now = new Date('2026-07-23T12:00:00Z').getTime();
const emptyOutput = () => ({ items: [], events: [], provenance: [], assessments: [], coverage: {} });

function source(overrides = {}) {
  return {
    id: 'source-test', platform: 'youtube', external_id: 'test', handle: 'test', name: 'Test',
    language: 'zh', content_tags: ['深度解读'], quality_prior: 80, reliability_prior: 70,
    enabled: true,
    ...overrides,
  };
}

// ── 第 1 组：输入解析与标准化（3 项）─────────────────────────
// 验证 YouTube Atom、B站动态 RSS、TwitterAPI.io JSON 三种原始格式
// 是否能正确提取为统一字段：native_id、标题、描述、发布时间、互动量

test('解析 YouTube Atom 并保留基础字段', () => {
  const entries = parseFeed(fixture('youtube.xml'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].native_id, 'video-ai-1');
  assert.match(entries[0].description, /实际使用/);
});

test('B站动态作为一等内容并区分转发与文字', () => {
  const entries = parseFeed(fixture('bilibili-dynamic.xml'));
  assert.equal(entries.length, 2);
  assert.equal(inferBilibiliType(entries[0]), 'bilibili_dynamic_repost');
  assert.equal(inferBilibiliType(entries[1]), 'bilibili_dynamic_text');
  const item = normalizeRssItem(entries[1], source({ platform: 'bilibili' }), 'bilibili_dynamic', new Date(now).toISOString());
  assert.equal(item.content_type, 'bilibili_dynamic_text');
});

test('TwitterAPI.io 响应可标准化并保留互动', () => {
  const payload = JSON.parse(fixture('x.json'));
  const item = normalizeTweet(payload.tweets[0], source({ platform: 'x', handle: 'test' }), new Date(now).toISOString());
  assert.equal(item.native_id, 'x-ai-1');
  assert.equal(item.metrics.views, 40000);
});

// ── 第 2 组：评分与证据公平性（7 项）──────────────────────────
// 核心约束：评分必须有证据，无证据保持中性；
// 低频/小样本/无基线不自动扣分；商业披露只在有明确证据时触发。

test('近期资讯比同类型旧内容拥有更高时效分', () => {
  const recent = { published_at: '2026-07-23T06:00:00Z', source_tags: ['即时资讯'] };
  const old = { published_at: '2026-07-16T06:00:00Z', source_tags: ['即时资讯'] };
  assert.ok(scoreTimeliness(recent, config, now) > scoreTimeliness(old, config, now));
});

test('轻度用户体验需覆盖至少两类明确证据', () => {
  const item = { title: 'AI 工具实测', description: '我用它完成工作流，免费额度有限，出现失败和稳定性问题', url: 'https://example.com' };
  const result = detectLightExperience(item, config);
  assert.ok(result.score > 50);
  assert.ok(result.evidence.length >= 2);
});

test('无商业证据不扣分，明确赞助才扣分', () => {
  const plain = detectCommercial({ title: '推荐 AI 工具', description: '这是我的使用体验', url: 'https://example.com' }, config);
  const sponsored = detectCommercial({ title: 'AI 工具', description: '本期由 Example 赞助', url: 'https://example.com' }, config);
  assert.equal(plain.penalty, 0);
  assert.equal(sponsored.label, 'declared_sponsorship');
  assert.ok(sponsored.penalty > 0);
  assert.ok(sponsored.evidence.length > 0);
});

test('低频优质来源不会因频率直接降低长期质量', () => {
  const item = normalizeRssItem(parseFeed(fixture('youtube.xml'))[0], source(), 'youtube_video', new Date(now).toISOString());
  const assessment = assessItem(item, source({ cadence_class: 'low_frequency', quality_prior: 90 }), config, now);
  assert.equal(assessment.score_breakdown.long_term_quality, 90);
});

// ── 第 3 组：溯源与异常（4 项）────────────────────────────────
// 异常检测不能自动删除内容（只标记 review）；
// 重复观察保留溯源关系；多观点保留而不合并为单一结论。

test('小样本异常状态为 insufficient_sample 且不扣分', () => {
  const item = normalizeRssItem(parseFeed(fixture('youtube.xml'))[0], source(), 'youtube_video', new Date(now).toISOString());
  const assessment = assessItem(item, source(), config, now);
  assert.equal(assessment.anomaly_assessment.status, 'insufficient_sample');
  assert.equal(assessment.anomaly_assessment.adjustment, 0);
});

test('重复观察保留溯源关系，同主题观点均保留', () => {
  const first = normalizeRssItem(parseFeed(fixture('youtube.xml'))[0], source(), 'youtube_video', new Date(now).toISOString());
  const duplicate = { ...first, id: `${first.id}-copy`, source_id: 'source-copy' };
  const provenance = buildProvenance([first, duplicate]);
  assert.equal(provenance[1].relation, 'duplicate_observation');
  const assessments = [assessItem(first, source(), config, now), assessItem(duplicate, source(), config, now)];
  const events = buildEvents([first, duplicate], assessments, config);
  assert.equal(events[0].content_ids.length, 2);
  assert.equal(events[0].viewpoints.length, 2);
});

test('事件聚合按内容索引写入评分并保留时间边界', () => {
  const items = [
    { id: 'first', title: 'Claude update', description: '', published_at: '2026-07-20T00:00:00Z', source_tags: [] },
    { id: 'second', title: 'Claude update', description: '', published_at: '2026-07-22T00:00:00Z', source_tags: ['官方来源'] },
    { id: 'third', title: 'Gemini update', description: '', published_at: '2026-07-21T00:00:00Z', source_tags: [] },
  ];
  const assessments = items.map(item => ({ content_id: item.id, event_id: null }));
  const events = buildEvents(items, assessments, config);
  const claudeEvent = events.find(event => event.content_ids.includes('first'));
  const geminiEvent = events.find(event => event.content_ids.includes('third'));
  assert.deepEqual(claudeEvent.content_ids, ['first', 'second']);
  assert.equal(claudeEvent.first_seen_at, '2026-07-20T00:00:00Z');
  assert.equal(claudeEvent.updated_at, '2026-07-22T00:00:00Z');
  assert.equal(claudeEvent.official_verification.status, 'official_source_present');
  assert.equal(geminiEvent.content_ids.length, 1);
  assert.deepEqual(assessments.map(assessment => assessment.event_id), [claudeEvent.id, claudeEvent.id, geminiEvent.id]);
});

test('样本达到阈值后使用 MAD 标记异常但不删除内容', () => {
  const anomalyConfig = JSON.parse(JSON.stringify(config));
  anomalyConfig.anomaly.min_samples = 5;
  const items = Array.from({ length: 6 }, (_, index) => ({
    id: `content-${index}`, source_id: 'same-source',
    metrics: { views: index === 5 ? 100000000 : 1000 + index * 10, likes: 10, comments: 2, reposts: null, replies: null },
  }));
  const assessments = items.map(item => ({
    content_id: item.id,
    anomaly_assessment: { status: 'insufficient_sample', sample_count: 0, adjustment: 0, evidence: [] },
  }));
  applyAnomalyDetection(items, assessments, anomalyConfig);
  assert.equal(assessments.at(-1).anomaly_assessment.status, 'review');
  assert.ok(assessments.at(-1).anomaly_assessment.evidence.length > 0);
  assert.equal(items.length, 6);
});

// ── 第 4 组：Coverage/降级/轮转（3 项）────────────────────────
// X 来源轮转时整体状态不能误报为 complete；
// B站多路由按最差结果聚合；动态降级保留内容并记录状态。

test('X 来源轮转时整体覆盖状态不会误报 complete', async () => {
  const xSources = Array.from({ length: 3 }, (_, index) => source({
    id: `x-${index}`, platform: 'x', handle: `user${index}`, external_id: `user${index}`,
    content_tags: ['即时资讯'],
  }));
  const rotationConfig = JSON.parse(JSON.stringify(config));
  rotationConfig.collection.x_max_sources_per_run = 1;
  const result = await runCollection({
    config: rotationConfig,
    sourcePayload: { schema_version: 1, sources: xSources },
    state: { schema_version: 1, sources: {}, x_rotation_offset: 0 },
    oldOutput: emptyOutput(),
    now, noWrite: true,
    collector: async current => ({
      items: [normalizeTweet({ id: `tweet-${current.id}`, text: 'New AI model release', createdAt: '2026-07-23T04:00:00Z' }, current, new Date(now).toISOString())],
      routeCoverage: null,
    }),
  });
  assert.equal(result.output.coverage.status, 'rotating');
  assert.equal(result.output.coverage.platforms.x.attempted, 1);
  assert.equal(result.state.x_rotation_offset, 1);
});

test('并发采集限制网络任务，并按来源顺序归并结果', async () => {
  const xSources = ['first', 'second', 'failed'].map(id => source({
    id, platform: 'x', handle: id, external_id: id, content_tags: ['即时资讯'],
  }));
  const concurrentConfig = JSON.parse(JSON.stringify(config));
  concurrentConfig.collection.x_max_sources_per_run = 3;
  concurrentConfig.collection.concurrency = 2;
  let active = 0;
  let peak = 0;
  const result = await runCollection({
    config: concurrentConfig,
    sourcePayload: { schema_version: 1, sources: xSources },
    state: { schema_version: 1, sources: {}, x_rotation_offset: 0 },
    oldOutput: emptyOutput(), now, noWrite: true, skipHistory: true,
    defaultReviewStatus: 'approved', // 管线测试保持断言公开投影
    collector: async current => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, current.id === 'first' ? 20 : 1));
      active--;
      if (current.id === 'failed') throw new Error('fixture failure');
      return {
        items: [normalizeTweet({ id: 'shared', text: `AI update from ${current.id}`, createdAt: '2026-07-23T04:00:00Z' }, current, new Date(now).toISOString())],
        routeCoverage: null,
      };
    },
  });
  assert.equal(peak, 2);
  assert.equal(result.output.items.length, 1);
  assert.equal(result.output.items[0].source_id, 'first');
  assert.equal(result.registry.videos['x:shared'].times_seen, 3);
  assert.equal(result.state.sources.failed.status, 'degraded');
  assert.equal(result.output.coverage.sources_terminal, 3);
});

test('明确 affiliate URL 形成有证据的商业标识', () => {
  const result = detectCommercial({
    title: 'AI 工具体验', description: '正常正文', url: 'https://example.com/post',
    explicit_links: ['https://vendor.example/buy?ref=creator'],
  }, config);
  assert.equal(result.label, 'affiliate_link');
  assert.ok(result.evidence.length > 0);
  assert.ok(result.penalty > 0);
});

test('互动绝对量在无来源基线时保持中性', () => {
  const base = normalizeRssItem(parseFeed(fixture('youtube.xml'))[0], source(), 'youtube_video', new Date(now).toISOString());
  const low = assessItem({ ...base, id: 'low', metrics: { views: 1, likes: 1, comments: 0 } }, source(), config, now);
  const high = assessItem({ ...base, id: 'high', metrics: { views: 1e9, likes: 1e8, comments: 1e6 } }, source(), config, now);
  assert.equal(low.score_breakdown.interaction_quality, config.scoring.neutral_score);
  assert.equal(high.score_breakdown.interaction_quality, config.scoring.neutral_score);
});

test('B站纯转发的长期与真实体验贡献低于原创动态', () => {
  const base = normalizeRssItem(parseFeed(fixture('bilibili-dynamic.xml'))[1], source({ platform: 'bilibili' }), 'bilibili_dynamic', new Date(now).toISOString());
  const original = assessItem(base, source({ quality_prior: 80 }), config, now);
  const repost = assessItem({ ...base, id: 'repost', content_type: 'bilibili_dynamic_repost' }, source({ quality_prior: 80 }), config, now);
  assert.ok(repost.score_breakdown.long_term_quality < original.score_breakdown.long_term_quality);
  assert.equal(repost.score_breakdown.light_user_experience, config.scoring.neutral_score);
});

test('显式引用能关联本批次已采集的候选原文', () => {
  const original = {
    id: 'original', platform: 'x', native_id: '1', url: 'https://x.com/source/status/1',
    content_type: 'x_post', fetched_at: new Date(now).toISOString(), explicit_links: [],
  };
  const commentary = {
    id: 'commentary', platform: 'bilibili', native_id: '2', url: 'https://t.bilibili.com/2',
    content_type: 'bilibili_dynamic_repost', fetched_at: new Date(now).toISOString(),
    explicit_links: ['https://x.com/source/status/1'],
  };
  const result = buildProvenance([original, commentary]);
  assert.equal(result[1].canonical_content_id, 'original');
  assert.equal(result[1].origin_status, 'candidate');
});

test('多来源 B站路由状态按最差结果聚合，不被后续成功掩盖', async () => {
  const sources = [
    source({ id: 'bi-a', platform: 'bilibili', external_id: 'a' }),
    source({ id: 'bi-b', platform: 'bilibili', external_id: 'b' }),
  ];
  const dynamic = normalizeRssItem(parseFeed(fixture('bilibili-dynamic.xml'))[1], sources[1], 'bilibili_dynamic', new Date(now).toISOString());
  const result = await runCollection({
    config, sourcePayload: { schema_version: 1, sources },
    state: { schema_version: 1, sources: {}, x_rotation_offset: 0 }, oldOutput: emptyOutput(), now, noWrite: true,
    collector: async current => current.id === 'bi-a'
      ? { items: [], routeCoverage: { video: { status: 'success', items: 0 }, dynamic: { status: 'degraded', items: 0, reason: 'timeout' }, article: { status: 'success', items: 0 } } }
      : { items: [dynamic], routeCoverage: { video: { status: 'success', items: 0 }, dynamic: { status: 'success', items: 1 }, article: { status: 'success', items: 0 } } },
  });
  assert.equal(result.output.coverage.platforms.bilibili.dynamic.status, 'degraded');
  assert.ok(result.output.coverage.platforms.bilibili.dynamic.reasons.includes('timeout'));
});

test('B站单平台范围不调用 YouTube/X 并保留旧投影', async () => {
  const sources = [
    source({ id: 'yt-scope', platform: 'youtube', external_id: 'yt' }),
    source({ id: 'x-scope', platform: 'x', external_id: 'x', handle: 'x' }),
    source({ id: 'bi-scope', platform: 'bilibili', external_id: 'bi' }),
  ];
  const calls = [];
  const oldYoutube = normalizeRssItem(parseFeed(fixture('youtube.xml'))[0], sources[0], 'youtube_video', new Date(now).toISOString());
  const dynamic = normalizeRssItem(parseFeed(fixture('bilibili-dynamic.xml'))[1], sources[2], 'bilibili_dynamic', new Date(now).toISOString());
  const result = await runCollection({
    config, sourcePayload: { schema_version: 1, sources }, platformScope: 'bilibili-only',
    state: { schema_version: 1, sources: {}, x_rotation_offset: 7 },
    oldOutput: { ...emptyOutput(), items: [oldYoutube] }, now, noWrite: true,
    defaultReviewStatus: 'approved', // 保留旧投影断言：门禁放行候选
    collector: async current => {
      calls.push(current.platform);
      return {
        items: [dynamic],
        routeCoverage: {
          video: { status: 'success', items: 0 },
          dynamic: { status: 'success', items: 1 },
          article: { status: 'success', items: 0 },
        },
      };
    },
  });
  assert.deepEqual(calls, ['bilibili']);
  assert.equal(result.output.coverage.platform_scope, 'bilibili-only');
  assert.equal(result.output.coverage.platforms.youtube.status, 'not_run');
  assert.equal(result.output.coverage.platforms.x.status, 'not_run');
  assert.equal(result.state.x_rotation_offset, 7);
  assert.ok(result.output.items.some(item => item.platform === 'youtube'));
  assert.equal(result.quota.platforms.youtube.consumed, 0);
});

test('采集范围拒绝未知值', () => {
  assert.equal(resolvePlatformScope('all'), 'all');
  assert.equal(resolvePlatformScope('bilibili-only'), 'bilibili-only');
  assert.throws(() => resolvePlatformScope('youtube-only'), /无效 NEWS_PLATFORM_SCOPE/);
});

test('人工B站内容校验链接类型并形成统一模型', () => {
  const sources = [source({ id: 'bi-manual', platform: 'bilibili', external_id: '123' })];
  const item = normalizeManualItem({
    source_id: 'bi-manual', content_type: 'bilibili_dynamic_text',
    url: 'https://www.bilibili.com/opus/123456', title: 'Claude AI 实测',
    summary: '实际使用 Claude AI 完成工作流', published_at: '2026-07-25T08:00:00Z',
  }, sources, '2026-07-25T09:00:00Z');
  assert.equal(item.native_id, 'dynamic-123456');
  assert.equal(item.acquisition_method, 'manual_curated');
  assert.equal(item.metrics.views, null);
  assert.throws(() => parseBilibiliUrl('https://example.com/opus/1'), /只允许/);
  assert.throws(() => normalizeManualItem({ ...item, url: 'https://www.bilibili.com/video/BV1abc', content_type: 'bilibili_article' }, sources), /不匹配/);
});

test('人工B站批量导入默认全有或全无并防重复', () => {
  const sources = [source({ id: 'bi-manual', platform: 'bilibili', external_id: '123' })];
  const payload = { schema_version: 1, items: [] };
  const valid = { source_id: 'bi-manual', content_type: 'bilibili_video', url: 'https://www.bilibili.com/video/BV1abc', title: 'AI 模型发布', summary: '新的 AI 模型发布', published_at: '2026-07-25T08:00:00Z' };
  const failed = importManualItems(payload, [valid, { ...valid, url: 'https://example.com/x' }], sources);
  assert.equal(failed.committed, false);
  assert.equal(payload.items.length, 0);
  const success = importManualItems(payload, [valid], sources);
  assert.equal(success.committed, true);
  assert.equal(payload.items.length, 1);
});

test('默认人工模式不调用B站网络并消费人工条目', async () => {
  const manualConfig = JSON.parse(JSON.stringify(config));
  manualConfig.collection.bilibili_collection_mode = 'manual';
  const bi = source({ id: 'bi-manual', platform: 'bilibili', external_id: '123' });
  const manual = { source_id: bi.id, content_type: 'bilibili_article', url: 'https://www.bilibili.com/read/cv123', title: 'Claude AI 深度解读', description: 'Claude AI 深度解读和实际使用', published_at: '2026-07-23T08:00:00Z' };
  let calls = 0;
  const result = await runCollection({
    config: manualConfig, sourcePayload: { schema_version: 1, sources: [bi] },
    state: { schema_version: 1, sources: {}, x_rotation_offset: 0 }, oldOutput: emptyOutput(),
    manualItems: { schema_version: 1, items: [manual] }, now, noWrite: true, skipHistory: true,
    defaultReviewStatus: 'approved',
    fetchImpl: async () => { calls++; throw new Error('不应调用网络'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.output.coverage.platforms.bilibili.status, 'manual_curated');
  assert.equal(result.output.items[0].acquisition_method, 'manual_curated');
});

test('B站诊断遇到Cloudflare后只探测一次并打开断路器', async () => {
  const biSources = [1, 2, 3].map(index => source({ id: `bi-${index}`, platform: 'bilibili', external_id: String(index) }));
  let calls = 0;
  const result = await runCollection({
    config, sourcePayload: { schema_version: 1, sources: biSources }, platformScope: 'bilibili-only',
    state: { schema_version: 1, sources: {}, x_rotation_offset: 0 }, oldOutput: emptyOutput(),
    manualItems: { schema_version: 1, items: [] }, now, noWrite: true, allowEmpty: true,
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 403, headers: { get: key => key === 'server' ? 'cloudflare' : null }, text: async () => '<title>Just a moment...</title>' };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.quota.platforms.bilibili.consumed, 1);
  assert.equal(result.output.coverage.platforms.bilibili.reason, 'rsshub_provider_blocked');
  assert.equal(result.output.coverage.history.status, 'provider_circuit_open');
});

test('采集批次保留 B站动态且显式记录动态降级', async () => {
  const sources = {
    schema_version: 1,
    sources: [
      source({ id: 'yt', platform: 'youtube', content_tags: ['即时资讯'] }),
      source({ id: 'bi', platform: 'bilibili', content_tags: ['轻度用户体验'] }),
    ],
  };
  const yt = normalizeRssItem(parseFeed(fixture('youtube.xml'))[0], sources.sources[0], 'youtube_video', new Date(now).toISOString());
  const dynamic = normalizeRssItem(parseFeed(fixture('bilibili-dynamic.xml'))[1], sources.sources[1], 'bilibili_dynamic', new Date(now).toISOString());
  const result = await runCollection({
    config, sourcePayload: sources,
    state: { schema_version: 1, sources: {}, x_rotation_offset: 0 }, oldOutput: emptyOutput(), now, noWrite: true,
    defaultReviewStatus: 'approved',
    collector: async current => current.platform === 'youtube'
      ? { items: [yt], routeCoverage: null }
      : { items: [dynamic], routeCoverage: { video: { status: 'success', items: 0 }, dynamic: { status: 'degraded', items: 1, reason: 'fixture' }, article: { status: 'success', items: 0 } } },
  });
  assert.ok(result.output.items.some(item => item.content_type === 'bilibili_dynamic_text'));
  assert.equal(result.output.coverage.platforms.bilibili.dynamic.status, 'degraded');
});

// ── 第 5 组：公开热点数据契约（B16 决策 74/77/78/85/88/89）──
// 热度按平台内相对互动量级归一化、依据片段取自来源原文、关联仅精确 URL 身份

test('依据片段：来源原文受控节选，纯链接或缺失为 null', () => {
  assert.equal(buildEvidenceExcerpt({ description: '   ' }), null);
  assert.equal(buildEvidenceExcerpt({ description: '' }), null);
  assert.equal(buildEvidenceExcerpt({ description: 'https://example.com/a https://example.com/b' }), null);
  assert.equal(buildEvidenceExcerpt({ description: '来自来源的一段公开描述' }), '来自来源的一段公开描述');
  assert.equal(buildEvidenceExcerpt({ description: '', title: '仅标题' }), '仅标题');
  const longText = '很长的依据内容。'.repeat(60);
  const excerpt = buildEvidenceExcerpt({ description: longText });
  assert.ok(excerpt.length <= 161, `受控节选不应超过上限：${excerpt.length}`);
  assert.match(excerpt, /…$/);
});

test('热度：按平台内相对互动量级归一化，缺失互动为 null', () => {
  const items = [
    { id: 'a', platform: 'youtube', metrics: { views: 1000, likes: 10, comments: 0 } },
    { id: 'b', platform: 'youtube', metrics: { views: 100000, likes: 500, comments: 50 } },
    { id: 'c', platform: 'x', metrics: { views: 100, likes: 1 } },
    { id: 'd', platform: 'x', metrics: { views: null, likes: null, comments: null, reposts: null, replies: null } },
  ];
  computeHotScores(items);
  const byId = id => items.find(item => item.id === id);
  assert.equal(byId('d').hot_score, null);
  for (const id of ['a', 'b', 'c']) {
    assert.ok(typeof byId(id).hot_score === 'number');
    assert.ok(byId(id).hot_score >= 0 && byId(id).hot_score <= 100);
  }
  assert.ok(byId('b').hot_score > byId('a').hot_score, '同平台互动量更高的条目热度应更高');
  assert.ok(typeof HEAT_DEFINITION === 'string' && HEAT_DEFINITION.length > 0);
});

test('关联资料：仅精确规范 URL 身份匹配工具，不模糊匹配', () => {
  const index = buildToolUrlIndex([
    { id: 'tool-a', name: 'Tool A', url: 'https://example.com/tool' },
    { id: 'tool-b', name: 'Tool B', url: 'https://example.net/other' },
  ]);
  const matched = resolveRelatedResources(
    { id: 'x', url: 'https://x.com/some/status', explicit_links: ['https://example.com/tool?utm_source=news'] },
    index,
  );
  assert.deepEqual(matched, [{ type: 'tool', id: 'tool-a', label: 'Tool A' }]);
  const none = resolveRelatedResources(
    { id: 'y', url: 'https://x.com/other', explicit_links: ['https://example.org/other'] },
    index,
  );
  assert.deepEqual(none, []);
});

test('公开投影补充热度/依据/关联字段，无互动数据热度为 null', () => {
  const items = [
    { id: 'a', platform: 'youtube', url: 'https://example.com/tool', explicit_links: [], description: '测试依据片段内容', published_at: new Date(now).toISOString(), title: 'T' },
  ];
  const index = buildToolUrlIndex([{ id: 'tool-a', name: 'Tool A', url: 'https://example.com/tool' }]);
  enrichHotspotProjection(items, index);
  assert.equal(items[0].hot_score, null);
  assert.equal(items[0].evidence_excerpt, '测试依据片段内容');
  assert.deepEqual(items[0].related_resources, [{ type: 'tool', id: 'tool-a', label: 'Tool A' }]);
});
