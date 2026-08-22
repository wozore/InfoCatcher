'use strict';

const fs = require('fs');

function error(path, message) {
  return { path, message };
}

function validateExclusionConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { ok: false, errors: [error('$', 'model-exclusions 顶层必须是对象')] };
  if (config.schema_version !== 1) errors.push(error('schema_version', '必须为 1'));
  if (!Array.isArray(config.rules)) {
    errors.push(error('rules', '必须是数组'));
    return { ok: errors.length === 0, errors };
  }
  const seen = new Set();
  config.rules.forEach((rule, index) => {
    const path = `rules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      errors.push(error(path, '必须是对象'));
      return;
    }
    if (typeof rule.vendor !== 'string' || !rule.vendor.trim()) errors.push(error(`${path}.vendor`, '必须是非空字符串'));
    const hasPrefix = typeof rule.identity_prefix === 'string' && rule.identity_prefix.trim();
    const hasIdentities = Array.isArray(rule.identities) && rule.identities.length > 0;
    if (Boolean(hasPrefix) === Boolean(hasIdentities)) errors.push(error(path, '必须且只能配置 identity_prefix 或 identities'));
    if (hasPrefix && /\s/.test(rule.identity_prefix)) errors.push(error(`${path}.identity_prefix`, '不能包含空白'));
    if (hasIdentities && (!rule.identities.every(identity => typeof identity === 'string' && identity.trim() && !/\s/.test(identity)) || new Set(rule.identities).size !== rule.identities.length)) {
      errors.push(error(`${path}.identities`, '必须是无空白且不重复的字符串数组'));
    }
    if (typeof rule.reason !== 'string' || !rule.reason.trim()) errors.push(error(`${path}.reason`, '必须提供排除理由'));
    const matchKey = hasPrefix ? `${rule.vendor}:prefix:${rule.identity_prefix}` : `${rule.vendor}:identities:${(rule.identities || []).join('|')}`;
    if (seen.has(matchKey)) errors.push(error(path, `匹配规则重复: ${matchKey}`));
    seen.add(matchKey);
  });
  return { ok: errors.length === 0, errors };
}

function readExclusionConfig(file) {
  if (!file || !fs.existsSync(file)) throw new Error('MODEL_EXCLUSIONS_MISSING');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = validateExclusionConfig(config);
  if (!result.ok) throw new Error(`MODEL_EXCLUSIONS_INVALID:${result.errors[0].path}:${result.errors[0].message}`);
  return config;
}

function ruleMatches(model, rule) {
  if (String(model?.vendor || '') !== rule.vendor) return false;
  const identity = String(model?.identity || '');
  if (rule.identity_prefix) return identity === rule.identity_prefix || identity.startsWith(`${rule.identity_prefix}-`);
  return rule.identities.includes(identity);
}

function exclusionForModel(model, config) {
  for (const rule of config.rules) {
    if (ruleMatches(model, rule)) return { rule, canonical: model.canonical, identity: model.identity, vendor: model.vendor, reason: rule.reason };
  }
  return null;
}

function filterExcludedRecords(records, config) {
  const kept = {};
  const excluded = [];
  for (const [key, record] of Object.entries(records || {})) {
    const match = exclusionForModel(record, config);
    if (match) excluded.push({ ...match, record_key: key });
    else kept[key] = record;
  }
  return { records: kept, excluded };
}

module.exports = { validateExclusionConfig, readExclusionConfig, exclusionForModel, filterExcludedRecords };
