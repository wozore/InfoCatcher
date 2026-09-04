'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS, CATALOG_GENERATOR_FILES } = require('../../shared/paths');
const { readJson, writeJsonAtomic, acquireLock, releaseLock } = require('../../shared/json-store');
const { validateCatalogSnapshot } = require('../core/catalog-snapshot-validator');
const { revisionOf } = require('../core/catalog-revision');
const { loadCatalogSnapshot, FILE_BY_AREA } = require('../core/catalog-snapshot-store');
const { planCatalogPatches } = require('../core/catalog-change-planner');
const { publishCatalogReleaseDatesAfterCommit } = require('../catalog-shared-publish');
const { buildStaticSite } = require('../../build/static-site');
const { normalizeRemovalTargets, planRecordRemoval } = require('./removal-planner');
const {
  removeIfExists,
  replaceDirectory,
  replaceCatalogFiles,
  copyCatalogFiles,
  backupDirectory,
} = require('./directory-swap');

function transactionPaths(options = {}) {
  const catalogDir = options.catalogDir || DIRS.catalog;
  const projectDir = options.projectDir || DIRS.project;
  const catalogFiles = options.catalogFiles || Object.fromEntries(
    Object.entries(FILE_BY_AREA).map(([area, file]) => [area, path.join(catalogDir, path.basename(file))]),
  );
  const transactionDir = options.transactionDir || path.join(catalogDir, '.transactions');
  const stagingDir = options.stagingDir || path.join(catalogDir, '.staging');
  const backupDir = options.backupDir || path.join(catalogDir, '.backup');
  return {
    projectDir,
    catalogDir,
    catalogFiles,
    transactionDir,
    stagingDir,
    backupDir,
    lock: options.lockPath || path.join(catalogDir, path.basename(CATALOG_GENERATOR_FILES.lock)),
    journal: options.journalPath || path.join(transactionDir, 'journal.json'),
  };
}

function ensureDirs(paths, fsImpl) {
  fsImpl.mkdirSync(paths.transactionDir, { recursive: true });
  fsImpl.mkdirSync(paths.stagingDir, { recursive: true });
  fsImpl.mkdirSync(paths.backupDir, { recursive: true });
}

function journalRead(paths) {
  return readJson(paths.journal, null);
}

function journalWrite(paths, value, runId) {
  writeJsonAtomic(paths.journal, value, runId);
}

function writeSnapshotFiles(snapshot, stagingCatalog, paths, fsImpl) {
  fsImpl.mkdirSync(stagingCatalog, { recursive: true });
  for (const [area, file] of Object.entries(paths.catalogFiles)) {
    const target = path.join(stagingCatalog, path.basename(file));
    fsImpl.writeFileSync(target, `${JSON.stringify({ schema_version: 1, items: snapshot[area] }, null, 2)}\n`, 'utf8');
  }
  for (const file of ['glossary.json', 'scenes.json', 'featured.json']) {
    const source = path.join(paths.catalogDir, file);
    if (fsImpl.existsSync(source)) fsImpl.copyFileSync(source, path.join(stagingCatalog, file));
  }
}

function finalizeTransaction(staging, backup, paths, fsImpl) {
  removeIfExists(staging, fsImpl);
  removeIfExists(backup, fsImpl);
  removeIfExists(paths.journal, fsImpl);
}

function rollbackFromJournal(journal, paths, fsImpl) {
  if (journal?.replaced?.length && journal.backup_catalog) {
    replaceCatalogFiles(journal.backup_catalog, paths.catalogFiles, { fsImpl });
  }
  if ((journal?.dist_replacement_started || journal?.dist_replaced)
    && journal.backup_dist && fsImpl.existsSync(journal.backup_dist)) {
    replaceDirectory(journal.backup_dist, path.join(paths.projectDir, 'dist'), { fsImpl });
  }
}

function builderOf(options) {
  if (typeof options.buildStaticSite === 'function') return options.buildStaticSite;
  if (typeof options.buildDist === 'function') return options.buildDist;
  return buildStaticSite;
}

