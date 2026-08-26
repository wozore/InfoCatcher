'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isIsoDate, validateReleaseIndexEntries, readReleaseIndex, writeReleaseIndex } = require('../../src/shared/release-index');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-index-test-'));
  return path.join(dir, 'model-release-dates.json');
}

const VALID_ENTRIES = [
  { model_key: 'openai--gpt-5.5', release_date: '2026-04-23', catalog_aliases: ['gpt-5-5', 'GPT-5.5'] },
  { model_key: 'zai--glm-5.3', release_date: '2026-05-30', catalog_aliases: [] },
];

test('release-index：isIsoDate 校验', () => {
  assert.equal(isIsoDate('2026-04-23'), true);
  assert.equal(isIsoDate('2026-04-23x'), false);
  assert.equal(isIsoDate('2026-13-01'), false);
});

test('release-index：validateReleaseIndexEntries 逐条校验', () => {
  assert.equal(validateReleaseIndexEntries(VALID_ENTRIES).length, 0);
  assert.ok(validateReleaseIndexEntries('nope').length, 'entries 必须是数组');
  const bad = validateReleaseIndexEntries([
    { model_key: '', release_date: '2026-04-23', catalog_aliases: [] },
    { model_key: 'x', release_date: 'not-a-date', catalog_aliases: [] },
    { model_key: 'x', release_date: '2026-04-23', catalog_aliases: [1] },
  ]);
  assert.equal(bad.length, 3);
});

test('release-index：writeReleaseIndex 合法落盘 + generated_at，非法 fail-closed 不覆盖', () => {
  const file = tempFile();
  const ok = writeReleaseIndex(VALID_ENTRIES, file);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.schema_version, 1);
  assert.equal(typeof raw.generated_at, 'string');
  assert.equal(raw.entries.length, 2);
  const invalid = writeReleaseIndex([{ model_key: 'x', release_date: 'bad' }], file);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'SHARED_RELEASE_INDEX_INVALID');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.length, 2, '非法不覆盖已落盘内容');
});

test('release-index：readReleaseIndex 缺失/损坏回退空 + 校验冻结', () => {
  const missing = readReleaseIndex(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-index-test-')), 'nope.json'));
  assert.equal(missing.entries.length, 0);
  const corrupt = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-index-test-')), 'x.json');
  fs.writeFileSync(corrupt, 'not json', 'utf8');
  assert.equal(readReleaseIndex(corrupt).entries.length, 0);
  const file = tempFile();
  writeReleaseIndex(VALID_ENTRIES, file);
  const loaded = readReleaseIndex(file);
  assert.equal(loaded.entries.length, 2);
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.entries), true);
});
