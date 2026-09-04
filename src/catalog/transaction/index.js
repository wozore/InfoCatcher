'use strict';

const engine = require('./engine');
const planner = require('./removal-planner');
const snapshotStore = require('../core/catalog-snapshot-store');

function loadCatalogSnapshot(...args) {
  return snapshotStore.loadCatalogSnapshot(...args);
}

function commitSnapshotChange(...args) {
  return engine.commitSnapshotChange(...args);
}

function commitCatalogChange(...args) {
  return engine.commitCatalogChange(...args);
}

function replaceToolLevel3(...args) {
  return engine.replaceToolLevel3(...args);
}

function removeCatalogRecords(...args) {
  return engine.removeCatalogRecords(...args);
}

function recoverCatalogTransaction(...args) {
  return engine.recoverCatalogTransaction(...args);
}

function planRecordRemoval(...args) {
  return planner.planRecordRemoval(...args);
}

module.exports = {
  FILE_BY_AREA: snapshotStore.FILE_BY_AREA,
  loadCatalogSnapshot,
  commitSnapshotChange,
  commitCatalogChange,
  replaceToolLevel3,
  removeCatalogRecords,
  planRecordRemoval,
  recoverCatalogTransaction,
};
