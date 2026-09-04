'use strict';

/**
 * compare-store.js — 模型对比数据管线 raw 快照读写（CommonJS）
 *
 * raw/ 为 4 源原样快照（管线写、前端不读）；校验失败时保留旧快照（调用方决定）。
 * 原子写：先写临时文件再 rename，避免半截文件。
 */

const fs = require('fs');
const path = require('path');
const { COMPARISON_FILES } = require('../../shared/paths');

const RAW_KEY_MAP = { openrouter: 'rawOpenRouter', lmarena: 'rawLmarena', livebench: 'rawLivebench', llm_stats: 'rawLlmStats' };

function rawKeyOf(key) {
  return RAW_KEY_MAP[key];
}

/** 读取 raw 快照；文件不存在返回 null；解析失败抛错（调用方 WARN 隔离）。 */
function readRawSnapshot(key) {
  const file = COMPARISON_FILES[rawKeyOf(key)];
  if (!file) throw new Error(`未知 raw 源: ${key}`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 原子写 JSON 文件（临时文件 + rename）。 */
function writeJsonAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 写 raw 快照（统一包 fetched_at + 数据本体）。 */
function writeRawSnapshot(key, data, fetchedAt = new Date().toISOString()) {
  const file = COMPARISON_FILES[rawKeyOf(key)];
  if (!file) throw new Error(`未知 raw 源: ${key}`);
  writeJsonAtomic(file, { fetched_at: fetchedAt, ...data });
  return file;
}

module.exports = { readRawSnapshot, writeRawSnapshot, writeJsonAtomic };
