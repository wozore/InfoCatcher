/**
 * news-tests.test.js — 内容语义与采集行为测试（17 项）
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
 *   第 4 组 — Coverage/降级/轮转（3 项）
 *     验证采集覆盖状态不误报、B站降级不丢失内容
 *
 * 运行方式：node --test scripts/news-tests.test.js
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
  runCollection,
} = require('./build-news');

const MVP_DIR = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(MVP_DIR, 'data/news-config.json'), 'utf8'));
const fixture = name => fs.readFileSync(path.join(__dirname, 'news-fixtures', name), 'utf8');
const now = new Date('2026-07-23T12:00:00Z').getTime();

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
    state: { schema_version: 1, sources: {}, x_rotation_offset: 0 }, now, noWrite: true,
    collector: async current => current.id === 'bi-a'
      ? { items: [], routeCoverage: { video: { status: 'success', items: 0 }, dynamic: { status: 'degraded', items: 0, reason: 'timeout' }, article: { status: 'success', items: 0 } } }
      : { items: [dynamic], routeCoverage: { video: { status: 'success', items: 0 }, dynamic: { status: 'success', items: 1 }, article: { status: 'success', items: 0 } } },
  });
  assert.equal(result.output.coverage.platforms.bilibili.dynamic.status, 'degraded');
  assert.ok(result.output.coverage.platforms.bilibili.dynamic.reasons.includes('timeout'));
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
    config, sourcePayload: sources, state: { schema_version: 1, sources: {}, x_rotation_offset: 0 }, now, noWrite: true,
    collector: async current => current.platform === 'youtube'
      ? { items: [yt], routeCoverage: null }
      : { items: [dynamic], routeCoverage: { video: { status: 'success', items: 0 }, dynamic: { status: 'degraded', items: 1, reason: 'fixture' }, article: { status: 'success', items: 0 } } },
  });
  assert.ok(result.output.items.some(item => item.content_type === 'bilibili_dynamic_text'));
  assert.equal(result.output.coverage.platforms.bilibili.dynamic.status, 'degraded');
});
