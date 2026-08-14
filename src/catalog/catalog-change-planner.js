'use strict';

const { emptySnapshot, normalizeSnapshot } = require('./catalog-contract');
const { previewHashOf } = require('./catalog-revision');
const { validateCatalogSnapshot } = require('./catalog-snapshot-validator');
const { validatePlannedRecords } = require('./catalog-record-completeness');

function planCatalogPatches(snapshotInput, layerPatches = []) {
  const snapshot = normalizeSnapshot(snapshotInput);
  const futureSnapshot = normalizeSnapshot(JSON.parse(JSON.stringify(snapshot)));
  const plannedRecords = Object.fromEntries(Object.keys(emptySnapshot()).map(area => [area, []]));
  const creates = Object.fromEntries(Object.keys(emptySnapshot()).map(area => [area, []]));
  const replacements = Object.fromEntries(Object.keys(emptySnapshot()).map(area => [area, []]));
  const changes = [];
  const seen = new Set();
  for (const patch of layerPatches) {
    if (!patch || !Object.prototype.hasOwnProperty.call(futureSnapshot, patch.area)) throw new Error(`PATCH_AREA_INVALID:${patch?.area}`);
    const key = `${patch.area}:${patch.id}`;
    if (seen.has(key)) throw new Error(`PATCH_DUPLICATE:${key}`);
    seen.add(key);
    const index = futureSnapshot[patch.area].findIndex(item => item.id === patch.id);
    if (patch.operation === 'noop') {
      if (index < 0) throw new Error(`PATCH_NOOP_TARGET_MISSING:${key}`);
      continue;
    }
    if (!patch.record || patch.record.id !== patch.id) throw new Error(`PATCH_RECORD_INVALID:${key}`);
    if (patch.operation === 'create') {
      if (index >= 0) throw new Error(`ID_CONFLICT:${key}`);
      futureSnapshot[patch.area].push(patch.record);
      creates[patch.area].push(patch.record);
    } else if (patch.operation === 'replace') {
      if (index < 0) throw new Error(`REPLACE_TARGET_MISSING:${key}`);
      futureSnapshot[patch.area][index] = patch.record;
      replacements[patch.area].push(patch.record);
    } else throw new Error(`PATCH_OPERATION_INVALID:${patch.operation}`);
    plannedRecords[patch.area].push(patch.record);
    changes.push({ area: patch.area, id: patch.id, operation: patch.operation, fields: Object.keys(patch.record) });
  }
  const strict = validatePlannedRecords(plannedRecords);
  if (!strict.ok) {
    const first = strict.errors[0];
    throw new Error(`PATCH_RECORDS_INCOMPLETE:${first.path}:${first.message}`);
  }
  const validation = validateCatalogSnapshot(futureSnapshot);
  if (!validation.ok) {
    const first = validation.errors[0];
    throw new Error(`SNAPSHOT_INVALID:${first.path}:${first.message}`);
  }
  const changePreview = {
    operation: 'layer_patches',
    creates: Object.fromEntries(Object.entries(creates).map(([area, items]) => [area, items.map(item => item.id)])),
    updates: changes.filter(change => change.operation === 'replace'),
    noops: layerPatches.filter(patch => patch.operation === 'noop').map(patch => ({ area: patch.area, id: patch.id })),
  };
  return {
    snapshot: futureSnapshot,
    creates,
    replacements,
    updates: changes.filter(change => change.operation === 'replace'),
    plannedRecords,
    changePreview,
    previewHash: previewHashOf(changePreview),
  };
}

module.exports = { planCatalogPatches };
