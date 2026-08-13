'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS, CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson, writeJsonAtomic, acquireLock, releaseLock } = require('../news/core/news-storage');
const { validateCatalogSnapshot } = require('./catalog-snapshot-validator');
const { revisionOf } = require('./catalog-revision');
const { loadCatalogSnapshot, FILE_BY_AREA } = require('./catalog-snapshot-store');
const { planCatalogChange } = require('./catalog-change-planner');
const { buildDist } = require('../../scripts/build-dist');

function ensureDirs() {
  fs.mkdirSync(CATALOG_GENERATOR_FILES.transactionDir, { recursive: true });
  fs.mkdirSync(CATALOG_GENERATOR_FILES.stagingDir, { recursive: true });
  fs.mkdirSync(CATALOG_GENERATOR_FILES.backupDir, { recursive: true });
}

function journalRead() {
  return readJson(CATALOG_GENERATOR_FILES.journal, null);
}

function journalWrite(value, runId) {
  writeJsonAtomic(CATALOG_GENERATOR_FILES.journal, value, runId);
}

function removeIfExists(file) {
  try { fs.rmSync(file, { recursive: true, force: true }); } catch {}
}

function writeSnapshotFiles(snapshot, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [area, file] of Object.entries(FILE_BY_AREA)) {
    const target = path.join(dir, path.basename(file));
    fs.writeFileSync(target, `${JSON.stringify({ schema_version: 1, items: snapshot[area] }, null, 2)}\n`, 'utf8');
  }
  for (const file of ['glossary.json', 'scenes.json', 'featured.json']) {
    const source = path.join(DIRS.catalog, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(dir, file));
  }
}

function copyCatalogFiles(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of Object.values(FILE_BY_AREA)) fs.copyFileSync(file, path.join(targetDir, path.basename(file)));
}

function replaceDirectory(sourceDir, targetDir) {
  const temp = `${targetDir}.txn.${process.pid}`;
  removeIfExists(temp);
  fs.cpSync(sourceDir, temp, { recursive: true });
  removeIfExists(targetDir);
  fs.renameSync(temp, targetDir);
}

function replaceCatalogFiles(sourceDir) {
  for (const file of Object.values(FILE_BY_AREA)) {
    const staged = path.join(sourceDir, path.basename(file));
    const temp = `${file}.txn.${process.pid}`;
    fs.copyFileSync(staged, temp);
    fs.renameSync(temp, file);
  }
}

function backupDist(target) {
  const dist = path.join(DIRS.project, 'dist');
  if (fs.existsSync(dist)) fs.cpSync(dist, target, { recursive: true });
}

function rollbackFromJournal(journal) {
  if (journal?.replaced?.length && journal.backup_catalog) replaceCatalogFiles(journal.backup_catalog);
  if ((journal?.dist_replacement_started || journal?.dist_replaced) && journal.backup_dist && fs.existsSync(journal.backup_dist)) {
    replaceDirectory(journal.backup_dist, path.join(DIRS.project, 'dist'));
  }
}

function finalizeTransaction(staging, backup) {
  removeIfExists(staging);
  removeIfExists(backup);
  removeIfExists(CATALOG_GENERATOR_FILES.journal);
}

