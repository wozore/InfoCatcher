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
 *                       approve/discard 达到置信度门槛时自动分流；hold、低置信度与失败留给人工。
 *                       可选把点赞最高的 topN 条评论（item.comments，YouTube v2 已采集
 *                       { text, likeCount }）追加进审核输入（TOP_COMMENTS 段）。
 *   L2 l2AiAdvice   —— AI 辅助建议（给人工看的），复用 reviewCandidate，**不自动改状态**，
 *                       最终是否通过由人工决定。仅对需要人工处理的 L1 结果调用。
 *
 * 失败语义（沿用 v1 content-reviewer）：LLM 失败 → verdict null，条目保持 pending，
 * 绝不 reject、绝不误杀。本模块自身为纯逻辑 + reviewCandidate 复用，不发起额外网络。
 *
 * 注入点：options.reviewCandidate 可替换真实 reviewCandidate（测试 mock 用），
 * 缺省回落到 content-reviewer 的真实实现。
 */

'use strict';

const { reviewCandidate, runPool } = require('../classify/content-reviewer');

// ═══════════════════════════════════════════════════════════════
// 常量与默认值
// ═══════════════════════════════════════════════════════════════

// L1 评论输入：点赞最高 N 条（config.review.l1_comments_top_n 缺省）
const DEFAULT_COMMENTS_TOP_N = 10;
// L1 自动通过置信度门槛（config.review.l1_confidence_auto_approve 缺省）
const DEFAULT_AUTO_APPROVE_CONFIDENCE = 0.85;
// L1 自动剔除置信度门槛（config.review.l1_confidence_auto_discard 缺省）
const DEFAULT_AUTO_DISCARD_CONFIDENCE = 0.9;
// L0 广告/推广信号词（英文大小写不敏感，中文直接子串匹配）
const ADVERTISING_RE = /sponsored|advertisement|推广|广告|affiliate|佣金/i;
// YouTube 简介中的明确 AI 生成/合成内容披露模板。
// 只匹配结构化披露语句，不把普通标题/描述中的「AI-generated」当作硬排除。
const AI_DISCLOSURE_PATTERNS = Object.freeze([
  /内容制作方式[\s\S]{0,120}由\s*AI\s*生成[\s\S]{0,100}(?:声音或影像内容经过加工|完全由\s*AI\s*生成)/i,
  /AI使用披露[\s\S]{0,180}(?:画面由\s*AI\s*生成式工具制作|由\s*AI\s*生成式工具制作)/i,
  /AI\s*Disclosure[\s\S]{0,180}visuals?\s+in\s+this\s+video\s+were\s+generated\s+using\s+AI\s+tools/i,
]);
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
 *                       | 'ai_generated_disclosure'（简介命中明确 AI 生成披露模板）
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

  if (item && item.platform === 'youtube'
      && AI_DISCLOSURE_PATTERNS.some(pattern => pattern.test(String(item.description || '')))) {
    return { pass: false, reason: 'ai_generated_disclosure' };
  }

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
 * 批量审核入口：L0 硬审 → L1 AI 审 → 自动分流 / pending 项附 L2 建议。输出单状态轴。
 *
 * L1/L2 按 config.collection.concurrency（缺省 5）并发执行，保持输入顺序；
 * 单条结果写入 result[index] 后由 runPool 保证与 items 同序返回。
 * 自动 approve/discard 不调用 L2；只有 pending 项调用 L2。
 *
 * @param {Array<object>} items - 统一内容模型条目数组
 * @param {object} config - news-config-v2.json（读 review / keywords 段）
 * @param {object} [options] - 透传 reviewCandidate 选项 + options.reviewCandidate 注入 mock
 * @returns {Promise<{ kept: Array, discarded: Array, advice: Array }>}
 *   - kept:      需要人工处理的项（hold / 低置信度 / L1 失败），以及高置信度
 *                approve 的自动 approved 项；前者为 pending，后者为 approved。
 *   - discarded: L0 硬审不过或 L1 高置信 discard 的项。
 *   - advice:    pending 项对应的 l2AiAdvice 建议对象列表；自动分流项不调用 L2。
 */
async function applyL1Verdicts(items, config, options = {}) {
  const source = Array.isArray(items) ? items : [];
  const autoApproveConfidence = Number(config && config.review && config.review.l1_confidence_auto_approve)
    || DEFAULT_AUTO_APPROVE_CONFIDENCE;
  const autoDiscardConfidence = Number(config && config.review && config.review.l1_confidence_auto_discard)
    || DEFAULT_AUTO_DISCARD_CONFIDENCE;
  const l2Enabled = !(config && config.review && config.review.l2_enabled === false);
  const concurrency = Number(config && config.collection && config.collection.concurrency) || 5;

  const result = new Array(source.length); // result[index] = { kept } | { discarded } | null

  await runPool(source, concurrency, async (item, index) => {
    if (!item || typeof item !== 'object') return; // 跳过，留 null

    // ── L0 规则硬审 ──
    const hard = l0HardFilter(item, config);
    if (!hard.pass) {
      result[index] = {
        discarded: {
          ...item,
          review_status: 'discarded',
          discard_reason: hard.reason,
          discard_stage: 'l0',
          l1_review: null,
          ai_advice: null,
        },
      };
      return;
    }

    // ── L1 AI 审（评论注入按 config.review 决定）──
    const l1 = await l1AiReview(item, { ...options, config });
    const l1Review = {
      verdict: l1.verdict,
      reasons: l1.reasons || [],
      confidence: l1.confidence || 0,
      llm_error: l1.llm_error || null,
    };
    const highConfidenceApprove = l1.verdict === 'approve' && l1.confidence >= autoApproveConfidence;
    const highConfidenceDiscard = l1.verdict === 'discard' && l1.confidence >= autoDiscardConfidence;
    if (highConfidenceApprove) {
      result[index] = {
        kept: {
          ...item,
          review_status: 'approved',
          l1_review: { ...l1Review, reasons: [] },
          ai_advice: null,
        },
      };
      return;
    }
    if (highConfidenceDiscard) {
      result[index] = {
        discarded: {
          ...item,
          review_status: 'discarded',
          discard_reason: 'ai_discard',
          discard_stage: 'l1',
          l1_review: { ...l1Review, reasons: [] },
          ai_advice: null,
        },
      };
      return;
    }

    // ── pending：hold / 低置信度 / LLM 失败 → 附 L2 建议供人工参考 ──
    const advice = l2Enabled
      ? await l2AiAdvice(item, { ...options, config })
      : null;
    result[index] = {
      kept: {
        ...item,
        review_status: 'pending',
        l1_review: l1Review,
        ai_advice: advice,
      },
    };
  });

  const kept = [];
  const discarded = [];
  for (const entry of result) {
    if (!entry) continue;
    if (entry.kept) kept.push(entry.kept);
    else if (entry.discarded) discarded.push(entry.discarded);
  }

  return { kept, discarded, advice: kept.map(item => item.ai_advice) };
}

module.exports = {
  l0HardFilter,
  l1AiReview,
  l2AiAdvice,
  applyL1Verdicts,
  AI_DISCLOSURE_PATTERNS,
  DEFAULT_COMMENTS_TOP_N,
  DEFAULT_AUTO_APPROVE_CONFIDENCE,
  DEFAULT_AUTO_DISCARD_CONFIDENCE,
};
