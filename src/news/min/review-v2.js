/**
 * review-v2.js —— 热点管线 v2 审核层（L0 规则硬审 → L1 AI 审 → L2 AI 建议+人工）
 *
 * 在热点管线中的位置：v2 采集（collector-youtube-v2 / collector-x-v2）落地后、
 * 评分（scoring-v2）与公开投影之前的审核步骤。与 v2 评分层同属独立数据通道。
 *
 * **不依赖旧版候选层的双状态轴（ai_processing_status / review_status 双轴），
 * 输出单状态轴判定**：
 *   review_status = 'pending'（保留，待人工）| 'discarded'（剔除）。
 * 本模块自身不写 store / 不落盘，只对传入条目计算判定并原样展开（+ 审核痕迹字段），
 * 是否持久化由调用方决定。
 *
 * 三层结构：
 *   L0 l0HardFilter —— 规则式硬过滤，零成本、零外部依赖。缺 title/url/published_at、
 *                       非 AI 主题（未命中 config.keywords.ai_keywords）、明显广告/推广
 *                       词 → 直接剔除（discarded，带 discard_reason）。
 *   L1 l1AiReview   —— AI 初步审核（复用 content-reviewer.reviewCandidate → DeepSeek）。
 *                       可选把点赞最高的 topN 条评论（item.comments，YouTube v2 已采集
 *                       { text, likeCount }）追加进审核输入（TOP_COMMENTS 段），让 AI
 *                       判断哪些评论有用、过滤无关/吵架。仅当 verdict=discard 且
 *                       confidence ≥ config.review.l1_confidence_auto_discard 时自动落
 *                       discarded —— approve/hold/LLM 失败（verdict null）永不自动剔除。
 *   L2 l2AiAdvice   —— AI 辅助建议（给人工看的），复用 reviewCandidate，**不自动改状态**，
 *                       最终是否通过由人工决定。
 *
 * 失败语义（沿用 v1 content-reviewer）：LLM 失败 → verdict null，条目保持 pending，
 * 绝不 reject、绝不误杀。本模块自身为纯逻辑 + reviewCandidate 复用，不发起额外网络。
 *
 * 注入点：options.reviewCandidate 可替换真实 reviewCandidate（测试 mock 用），
 * 缺省回落到 content-reviewer 的真实实现。
 */

'use strict';

const { reviewCandidate } = require('../classify/content-reviewer');

// ═══════════════════════════════════════════════════════════════
// 常量与默认值
// ═══════════════════════════════════════════════════════════════

// L1 评论输入：点赞最高 N 条（config.review.l1_comments_top_n 缺省）
const DEFAULT_COMMENTS_TOP_N = 10;
// L1 自动剔除置信度门槛（config.review.l1_confidence_auto_discard 缺省）
const DEFAULT_AUTO_DISCARD_CONFIDENCE = 0.9;
// L0 广告/推广信号词（英文大小写不敏感，中文直接子串匹配）
const ADVERTISING_RE = /sponsored|advertisement|推广|广告|affiliate|佣金/i;
// 评论拼进 L1 输入的段标记
const TOP_COMMENTS_LABEL = '[TOP_COMMENTS]';

// ═══════════════════════════════════════════════════════════════
// L0 规则硬审
// ═══════════════════════════════════════════════════════════════

/**
 * L0 规则式硬过滤（纯函数，零成本零外部依赖）。
 * @param {object} item - 统一内容模型条目（含 title / url / published_at / description）
 * @param {object} config - news-config-v2.json（读 keywords.ai_keywords 段）
 * @returns {{ pass: boolean, reason?: string }}
 *   pass=false 的 reason：'incomplete'（缺 title/url/published_at）
 *                       | 'not_ai'（title+description 未命中任何 ai_keywords）
 *                       | 'advertising'（命中明显广告/推广词）
 */
