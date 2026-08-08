const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_BATCHES,
  compactCandidates,
  formatBatchAt,
  appendMinHistory,
} = require('../../src/news/min/min-history');

test('min-history 只保存 id/title，并按北京时间格式化批次时间', () => {
  const source = [{
    id: 'x-1', title: '标题', description: '不应保存', review_status: 'approved',
    localizations: { zh: { title: '翻译' } }, final_score: 99,
  }, { title: '缺 id，跳过' }];
  assert.deepEqual(compactCandidates(source), [{ id: 'x-1', title: '标题' }]);
  assert.equal(formatBatchAt('2026-08-09T14:00:01.000Z'), '2026-08-09-22:00:01');
});

test('min-history 最多保留最近 30 批', () => {
  let history = { schema_version: 1, batches: [] };
  for (let i = 1; i <= MAX_BATCHES + 1; i += 1) {
    history = appendMinHistory(history, [{ id: `id-${i}`, title: `标题-${i}` }], `2026-08-${String(i).padStart(2, '0')}T00:00:00Z`);
  }
  assert.equal(history.batches.length, MAX_BATCHES);
  assert.equal(history.batches[0].items[0].id, 'id-2');
  assert.equal(history.batches.at(-1).items[0].id, 'id-31');
  assert.deepEqual(Object.keys(history.batches[0].items[0]).sort(), ['id', 'title']);
});

test('min-history 相同批次时间重复追加时保持幂等', () => {
  const once = appendMinHistory(null, [{ id: 'id-1', title: '标题' }], '2026-08-09T00:00:00Z');
  const twice = appendMinHistory(once, [{ id: 'id-2', title: '不应重复批次' }], '2026-08-09T00:00:00Z');
  assert.equal(twice.batches.length, 1);
  assert.equal(twice.batches[0].items[0].id, 'id-2');
});
