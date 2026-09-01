'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  revisionOfConfig,
  applyKeywordExclusions,
  commitKeywordExclusions,
  applyRefineKeywords,
} = require('../../src/news/min/keyword-actions');

function tmpConfig(overrides = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kw-actions-')), 'config.json');
  fs.writeFileSync(file, JSON.stringify({ keywords: { ai_keywords: [], excluded_keywords: [], ...(overrides.keywords || {}) }, ...(overrides.rest || {}) }));
  return file;
}

test('applyKeywordExclusions 幂等追加丢弃词并大小写不敏感去重', () => {
  const config = { keywords: { ai_keywords: ['ai'], excluded_keywords: ['gpt'] } };
  const revision = revisionOfConfig(config);
  const result = applyKeywordExclusions(config, ['google', 'GOOGLE', 'yolo'], { expectedRevision: revision });
  assert.equal(result.added.length, 2);
  assert.deepEqual(result.config.keywords.excluded_keywords, ['gpt', 'google', 'yolo']);
  assert.equal(result.changed, true);
  // 已存在的丢弃词不再重复
  const second = applyKeywordExclusions(result.config, ['google'], { expectedRevision: result.revision });
  assert.equal(second.added.length, 0);
  assert.equal(second.changed, false);
});

test('applyKeywordExclusions 校验 expected revision 与非空字符串', () => {
  const config = { keywords: {} };
  assert.throws(() => applyKeywordExclusions(config, ['x'], {}), /expected revision/);
  assert.throws(() => applyKeywordExclusions(config, [123], { expectedRevision: revisionOfConfig(config) }), /非空字符串/);
  assert.throws(() => applyKeywordExclusions(config, [''], { expectedRevision: revisionOfConfig(config) }), /非空字符串/);
});

test('commitKeywordExclusions 带 revision 门禁原子写回且无变化不写', () => {
  const file = tmpConfig();
  const revision = revisionOfConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  const written = commitKeywordExclusions(['google'], { configPath: file, expectedRevision: revision, runId: 'test-kw-exclude' });
  assert.equal(written.written, true);
  assert.equal(written.added.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).keywords.excluded_keywords, ['google']);
  // 重复丢弃：无新增，不写盘
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  const noop = commitKeywordExclusions(['google'], { configPath: file, expectedRevision: revisionOfConfig(current) });
  assert.equal(noop.written, false);
  // 陈旧 revision 拒绝写
  assert.throws(() => commitKeywordExclusions(['yolo'], { configPath: file, expectedRevision: 'stale' }), /revision 冲突/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('refine 采纳只进 ai_keywords，丢弃词独立不混入采集关键词', () => {
  const config = { keywords: { ai_keywords: ['ai'], excluded_keywords: ['google'] } };
  const list = {
    kind: 'keyword_refine_candidates',
    candidates: [
      { word: 'google', category: 'tool', candidate_type: 'repeated', count: 5 },
      { word: 'yolo', category: 'tool', candidate_type: 'repeated', count: 4 },
    ],
    adopted_keywords: ['yolo'],
  };
  const result = applyRefineKeywords(config, list);
  assert.deepEqual(result.config.keywords.ai_keywords, ['ai', 'yolo']);
  assert.deepEqual(result.config.keywords.excluded_keywords, ['google']);
});
