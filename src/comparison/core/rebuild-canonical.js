'use strict';

/**
 * rebuild-canonical.js — 模型主键与名称规范化（纯逻辑）
 */

const { parseModelNameMetadata, stripRevision } = require('../identity/model-identity');

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// 日期 token 剥离（尾部或中缀，如 -2025-02-27 / 20250326 / 2025-02 / 202506 / 08-2024 / 26-01-10 / 02-15；
// 分隔符兼容连字符/下划线/空格——lmarena 空格分隔日期如 'Amazon Nova ... 10-09' 也命中）。
function stripCanonicalDates(model) {
  return String(model || '')
    .replace(/[-_\s]\d{4}-\d{2}-\d{2}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{8}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{4}-\d{2}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{6}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{2}-\d{4}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{2}-\d{2}-\d{2}(?=[-_\s:]|$)/, '')
    .replace(/[-_\s]\d{2}-\d{2}(?=[-_\s:]|$)/, '');
}

function openrouterCanonical(id) {
  const model = String(id).split('/').pop() || '';
  return slugify(stripCanonicalDates(model));
}

function llmStatsCanonical(modelId) {
  return slugify(stripCanonicalDates(modelId));
}

function openrouterVendor(id) {
  return slugify(String(id).split('/')[0]);
}

// 展示名仅移除发布日期、供应方式与已解析的评测挡位；参数规模、MoE、模式和模态均属于模型身份，必须保留。
function cleanModelDisplay(raw) {
  if (raw == null) return null;
  let name = String(raw).trim();
  if (!name) return null;
  name = name.replace(/\s*\((?:high|low|medium|xhigh|auto|max)(?:-effort)?\)\s*$/i, '');
  name = name.replace(/\s*\((?:\d{4}-\d{2}-\d{2}|\d{2}-\d{4})\)\s*$/i, '');
  name = stripRevision(name);
  name = name.replace(/(?:[-_\s]+)(?:batch|free|fast|latest)\s*$/i, '');
  name = name.replace(/[-_\s]{2,}/g, ' ').replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
  return name || null;
}

function lmarenaParse(name) {
  const parsed = parseModelNameMetadata('lmarena', name);
  return {
    base: parsed.model_name,
    degree: parsed.degree,
    evaluation_profile: parsed.evaluation_profile,
  };
}

function livebenchParse(name) {
  const parsed = parseModelNameMetadata('livebench', name);
  return {
    base: slugify(stripRevision(parsed.model_name)),
    degree: parsed.degree,
    evaluation_profile: parsed.evaluation_profile,
  };
}

const SOURCE_ORDER = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];

function buildAliasMap(entries) {
  const map = { openrouter: {}, lmarena: {}, livebench: {}, llm_stats: {} };
  for (const entry of entries || []) {
    for (const source of SOURCE_ORDER) {
      for (const alias of entry.aliases?.[source] || []) {
        map[source][String(alias).toLowerCase()] = entry.canonical;
      }
    }
  }
  return map;
}

function resolveCanonical(aliasMap, source, rawName, autoCanonical) {
  return aliasMap[source][String(rawName).toLowerCase()] || autoCanonical;
}

module.exports = {
  slugify,
  stripCanonicalDates,
  openrouterCanonical,
  llmStatsCanonical,
  openrouterVendor,
  cleanModelDisplay,
  lmarenaParse,
  livebenchParse,
  buildAliasMap,
  resolveCanonical,
};
