/**
 * check-secrets.test.js — scripts/check-secrets.js 密钥扫描守卫测试（4 项）
 *
 * 测试原理：
 *   check-secrets 是防「密钥明文进版本库」的守卫（validate.js 原则6 + CI 步骤）。
 *   这些测试验证：模式自检通过、高熵形态被命中而低熵短占位不会、
 *   扫描器能命中仓库内未跟踪文件中的合成密钥、清理后仓库零命中。
 *
 * 注意：所有合成密钥均用 'sk-' + 'A'.repeat(n) 拼接构造，源码中不含
 * 完整的高熵字符串，避免扫描器误命中测试文件自身（自证无污染）。
 *
 * 运行方式：node --test tests/maintenance/check-secrets.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { scanRepo, selftest, PATTERNS } = require('../../scripts/check-secrets');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');

test('内置自检 selftest 全部通过', () => {
  assert.equal(selftest(), true);
});

test('合成高熵 key 被命中，低熵短占位不被命中', () => {
  const positive = 'sk-' + 'A'.repeat(32); // 形态同 DeepSeek/OpenAI key
  const negative = 'sk-abc 短占位，非 key，无高熵段';
  let posHit = false;
  let negHit = false;
  for (const p of PATTERNS) {
    p.regex.lastIndex = 0;
    if (p.regex.test(positive)) posHit = true;
    p.regex.lastIndex = 0;
    if (p.regex.test(negative)) negHit = true;
  }
  assert.equal(posHit, true, '合成 sk-key 应命中至少一个模式');
  assert.equal(negHit, false, '低熵短占位不应命中任何模式');
});

test('scanRepo 命中未跟踪文件中的合成密钥并带定位信息', (t) => {
  const probe = path.join(PROJECT_DIR, '_tmp_secret_probe.test.txt');
  const secret = 'sk-' + 'C'.repeat(32);
  fs.writeFileSync(probe, ['probe', `token = "${secret}"`, 'tail'].join('\n'));
  t.after(() => fs.rmSync(probe, { force: true }));

  const hits = scanRepo().filter(f => path.basename(f.file) === path.basename(probe));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.match(hits[0].pattern, /sk-/);
  assert.ok(hits[0].preview && hits[0].preview.length > 0, '应含脱敏预览');
});

test('无探测残留时仓库扫描零命中（validate.js 原则6 同保证）', () => {
  // 依赖上一条 t.after 已完成清理；若仓库未来出现真实密钥形态，
  // 本测试与 validate.js 原则6 会同时拦截——这正是守卫的用途。
  assert.deepEqual(scanRepo(), []);
});
