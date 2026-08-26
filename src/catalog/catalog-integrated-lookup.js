'use strict';

const { readReleaseIndex } = require('../shared/release-index');

/**
 * catalog-integrated-lookup.js — 卡片生成器从共享 release_date 索引机械查找
 *
 * 生成 api_model/product_variant 卡时，若模型 release_date 缺失（AI 官方来源未给出），
 * 从 comparison 生成的共享索引 `data/shared/model-release-dates.json` 机械补填。
 * 这是 comparison → catalog 方向的机械查找（只读共享段，不直接读 integrated 大文件）。
 * 反方向（catalog → comparison）由 comparison 侧经共享投影 `catalog-release-dates.json` 处理。
 */

function slugifyModelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** 读共享 release_date 索引（委托 src/shared 校验接口，业务侧零裸 fs；缺失/损坏回退空）。 */
function loadSharedReleaseIndex() {
  return readReleaseIndex();
}

/** 从共享索引建查找 Map（alias/canonical/title/identity-slug → release_date）。 */
function buildIntegratedLookup(payload = {}) {
  const byAlias = new Map();
  const byCanonical = new Map();
  const byIdentity = new Map();
  for (const entry of payload.entries || []) {
    if (!entry.release_date || !/^\d{4}-\d{2}-\d{2}$/.test(entry.release_date)) continue;
    if (entry.model_key) byCanonical.set(String(entry.model_key).toLowerCase(), entry.release_date);
    if (entry.model_key && entry.model_key.includes('--')) {
      const identity = entry.model_key.slice(entry.model_key.indexOf('--') + 2);
      byIdentity.set(identity.toLowerCase(), entry.release_date);
    }
    for (const alias of entry.catalog_aliases || []) {
      byAlias.set(String(alias).trim().toLowerCase(), entry.release_date);
    }
  }
  return { byAlias, byCanonical, byIdentity };
}

/**
 * 按 seed 查找 release_date：tool_key → 标题 slug → 标题原文 → identity。
 * @param {{tool_key?: string, name?: string}} seed
 * @param {{byAlias: Map, byCanonical: Map, byIdentity: Map}} lookup
 * @returns {{date: string, matched: string}|null}
 */
function lookupReleaseDateForSeed(seed, lookup) {
  if (!seed || !lookup) return null;
  const needles = [
    seed.tool_key,
    slugifyModelName(seed.name),
    String(seed.name || '').trim().toLowerCase(),
    String(seed.name || '').trim().toLowerCase().replace(/\s+/g, '-'),
  ].filter(Boolean);
  for (const needle of needles) {
    const hit = lookup.byAlias.get(needle) || lookup.byCanonical.get(needle) || lookup.byIdentity.get(needle);
    if (hit) return { date: hit, matched: needle };
  }
  return null;
}

module.exports = { slugifyModelName, loadSharedReleaseIndex, buildIntegratedLookup, lookupReleaseDateForSeed };