function commitCatalogChange(seed, options = {}) {
  ensureDirs();
  const runId = options.runId || `catalog-${process.pid}-${Date.now()}`;
  const draftId = options.draftId || null;
  const lockPath = CATALOG_GENERATOR_FILES.lock;
  const staging = path.join(CATALOG_GENERATOR_FILES.stagingDir, runId);
  const stagingCatalog = path.join(staging, 'catalog');
  const backup = path.join(CATALOG_GENERATOR_FILES.backupDir, runId);
  const backupCatalog = path.join(backup, 'catalog');
  const stagedDist = path.join(staging, 'dist');
  const backupDist = path.join(backup, 'dist');
  let lockHeld = false;
  try {
    acquireLock(lockPath, { run_id: runId, pid: process.pid, draft_id: draftId, at: new Date().toISOString() });
    lockHeld = true;
    const before = loadCatalogSnapshot();
    if (options.expectedRevision && before.revision !== options.expectedRevision) {
      return { ok: false, code: 'REVISION_CONFLICT', revision: before.revision };
    }
    const plan = planCatalogChange(before.snapshot, seed, options.catalogDraft || {});
    const targetRevision = revisionOf(plan.snapshot);
    const journal = {
      schema_version: 1,
      run_id: runId,
      draft_id: draftId,
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
    journalWrite(journal, runId);
    writeSnapshotFiles(plan.snapshot, stagingCatalog);
    const stagedValidation = validateCatalogSnapshot(plan.snapshot);
    if (!stagedValidation.ok) throw new Error(`SNAPSHOT_INVALID:${stagedValidation.errors[0].message}`);
    buildDist({ catalogDir: stagingCatalog, outputDir: stagedDist });
    journal.phase = 'dist_staged';
    journalWrite(journal, runId);
    copyCatalogFiles(backupCatalog);
    backupDist(backupDist);
    journal.phase = 'committing';
    journal.replaced = Object.keys(FILE_BY_AREA);
    journalWrite(journal, runId);
    replaceCatalogFiles(stagingCatalog);
    journal.phase = 'catalog_validated';
    journalWrite(journal, runId);
    const after = loadCatalogSnapshot();
    if (after.revision !== targetRevision) throw new Error('TARGET_REVISION_MISMATCH');
    journal.dist_replacement_started = true;
    journalWrite(journal, runId);
    replaceDirectory(stagedDist, path.join(DIRS.project, 'dist'));
    journal.dist_replaced = true;
    journal.phase = 'dist_verified';
    journalWrite(journal, runId);
    journal.phase = 'committed';
    journalWrite(journal, runId);
    finalizeTransaction(staging, backup);
    return { ok: true, plan, beforeRevision: before.revision, targetRevision };
  } catch (error) {
    const journal = journalRead();
    try { if (journal?.run_id === runId) rollbackFromJournal(journal); }
    catch (rollbackError) {
      return { ok: false, code: 'ROLLBACK_FAILED', error: rollbackError.message, originalError: error.message };
    } finally {
      finalizeTransaction(staging, backup);
    }
    return { ok: false, code: error.code || 'BUILD_FAILED', error: error.message };
  } finally {
    if (lockHeld) releaseLock(lockPath, runId);
  }
}

function replaceToolLevel3(items, options = {}) {
  if (!Array.isArray(items)) return { ok: false, code: 'INVALID_WRITE', error: 'tool-level3 items 必须是数组' };
  ensureDirs();
  const runId = options.runId || `catalog-replace-${process.pid}-${Date.now()}`;
  const lockPath = CATALOG_GENERATOR_FILES.lock;
  const staging = path.join(CATALOG_GENERATOR_FILES.stagingDir, runId);
  const stagingCatalog = path.join(staging, 'catalog');
  const backup = path.join(CATALOG_GENERATOR_FILES.backupDir, runId);
  const backupCatalog = path.join(backup, 'catalog');
  const stagedDist = path.join(staging, 'dist');
  const backupDist = path.join(backup, 'dist');
  let lockHeld = false;
  try {
    acquireLock(lockPath, { run_id: runId, pid: process.pid, operation: 'replace-tool-level3', at: new Date().toISOString() });
    lockHeld = true;
    const before = loadCatalogSnapshot();
    const target = { ...before.snapshot, 'tool-level3': items };
    const validation = validateCatalogSnapshot(target);
    if (!validation.ok) return { ok: false, code: 'SNAPSHOT_INVALID', errors: validation.errors };
    const journal = {
      schema_version: 1, run_id: runId, phase: 'staging', before_revision: before.revision,
      target_revision: revisionOf(target), staging, backup, backup_catalog: backupCatalog,
      staged_dist: stagedDist,
      backup_dist: backupDist, replaced: [], dist_replaced: false, at: new Date().toISOString(),
    };
    journalWrite(journal, runId);
    writeSnapshotFiles(target, stagingCatalog);
    buildDist({ catalogDir: stagingCatalog, outputDir: stagedDist });
    journal.phase = 'dist_staged';
    journalWrite(journal, runId);
    copyCatalogFiles(backupCatalog);
    backupDist(backupDist);
    journal.phase = 'committing';
    journal.replaced = Object.keys(FILE_BY_AREA);
    journalWrite(journal, runId);
    replaceCatalogFiles(stagingCatalog);
    journal.phase = 'catalog_validated';
    journalWrite(journal, runId);
    journal.dist_replacement_started = true;
    journalWrite(journal, runId);
    replaceDirectory(stagedDist, path.join(DIRS.project, 'dist'));
    journal.dist_replaced = true;
    journal.phase = 'committed';
    journalWrite(journal, runId);
    finalizeTransaction(staging, backup);
    return { ok: true, revision: journal.target_revision };
  } catch (error) {
    const journal = journalRead();
    try { if (journal?.run_id === runId) rollbackFromJournal(journal); }
    catch (rollbackError) {
      return { ok: false, code: 'ROLLBACK_FAILED', error: rollbackError.message, originalError: error.message };
    } finally {
      finalizeTransaction(staging, backup);
    }
    return { ok: false, code: error.code || 'BUILD_FAILED', error: error.message };
  } finally {
    if (lockHeld) releaseLock(lockPath, runId);
  }
}

function recoverCatalogTransaction() {
  ensureDirs();
  const journal = journalRead();
  if (!journal) return { ok: true, recovered: false };
  if (journal.phase === 'committed') {
    finalizeTransaction(journal.staging, journal.backup);
    return { ok: true, recovered: true, cleanupOnly: true };
  }
  try { rollbackFromJournal(journal); }
  catch (error) { return { ok: false, code: 'TRANSACTION_RECOVERY_REQUIRED', error: error.message }; }
  finalizeTransaction(journal.staging, journal.backup);
  return { ok: true, recovered: true };
}

module.exports = { loadCatalogSnapshot, commitCatalogChange, replaceToolLevel3, recoverCatalogTransaction, FILE_BY_AREA };
