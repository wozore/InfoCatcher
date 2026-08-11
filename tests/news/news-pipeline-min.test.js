/**
 * news-pipeline-min.test.js — 热点管线 v2 总指挥（pipeline-min.runMin）全链测试
 *
 * 测试原理：
 *   不请求真实网络，注入 mock 采集器 / 审核 / 总结 / 本地化验证全链：
 *     L0 丢弃 → 分类 → 评分 → 审核 → 候选落地 → 总结/本地化 → 每日公开投影。
 *
 * 覆盖：
 *   1. mock 采集 4 条（2 X + 2 YouTube，含 1 条缺字段、1 条非 AI）
 *      → L0 丢弃 2 条（coverage.l0_dropped=2）、分类 2 条、评分 2 条；
 *   2. mock 审核：YouTube 项判 discarded、X 项 kept → 候选层单状态轴齐全；
 *   3. hotspots.json 公开投影无内部字段（review_status / ai_advice / final_score 剔除）；
 *   4. discarded 候选不进公开投影；候选层保留 review_status。
 *
 * 运行方式：node --test tests/news/news-pipeline-min.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { runMin, isCollectionEnabled } = require('../../src/news/min/pipeline-min');
const { NEWS_FILES } = require('../../src/shared/paths');
const { readJson, writeJsonAtomic } = require('../../src/news/core/news-storage');

const CONFIG = require('../../data/news/config/news-config-v2.json');

const MIN_PATH = NEWS_FILES.minCandidates;
const HISTORY_PATH = NEWS_FILES.sourceHistory;
const HOTSPOTS_PATH = NEWS_FILES.hotspots;
const LAST_RUN_PATH = NEWS_FILES.lastRun;

/** 备份/恢复真实数据文件，测试不污染仓库。 */
const backups = {};
function backupAll() {
  for (const file of [MIN_PATH, HISTORY_PATH, HOTSPOTS_PATH, LAST_RUN_PATH]) {
    try { backups[file] = fs.readFileSync(file, 'utf8'); }
    catch { backups[file] = null; }
  }
}
function restoreAll() {
  for (const [file, content] of Object.entries(backups)) {
    if (content === null) { try { fs.unlinkSync(file); } catch {} }
    else { fs.writeFileSync(file, content, 'utf8'); }
  }
}

/** 固定参考时间（2026-08-07 14:00 北京时间）。 */
const NOW = new Date('2026-08-07T06:00:00Z');
const hoursAgo = n => new Date(NOW.getTime() - n * 3600 * 1000).toISOString();

