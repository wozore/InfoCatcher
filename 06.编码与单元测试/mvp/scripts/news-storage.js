'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (arguments.length >= 2 && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJsonAtomic(file, value, runId = 'manual') {
  const suffix = `${runId}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  const temp = `${file}.tmp.${suffix}`;
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}

function acquireLock(lockPath, metadata) {
  const fd = fs.openSync(lockPath, 'wx');
  try {
    fs.writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return metadata;
}

function releaseLock(lockPath, runId) {
  const current = readJson(lockPath, null);
  if (!current) return false;
  if (runId && current.run_id !== runId) throw new Error('锁属于另一个构建任务');
  fs.unlinkSync(lockPath);
  return true;
}

function inspectLock(lockPath) {
  const lock = readJson(lockPath, null);
  if (!lock) return { status: 'unlocked', lock: null };
  return { status: 'locked', lock };
}

function forceUnlock(lockPath, reason, auditPath) {
  if (!reason) throw new Error('force-unlock 必须提供 reason');
  const current = readJson(lockPath, null);
  if (!current) return false;
  fs.unlinkSync(lockPath);
  const audit = readJson(auditPath, { schema_version: 1, events: [] });
  audit.events.push({ action: 'force_unlock', reason, previous_lock: current, at: new Date().toISOString() });
  writeJsonAtomic(auditPath, audit, 'force-unlock');
  return true;
}

module.exports = { readJson, writeJsonAtomic, acquireLock, releaseLock, inspectLock, forceUnlock };
