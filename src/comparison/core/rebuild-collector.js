'use strict';

/**
 * rebuild-collector.js — 4 源 raw 快照收集与实体记录聚拢（纯逻辑）
 */

const { LMARENA_CONFIGS, LMARENA_AGENT_CONFIGS } = require('./compare-schema');
const { createModelIdentityResolver } = require('../identity/model-identity');
const { normalizeRevision } = require('../series/revision-date');

const SOURCE_ORDER = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];

function hasNum(x) {
  return x != null && String(x).trim() !== '' && Number.isFinite(Number(x));
}

function addIdentityMetadata(record, resolved, source, rawName, now = new Date()) {
  if (resolved.revision) record.revisions.add(normalizeRevision(resolved.revision, now));
  if (resolved.evaluation_profile) record.evaluation_profiles.add(resolved.evaluation_profile);
  if (!record.source_names[source]) record.source_names[source] = [];
  if (!record.source_names[source].includes(rawName)) record.source_names[source].push(rawName);
  for (const offering of resolved.offerings) {
    if (!record.offerings[source]) record.offerings[source] = [];
    if (!record.offerings[source].some(entry => entry.kind === offering && entry.raw_name === rawName)) {
      record.offerings[source].push({ kind: offering, raw_name: rawName });
    }
  }
}

function collectSourceRecords(snapshots, identityRegistry = {}, now = new Date()) {
  const registry = Array.isArray(identityRegistry) ? { schema_version: 1, entries: identityRegistry } : identityRegistry;
  const resolveIdentity = createModelIdentityResolver(registry);
  const records = {}; // model_key[@revision] → { identity, vendor, sources }
  const get = resolved => {
    const revision = resolved.revision ? normalizeRevision(resolved.revision, now) : null;
    const recordKey = revision ? `${resolved.model_key}@${revision}` : resolved.model_key;
    if (!records[recordKey]) {
      records[recordKey] = {
        canonical: recordKey,
        identity: resolved.identity,
        family: resolved.family,
        vendor: resolved.vendor,
        revisions: new Set(),
        evaluation_profiles: new Set(),
        offerings: {},
        source_names: {},
        sources: {},
      };
    }
    return records[recordKey];
  };

  // openrouter（无 degree；Batch/Free/Fast/Latest 收拢到主模型）
  for (const item of snapshots.openrouter?.data || []) {
    const resolved = resolveIdentity({ source: 'openrouter', rawName: item.id });
    if (resolved.kind !== 'model') continue;
    const rec = get(resolved);
    addIdentityMetadata(rec, resolved, 'openrouter', item.id, now);
    const current = rec.sources.openrouter;
    const currentOfferingCount = Number(current?._identityOfferingCount || 0);
    if (!current || resolved.offerings.length < currentOfferingCount ||
      (resolved.offerings.length === currentOfferingCount && Number(item.created || 0) > Number(current.created || 0))) {
      rec.sources.openrouter = { ...item, vendor: resolved.vendor, _identityOfferingCount: resolved.offerings.length };
    }
  }

  // lmarena（per config × degree；agent 榜用 score 比例分，其余 9 榜用 rating Elo）
  for (const config of LMARENA_CONFIGS) {
    const scoreField = LMARENA_AGENT_CONFIGS.includes(config) ? 'score' : 'rating';
    for (const row of snapshots.lmarena?.configs?.[config] || []) {
      const resolved = resolveIdentity({ source: 'lmarena', rawName: row.model_name, vendorHint: row.organization });
      if (resolved.kind !== 'model') continue;
      const rawScore = row[scoreField];
      if (!hasNum(rawScore)) continue;
      const rec = get(resolved);
      addIdentityMetadata(rec, resolved, 'lmarena', row.model_name, now);
      const lmarena = rec.sources.lmarena || (rec.sources.lmarena = {
        configs: {}, profiles: {}, organization: resolved.vendor, license: row.license, degreeOrder: {}, baseName: null,
      });
      if (!lmarena.baseName) lmarena.baseName = resolved.display;
      const degree = resolved.degree || 'base';
      const score = { score: Number(rawScore), rank: row.rank };
      if (resolved.evaluation_profile) {
        const profiles = lmarena.profiles[config] || (lmarena.profiles[config] = {});
        const profileScores = profiles[resolved.evaluation_profile] || (profiles[resolved.evaluation_profile] = {});
        if (!profileScores[degree]) profileScores[degree] = score;
        continue;
      }
      lmarena.configs[config] = lmarena.configs[config] || {};
      if (!lmarena.configs[config][degree]) lmarena.configs[config][degree] = score;
      if (!lmarena.degreeOrder[config]) lmarena.degreeOrder[config] = [];
      if (!lmarena.degreeOrder[config].includes(degree)) lmarena.degreeOrder[config].push(degree);
    }
  }

  // livebench（per degree 组分数）
  for (const row of snapshots.livebench?.groups || []) {
    const resolved = resolveIdentity({ source: 'livebench', rawName: row.model });
    if (resolved.kind !== 'model') continue;
    const rec = get(resolved);
    addIdentityMetadata(rec, resolved, 'livebench', row.model, now);
    const livebench = rec.sources.livebench || (rec.sources.livebench = { scores: {}, degreeOrder: [] });
    const degree = resolved.degree || 'base';
    if (!livebench.scores[degree]) livebench.scores[degree] = {};
    for (const key of ['reasoning', 'coding', 'math', 'language', 'instruction_following', 'data_analysis', 'agentic_coding']) {
      if (hasNum(row[key])) livebench.scores[degree][key] = Number(row[key]);
    }
    if (!livebench.degreeOrder.includes(degree)) livebench.degreeOrder.push(degree);
  }

  // llm_stats（无 degree；model_id 常带日期，统一剥离对齐）
  for (const model of snapshots.llm_stats?.models || []) {
    const resolved = resolveIdentity({ source: 'llm_stats', rawName: model.model_id, vendorHint: model.organization_id || model.organization });
    if (resolved.kind !== 'model') continue;
    const rec = get(resolved);
    addIdentityMetadata(rec, resolved, 'llm_stats', model.model_id, now);
    if (!rec.sources.llm_stats || !resolved.revision) rec.sources.llm_stats = model;
  }

  return records;
}

module.exports = {
  SOURCE_ORDER,
  collectSourceRecords,
  addIdentityMetadata,
};
