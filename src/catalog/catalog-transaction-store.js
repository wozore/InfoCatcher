'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS, CATALOG_GENERATOR_FILES } = require('../shared/paths');
const { readJson, writeJsonAtomic, acquireLock, releaseLock } = require('../news/core/news-storage');
const { validateCatalogSnapshot } = require('./catalog-snapshot-validator');
const { revisionOf } = require('./catalog-revision');
const { loadCatalogSnapshot, FILE_BY_AREA } = require('./catalog-snapshot-store');
const { planCatalogPatches } = require('./catalog-change-planner');
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

/**
 * 用 sourceDir 原子替换 targetDir（Windows 安全）。
 * 旧做法先删除 targetDir 再 rename，Windows 上 rename 覆盖非空目录会 EPERM，
 * 且删除失败被静默吞掉 → 目标目录可能被删而新目录未就位（曾导致 dist 丢失）。
 * 现改为「旧目录改名腾位 → 新目录就位 → 删除旧目录」：
 *   - target 在改名成功前始终存在（被占用时 rename 失败，target 保持原样，错误清晰）；
 *   - 新目录就位失败时把旧目录改回，不丢数据。
 */
function replaceDirectory(sourceDir, targetDir) {
  const temp = `${targetDir}.txn.${process.pid}`;
  removeIfExists(temp);
  fs.cpSync(sourceDir, temp, { recursive: true });
  if (!fs.existsSync(targetDir)) {
    fs.renameSync(temp, targetDir);
    return;
  }
  const old = `${targetDir}.old.${process.pid}`;
  removeIfExists(old);
  try {
    fs.renameSync(targetDir, old);
  } catch (error) {
    // Windows：目标目录被占用（IDE/杀软监视持有目录句柄）时 rename 整目录会 EPERM，
    // 但删除文件/重建可行（build-dist 同法）。回退删除重建；事务有 backup_dist 兜底回滚。
    removeIfExists(targetDir);
    fs.cpSync(temp, targetDir, { recursive: true });
    removeIfExists(temp);
    return;
  }
  try {
    fs.renameSync(temp, targetDir);
  } catch (error) {
    try { fs.renameSync(old, targetDir); } catch {}
    removeIfExists(temp);
    throw error;
  }
  removeIfExists(old);
}

function replaceCatalogFiles(sourceDir) {
  for (const file of Object.values(FILE_BY_AREA)) {
    const staged = path.join(sourceDir, path.basename(file));
    const temp = `${file}.txn.${process.pid}`;
    fs.copyFileSync(staged, temp);
    fs.renameSync(temp, file);
  }
}

function backupDistDirectory(target) {
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

function planRecordRemoval(snapshot, normalized) {
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

function commitSnapshotChange(target, options = {}) {
  ensureDirs();
  const runId = options.runId || `catalog-${options.operation || 'snapshot'}-${process.pid}-${Date.now()}`;
  const lockPath = CATALOG_GENERATOR_FILES.lock;
  const staging = path.join(CATALOG_GENERATOR_FILES.stagingDir, runId);
  const stagingCatalog = path.join(staging, 'catalog');
  const backup = path.join(CATALOG_GENERATOR_FILES.backupDir, runId);
  const backupCatalog = path.join(backup, 'catalog');
  const stagedDist = path.join(staging, 'dist');
  const backupDist = path.join(backup, 'dist');
  let lockHeld = false;
  try {
    acquireLock(lockPath, { run_id: runId, pid: process.pid, operation: options.operation || 'snapshot', at: new Date().toISOString() });
    lockHeld = true;
    const before = loadCatalogSnapshot();
    if (options.expectedRevision && before.revision !== options.expectedRevision) return { ok: false, code: 'REVISION_CONFLICT', revision: before.revision };
    const validation = validateCatalogSnapshot(target);
    if (!validation.ok) return { ok: false, code: 'SNAPSHOT_INVALID', errors: validation.errors };
    const targetRevision = revisionOf(target);
    const journal = {
      schema_version: 1, run_id: runId, phase: 'staging', before_revision: before.revision,
      target_revision: targetRevision, staging, backup, backup_catalog: backupCatalog,
      staged_dist: stagedDist, backup_dist: backupDist, replaced: [], dist_replaced: false, at: new Date().toISOString(),
    };
    journalWrite(journal, runId);
    writeSnapshotFiles(target, stagingCatalog);
    buildDist({ catalogDir: stagingCatalog, outputDir: stagedDist });
    journal.phase = 'dist_staged';
    journalWrite(journal, runId);
    copyCatalogFiles(backupCatalog);
    backupDistDirectory(backupDist);
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
    return { ok: true, beforeRevision: before.revision, targetRevision };
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

function removeCatalogRecords(targets, options = {}) {
  let normalized;
  try { normalized = normalizeRemovalTargets(targets); }
  catch (error) { return { ok: false, code: error.message.split(':')[0], error: error.message }; }
  const current = loadCatalogSnapshot();
  if (!options.expectedRevision) return { ok: false, code: 'REMOVE_EXPECTED_REVISION_REQUIRED' };
  if (options.expectedRevision !== current.revision) return { ok: false, code: 'REVISION_CONFLICT', revision: current.revision };
  const planned = planRecordRemoval(current.snapshot, normalized);
  if (!planned.ok) return planned;
  const result = commitSnapshotChange(planned.snapshot, { ...options, operation: 'remove-catalog-records' });
  return result.ok ? { ...result, removed: normalized } : result;
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
    if (!Array.isArray(options.layerPatches)) return { ok: false, code: 'LAYER_PATCHES_REQUIRED', error: 'schema v3 Apply 必须提供 layerPatches' };
    const plan = planCatalogPatches(before.snapshot, options.layerPatches);
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
    backupDistDirectory(backupDist);
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
    backupDistDirectory(backupDist);
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

module.exports = { loadCatalogSnapshot, commitCatalogChange, replaceToolLevel3, removeCatalogRecords, planRecordRemoval, recoverCatalogTransaction, FILE_BY_AREA };
