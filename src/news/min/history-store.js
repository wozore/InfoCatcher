/**
 * history-store.js —— 来源长期质量历史库（热点管线 v2）
 *
 * 在热点管线中的位置：v2 评分层（scoring-v2.js）的数据源。
 * 为每个来源（<platform>:<sourceKey>）持久化历史互动样本，
 * 并基于窗口时限内最近 window_n 个样本，用三率加权
 * （综合参与率 c / 赞评比 d / 点赞率 a）计算来源长期质量分（0~100）。
 *
 * 纯本地统计：本模块不发起任何网络请求、不消耗 API 额度。
 *
 * 数据文件：data/news/runtime/source-history.json（不发布到 dist/）
 *   schema:
 *     { sources: { "<platform>:<sourceKey>": {
 *         samples: [ { published_at, views, likes, comments, reposts, replies } ],
 *         seen_native_ids: [ ... ],   // 幂等去重登记（内部字段，不属于公开样本）
 *       } } }
 *   sourceKey = X 用 handle、YouTube 用 channelId
 *   （优先取 item.source_key；否则从 item.source_id 去掉 "<platform>-" 前缀派生）。
 *
 * 评分语义（news-config-v2.json long_term_quality）：
 *   1) 按 published_at 距今是否在窗口时限内过滤（YouTube window_months_youtube=6 /
 *      X window_months_x=2），取最近 window_n=10 个；
 *   2) 窗口内样本数不足 observation_period_count=3 → insufficient（中性 50）；
 *   3) 样本数在 [observation_period_count, min_samples) 即 3~4 → observation，
 *      三率原始分压缩映射到 observation_score_range=[20,60]（20 + 40×raw/100）；
 *   4) 样本数 ≥ min_samples=5 → long_term，三率原始分直接作为 0~100 分。
 *
 * 三率加权（c 为主、d 修正、a 最小加分）：
 *   c = (likes + comments + reposts) / views   —— 综合参与率，权重 0.6
 *   d = likes / comments                        —— 赞评比（对数刻度），权重 0.25
 *   a = likes / views                           —— 点赞率，权重 0.15
 *   分母不可用时该条速率取中性（跳过该样本的该项统计）；全无数据时各速率记中性 50。
 */

'use strict';

const { readJson, writeJsonAtomic } = require('../../shared/json-store');
const { NEWS_FILES } = require('../../shared/paths');

const HISTORY_PATH = NEWS_FILES.sourceHistory;

const DAY_MS = 86400000;
// 平均月长（365.25/12 天），用于把配置里的 window_months_* 换算成毫秒窗口
const MONTH_MS = DAY_MS * 30.4375;

// 三率加权权重：c 主 / d 修正 / a 最小加分
const RATE_WEIGHTS = { c: 0.6, d: 0.25, a: 0.15 };

/** 读历史库；文件不存在时返回空 store。 */
function readHistoryStore() {
  return readJson(HISTORY_PATH, { sources: {} });
}

/** 原子写回历史库。 */
function writeHistoryStore(store, runId = 'history') {
  writeJsonAtomic(HISTORY_PATH, store, runId);
}

