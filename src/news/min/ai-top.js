/**
 * ai-top.js —— approved 候选的 AI top 待选项逻辑：YouTube 判定、top N 解析、
 * 模型输入裁剪、AI 结果确定性收敛（按 AI id 顺序取值，漏选/无效 id 按评分倒序补齐）
 * 与 top.json 产物组装。不负责 AI 请求、文件读写或命令行输出。
 */

'use strict';

const { scoreOf, suggestReview } = require('./review-list');

/** 喂给 AI 的 approved 候选输入上限（控制本地模型上下文，config.ai_top_input_max 可调）。 */
const MAX_AI_TOP_INPUT = 40;

/**
 * 判定"最后一次采集是否有 YouTube 内容"（ai-top 选 top N 用）。
 * 依据采集运行记录 last-run.json（pipeline-min runMin 末尾写）的 youtube 平台
 * 实际采到内容数（items > 0）。用户拍板语义：**YouTube 实际采到内容才算有**；
 * not_run / failed / items=0 均视为无。分时采集下 X 日 top10、YouTube+X 日 top15，
 * 避免 approved 层残留的历史 YouTube 候选误触发 top15。
 * @param {object|null} lastRun readJson(NEWS_FILES.lastRun, null) 的结果
 * @returns {boolean} youtube 实际采到内容 → true
 */
function hasYouTubeInLastRun(lastRun) {
  if (!lastRun || !lastRun.collectors || !lastRun.collectors.youtube) return false;
  return Number(lastRun.collectors.youtube.items) > 0;
}

/**
 * 解析 ai-top 的 YouTube 判定与 top 数量（纯逻辑，无 I/O，便于测试）。
 * 有 approved 候选时优先以最后一次采集记录判定；历史审核或手工导入缺少
 * last-run 时，回退读取当前 approved 候选的 platform 字段，避免阻断后续编辑流程。
 * @param {Array} approved 候选层中 review_status==='approved' 的候选
 * @param {object|null} lastRun readJson(NEWS_FILES.lastRun, null) 的结果
 * @param {object} config v2 配置（读 collection.review_top_with_youtube / review_top_pure_x）
 * @returns {{ ok: true, hasYouTube: boolean, topN: number, source: 'last_run'|'approved_candidates' } |
 *            { ok: false, reason: 'no_approved' }}
 */
function resolveAiTopConfig(approved, lastRun, config) {
  if (!Array.isArray(approved) || approved.length === 0) {
    return { ok: false, reason: 'no_approved' };
  }
  const fromLastRun = Boolean(lastRun);
  const hasYouTube = fromLastRun
    ? hasYouTubeInLastRun(lastRun)
    : approved.some(candidate => String(candidate?.platform || '').trim().toLowerCase() === 'youtube');
  const collection = (config && config.collection) || {};
  const topN = hasYouTube
    ? Number(collection.review_top_with_youtube) || 15
    : Number(collection.review_top_pure_x) || 10;
  return { ok: true, hasYouTube, topN, source: fromLastRun ? 'last_run' : 'approved_candidates' };
}

/** 仅让 AI 读取按评分排序的有限候选池，避免历史 approved 大量累积时超出本地模型上下文。 */
function topCandidatesForAi(approved, limit = MAX_AI_TOP_INPUT) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : MAX_AI_TOP_INPUT;
  return (Array.isArray(approved) ? approved : [])
    .map(candidate => ({
      id: candidate.id,
      score: scoreOf(candidate),
      summary: String(candidate.summary || candidate.title || '(无标题)').trim().slice(0, 120),
    }))
    .sort((left, right) => (right.score ?? -Infinity) - (left.score ?? -Infinity))
    .slice(0, safeLimit);
}

/**
 * 组装 top.json 产物（第二阶段：AI 待选项清单，交维护者标记 top_selected）。
 * human_lines 是人类可读的清单正文（写盘内容，非命令行输出）。
 */
function buildAiTopPayload({ approved, selected, aiInput, aiTopInputMax, topN, manualFolderDateKey }) {
  return {
    schema_version: 1,
    kind: 'ai_top_candidates',
    generated_at: new Date().toISOString(),
    date: manualFolderDateKey,
    approved_count: approved.length,
    ai_input_count: aiInput.length,
    target_top_n: topN,
    ai_selected_count: selected.length,
    note: 'AI 从人工 approved 候选中挑选的 top 待选项（按最后一次采集记录判定：有 YouTube 内容 15 / 纯 X 10；输入限定为评分最高的 '
          + String(aiTopInputMax) + ' 条 approved，避免超出本地模型上下文）。' +
          '请把要显示在前端的 3~5（有 YouTube 日 3~8）条 top_selected 置为 true；' +
          '确认后双击 bat/apply-top.bat（应用选择 + 重建公开投影，显示到前端）。',
    candidates: selected,
    human_lines: selected.map(c =>
      `[${c.score === null ? '-' : c.score}] ${c.summary}\n` +
      `    作者：${c.author_name}\n` +
      `    内容：${c.description}\n` +
      `    建议：${c.suggestion}` +
      (c.original ? `\n    原文：${c.original}` : '')
    ),
  };
}

function selectTopCandidates(approved, ids, topN) {
  const byId = new Map((approved || []).map(candidate => [candidate.id, candidate]));
  const aiOrdered = (ids || []).map(id => byId.get(id)).filter(Boolean);
  const rest = (approved || [])
    .filter(candidate => !aiOrdered.some(chosen => chosen.id === candidate.id))
    .sort((a, b) => (scoreOf(b) ?? -Infinity) - (scoreOf(a) ?? -Infinity));
  return aiOrdered.concat(rest).slice(0, topN).map(candidate => {
    const zh = candidate.localizations && candidate.localizations.zh;
    const localizedDescription = (zh && (zh.description || zh.title)) || '';
    const originalText = String(candidate.description || '').trim();
    const isChinese = /[一-鿿]/.test(originalText);
    return {
      id: candidate.id,
      score: scoreOf(candidate),
      summary: String(candidate.summary || candidate.title || '(无标题)').trim(),
      suggestion: suggestReview(candidate),
      top_selected: false,
      description: localizedDescription || originalText,
      ...(isChinese ? {} : { original: candidate.url || '' }),
      author_name: candidate.author_name || '',
    };
  });
}

module.exports = {
  MAX_AI_TOP_INPUT,
  buildAiTopPayload,
  hasYouTubeInLastRun,
  resolveAiTopConfig,
  selectTopCandidates,
  topCandidatesForAi,
};
