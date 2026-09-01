/**
 * keyword-actions.js —— 新闻关键词维护 mutation（纯本地、无 CLI/网络依赖）
 *
 * 关键词清单只允许维护者从 candidates 中选择 adopted_keywords 或丢弃（加入
 * keywords.excluded_keywords 黑名单，防止下次再被 AI 建议）；落盘时只改变
 * config.keywords.ai_keywords / excluded_keywords，并以 config revision 拒绝陈旧写入。
 */

'use strict';

const crypto = require('crypto');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { NEWS_FILES } = require('../../shared/paths');

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function revisionOfConfig(config) {
  return crypto.createHash('sha256').update(stableStringify(config || {})).digest('hex');
}

function assertExpectedConfigRevision(config, expectedRevision) {
  if (typeof expectedRevision !== 'string' || expectedRevision.length === 0) {
    throw new Error('关键词 mutation 必须提供 expected revision');
  }
  const actualRevision = revisionOfConfig(config);
  if (actualRevision !== expectedRevision) {
    const error = new Error(`配置 revision 冲突：expected=${expectedRevision}，actual=${actualRevision}`);
    error.code = 'REVISION_CONFLICT';
    error.expected_revision = expectedRevision;
    error.actual_revision = actualRevision;
    throw error;
  }
  return actualRevision;
}

/**
 * 既有关键词清单规则：候选字段完整且唯一，adopted_keywords 必须是 candidates 子集，
 * 采纳词按大小写不敏感去重，并幂等追加到 keywords.ai_keywords。
 */
function applyRefineKeywords(config, list) {
  if (!list || list.kind !== 'keyword_refine_candidates' || !Array.isArray(list.candidates) || !Array.isArray(list.adopted_keywords)) {
    throw new Error('非法关键词清单：需要 kind=\'keyword_refine_candidates\'，且含 candidates 与 adopted_keywords 数组');
  }
  const candidateWords = new Set();
  for (const candidate of list.candidates) {
    if (!candidate || typeof candidate.word !== 'string' || !candidate.word.trim() || typeof candidate.category !== 'string' || !candidate.category.trim() || !['repeated', 'emerging'].includes(candidate.candidate_type) || !Number.isInteger(candidate.count) || candidate.count < 1) {
      throw new Error('关键词清单含非法 candidates 条目（需 word、category、candidate_type、count 四字段）');
    }
    const key = candidate.word.trim().toLowerCase();
    if (candidateWords.has(key)) throw new Error(`关键词清单含重复候选词：${candidate.word.trim()}`);
    candidateWords.add(key);
  }

  const adopted = [];
  const adoptedKeys = new Set();
  let duplicates = 0;
  for (const raw of list.adopted_keywords) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('adopted_keywords 只能包含非空字符串');
    const word = raw.trim();
    const key = word.toLowerCase();
    if (!candidateWords.has(key)) throw new Error(`adopted_keywords 含不在 candidates 中的词：${word}`);
    if (adoptedKeys.has(key)) {
      duplicates += 1;
      continue;
    }
    adoptedKeys.add(key);
    adopted.push(word);
  }

  const nextConfig = { ...(config || {}), keywords: { ...((config && config.keywords) || {}) } };
  const existing = Array.isArray(nextConfig.keywords.ai_keywords) ? nextConfig.keywords.ai_keywords.slice() : [];
  const existingKeys = new Set(existing.map(word => String(word).trim().toLowerCase()));
  const added = [];
  const alreadyExists = [];
  for (const word of adopted) {
    if (existingKeys.has(word.toLowerCase())) {
      alreadyExists.push(word);
      continue;
    }
    existing.push(word);
    existingKeys.add(word.toLowerCase());
    added.push(word);
  }
  nextConfig.keywords.ai_keywords = existing;
  return { config: nextConfig, added, already_exists: alreadyExists, duplicates, changed: added.length > 0 };
}