function publishAfterCommit(options) {
  if (options.publishCatalogReleaseDates === false) return;
  const publish = options.publishCatalogReleaseDatesAfterCommit || publishCatalogReleaseDatesAfterCommit;
  publish();
}

function runTransaction({ target, options, operation, prepare, result, includeDraftId = false, includeLockOperation = true }) {
  const paths = transactionPaths(options);
  const fsImpl = options.fsImpl || fs;
  ensureDirs(paths, fsImpl);
  const runId = options.runId || `catalog-${options.operation || operation}-${process.pid}-${Date.now()}`;
  const staging = path.join(paths.stagingDir, runId);
  const stagingCatalog = path.join(staging, 'catalog');
  const backup = path.join(paths.backupDir, runId);
  const backupCatalog = path.join(backup, 'catalog');
  const stagedDist = path.join(staging, 'dist');
  const backupDist = path.join(backup, 'dist');
  let lockHeld = false;
  try {
    acquireLock(paths.lock, { run_id: runId, pid: process.pid, ...(includeLockOperation ? { operation } : {}), ...(includeDraftId ? { draft_id: options.draftId || null } : {}), at: new Date().toISOString() });
    lockHeld = true;
    const loadSnapshot = options.loadCatalogSnapshot || loadCatalogSnapshot;
    const before = loadSnapshot();
    if (options.expectedRevision && before.revision !== options.expectedRevision) {
      return { ok: false, code: 'REVISION_CONFLICT', revision: before.revision };
    }
    const prepared = prepare ? prepare(before) : { ok: true, snapshot: target };
    if (!prepared.ok) return prepared;
    const nextSnapshot = prepared.snapshot;
    const validation = validateCatalogSnapshot(nextSnapshot);
    if (!validation.ok) return { ok: false, code: 'SNAPSHOT_INVALID', errors: validation.errors };
    const targetRevision = revisionOf(nextSnapshot);
    const journal = {
      schema_version: 1,
      run_id: runId,
      ...(includeDraftId ? { draft_id: options.draftId || null } : {}),
      phase: 'staging',
      before_revision: before.revision,
      target_revision: targetRevision,
      staging,
      backup,
      backup_catalog: backupCatalog,
      staged_dist: stagedDist,
      backup_dist: backupDist,
      replaced: [],
      dist_replaced: false,
      at: new Date().toISOString(),
    };
    journalWrite(paths, journal, runId);
    writeSnapshotFiles(nextSnapshot, stagingCatalog, paths, fsImpl);
    if (options.buildDist !== false) {
      builderOf(options)({ catalogDir: stagingCatalog, outputDir: stagedDist });
    }
    journal.phase = options.buildDist === false ? 'catalog_staged' : 'dist_staged';
    journalWrite(paths, journal, runId);
    copyCatalogFiles(backupCatalog, paths.catalogFiles, { fsImpl });
    if (options.buildDist !== false) backupDirectory(backupDist, paths.projectDir, { fsImpl });
    journal.phase = 'committing';
    journal.replaced = Object.keys(paths.catalogFiles);
    journalWrite(paths, journal, runId);
    replaceCatalogFiles(stagingCatalog, paths.catalogFiles, { fsImpl });
    journal.phase = 'catalog_validated';
    journalWrite(paths, journal, runId);
    const after = loadSnapshot();
    if (after.revision !== targetRevision) throw new Error('TARGET_REVISION_MISMATCH');
    if (options.buildDist !== false) {
      journal.dist_replacement_started = true;
      journalWrite(paths, journal, runId);
      replaceDirectory(stagedDist, path.join(paths.projectDir, 'dist'), { fsImpl });
      journal.dist_replaced = true;
      journal.phase = 'dist_verified';
      journalWrite(paths, journal, runId);
    }
    journal.phase = 'committed';
    journalWrite(paths, journal, runId);
    publishAfterCommit(options);
    finalizeTransaction(staging, backup, paths, fsImpl);
    return { ok: true, ...(result ? result(prepared, before, targetRevision) : {}), beforeRevision: before.revision, targetRevision };
  } catch (error) {
    const journal = journalRead(paths);
    try {
      if (journal?.run_id === runId) rollbackFromJournal(journal, paths, fsImpl);
    } catch (rollbackError) {
      return { ok: false, code: 'ROLLBACK_FAILED', error: rollbackError.message, originalError: error.message };
    } finally {
      finalizeTransaction(staging, backup, paths, fsImpl);
    }
    return { ok: false, code: error.code || 'BUILD_FAILED', error: error.message };
  } finally {
    if (lockHeld) releaseLock(paths.lock, runId);
  }
}

