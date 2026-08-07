/**
 * scripts/build-news.js — 热点构建管线 CLI 入口（薄包装）
 *
 * 双重角色：直接运行时为 CLI（node scripts/build-news.js）；被 require 时
 * 透传 re-export src/news/pipeline/build-news 的全部导出，供 publish-news.js、
 * benchmark-news.js 复用同一份实现。
 *
 * 用法：
 *   node scripts/build-news.js               # 旧流程（v1，现状不动）
 *   node scripts/build-news.js --min         # 热点管线 v2（调 runMin；缺 API key 各平台降级不崩）
 *   node scripts/build-news.js --min --fixture  # v2 注入 mock 采集器跑通全链（无网络、确定性）
 */
'use strict';

// 先加载 .env（密钥只经环境变量注入，见 src/shared/env.js），再加载实现。
// 必须在 require 实现之前调用：实现模块顶层会读 process.env.DEEPSEEK_API_KEY。
const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const implementation = require('../src/news/pipeline/build-news');

// ── 热点管线 v2 CLI 入口（--min / --min --fixture）────────────────
// 只做接线：调 runMin 编排，不重写任何 v2 模块。
// 无 API key 时 YouTube/X 采集器各自降级返回空（coverage.status='failed'），
// AI 步骤（分类/审核/总结/本地化）缺 DEEPSEEK_API_KEY 即时降级，管线不抛错。
async function mainMin() {
  const { runMin } = require('../src/news/min/pipeline-min');
  const fixture = process.argv.includes('--fixture');
  const options = fixture ? buildMinFixtureOptions() : {};
  const { coverage, minCandidates, publicItems } = await runMin(options);
  const youtube = coverage.collectors && coverage.collectors.youtube;
  const x = coverage.collectors && coverage.collectors.x;
  console.log(`ℹ️ v2 覆盖：${coverage.status}（youtube=${youtube ? `${youtube.status}/${youtube.items || 0} 条` : '未运行'}，x=${x ? `${x.status}/${x.items || 0} 条` : '未运行'}）`);
  if (coverage.status === 'failed') {
    const reasons = [youtube && youtube.reason, x && x.reason].filter(Boolean).join('；');
    console.log(`   ⚠️ 双采集均失败${reasons ? `（${reasons}）` : ''}——通常因缺 API key，管线已降级不崩`);
  }
  if (fixture) console.log('   注：--fixture 为 mock 采集，覆盖状态仅用于验证 v2 管线贯通');
  console.log(`✅ v2 构建完成：minCandidates=${minCandidates}，publicItems=${publicItems}`);
  return { coverage, minCandidates, publicItems };
}

/** --min --fixture 注入：mock 采集器 + 纯规则 AI 步骤（无网络、确定性、可复现）。 */
function buildMinFixtureOptions() {
  const now = new Date('2026-08-05T12:00:00Z');
  const fetchedAt = now.toISOString();
  const published = new Date(now.getTime() - 2 * 86400000).toISOString();
  const mk = (id, platform, nativeId, title, description) => ({
    id,
    platform,
    native_id: nativeId,
    source_type: platform === 'youtube' ? 'youtube_video' : 'x_post',
    url: platform === 'youtube'
      ? `https://www.youtube.com/watch?v=${nativeId}`
      : `https://x.com/OpenAI/status/${nativeId}`,
    title,
    description,
    published_at: published,
    fetched_at: fetchedAt,
    author_id: platform === 'youtube' ? 'youtube-fixture-channel' : 'x-fixture-openai',
    author_name: platform === 'youtube' ? 'Fixture AI Channel' : 'OpenAI',
    source_id: platform === 'youtube' ? 'youtube-fixture-channel' : 'x-fixture-openai',
    language: 'en',
    source_tags: [],
    thumbnail: null,
    metrics: { views: 1200, likes: 120, comments: 8, reposts: null, replies: null },
    explicit_links: [],
    comments: [],
    content_type: null,
  });
  const youtubeItems = [
    mk('youtube-fixture-1', 'youtube', 'vid-abc123', 'DeepSeek 发布新推理模型，agent 能力再进一步',
      'DeepSeek 官方演示了新一代推理模型，重点提升智能体（agent）在复杂任务上的表现。'),
    mk('youtube-fixture-2', 'youtube', 'vid-def456', '用 GPT 智能体重构编码工作流', 'OpenAI GPT agent 让软件开发的日常流程大幅自动化。'),
  ];
  const xItems = [
    mk('x-fixture-1', 'x', 'tweet-111', 'Anthropic Claude 新增长上下文 RAG 能力', 'AnthropicAI: Claude 现在支持更长的上下文与 RAG 工作流，欢迎实测。'),
    mk('x-fixture-2', 'x', 'tweet-222', 'Gemini 多模态智能体新演示', 'GoogleDeepMind 展示 Gemini 在多模态 agent 任务上的进展。'),
  ];
  const fixtureCollector = items => async () => ({ items, coverage: { status: 'success', reason: null } });
  const classify = async item => ({
    content_type: /agent|智能体/.test(item.title) ? 'ai_technology' : 'ai_industry',
    content_type_status: 'rule_based',
    classifier: 'mock-fixture',
    reasons: ['mock-fixture'],
  });
  const review = async items => ({
    kept: (items || []).map(item => ({
      ...item,
      review_status: 'pending',
      l1_review: { verdict: null, reasons: [], confidence: 0, llm_error: 'mock-fixture' },
      ai_advice: null,
    })),
    discarded: [],
  });
  const summarize = async items => {
    let summarized = 0;
    for (const item of items || []) {
      if (item && !item.summary) { item.summary = `${item.title}：聚焦 AI 领域最新进展，值得关注。`; summarized += 1; }
    }
    return { summarized };
  };
  const localize = async items => {
    let localized = 0;
    for (const item of items || []) {
      if (item && !item.localizations) {
        item.localizations = { zh: { title: item.title, description: item.description } };
        localized += 1;
      }
    }
    return { localized };
  };

  // 内存存根：fixture 全链验证用，绝不对真实运行时文件落盘
  // （min-candidates.json / source-history.json 保持未被污染的状态）。
  // 签名对齐 pipeline-min 注入点：historyIn()/historyOut(store,runId)/
  // minStoreIn()/minStoreOut(store,runId)。
  const memHistory = () => ({ sources: {} });
  const memHistoryOut = () => {};
  const memMin = () => ({ schema_version: 1, updated_at: null, candidates: [] });
  const memMinOut = () => {};

  return {
    now,
    collectors: { youtube: fixtureCollector(youtubeItems), x: fixtureCollector(xItems) },
    classify,
    review,
    summarize,
    localize,
    historyIn: memHistory,
    historyOut: memHistoryOut,
    minStoreIn: memMin,
    minStoreOut: memMinOut,
  };
}

// require.main === module：仅作为主入口直接执行时才跑管线；被 require（复用实现）时不产生副作用。
if (require.main === module) {
  if (process.argv.includes('--min')) {
    mainMin().catch(error => {
      console.error(`❌ 热点构建 v2 失败：${error.message}`);
      process.exit(1);
    });
  } else {
    implementation.main().catch(error => {
      console.error(`❌ 热点构建失败：${error.message}`);
      process.exit(1);
    });
  }
}

module.exports = implementation;
