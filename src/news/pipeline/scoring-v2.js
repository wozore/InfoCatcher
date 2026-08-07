/**
 * scoring-v2.js —— 热点管线 v2 评分层
 *
 * 在热点管线中的位置：对统一内容模型条目按 config.scoring.weights 的
 * 六个权重做加权评分。长期质量分来自 history-store 的本地三率统计
 * （不发网络请求、不消耗额度）；本层只接收调用方传入的 history，
 * 不自己读盘。
 *
 * 评分公式（news-config-v2.json scoring.weights，六个权重合计 1.00）：
 *   final_score = clamp(Σ weight_i × score_i, 0, 100)
 *
 *   long_term_quality   —— history-store.evaluateLongTermQuality（纯本地统计）
 *   recent_timeliness   —— 指数衰减 100×exp(-ln2×ageDays/半衰期)，
 *                          半衰期取 config.scoring.half_life_days 或固定 7 天
 *   light_user_experience —— 标题/描述命中体验信号词 → 70，否则 50
 *   source_reliability  —— 仅 X 用（平台认证 → 90；无认证数据 → 中性 50）；
 *                          YouTube 不评此项（score 0，权重并入 long_term_quality，
 *                          保持权重合计 1.00）
 *   interaction_quality —— 单条三率加权（与 history-store 同一套三率算法）
 *   type_preference     —— 按 item.content_type 查 type_preference_score；
 *                          content_type 为 null → unclassified（50）
 *
 * 对比旧 scoring.js：v2 用历史库做长期质量、用真实互动三率做互动质量，
 * 不再依赖 source.quality_prior 先验与 interactionScore 占位中性分。
 */

'use strict';

const { evaluateLongTermQuality, computeThreeRateScore } = require('../min/history-store');

const DEFAULT_EXPERIENCE_WORDS = ['实测', '上手', '使用', '体验', '教程', '工作流'];
const DEFAULT_HALF_LIFE_DAYS = 7;

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

/**
 * 近期时效性：指数衰减。半衰期取 config.scoring.half_life_days（按首标签）
 * 或默认 7 天；published_at 缺失/非法时返回中性 50。
 */
function scoreTimelinessV2(item, config, now = Date.now()) {
  const t = item.published_at ? new Date(item.published_at).getTime() : NaN;
  if (!Number.isFinite(t)) return 50;
  const ageDays = Math.max(0, (now - t) / 86400000);
  const halfLives = config.scoring && config.scoring.half_life_days;
  const halfLife = halfLives
    ? (halfLives[item.source_tags?.[0]] || halfLives.default || DEFAULT_HALF_LIFE_DAYS)
    : DEFAULT_HALF_LIFE_DAYS;
  return Math.round(clamp(100 * Math.exp(-Math.LN2 * ageDays / halfLife)) * 10) / 10;
}

/**
 * 轻度用户体验信号：标题/描述命中任一体验信号词 → 70，否则 50。
 * 信号词优先取 config.light_user_signals（旧配置结构，对象值为词数组），
 * 缺省用简化词表：实测|上手|使用|体验|教程|工作流。
 */
function detectLightExperienceV2(item, config) {
  const signals = config && config.light_user_signals;
  const words = Object.values(signals || {}).flat().filter(Boolean);
  const list = words.length ? words : DEFAULT_EXPERIENCE_WORDS;
  const text = `${item.title || ''} ${item.description || ''}`.toLowerCase();
  return list.some(word => text.includes(String(word).toLowerCase())) ? 70 : 50;
}

/**
 * 来源可靠性：仅 X 用。平台认证（is_verified/verified/author_verified）→ 90；
 * 无认证数据 → 中性 50。YouTube（及非 x 平台）不评此项 → 0。
 */
function scoreSourceReliability(item) {
  if (item.platform !== 'x') return 0;
  const verified = item.is_verified === true || item.verified === true || item.author_verified === true;
  return verified ? 90 : 50;
}

/**
 * 内容类型偏好：按 item.content_type 查 type_preference_score；
 * content_type 为 null → unclassified（50）；未知类型 → other（50）。
 */
function scoreTypePreference(item, config) {
  const table = (config && config.scoring && config.scoring.type_preference_score) || {};
  const ct = item.content_type;
  if (ct == null) return table.unclassified ?? 50;
  return table[ct] ?? table.other ?? 50;
}

/**
 * v2 评分入口：对单条统一内容模型条目计算加权评分。
 *
 * @param {object} item 统一内容模型（含 metrics / content_type / platform，
 *                      published_at，可选 source_tags）
 * @param {object} options
 * @param {object} options.config news-config-v2.json（读 scoring 段）
 * @param {string} options.sourceKey X 用 handle、YouTube 用 channelId
 * @param {object} [options.history] history-store（缺省按空库 → 长期质量中性 50）
 * @returns {{ content_id, final_score, score_breakdown, assessed_at }}
 */
function assessItemV2(item, { config, sourceKey, history } = {}) {
  const now = Date.now();
  const scoring = (config && config.scoring) || {};
  const weights = { ...(scoring.weights || {}) };

  const longTerm = evaluateLongTermQuality(history, item.platform, sourceKey, config);
  const scores = {
    long_term_quality: longTerm.score,
    recent_timeliness: scoreTimelinessV2(item, config, now),
    light_user_experience: detectLightExperienceV2(item, config),
    source_reliability: scoreSourceReliability(item),
    interaction_quality: computeThreeRateScore(item.metrics),
    type_preference: scoreTypePreference(item, config),
  };

  // YouTube（及非 x 平台）不评来源可靠性：score=0，把该项权重并入 long_term_quality，
  // 保持权重合计 1.00（语义：长期质量对 YouTube 承担更大权重）。
  if (item.platform !== 'x' && weights.source_reliability != null) {
    weights.long_term_quality = (weights.long_term_quality || 0) + weights.source_reliability;
    weights.source_reliability = 0;
  }

  const weighted = Object.entries(weights)
    .reduce((sum, [key, weight]) => sum + (scores[key] || 0) * weight, 0);
  const final_score = Math.round(clamp(weighted) * 10) / 10;

  return {
    content_id: item.id,
    final_score,
    score_breakdown: {
      ...scores,
      long_term_status: longTerm.status,
      applied_weights: weights,
    },
    assessed_at: new Date(now).toISOString(),
  };
}

module.exports = {
  assessItemV2,
  scoreTimelinessV2,
  detectLightExperienceV2,
  scoreSourceReliability,
  scoreTypePreference,
  DEFAULT_EXPERIENCE_WORDS,
  DEFAULT_HALF_LIFE_DAYS,
};