// ── mock 采集数据：4 条（2 X + 2 YouTube） ──
// xItem1：有效 AI 推文（过 L0）
const xItem1 = {
  id: 'x-mock-openai-launch', platform: 'x', native_id: 'mock-x-1001', source_type: 'x_post',
  url: 'https://x.com/OpenAI/status/1001',
  title: 'OpenAI launches new GPT model for developers',
  description: 'OpenAI introduces a brand new reasoning model today.',
  published_at: hoursAgo(1), fetched_at: NOW.toISOString(),
  author_id: 'x-hashopenai', author_name: 'OpenAI', source_id: 'x-hashopenai',
  language: 'en', source_tags: [], thumbnail: null,
  metrics: { views: 1000, likes: 200, comments: null, reposts: 50, replies: 10 },
  explicit_links: ['https://openai.com'], content_type: null, comments: [],
};
// xItem2：缺 published_at → L0 incomplete
const xItem2 = {
  id: 'x-mock-no-date', platform: 'x', native_id: 'mock-x-1002', source_type: 'x_post',
  url: 'https://x.com/SomeAI/status/1002', title: 'AI news without date',
  description: 'some AI content', published_at: null, fetched_at: NOW.toISOString(),
  author_id: 'x-hashsomeai', author_name: 'SomeAI', source_id: 'x-hashsomeai',
  language: 'en', source_tags: [], thumbnail: null,
  metrics: { views: 10, likes: 1, comments: null, reposts: 0, replies: 0 },
  explicit_links: [], content_type: null, comments: [],
};
// ytItem1：有效 AI 视频（过 L0，审核判 discarded）
const ytItem1 = {
  id: 'youtube-mock-deepseek', platform: 'youtube', native_id: 'mock-yt-2001', source_type: 'youtube_video',
  url: 'https://www.youtube.com/watch?v=2001',
  title: 'DeepSeek releases new reasoning model',
  description: 'DeepSeek-R2 tested: benchmark results and practical guide.',
  published_at: hoursAgo(2), fetched_at: NOW.toISOString(),
  author_id: 'youtube-hashdeepseek', author_name: 'DeepSeek', source_id: 'youtube-hashdeepseek',
  language: 'en', source_tags: [], thumbnail: null,
  metrics: { views: 5000, likes: 400, comments: 30, reposts: null, replies: null },
  explicit_links: [], content_type: null, comments: [],
};
// ytItem2：非 AI → L0 not_ai
const ytItem2 = {
  id: 'youtube-mock-cooking', platform: 'youtube', native_id: 'mock-yt-2002', source_type: 'youtube_video',
  url: 'https://www.youtube.com/watch?v=2002',
  title: 'Homemade pizza dough recipe',
  description: 'Easy step by step cooking guide for dinner tonight.',
  published_at: hoursAgo(3), fetched_at: NOW.toISOString(),
  author_id: 'youtube-hashcooking', author_name: 'CookingChannel', source_id: 'youtube-hashcooking',
  language: 'en', source_tags: [], thumbnail: null,
  metrics: { views: 100, likes: 5, comments: 1, reposts: null, replies: null },
  explicit_links: [], content_type: null, comments: [],
};

// ── 预置候选：1 条已人工 approved（可进公开投影） ──
const seed = {
  id: 'x-mock-seed-approved', platform: 'x', native_id: 'mock-seed-1', source_type: 'x_post',
  url: 'https://x.com/AnthropicAI/status/seed1',
  title: 'Anthropic Claude update already approved',
  description: 'This item was approved by human reviewer earlier.',
  published_at: hoursAgo(5), fetched_at: NOW.toISOString(),
  author_id: 'x-hashanthropic', author_name: 'AnthropicAI', source_id: 'x-hashanthropic',
  language: 'en', source_tags: [], thumbnail: null,
  metrics: { views: 800, likes: 120, comments: null, reposts: 10, replies: 0 },
  explicit_links: ['https://anthropic.com'], content_type: 'ai_product',
  // 模拟真实"已总结/本地化再获批"的候选：summary/summary_key_points/localizations 为
  // 人工审核通过前经 summarize/localize 写入的公开字段，须经白名单存活到公开投影。
  summary: '摘要：Anthropic Claude update already approved',
  summary_key_points: ['要点一', '要点二'],
  localizations: { zh: { title: '中文标题：Anthropic Claude update already approved', description: 'This item was approved by human reviewer earlier.' } },
  review_status: 'approved', reviewed_at: hoursAgo(4),
  // 模拟维护者已从 AI 待选项确认显示（第二阶段）→ 可进公开投影
  top_selected: true,
  ai_advice: { verdict: 'approve', reasons: ['人工确认'] },
};

const previousPublicItem = {
  id: seed.id,
  platform: seed.platform,
  native_id: seed.native_id,
  content_type: seed.content_type,
  url: seed.url,
  title: seed.title,
  description: seed.description,
  published_at: seed.published_at,
  summary: seed.summary,
  summary_key_points: seed.summary_key_points,
  localizations: seed.localizations,
  hot_score: 80,
  evidence_excerpt: seed.description,
  related_resources: [],
};

