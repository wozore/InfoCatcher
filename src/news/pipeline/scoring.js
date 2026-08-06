/**
 * scoring.js —— 评分与异常检测层
 *
 * 在热点管线中的位置：对统一内容模型条目计算
 * 长期专业质量/近期时效性/轻度用户体验/来源可靠性/互动质量 的加权评分，
 * 并在有证据时执行商业推广扣分与 MAD 鲁棒异常检测。
 *
 * 评分公式（见 news-config.json scoring.weights）：
 *   基础分 = 0.30×长期专业质量 + 0.25×近期时效性 + 0.10×轻度用户体验
 *          + 0.20×来源可靠性 + 0.15×互动质量
 *   最终分 = clamp(基础分 - 商业推广扣分 - 异常调整, 0, 100)
 *
 * 时效分使用指数衰减：100 × exp(-ln(2) × 内容年龄天数 / 半衰期天数)
 * 轻度用户体验、商单和异常必须在有证据时才能扣分/加分，
 * 证据不足时保持中性（50 分、0 扣分、insufficient_sample）。
 *
 * 本层为纯函数，不依赖外部模块。
 */

'use strict';

/** AI 关键词过滤：标题或描述包含任一配置关键词（大小写不敏感） */
function matchesAi(item, config) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  return config.ai_keywords.some(keyword => text.includes(keyword.toLowerCase()));
}

function primaryTag(item) {
  return item.source_tags?.[0] || 'default';
}

function scoreTimeliness(item, config, now = Date.now()) {
  const ageDays = Math.max(0, (now - new Date(item.published_at).getTime()) / 86400000);
  const halfLife = config.scoring.half_life_days[primaryTag(item)] || config.scoring.half_life_days.default;
  return Math.max(0, Math.min(100, 100 * Math.exp(-Math.LN2 * ageDays / halfLife)));
}

/**
 * 轻度用户体验信号：须命中 ≥2 个类别才计分（单个类别不足以断定），
 * 得分 = 50 + 类别数×12.5（上限 100），置信度 = 类别数/4；证据不足返回中性分。
 */
function detectLightExperience(item, config) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const categories = Object.entries(config.light_user_signals)
    .filter(([, words]) => words.some(word => text.includes(word.toLowerCase())))
    .map(([category]) => category);
  if (categories.length < 2) return { score: config.scoring.neutral_score, confidence: 0.25, evidence: [] };
  return {
    score: Math.min(100, 50 + categories.length * 12.5),
    confidence: Math.min(1, categories.length / 4),
    evidence: categories.map(category => ({ type: `light_experience_${category}`, source_url: item.url })),
  };
}

/**
 * 商业推广检测：命中任一配置文本信号，或显式链接含 affiliate/ref= 等联盟 URL 模式时
 * 返回对应扣分；未命中返回 none_confirmed（0 扣分，不给无证据的扣分）。
 */
function detectCommercial(item, config) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  for (const [label, words] of Object.entries(config.commercial_signals)) {
    const matched = words.find(word => text.includes(word.toLowerCase()));
    if (matched) {
      return {
        label,
        confidence: 0.9,
        penalty: config.scoring.commercial_penalties[label] || 0,
        evidence: [{ type: 'explicit_text_match', text: matched, source_url: item.url }],
      };
    }
  }
  const affiliateUrl = (item.explicit_links || []).find(link => /(?:affiliate|aff_id|ref=|referral|partner)/i.test(link));
  if (affiliateUrl) {
    return {
      label: 'affiliate_link', confidence: 0.8,
      penalty: config.scoring.commercial_penalties.affiliate_link || 0,
      evidence: [{ type: 'affiliate_url_pattern', source_url: affiliateUrl }],
    };
  }
  return { label: 'none_confirmed', confidence: 0.5, penalty: 0, evidence: [] };
}

/**
 * 互动质量：当前为占位实现——一律返回中性分 + confidence 0.1（awaiting_source_baseline），
 * 等待接入来源平台互动基线后再做真实评分。真实计算见 interactionValue（仅用于异常检测）。
 */
function interactionScore(item, neutral) {
  const values = Object.values(item.metrics || {}).filter(value => Number.isFinite(value));
  if (!values.length) return { score: neutral, confidence: 0, reason: 'metrics_unavailable' };
  return { score: neutral, confidence: 0.1, reason: 'awaiting_source_baseline' };
}

/**
 * 组装单条评估：加权求和（权重见配置），扣商业推广罚分后 clamp 到 0–100。
 * 两个 repost 特例：contentTypeFactor=0.6 压低长期质量分；light_experience 直接取中性
 * （转发内容不评用户体验）。互动质量占位为中性（见 interactionScore）。
 */
