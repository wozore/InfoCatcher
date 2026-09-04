'use strict';

const { FILE_BY_AREA } = require('../core/catalog-snapshot-store');
const { validateCatalogSnapshot } = require('../core/catalog-snapshot-validator');

function normalizeRemovalTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('REMOVE_TARGETS_REQUIRED');
  const seen = new Set();
  return targets.map(target => {
    const area = target?.area;
    const id = target?.id;
    if (!FILE_BY_AREA[area] || typeof id !== 'string' || !id.trim()) throw new Error(`REMOVE_TARGET_INVALID:${area}:${id}`);
    const key = `${area}:${id}`;
    if (seen.has(key)) throw new Error(`REMOVE_TARGET_DUPLICATE:${key}`);
    seen.add(key);
    return { area, id };
  });
}

function removeReferences(snapshot, removedRefs) {
  for (const items of Object.values(snapshot)) {
    for (const item of items) {
      for (const field of ['level1_ref', 'level2_ref', 'detail_ref']) {
        if (item[field] && removedRefs.has(`${item[field].kind}:${item[field].id}`)) delete item[field];
      }
      for (const field of ['level2_refs', 'detail_refs']) {
        if (Array.isArray(item[field])) item[field] = item[field].filter(ref => !removedRefs.has(`${ref.kind}:${ref.id}`));
      }
    }
  }
}

function planRecordRemoval(snapshot, targets) {
  const normalized = normalizeRemovalTargets(targets);
  const missing = normalized.filter(target => !snapshot[target.area].some(item => item.id === target.id));
  if (missing.length) return { ok: false, code: 'REMOVE_TARGET_MISSING', missing };
  const removedRefs = new Set(normalized.map(target => `${target.area}:${target.id}`));
  const targetSnapshot = Object.fromEntries(Object.entries(snapshot).map(([area, items]) => [
    area,
    items.filter(item => !normalized.some(target => target.area === area && target.id === item.id)),
  ]));
  removeReferences(targetSnapshot, removedRefs);
  const validation = validateCatalogSnapshot(targetSnapshot);
  if (!validation.ok) return { ok: false, code: 'SNAPSHOT_INVALID', errors: validation.errors };
  return { ok: true, snapshot: targetSnapshot, removed: normalized };
}

module.exports = { normalizeRemovalTargets, planRecordRemoval };
