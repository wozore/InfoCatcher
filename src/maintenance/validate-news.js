/**
 * validate-news.js — 知览 KnowView news 域数据校验
 *
 * 从 validate.js 拆分出的 news 域：v2 主链仍存在的数据文件——
 * hotspots.json（公开投影）与 min-candidates.json（v2 单状态轴候选层）的校验函数与入口。
 * 失败通过本模块独立的 fail()/failed 状态记录，由 validate.js 聚合为最终退出码。
 *
 * 用法：由 validate.js 调用 validateNews()。
 */

'use strict';

const fs = require('fs');
const { NEWS_FILES } = require('../shared/paths');
// 热点管线 v2 单状态轴候选层：只读其枚举常量，避免与 min-store 的状态轴语义漂移。
const { MIN_REVIEW_STATUSES } = require('../news/min/min-store');

let failed = false;

/** 记录一个校验失败项。不中断执行，确保一次运行能报告所有问题 */
function fail(msg) {
  console.error('❌', msg);
  failed = true;
}

/** 批量检查对象是否缺少必填字段 */
function checkRequired(obj, path, fields) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      fail(`${path}.${f} 缺失`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 平台 / 内容类型常量（v2 主链枚举，validateHotspots 与 validateMinNews 共用）
// ═══════════════════════════════════════════════════════════════

const NEWS_PLATFORMS = ['youtube', 'x'];
// B16 决策 65：来源媒体类型（采集时的平台内容形态，仅作溯源元信息，不进前端筛选）。
const SOURCE_TYPES = [
  'youtube_video', 'x_post', 'unknown'
];
// B16 决策 65/66/79：内容类型（热点视图主分类维度）。unclassified 表示
// AI 分类 + 人工确认未上线前的诚实占位（路径 B）；路径 A 上线后由审核确认填充。
const CONTENT_TYPES = [
  'ai_tool', 'ai_product', 'ai_concept', 'ai_technology', 'ai_industry', 'other', 'unclassified'
];

const X_CREDITS_MAX_PER_RUN = 3750;
const X_CREDITS_MIN_PER_TWEET = 15;
const X_CREDITS_MIN_PER_ARTICLE = 100;
const X_TWEETS_MIN_PER_REQUEST_MAX = 20;

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** 校验热点 v2 配置中的统一开关与 X 供应商安全预算边界。 */
function validateNewsConfig(data, onError = fail) {
  let valid = true;
  const reject = message => { valid = false; onError(message); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    reject('news-config-v2.json 顶层应为对象');
    return false;
  }
  const collection = data.collection;
  if (!collection || typeof collection !== 'object' || Array.isArray(collection)) {
    reject('news-config-v2.json.collection 应为对象');
    return false;
  }
  if (typeof collection.enabled !== 'boolean') {
    reject('news-config-v2.json.collection.enabled 应为布尔值');
  }
  const budget = collection.x_credits_per_run;
  if (!isNonNegativeInteger(budget) || budget > X_CREDITS_MAX_PER_RUN) {
    reject(`news-config-v2.json.collection.x_credits_per_run 应为 0–${X_CREDITS_MAX_PER_RUN} 整数`);
  }
  const tweetCost = collection.x_credits_per_tweet;
  if (!Number.isInteger(tweetCost) || tweetCost < X_CREDITS_MIN_PER_TWEET) {
    reject(`news-config-v2.json.collection.x_credits_per_tweet 应为不小于 ${X_CREDITS_MIN_PER_TWEET} 的整数`);
  }
  const articleCost = collection.x_credits_per_article;
  if (!Number.isInteger(articleCost) || articleCost < X_CREDITS_MIN_PER_ARTICLE) {
    reject(`news-config-v2.json.collection.x_credits_per_article 应为不小于 ${X_CREDITS_MIN_PER_ARTICLE} 的整数`);
  }
  const requestMax = collection.x_tweets_per_request_max;
  if (!Number.isInteger(requestMax) || requestMax < X_TWEETS_MIN_PER_REQUEST_MAX) {
    reject(`news-config-v2.json.collection.x_tweets_per_request_max 应为不小于 ${X_TWEETS_MIN_PER_REQUEST_MAX} 的整数`);
  }
  return valid;
}

/** 校验 last-run 中的 X credits/request 账本；失败/未运行允许 credits=null。 */
function validateLastRun(data, onError = fail) {
  let valid = true;
  const reject = message => { valid = false; onError(message); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    reject('last-run.json 顶层应为对象');
    return false;
  }
  const x = data.collectors && data.collectors.x;
  if (!x || typeof x !== 'object' || Array.isArray(x)) {
    reject('last-run.json.collectors.x 应为对象');
    return false;
  }
  const credits = x.credits;
  if (credits == null) {
    if (x.status === 'success' || x.status === 'partial') {
      reject('last-run.json.collectors.x.credits 在 X 已运行时不得为空');
    }
    return valid;
  }
  if (typeof credits !== 'object' || Array.isArray(credits)) {
    reject('last-run.json.collectors.x.credits 应为对象或 null');
    return false;
  }
  for (const field of ['used', 'budget', 'tweets', 'articles']) {
    if (!isNonNegativeInteger(credits[field])) {
      reject(`last-run.json.collectors.x.credits.${field} 应为非负整数`);
    }
  }
  if (isNonNegativeInteger(credits.budget) && credits.budget > X_CREDITS_MAX_PER_RUN) {
    reject(`last-run.json.collectors.x.credits.budget 不得超过 ${X_CREDITS_MAX_PER_RUN}`);
  }
  if (isNonNegativeInteger(credits.used) && isNonNegativeInteger(credits.budget)
    && credits.used > credits.budget) {
    reject('last-run.json.collectors.x.credits.used 不得超过 budget');
  }
  const requests = credits.requests;
  if (!requests || typeof requests !== 'object' || Array.isArray(requests)) {
    reject('last-run.json.collectors.x.credits.requests 应为对象');
    return false;
  }
  for (const field of ['total', 'tweet', 'article', 'retries']) {
    if (!isNonNegativeInteger(requests[field])) {
      reject(`last-run.json.collectors.x.credits.requests.${field} 应为非负整数`);
    }
  }
  if (isNonNegativeInteger(requests.total) && isNonNegativeInteger(requests.tweet)
    && isNonNegativeInteger(requests.article) && requests.total !== requests.tweet + requests.article) {
    reject('last-run.json.collectors.x.credits.requests.total 应等于 tweet + article');
  }
  if (isNonNegativeInteger(requests.retries) && isNonNegativeInteger(requests.total)
    && requests.retries > requests.total) {
    reject('last-run.json.collectors.x.credits.requests.retries 不得超过 total');
  }
  return valid;
}

// ═══════════════════════════════════════════════════════════════
// 第 4 组：hotspots.json — 前端热点投影引用完整性
//
// 核心约束：
//   - items 为数组，每条内容有完整的 id/platform/content_type/url/title/日期
// ═══════════════════════════════════════════════════════════════
function validateHotspots(data) {
  if (!data || !Array.isArray(data.items)) {
    fail('hotspots.json.items 应为数组');
    return;
  }
  const contentIds = new Set();
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i];
    const tag = `hotspots.json.items[${i}] (${item.title || '未知'})`;
    checkRequired(item, tag, ['id', 'platform', 'native_id', 'source_type', 'url', 'title', 'published_at', 'source_id', 'metrics']);
    if (contentIds.has(item.id)) fail(`${tag}.id 重复: ${item.id}`);
    contentIds.add(item.id);
    if (!NEWS_PLATFORMS.includes(item.platform)) fail(`${tag}.platform 不支持: ${item.platform}`);
    if (!SOURCE_TYPES.includes(item.source_type)) fail(`${tag}.source_type 不支持: ${item.source_type}`);
    if (item.content_type !== undefined && !CONTENT_TYPES.includes(item.content_type)) fail(`${tag}.content_type 不支持: ${item.content_type}`);
    if (Number.isNaN(new Date(item.published_at).getTime())) fail(`${tag}.published_at 不是有效日期`);
    if (item.metrics && typeof item.metrics !== 'object') fail(`${tag}.metrics 应为对象`);
    // B16 决策 74/77/85/88/89：公开热点数据契约补充字段（可选字段，存在才校验）
    if (item.hot_score !== undefined && item.hot_score !== null && !(typeof item.hot_score === 'number' && item.hot_score >= 0 && item.hot_score <= 100)) {
      fail(`${tag}.hot_score 应为 0–100 数值或 null`);
    }
    if (item.evidence_excerpt !== undefined && item.evidence_excerpt !== null && typeof item.evidence_excerpt !== 'string') {
      fail(`${tag}.evidence_excerpt 应为字符串或 null`);
    }
    // content-summarizer：公开 summary 字段（存在时校验格式；仅经人工审核 approved 的候选才会带）
    if (item.summary !== undefined && item.summary !== null && typeof item.summary !== 'string') {
      fail(`${tag}.summary 应为字符串或 null`);
    }
    if (item.summary_key_points !== undefined) {
      if (!Array.isArray(item.summary_key_points)) fail(`${tag}.summary_key_points 应为数组`);
      else for (const point of item.summary_key_points) {
        if (typeof point !== 'string') fail(`${tag}.summary_key_points 元素应为字符串`);
      }
    }
    if (item.related_resources !== undefined) {
      if (!Array.isArray(item.related_resources)) fail(`${tag}.related_resources 应为数组`);
      else for (const [resourceIndex, resource] of item.related_resources.entries()) {
        const resourceTag = `${tag}.related_resources[${resourceIndex}]`;
        if (!resource || typeof resource !== 'object') { fail(`${resourceTag} 应为对象`); continue; }
        if (!['tool', 'concept', 'scene'].includes(resource.type)) fail(`${resourceTag}.type 应为 tool/concept/scene`);
        if (!resource.id || typeof resource.id !== 'string') fail(`${resourceTag}.id 应为非空字符串`);
      }
    }
    // content-localizer：公开 localizations 字段（存在时校验形状；与候选层同规则。
    // 内部痕迹 localizations_meta 已由 INTERNAL_FIELDS 剔除，不应出现在公开投影）
    if (item.localizations !== undefined) {
      if (!item.localizations || typeof item.localizations !== 'object') {
        fail(`${tag}.localizations 应为对象`);
      } else {
        for (const [locale, localized] of Object.entries(item.localizations)) {
          if (!localized || typeof localized !== 'object') {
            fail(`${tag}.localizations.${locale} 应为对象`);
            continue;
          }
          if (localized.title !== undefined && typeof localized.title !== 'string') fail(`${tag}.localizations.${locale}.title 应为字符串`);
          if (localized.description !== undefined && typeof localized.description !== 'string') fail(`${tag}.localizations.${locale}.description 应为字符串`);
        }
      }
    }
    if (item.localizations_meta !== undefined) fail(`${tag}.localizations_meta 是内部字段，不应出现在公开投影`);
  }
  if (data.heat_definition !== undefined && typeof data.heat_definition !== 'string') {
    fail('hotspots.json.heat_definition 应为字符串');
  }

  if (!data.coverage || typeof data.coverage !== 'object') fail('hotspots.json.coverage 缺失');
  console.log(`  hotspots.json: ${data.items.length} 条内容，通过`);
}