// ── mock 注入 ──
const collectors = {
  youtube: async () => ({ items: [ytItem1, ytItem2], quota: {}, coverage: { status: 'success' } }),
  x: async () => ({
    items: [xItem1, xItem2],
    credits: {
      used: 45,
      budget: 3750,
      tweets: 2,
      articles: 0,
      requests: { total: 1, tweet: 1, article: 0, retries: 0 },
    },
    coverage: { status: 'success' },
  }),
};
// 审核 mock：YouTube 判 discarded、X 判 kept（避免真实 LLM）
const review = async items => {
  const kept = [];
  const discarded = [];
  for (const item of items) {
    if (item.platform === 'youtube') {
      discarded.push({ ...item, review_status: 'discarded', discard_stage: 'l1', discard_reason: 'ai_discard', l1_review: null, ai_advice: null });
    } else {
      kept.push({ ...item, review_status: 'pending', l1_review: null, ai_advice: { verdict: 'approve', reasons: [] } });
    }
  }
  return { kept, discarded };
};
const summarize = async items => {
  let summarized = 0;
  for (const item of items) {
    item.summary = `摘要：${item.title}`;
    item.summary_key_points = ['要点一', '要点二'];
    summarized += 1;
  }
  return { summarized, skipped: 0 };
};
const localize = async items => {
  let localized = 0;
  for (const item of items) {
    item.localizations = { zh: { title: `中文标题：${item.title}`, description: item.description } };
    localized += 1;
  }
  return { localized, skipped: 0 };
};

test('热点采集总开关仅接受严格布尔 true', () => {
  assert.equal(isCollectionEnabled({ collection: { enabled: true } }), true);
  assert.equal(isCollectionEnabled({ collection: { enabled: false } }), false);
  assert.equal(isCollectionEnabled({ collection: { enabled: 'true' } }), false);
  assert.equal(isCollectionEnabled({ collection: {} }), false);
  assert.equal(isCollectionEnabled({}), false);
  assert.equal(isCollectionEnabled(null), false);
});

test('热点采集总开关关闭时全链零调用、零写入', async () => {
  const calls = [];
  const never = name => () => {
    calls.push(name);
    throw new Error(`${name} 不应被调用`);
  };
  const result = await runMin({
    config: { ...CONFIG, collection: { ...CONFIG.collection, enabled: false } },
    now: NOW,
    collectors: { youtube: never('youtube'), x: never('x') },
    classify: never('classify'),
    score: never('score'),
    review: never('review'),
    summarize: never('summarize'),
    localize: never('localize'),
    historyIn: never('historyIn'),
    historyOut: never('historyOut'),
    minStoreIn: never('minStoreIn'),
    minStoreOut: never('minStoreOut'),
    lastRunOut: never('lastRunOut'),
    runId: 'test-min-disabled',
  });

  assert.deepEqual(calls, []);
  assert.equal(result.coverage.status, 'disabled');
  assert.equal(result.coverage.collection_enabled, false);
  assert.equal(result.coverage.collectors.youtube.status, 'not_run');
  assert.equal(result.coverage.collectors.x.status, 'not_run');
  assert.equal(result.minCandidates, 0);
  assert.equal(result.publicItems, 0);
});

test('采集状态汇总：单平台失败/降级为 partial，全部失败才是 failed', async () => {
  const runCase = async (youtubeStatus, xStatus) => runMin({
    config: CONFIG,
    now: NOW,
    collectors: {
      youtube: async () => ({ items: [], coverage: { status: youtubeStatus, reason: youtubeStatus === 'success' ? null : 'youtube_test' } }),
      x: async () => ({
        items: [],
        credits: { used: 0, budget: 3750, tweets: 0, articles: 0, requests: { total: 0, tweet: 0, article: 0, retries: 0 } },
        coverage: { status: xStatus, reason: xStatus === 'success' ? null : 'x_test' },
      }),
    },
    review: async () => ({ kept: [], discarded: [] }),
    summarize: async () => ({ summarized: 0 }),
    localize: async () => ({ localized: 0 }),
    historyIn: () => ({ sources: {} }),
    historyOut: () => {},
    minStoreIn: () => ({ schema_version: 1, updated_at: null, candidates: [] }),
    minStoreOut: () => {},
    lastRunOut: () => {},
    autoReviewList: false,
  });

  assert.equal((await runCase('success', 'failed')).coverage.status, 'partial');
  assert.equal((await runCase('success', 'partial')).coverage.status, 'partial');
  assert.equal((await runCase('failed', 'failed')).coverage.status, 'failed');
});