function l0HardFilter(item, config) {
  const title = String(item && item.title || '').trim();
  const url = String(item && item.url || '').trim();
  const publishedAt = item && item.published_at;
  if (!title || !url || !publishedAt) {
    return { pass: false, reason: 'incomplete' };
  }

  // AI 关键词命中（与旧 scoring.js 的 matchesAi 同款大小写不敏感子串匹配）
  const text = `${title} ${String(item.description || '')}`.toLowerCase();
  const keywords = Array.isArray(config && config.keywords && config.keywords.ai_keywords)
    ? config.keywords.ai_keywords
    : [];
  const hitsAi = keywords.some(keyword =>
    keyword && text.includes(String(keyword).toLowerCase())
  );
  if (!hitsAi) return { pass: false, reason: 'not_ai' };

  if (ADVERTISING_RE.test(text)) return { pass: false, reason: 'advertising' };

  return { pass: true };
}

// ═══════════════════════════════════════════════════════════════
// 评论输入（TOP_COMMENTS 拼装）
// ═══════════════════════════════════════════════════════════════

/**
 * 从 item.comments 中取点赞最高的 topN 条（默认 10），返回 [{ text, likeCount }]。
 * 兼容 YouTube v2 的 { text, likeCount }、X v2 的空数组，也容忍纯字符串评论。
 * 无有效评论返回空数组。
 */
function pickTopComments(item, config) {
  const comments = Array.isArray(item && item.comments) ? item.comments : [];
  if (!comments.length) return [];
  const topN = Number(config && config.review && config.review.l1_comments_top_n) || DEFAULT_COMMENTS_TOP_N;
  const ranked = comments
    .map(comment => {
      if (typeof comment === 'string') {
        return { text: comment.trim(), likeCount: 0 };
      }
      if (!comment || typeof comment !== 'object') return null;
      const text = String(comment.text || comment.content || comment.body || '').trim();
      const like = Number(comment.likeCount ?? comment.likes ?? comment.like_count ?? 0);
      return { text, likeCount: Number.isFinite(like) ? like : 0 };
    })
    .filter(entry => entry && entry.text)
    .sort((a, b) => b.likeCount - a.likeCount)
    .slice(0, topN);
  return ranked;
}

/**
 * 构造 L1 审核输入：若 config.review.l1_input_include_comments 为 true 且
 * item.comments 有内容，把点赞最高 topN 条评论追加到 description 后
 * （标注 [TOP_COMMENTS] 段），供 AI 判断哪些评论有用、过滤无关/吵架。
 * 否则返回原 item（不拷贝，避免无谓的对象展开）。
 */
function buildL1Input(item, config) {
  if (!item || typeof item !== 'object') return item;
  if (!(config && config.review && config.review.l1_input_include_comments === true)) return item;
  const top = pickTopComments(item, config);
  if (!top.length) return item;

  const description = String(item.description || '').trim();
  const block = top
    .map((entry, index) => `[${index + 1}] (赞 ${entry.likeCount}) ${entry.text}`)
    .join('\n');
  const commentsSection = `${TOP_COMMENTS_LABEL}\n${block}`;
  const nextDescription = description ? `${description}\n\n${commentsSection}` : commentsSection;
  return { ...item, description: nextDescription };
}

// ═══════════════════════════════════════════════════════════════
// L1 AI 审 / L2 AI 建议
// ═══════════════════════════════════════════════════════════════

/**
 * L1 AI 审核单条：构造输入（含可选 TOP_COMMENTS 评论段）后复用
 * reviewCandidate 调 DeepSeek。
 * @param {object} item - 统一内容模型条目
 * @param {object} options - 透传 reviewCandidate 选项（provider/model/apiKey/fetchImpl/
 *                           timeoutMs/now），config 走 options.config（news-config-v2.json），
 *                           options.reviewCandidate 可注入 mock
 * @returns {Promise<{ verdict: 'discard'|'approve'|'hold'|null, reasons: string[],
 *                      confidence: number, llm_error: string|null }>}
 *   LLM 失败 → verdict null（不误杀，条目保持 pending）。
 */
