'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(file);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [file] : [];
  });
}

test('跨平台全量测试入口', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...testFiles(__dirname)], {
    cwd: path.resolve(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
  assert.equal(result.status, 0, `全量测试退出码：${result.status}`);
});
