/**
 * env.test.js — src/shared/env.js loadDotEnv 单元测试（5 项）
 *
 * 测试原理：
 *   loadDotEnv 是零依赖 .env 加载器，是本项目「密钥只经环境变量注入」约定
 *   的落地一环（.env 已 gitignore，build-news/news-cli 入口启动时加载）。
 *   这些测试验证解析语义，确保本地 .env 行为与预期一致：
 *   成对引号剥离、export 前缀、注释/空行/无等号行跳过、
 *   不覆盖已有环境变量（CI 中 GitHub Secrets 优先级高于 .env）、缺文件静默返回 0。
 *
 * 运行方式：node --test tests/maintenance/env.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadDotEnv } = require('../../src/shared/env');

/** 在系统临时目录写一个 .env 测试文件，返回其路径 */
function makeEnvFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  fs.writeFileSync(path.join(dir, '.env'), content);
  return path.join(dir, '.env');
}

/** 清空指定 key 的既有值，测试结束后恢复，保证用例确定性 */
function withCleanEnv(t, keys) {
  const prev = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  t.after(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

test('成对引号剥离 + export 前缀 + 返回加载计数', (t) => {
  withCleanEnv(t, ['DEEPSEEK_API_KEY', 'MY_FLAG']);
  const file = makeEnvFile(['DEEPSEEK_API_KEY="sk-demo"', 'export MY_FLAG=true'].join('\n'));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  assert.equal(loadDotEnv(file), 2);
  assert.equal(process.env.DEEPSEEK_API_KEY, 'sk-demo');
  assert.equal(process.env.MY_FLAG, 'true');
});

test('注释/空行/无等号/空 key 行跳过，不产生环境变量', (t) => {
  withCleanEnv(t, ['NOISE']);
  const file = makeEnvFile(['# 注释', '', '   # 缩进注释', 'NO_EQUALS_LINE', 'export   ', '=leading-empty-key'].join('\n'));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  assert.equal(loadDotEnv(file), 0);
  assert.equal(process.env.NOISE, undefined);
});

test('不覆盖已有环境变量（CI Secrets 优先级高于 .env）', (t) => {
  withCleanEnv(t, ['ALREADY_SET', 'FRESH']);
  process.env.ALREADY_SET = 'keep-me';
  const file = makeEnvFile(['ALREADY_SET=from-env-file', 'FRESH=ok'].join('\n'));
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));

  assert.equal(loadDotEnv(file), 1); // 只 FRESH 写入，ALREADY_SET 被跳过
  assert.equal(process.env.ALREADY_SET, 'keep-me');
  assert.equal(process.env.FRESH, 'ok');
});

test('缺文件静默返回 0，不报错（CI 无 .env 是常态）', () => {
  const missing = path.join(os.tmpdir(), 'env-test-no-such', '.env');
  assert.equal(loadDotEnv(missing), 0);
});

test('空文件返回 0', (t) => {
  const file = makeEnvFile('');
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  assert.equal(loadDotEnv(file), 0);
});
