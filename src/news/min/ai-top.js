/**
 * ai-top.js —— approved 候选的 AI top 结果确定性收敛：按 AI id 顺序取值，
 * 对漏选或无效 id 的结果按评分倒序补齐，并组装人工审核清单条目。
 * 不负责 AI 请求、文件读写或命令行输出。
 */

'use strict';

const { scoreOf, suggestReview } = require('./review-list');

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
  selectTopCandidates,
};