test('pipeline-min 全链：L0 丢弃 → 分类 → 评分 → 审核 → 候选 → 投影', async () => {
  backupAll();
  // 预置已 approved 候选
  writeJsonAtomic(MIN_PATH, { schema_version: 1, updated_at: NOW.toISOString(), candidates: [seed] }, 'test-seed');

  let result;
  try {
    result = await runMin({
      config: CONFIG,
      now: NOW,
      collectors,
      review,
      summarize,
      localize,
      minStoreIn: () => ({ schema_version: 1, updated_at: NOW.toISOString(), candidates: [seed] }),
      runId: 'test-min',
      autoReviewList: false, // 关闭自动生成待审清单，避免污染 data/manual/（清单生成有独立测试）
    });
  } catch (error) {
    restoreAll();
    throw error;
  }

  try {
    // ── 返回统计 ──
    assert.equal(result.minCandidates, 5, '候选层总数 = 预置 1 + kept 1 + L1 discarded 1 + L0 dropped 2');
    assert.equal(result.publicItems, 1, '公开投影仅含预置 approved 候选');
    assert.equal(result.coverage.status, 'complete');
    assert.equal(result.coverage.collected_total, 4);
    assert.equal(result.coverage.after_dedupe, 4);
    assert.equal(result.coverage.l0_dropped, 2, '缺字段 + 非 AI 各 1 条被 L0 丢弃');
    assert.equal(result.coverage.classified, 2, '过 L0 的两条完成分类');
    assert.equal(result.coverage.scored, 2, '过 L0 的两条完成评分');
    assert.equal(result.coverage.kept, 1);
    assert.equal(result.coverage.discarded, 1);
    assert.equal(result.coverage.summarized, 1, '仅 pending 的 kept 被总结');
    assert.equal(result.coverage.localized, 1, '仅 pending 的 kept 被本地化');

    // ── 候选层：单状态轴齐全 ──
    const minStore = readJson(MIN_PATH, null);
    assert.equal(minStore.candidates.length, 5);
    const byId = new Map(minStore.candidates.map(c => [c.id, c]));
    assert.ok(byId.has('x-mock-seed-approved'));
    for (const candidate of minStore.candidates) {
      assert.ok(['pending', 'approved', 'discarded'].includes(candidate.review_status), `${candidate.id} 有合法 review_status`);
    }
    const xKept = byId.get(xItem1.id);
    assert.equal(xKept.review_status, 'pending');
    assert.equal(xKept.content_type, 'ai_technology', 'X 项已分类');
    assert.equal(typeof xKept.final_score, 'number', 'X 项已评分');
    assert.equal(xKept.summary, `摘要：${xItem1.title}`, 'pending 项已总结');
    assert.ok(xKept.localizations && xKept.localizations.zh, 'pending 项已本地化');
    const ytDiscarded = byId.get(ytItem1.id);
    assert.equal(ytDiscarded.review_status, 'discarded');
    assert.equal(ytDiscarded.discard_stage, 'l1');
    assert.equal(byId.get(xItem2.id).review_status, 'discarded');
    assert.equal(byId.get(xItem2.id).discard_stage, 'l0');
    assert.equal(byId.get(ytItem2.id).discard_stage, 'l0');

    // ── 公开投影：无内部字段、discarded 不进入 ──
    const hotspots = readJson(HOTSPOTS_PATH, null);
    assert.equal(hotspots.items.length, 1);
    const publicItem = hotspots.items[0];
    assert.equal(publicItem.id, seed.id, '当前批次无 approved 时保留上一版公开投影');
    const internalFields = ['review_status', 'reviewed_at', 'ai_advice', 'l1_review', 'discard_stage', 'discard_reason', 'final_score', 'score_breakdown'];
    for (const field of internalFields) {
      assert.equal(publicItem[field], undefined, `公开条目不含内部字段 ${field}`);
    }
    assert.ok('hot_score' in publicItem, '公开条目补充 hot_score');
    assert.ok('evidence_excerpt' in publicItem, '公开条目补充 evidence_excerpt');
    assert.ok(Array.isArray(publicItem.related_resources), '公开条目补充 related_resources');
    // 白名单回归防护：approved 候选已总结/本地化的公开字段须存活到公开投影
    assert.equal(publicItem.summary, `摘要：${seed.title}`, '公开条目保留 AI 总结');
    assert.ok(Array.isArray(publicItem.summary_key_points), '公开条目保留总结要点');
    assert.ok(publicItem.localizations && publicItem.localizations.zh, '公开条目保留本地化中文');
    assert.equal(hotspots.items.some(item => item.id === ytItem1.id), false, 'discarded 候选不进公开投影');

    // ── 采集运行记录 last-run.json：每次采集结束写入，供 ai-top 判定 hasYouTube ──
    const lastRun = readJson(LAST_RUN_PATH, null);
    assert.ok(lastRun, 'last-run.json 已写入');
    assert.equal(lastRun.run_id, 'test-min', 'last-run 记录 run_id');
    assert.equal(lastRun.collected_at, NOW.toISOString(), 'last-run 记录采集时间');
    assert.deepEqual(lastRun.platforms, ['youtube', 'x'], 'last-run 记录启用平台');
    assert.equal(lastRun.collectors.youtube.status, 'success');
    assert.equal(lastRun.collectors.youtube.items, 2, 'YouTube 实际采到 2 条');
    assert.equal(lastRun.collectors.x.status, 'success');
    assert.equal(lastRun.collectors.x.items, 2, 'X 实际采到 2 条');
    assert.deepEqual(lastRun.collectors.x.credits, {
      used: 45,
      budget: 3750,
      tweets: 2,
      articles: 0,
      requests: { total: 1, tweet: 1, article: 0, retries: 0 },
    });
  } finally {
    restoreAll();
  }
});

