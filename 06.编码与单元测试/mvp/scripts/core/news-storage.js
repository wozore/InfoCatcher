/**
 * news-storage.js — JSON 原子写入与构建并发锁
 *
 * 在热点管线中的位置：最底层基础设施，被 build-news.js（构建编排）、
 * news-cli.js（运维入口）和 foundation 测试直接依赖。
 *
 * 职责：
 *   1. 安全的 JSON 读写：文件不存在时返回 fallback，其他错误仍然抛出。
 *   2. 原子替换：先写唯一临时文件 → fsync → 同盘 rename，
 *      确保目标文件要么是旧完整版本、要么是新完整版本，不会出现半写状态。
 *   3. 构建锁：通过 fs.openSync(path, 'wx') 实现排他创建，
 *      同一时间只允许一个热点构建任务运行。
 *   4. 强制解锁审计：forceUnlock 必须提供 reason，操作写入审计 JSON。
 *
 * 为什么不用数据库事务：
 *   当前规模（数万条视频记录、单文件数 MB）用 JSON + 原子替换足够；
 *   文件过大时再迁移为固定分片或 SQLite。环 C 之前不引入数据库依赖。
 *
 * 使用示例：
 *   const { readJson, writeJsonAtomic, acquireLock, releaseLock } = require('./news-storage');
 *   const data = readJson('state.json', { schema_version: 1, items: [] });
 *   acquireLock('.lock', { run_id: 'r1', pid: process.pid });
 *   writeJsonAtomic('state.json', data, 'r1');
 *   releaseLock('.lock', 'r1');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 读取并解析 JSON 文件。
 * @param {string} file 文件路径
 * @param {*} [fallback] 仅在文件不存在(ENOENT)时返回的默认值；
 *   不传 fallback 时，ENOENT 同样会抛出，避免静默吞掉缺失的必需文件。
 * @returns {*} 解析后的 JSON 值
 */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (arguments.length >= 2 && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

/**
 * 原子写入 JSON 文件。
 * 流程：打开独占临时文件(wx) → 写入 + fsync → rename 替换目标。
 * 临时文件名包含 runId、PID 和随机 hex，避免多进程/多任务冲突。
 * rename 失败时删除自身临时文件，保留原有目标文件不变。
 *
 * @param {string} file 目标文件路径
 * @param {*} value 要序列化的值
 * @param {string} [runId='manual'] 调用者标识，出现在临时文件名中用于排查
 */
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

/**
 * 获取构建锁（排他创建）。
 * 如果锁文件已存在（EEXIST），说明另一个构建任务仍在运行，
 * 调用方应捕获错误并以 build_locked 退出，不要自动删除锁。
 *
 * @param {string} lockPath 锁文件路径
 * @param {object} metadata 存入锁文件的信息（至少包含 run_id）
 * @returns {object} 写入的 metadata
 */
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

/**
 * 释放构建锁。
 * 校验锁的所有权：如果 runId 不匹配，拒绝释放并抛出，
 * 防止误删另一个正在运行的构建任务的锁。
 *
 * @param {string} lockPath 锁文件路径
 * @param {string} runId 当前构建的 run_id
 * @returns {boolean} 是否成功释放
 */
function releaseLock(lockPath, runId) {
  const current = readJson(lockPath, null);
  if (!current) return false;
  if (runId && current.run_id !== runId) throw new Error('锁属于另一个构建任务');
  fs.unlinkSync(lockPath);
  return true;
}

/**
 * 查看锁的状态，不修改任何文件。
 * @returns {{ status: 'locked'|'unlocked', lock: object|null }}
 */
function inspectLock(lockPath) {
  const lock = readJson(lockPath, null);
  if (!lock) return { status: 'unlocked', lock: null };
  return { status: 'locked', lock };
}

/**
 * 强制解锁（运维操作，需要明确 reason）。
 * 删除锁文件后，将原锁信息和 reason 写入 auditPath 审计日志。
 * 不自动判断锁是否"过期"——由操作者通过 news-cli.js lock status 判断后执行。
 *
 * @param {string} lockPath 锁文件路径
 * @param {string} reason 强制解锁原因（必填）
 * @param {string} auditPath 审计 JSON 路径
 * @returns {boolean} 是否确实删除了锁
 */
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