// ═══════════════════════════════════════════════════════════════
// 热点管线 v2 候选层（min-candidates.json，单状态轴）校验
//
// v2 与旧候选层解耦：无 ai_processing_status 轴，review_status 只取
// pending/approved/discarded（MIN_REVIEW_STATUSES，读自 min-store）。
// 文件不存在 → 优雅跳过（v2 管线未首跑，不阻塞）；空候选 → 通过。
// 硬错误走 fail()（计入本模块 failed，由 validate.js 聚合退出码）；
// approved 缺公开字段（title/url/published_at）只告警不阻塞。
// ═══════════════════════════════════════════════════════════════
function validateMinNews() {
  const file = NEWS_FILES.minCandidates;
  const errors = [];
  const warnings = [];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log('  min-candidates.json: 文件不存在（v2 管线未首跑），优雅跳过');
      return { valid: true, errors, warnings };
    }
    const message = `min-candidates.json 解析失败：${error.message}`;
    errors.push(message);
    fail(message);
    return { valid: false, errors, warnings };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    const message = 'min-candidates.json 顶层应为对象';
    errors.push(message);
    fail(message);
    return { valid: false, errors, warnings };
  }

  // 顶层 schema：schema_version 为缺省 1；缺失仅告警（createMinStore 容缺省），
  // 存在但非法（非正整数）则报错。
  if (data.schema_version !== undefined
    && (!Number.isInteger(data.schema_version) || data.schema_version < 1)) {
    const message = 'min-candidates.json.schema_version 应为正整数';
    errors.push(message);
    fail(message);
  } else if (data.schema_version === undefined) {
    warnings.push('min-candidates.json 缺少 schema_version（缺省按 1 处理）');
    console.warn('⚠️  min-candidates.json 缺少 schema_version（缺省按 1 处理）');
  }

  if (!Array.isArray(data.candidates)) {
    const message = 'min-candidates.json.candidates 应为数组';
    errors.push(message);
    fail(message);
    return { valid: false, errors, warnings };
  }

  const ids = new Set();
  for (let i = 0; i < data.candidates.length; i++) {
    const candidate = data.candidates[i];
    const tag = `min-candidates.json.candidates[${i}] (${(candidate && candidate.title) || '未知'})`;
    if (!candidate || typeof candidate !== 'object') {
      const message = `${tag} 应为对象`;
      errors.push(message);
      fail(message);
      continue;
    }
    // v2 单状态轴候选：id 非空且唯一
    if (!candidate.id || ids.has(candidate.id)) {
      const message = `${tag}.id 缺失或重复: ${candidate.id}`;
      errors.push(message);
      fail(message);
    }
    ids.add(candidate.id);
    // review_status 必须 ∈ MIN_REVIEW_STATUSES（pending/approved/discarded）
    if (!MIN_REVIEW_STATUSES.includes(candidate.review_status)) {
      const message = `${tag}.review_status 无效（合法值：${MIN_REVIEW_STATUSES.join(' / ')}）`;
      errors.push(message);
      fail(message);
    }
    // platform 必须合法（youtube / x）
    if (!NEWS_PLATFORMS.includes(candidate.platform)) {
      const message = `${tag}.platform 不支持: ${candidate.platform}`;
      errors.push(message);
      fail(message);
    }
    // 公开字段完整性：approved 候选必须有 title/url/published_at（不全告警，不阻塞）
    if (candidate.review_status === 'approved') {
      for (const field of ['title', 'url', 'published_at']) {
        const value = candidate[field];
        if (value === undefined || value === null || value === '') {
          const message = `${tag} 已 approved 但缺少公开字段 ${field}`;
          warnings.push(message);
          console.warn(`⚠️  ${message}`);
        }
      }
    }
  }

  if (errors.length === 0) {
    console.log(`  min-candidates.json: ${data.candidates.length} 条候选（v2 单状态轴），通过`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ═══════════════════════════════════════════════════════════════
// news 域入口：校验公开投影与 v2 候选层
//
// 只校验仍存在的数据文件：hotspots.json（公开投影）与
// min-candidates.json（v2 候选层）。
// ═══════════════════════════════════════════════════════════════
function validateNews() {
  // v2 配置：总开关与 X 预算属于采集安全边界，配置非法必须阻断。
  try {
    validateNewsConfig(JSON.parse(fs.readFileSync(NEWS_FILES.configV2, 'utf8')));
  } catch (error) {
    fail(`news-config-v2.json 解析失败：${error.message}`);
  }

  // last-run 为运行产物，尚未首跑时允许不存在；存在则校验 credits/request 账本。
  try {
    validateLastRun(JSON.parse(fs.readFileSync(NEWS_FILES.lastRun, 'utf8')));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      console.log('  last-run.json: 文件不存在（尚无采集运行记录），优雅跳过');
    } else {
      fail(`last-run.json 解析失败：${error.message}`);
    }
  }

  // hotspots.json
  try {
    validateHotspots(JSON.parse(fs.readFileSync(NEWS_FILES.hotspots, 'utf8')));
  } catch (e) {
    fail(`hotspots.json 解析失败：${e.message}`);
  }
}

module.exports = {
  validateNews,
  validateMinNews,
  validateNewsConfig,
  validateLastRun,
  get failed() { return failed; },
};
