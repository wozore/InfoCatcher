'use strict';

const { CATALOG_FILES, CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson } = require('../shared/json-store');
const { normalizeSnapshot } = require('./catalog-contract');
const { revisionOf } = require('./catalog-revision');

const FILE_BY_AREA = Object.freeze({
  'vendor-card': CATALOG_FILES.vendorCards,
  'tool-card': CATALOG_FILES.toolCards,
  'vendor-level1': CATALOG_FILES.vendorPreviewLevel1,
  'vendor-level2': CATALOG_FILES.vendorPreviewLevel2,
  'tool-level3': CATALOG_FILES.toolPreviewLevel3,
});

function loadCatalogSnapshot() {
  const snapshot = {};
  for (const [area, file] of Object.entries(FILE_BY_AREA)) {
    const payload = readJson(file);
    const items = Array.isArray(payload) ? payload : payload.items;
    if (!Array.isArray(items)) throw new Error(`CATALOG_ITEMS_INVALID:${area}`);
    snapshot[area] = items;
  }
  const normalized = normalizeSnapshot(snapshot);
  return { snapshot: normalized, revision: revisionOf(normalized) };
}

function catalogFileByArea(area) {
  const file = FILE_BY_AREA[area];
  if (!file) throw new Error(`INVALID_AREA:${area}`);
  return file;
}

function catalogFiles() {
  return { ...FILE_BY_AREA };
}

function generatorPaths() {
  return { ...CATALOG_GENERATOR_FILES };
}

module.exports = { FILE_BY_AREA, loadCatalogSnapshot, catalogFileByArea, catalogFiles, generatorPaths };