function assessItem(item, source, config, now) {
  const light = detectLightExperience(item, config);
  const commercial = detectCommercial(item, config);
  const interaction = interactionScore(item, config.scoring.neutral_score);
  const contentTypeFactor = item.source_type === 'bilibili_dynamic_repost' ? 0.6 : 1;
  const scores = {
    long_term_quality: (source.quality_prior ?? config.scoring.neutral_score) * contentTypeFactor,
    recent_timeliness: scoreTimeliness(item, config, now),
    light_user_experience: item.source_type === 'bilibili_dynamic_repost'
      ? config.scoring.neutral_score
      : light.score,
    source_reliability: source.reliability_prior ?? config.scoring.neutral_score,
    interaction_quality: interaction.score,
  };
  const weighted = Object.entries(config.scoring.weights)
    .reduce((sum, [key, weight]) => sum + scores[key] * weight, 0);
  return {
    content_id: item.id,
    event_id: null,
    score_breakdown: scores,
    final_score: Math.round(Math.max(0, Math.min(100, weighted - commercial.penalty)) * 10) / 10,
    confidence: Math.round(((light.confidence + interaction.confidence + 1) / 3) * 100) / 100,
    commercial_assessment: commercial,
    anomaly_assessment: {
      status: 'insufficient_sample',
      method: config.anomaly.method,
      sample_count: 0,
      min_samples: config.anomaly.min_samples,
      adjustment: 0,
      evidence: [],
    },
    official_cross_check: { status: source.content_tags.includes('官方来源') ? 'official_source' : 'not_checked', evidence: [] },
    evidence: [...light.evidence],
    assessed_at: new Date(now).toISOString(),
  };
}

function interactionValue(item) {
  const metrics = item.metrics || {};
  const weights = { views: 0.02, likes: 1, comments: 2, reposts: 2, replies: 2 };
  let total = 0;
  let available = false;
  for (const [key, weight] of Object.entries(weights)) {
    if (Number.isFinite(metrics[key])) {
      available = true;
      total += metrics[key] * weight;
    }
  }
  return available ? Math.log10(total + 1) : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * MAD 鲁棒异常检测：按来源平台分组，以互动对数指数（interactionValue）为样本。
 * 样本数 < min_samples 时仅标记 insufficient_sample、不做调整；
 * 否则以中位数为中心，计算鲁棒 z-score = 0.6745×(x−median)/MAD，
 * 超过 mad_threshold 的条目标记 review 并应用 confirmed_adjustment 扣分。
 */
function applyAnomalyDetection(items, assessments, config) {
  const groups = new Map();
  for (const item of items) {
    const value = interactionValue(item);
    if (value == null) continue;
    if (!groups.has(item.source_id)) groups.set(item.source_id, []);
    groups.get(item.source_id).push({ item, value });
  }

  const assessmentMap = new Map(assessments.map(assessment => [assessment.content_id, assessment]));
  for (const samples of groups.values()) {
    const values = samples.map(sample => sample.value);
    if (values.length < config.anomaly.min_samples) {
      for (const sample of samples) {
        const target = assessmentMap.get(sample.item.id).anomaly_assessment;
        target.sample_count = values.length;
      }
      continue;
    }
    const center = median(values);
    const deviations = values.map(value => Math.abs(value - center));
    const mad = median(deviations);
    for (const sample of samples) {
      const robustZ = mad === 0 ? 0 : 0.6745 * (sample.value - center) / mad;
      const target = assessmentMap.get(sample.item.id).anomaly_assessment;
      target.sample_count = values.length;
      target.baseline = { median: center, mad };
      target.threshold = config.anomaly.mad_threshold;
      target.trigger_value = sample.value;
      if (Math.abs(robustZ) > config.anomaly.mad_threshold) {
        target.status = 'review';
        target.robust_z = robustZ;
        target.adjustment = config.anomaly.confirmed_adjustment;
        target.evidence = [{
          type: 'mad_outlier', sample_count: values.length, median: center, mad,
          robust_z: robustZ, threshold: config.anomaly.mad_threshold,
        }];
      } else {
        target.status = 'within_baseline';
        target.robust_z = robustZ;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 公开热点数据契约（B16 决策 74/77/78/85/88/89）
//
// hot_score 热度语义（0–100 平台内相对互动量级；无互动数据为 null）：
//   只在来源平台内计算相对量级，不构成跨平台权威综合热度；
//   缺失互动数据的条目为 null，前端按“最近”时间回退，不伪装为 0 或高热度。
// ═══════════════════════════════════════════════════════════════

const HEAT_DEFINITION = 'hot_score 表示条目在其来源平台内的相对互动量级（0–100），由公开互动数据（浏览/点赞/评论/转发）的加权对数指数按平台归一化得到；仅在平台内可比，跨平台不构成权威综合热度。无互动数据时为 null，前端按“最近”时间回退排序。';

module.exports = {
  matchesAi,
  primaryTag,
  scoreTimeliness,
  detectLightExperience,
  detectCommercial,
  interactionScore,
  assessItem,
  interactionValue,
  median,
  applyAnomalyDetection,
  HEAT_DEFINITION,
};