/** 纯 mutation：expected revision 通过后才生成配置候选，不做 I/O。 */
function applyKeywordActions(config, list, options = {}) {
  assertExpectedConfigRevision(config, options.expectedRevision);
  const result = applyRefineKeywords(config, list);
  return {
    ...result,
    before_revision: options.expectedRevision,
    revision: revisionOfConfig(result.config),
  };
}

/**
 * 丢弃关键词（黑名单）：把维护者明确不要的词加入 keywords.excluded_keywords，
 * 避免下次 refine 再次建议。大小写不敏感去重，幂等追加。
 */
function applyKeywordExclusions(config, words, options = {}) {
  assertExpectedConfigRevision(config, options.expectedRevision);
  const list = Array.isArray(words) ? words : [];
  const normalized = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) throw new Error('丢弃的关键词只能是非空字符串');
    const word = raw.trim();
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(word);
  }
  const nextConfig = { ...(config || {}), keywords: { ...((config && config.keywords) || {}) } };
  const existing = Array.isArray(nextConfig.keywords.excluded_keywords) ? nextConfig.keywords.excluded_keywords.slice() : [];
  const existingKeys = new Set(existing.map(word => String(word).trim().toLowerCase()));
  const added = [];
  for (const word of normalized) {
    if (existingKeys.has(word.toLowerCase())) continue;
    existing.push(word);
    existingKeys.add(word.toLowerCase());
    added.push(word);
  }
  nextConfig.keywords.excluded_keywords = existing;
  return {
    config: nextConfig,
    added,
    already_exists: normalized.filter(word => !added.some(addedWord => addedWord.toLowerCase() === word.toLowerCase())),
    changed: added.length > 0,
    before_revision: options.expectedRevision,
    revision: revisionOfConfig(nextConfig),
  };
}

/** 配置 guarded commit：把丢弃词原子写回 config；无新增词时不写盘。 */
function commitKeywordExclusions(words, options = {}) {
  const configPath = options.configPath || NEWS_FILES.configV2;
  const current = options.config || readJson(configPath, {});
  const result = applyKeywordExclusions(current, words, { expectedRevision: options.expectedRevision });
  if (result.changed) {
    const latest = readJson(configPath, {});
    assertExpectedConfigRevision(latest, options.expectedRevision);
    const latestResult = applyKeywordExclusions(latest, words, { expectedRevision: options.expectedRevision });
    if (options.writeConfig) options.writeConfig(latestResult.config, options.runId || 'keyword-exclusions', { expectedRevision: options.expectedRevision });
    else writeJsonAtomic(configPath, latestResult.config, options.runId || 'keyword-exclusions');
    return { ...latestResult, written: true };
  }
  return { ...result, written: false };
}

/**
 * 配置 guarded commit：磁盘校验 expected revision 后原子写回；无新增词时不写盘。
 * configPath/writeConfig 仅为离线调用注入，不改变默认单一配置写者。
 */
function commitKeywordActions(list, options = {}) {
  const configPath = options.configPath || NEWS_FILES.configV2;
  const current = options.config || readJson(configPath, {});
  const expectedRevision = options.expectedRevision;
  const result = applyKeywordActions(current, list, { expectedRevision });
  if (result.changed) {
    const latest = readJson(configPath, {});
    assertExpectedConfigRevision(latest, expectedRevision);
    const latestResult = applyKeywordActions(latest, list, { expectedRevision });
    if (options.writeConfig) options.writeConfig(latestResult.config, options.runId || 'keyword-actions', { expectedRevision });
    else writeJsonAtomic(configPath, latestResult.config, options.runId || 'keyword-actions');
    return { ...latestResult, written: true };
  }
  return { ...result, written: false };
}

module.exports = {
  revisionOfConfig,
  assertExpectedConfigRevision,
  applyRefineKeywords,
  applyKeywordActions,
  applyKeywordSelection: applyKeywordActions,
  commitKeywordActions,
  applyKeywordExclusions,
  commitKeywordExclusions,
};