test('pipeline-min 审核失败降级：全部保留为 pending，不抛错', async () => {
  backupAll();
  let capturedMinStore = null;
  let result;
  try {
    result = await runMin({
      config: CONFIG,
      now: NOW,
      collectors,
      summarize,
      localize,
      review: async () => { throw new Error('llm outage'); },
      // 该测试只验证本次审核失败产生的候选，使用空的内存候选层，
      // 避免把仓库中已有的历史候选计入 pending 数量。
      minStoreIn: () => ({ schema_version: 1, updated_at: null, candidates: [] }),
      minStoreOut: store => { capturedMinStore = store; },
      runId: 'test-min-degrade',
      autoReviewList: false, // 关闭自动生成待审清单，避免污染 data/manual/（清单生成有独立测试）
    });
  } catch (error) {
    restoreAll();
    throw error;
  }
  try {
    assert.equal(result.coverage.status, 'partial', '审核失败 → partial');
    assert.ok(result.coverage.review_error.includes('llm outage'));
    assert.equal(result.coverage.kept, 2, '审核失败降级：过 L0 的两条全部保留');
    assert.equal(result.coverage.discarded, 0);
    assert.ok(capturedMinStore, '审核失败测试应捕获内存候选层');
    const keptCount = capturedMinStore.candidates.filter(c => c.review_status === 'pending').length;
    assert.equal(keptCount, 2, '降级保留的候选均为 pending');
    const hotspots = readJson(HOTSPOTS_PATH, null);
    assert.equal(result.coverage.public_projection, 'empty_skipped_write', '无 approved 候选 → 空投影不写盘');
    assert.ok(hotspots && hotspots.items.length > 0, '空投影保留上一版 hotspots.json（不覆盖为空）');
  } finally {
    restoreAll();
  }
});