function commitSnapshotChange(target, options = {}) {
  return runTransaction({ target, options, operation: options.operation || 'snapshot' });
}

function removeCatalogRecords(targets, options = {}) {
  let normalized;
  try { normalized = normalizeRemovalTargets(targets); }
  catch (error) { return { ok: false, code: error.message.split(':')[0], error: error.message }; }
  const loadSnapshot = options.loadCatalogSnapshot || loadCatalogSnapshot;
  const current = loadSnapshot();
  if (!options.expectedRevision) return { ok: false, code: 'REMOVE_EXPECTED_REVISION_REQUIRED' };
  if (options.expectedRevision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', revision: current.revision };
  const planned = planRecordRemoval(current.snapshot, normalized);
  if (!planned.ok) return planned;
  const result = runTransaction({
    target: planned.snapshot,
    options: { ...options, operation: 'remove-catalog-records' },
    operation: 'remove-catalog-records',
  });
  return result.ok ? { ...result, removed: normalized } : result;
}

function commitCatalogChange(seed, options = {}) {
  return runTransaction({
    target: null,
    options: { ...options, runId: options.runId || `catalog-${process.pid}-${Date.now()}` },
    operation: options.operation || 'catalog',
    prepare(before) {
      if (!Array.isArray(options.layerPatches)) return { ok: false, code: 'LAYER_PATCHES_REQUIRED', error: 'schema v3 Apply 必须提供 layerPatches' };
      const plan = planCatalogPatches(before.snapshot, options.layerPatches);
      return { ok: true, snapshot: plan.snapshot, plan };
    },
    result(prepared) { return { plan: prepared.plan }; },
    includeDraftId: true,
    includeLockOperation: false,
  });
}

function replaceToolLevel3(items, options = {}) {
  if (!Array.isArray(items)) return { ok: false, code: 'INVALID_WRITE', error: 'tool-level3 items 必须是数组' };
  return runTransaction({
    target: null,
    options: { ...options, runId: options.runId || `catalog-replace-${process.pid}-${Date.now()}` },
    operation: 'replace-tool-level3',
    prepare(before) {
      return { ok: true, snapshot: { ...before.snapshot, 'tool-level3': items } };
    },
    result(_prepared, _before, targetRevision) { return { revision: targetRevision }; },
  });
}

function recoverCatalogTransaction(options = {}) {
  const paths = transactionPaths(options);
  const fsImpl = options.fsImpl || fs;
  ensureDirs(paths, fsImpl);
  const journal = journalRead(paths);
  if (!journal) return { ok: true, recovered: false };
  if (journal.phase === 'committed') {
    finalizeTransaction(journal.staging, journal.backup, paths, fsImpl);
    return { ok: true, recovered: true, cleanupOnly: true };
  }
  try { rollbackFromJournal(journal, paths, fsImpl); }
  catch (error) { return { ok: false, code: 'TRANSACTION_RECOVERY_REQUIRED', error: error.message }; }
  finalizeTransaction(journal.staging, journal.backup, paths, fsImpl);
  return { ok: true, recovered: true };
}

module.exports = { commitSnapshotChange, commitCatalogChange, replaceToolLevel3, removeCatalogRecords, recoverCatalogTransaction };