function finiteOr(value) {
  return Number.isFinite(value) ? value : null;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 从 item 派生 sourceKey：
 *   item.source_key 优先；否则去 source_id 的 "<platform>-" 前缀；
 *   再退化为 channel_id / author_id。
 */
function sourceKeyOf(item) {
  if (item.source_key) return item.source_key;
  const prefix = `${item.platform || ''}-`;
  if (item.source_id && prefix.length > 0 && item.source_id.startsWith(prefix)) {
    return item.source_id.slice(prefix.length);
  }
  return item.source_id || item.channel_id || item.author_id || null;
}

function ensureStore(store) {
  if (store && store.sources && typeof store.sources === 'object') return store;
  return { sources: {} };
}

/**
 * 把每条 item 的互动样本（metrics + published_at）按 "<platform>:<sourceKey>"
 * 追加进 store 的 samples。幂等：同 native_id 不重复追加（由 seen_native_ids 登记）。
 * 直接修改并返回传入的 store。
 */
function appendSamples(store, items) {
  const next = ensureStore(store);
  for (const item of items || []) {
    if (!item || !item.native_id) continue;
    const sourceKey = sourceKeyOf(item);
    if (!sourceKey) continue;
    const key = `${item.platform || 'unknown'}:${sourceKey}`;
    const entry = next.sources[key] || (next.sources[key] = { samples: [], seen_native_ids: [] });
    if (!entry.seen_native_ids) entry.seen_native_ids = [];
    if (entry.seen_native_ids.includes(item.native_id)) continue;
    const m = item.metrics || {};
    entry.samples.push({
      published_at: item.published_at || null,
      views: finiteOr(m.views),
      likes: finiteOr(m.likes),
      comments: finiteOr(m.comments),
      reposts: finiteOr(m.reposts),
      replies: finiteOr(m.replies),
    });
    entry.seen_native_ids.push(item.native_id);
  }
  return next;
}

/**
 * 单条样本的三率：
 *   c = 综合参与率 (likes+comments+reposts)/views
 *   d = 赞评比 likes/comments
 *   a = 点赞率 likes/views
 * 分母不可用（缺失/0/非数字）时对应速率返回 null。
 */
function perSampleRates(sample) {
  const views = sample.views;
  const likes = sample.likes;
  const comments = sample.comments;
  const reposts = sample.reposts;
  const c = Number.isFinite(views) && views > 0
    ? ((Number.isFinite(likes) ? likes : 0)
       + (Number.isFinite(comments) ? comments : 0)
       + (Number.isFinite(reposts) ? reposts : 0)) / views
    : null;
  const d = Number.isFinite(comments) && comments > 0 && Number.isFinite(likes)
    ? likes / comments
    : null;
  const a = Number.isFinite(views) && views > 0 && Number.isFinite(likes)
    ? likes / views
    : null;
  return { c, d, a };
}

function averageOf(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

/** c 参与率 → 分：参与率 15% 记满分 100，线性；无数据取中性 50。 */
function scoreCRate(value) {
  if (value == null) return 50;
  return clamp(100 * value / 0.15);
}

/** d 赞评比 → 分：对数刻度，50:1 记满分（log10(51)）；无数据取中性 50。 */
function scoreDRate(value) {
  if (value == null) return 50;
  return clamp(100 * Math.log10(value + 1) / Math.log10(51));
}

/** a 点赞率 → 分：点赞率 10% 记满分；无数据取中性 50。 */
function scoreARate(value) {
  if (value == null) return 50;
  return clamp(100 * value / 0.10);
}

/**
 * 三率加权综合分（0~100，四舍五入到 0.1）。
 * 对一组样本：逐条算三率 → 各速率取均值 → c 主(0.6) + d 修正(0.25) + a 加分(0.15)。
 * 速率缺数据时该项记中性 50。
 */
function computeAggregateScore(samples) {
  const cs = [];
  const ds = [];
  const as = [];
  for (const sample of samples || []) {
    const { c, d, a } = perSampleRates(sample);
    if (c != null) cs.push(c);
    if (d != null) ds.push(d);
    if (a != null) as.push(a);
  }
  const raw = RATE_WEIGHTS.c * scoreCRate(averageOf(cs))
    + RATE_WEIGHTS.d * scoreDRate(averageOf(ds))
    + RATE_WEIGHTS.a * scoreARate(averageOf(as));
  return Math.round(clamp(raw) * 10) / 10;
}

/**
 * 单条 item 的互动质量分（0~100）：同一套三率加权，按单条 metrics 独立计算。
 * 供 scoring-v2 的 interaction_quality 使用。
 */
function computeThreeRateScore(metrics) {
  const sample = {
    views: finiteOr(metrics && metrics.views),
    likes: finiteOr(metrics && metrics.likes),
    comments: finiteOr(metrics && metrics.comments),
    reposts: finiteOr(metrics && metrics.reposts),
  };
  return computeAggregateScore([sample]);
}

/**
 * 计算来源长期质量分（0~100）。
 * 只统计窗口时限内最近 window_n 个样本（按 published_at 距今判断）；
 * 样本不足按 observation_period_count / min_samples 分档：
 *   insufficient / observation / long_term。
 * @param {object} store 历史库 store（缺省按空库处理）
 * @param {string} platform 'x' | 'youtube'
 * @param {string} sourceKey X 用 handle、YouTube 用 channelId
 * @param {object} config news-config-v2.json（读 long_term_quality 段）
 * @returns {{ score: number, status: 'insufficient'|'observation'|'long_term', sample_count: number }}
 */
function evaluateLongTermQuality(store, platform, sourceKey, config) {
  const cfg = (config && config.long_term_quality) || {};
  const windowMonths = platform === 'youtube'
    ? (cfg.window_months_youtube || 6)
    : (cfg.window_months_x || 2);
  const windowN = cfg.window_n || 10;
  const minSamples = cfg.min_samples || 5;
  const observationCount = cfg.observation_period_count || 3;
  const range = cfg.observation_score_range || [20, 60];
  const neutral = cfg.neutral_score ?? 50;

  const key = `${platform}:${sourceKey}`;
  const entry = store && store.sources ? store.sources[key] : null;
  const samples = (entry && Array.isArray(entry.samples)) ? entry.samples : [];
  const now = Date.now();
  const windowMs = windowMonths * MONTH_MS;

  const inWindow = samples
    .filter(sample => {
      const t = sample && sample.published_at ? new Date(sample.published_at).getTime() : NaN;
      if (!Number.isFinite(t)) return false;
      const age = now - t;
      return age >= 0 && age <= windowMs;
    })
    .sort((x, y) => new Date(y.published_at).getTime() - new Date(x.published_at).getTime())
    .slice(0, windowN);

  const count = inWindow.length;
  if (count < observationCount) {
    return { score: neutral, status: 'insufficient', sample_count: count };
  }
  if (count < minSamples) {
    const raw = computeAggregateScore(inWindow);
    const score = Math.round(clamp(range[0] + (range[1] - range[0]) * raw / 100) * 10) / 10;
    return { score, status: 'observation', sample_count: count };
  }
  const score = computeAggregateScore(inWindow);
  return { score, status: 'long_term', sample_count: count };
}

module.exports = {
  HISTORY_PATH,
  readHistoryStore,
  writeHistoryStore,
  appendSamples,
  evaluateLongTermQuality,
  computeThreeRateScore,
  sourceKeyOf,
  perSampleRates,
};