async function l1AiReview(item, options = {}) {
  const review = options.reviewCandidate || reviewCandidate;
  const input = buildL1Input(item, options.config);
  const result = await review(input, options);
  if (!result.verdict) {
    return {
      verdict: null,
      reasons: Array.isArray(result.reasons) ? result.reasons : [],
      confidence: 0,
      llm_error: result.llm_error || null,
    };
  }
  return {
    verdict: result.verdict,
    reasons: Array.isArray(result.reasons) ? result.reasons : [],
    confidence: Number(result.confidence) || 0,
    llm_error: result.llm_error || null,
  };
}

/**
 * L2 AI 辅助建议（给人工看的）：复用 reviewCandidate，返回建议对象
 * （verdict/reasons/confidence/reviewer/generated_at/input_chars/llm_error）。
 * **不自动改状态**，最终是否通过由人工决定。
 * LLM 失败时建议对象 verdict 为 null（不误杀）。
 */
async function l2AiAdvice(item, options = {}) {
  const review = options.reviewCandidate || reviewCandidate;
  return review(item, options);
}

// ═══════════════════════════════════════════════════════════════
// 批量入口
// ═══════════════════════════════════════════════════════════════

/**
 * 批量审核入口：L0 硬审 → L1 AI 审 → 保留项附 L2 建议。输出单状态轴。
 *
 * @param {Array<object>} items - 统一内容模型条目数组
 * @param {object} config - news-config-v2.json（读 review / keywords 段）
 * @param {object} [options] - 透传 reviewCandidate 选项 + options.reviewCandidate 注入 mock
 * @returns {Promise<{ kept: Array, discarded: Array, advice: Array }>}
 *   - kept:      通过项（approve / hold / L1 verdict null），每条
 *                { ...item, review_status: 'pending', l1_review, ai_advice }
 *   - discarded: 剔除项（L0 硬审不过 / L1 discard+高置信），每条
 *                { ...item, review_status: 'discarded', discard_reason, discard_stage, l1_review, ai_advice: null }
 *   - advice:    kept 项对应的 l2AiAdvice 建议对象列表（供人工审核面板取用，与 kept 同序；
 *                l2_enabled=false 或 L2 LLM 失败时为 null）
 */
async function applyL1Verdicts(items, config, options = {}) {
  const source = Array.isArray(items) ? items : [];
  const autoDiscardConfidence = Number(config && config.review && config.review.l1_confidence_auto_discard)
    || DEFAULT_AUTO_DISCARD_CONFIDENCE;
  const l2Enabled = !(config && config.review && config.review.l2_enabled === false);

  const kept = [];
  const discarded = [];

  for (const item of source) {
    if (!item || typeof item !== 'object') continue;

    // ── L0 规则硬审 ──
    const hard = l0HardFilter(item, config);
    if (!hard.pass) {
      discarded.push({
        ...item,
        review_status: 'discarded',
        discard_reason: hard.reason,
        discard_stage: 'l0',
        l1_review: null,
        ai_advice: null,
      });
      continue;
    }

    // ── L1 AI 审（评论注入按 config.review 决定）──
    const l1 = await l1AiReview(item, { ...options, config });
    const l1Review = {
      verdict: l1.verdict,
      reasons: l1.reasons || [],
      confidence: l1.confidence || 0,
      llm_error: l1.llm_error || null,
    };
    const autoDiscard = l1.verdict === 'discard' && l1.confidence >= autoDiscardConfidence;
    if (autoDiscard) {
      discarded.push({
        ...item,
        review_status: 'discarded',
        discard_reason: 'ai_discard',
        discard_stage: 'l1',
        l1_review: l1Review,
        ai_advice: null,
      });
      continue;
    }

    // ── kept：approve / hold / LLM 失败 → pending，附 L2 建议供人工参考 ──
    const advice = l2Enabled
      ? await l2AiAdvice(item, { ...options, config })
      : null;
    kept.push({
      ...item,
      review_status: 'pending',
      l1_review: l1Review,
      ai_advice: advice,
    });
  }

  return { kept, discarded, advice: kept.map(item => item.ai_advice) };
}

module.exports = {
  l0HardFilter,
  l1AiReview,
  l2AiAdvice,
  applyL1Verdicts,
  DEFAULT_COMMENTS_TOP_N,
  DEFAULT_AUTO_DISCARD_CONFIDENCE,
};
