/**
 * news-workbench-domain.test.js — 第一期新闻维护者工作台领域 mutation 离线回归。
 *
 * 只使用内存 store 与临时配置文件：验证 revision 防陈旧写、approved/pending 门禁、
 * top set/unset 不发布，以及关键词清单仅更新 config.keywords.ai_keywords。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  revisionOfMinStore,
  commitMinStoreMutation,
  reviewPendingCandidates,
  setApprovedTopSelectedMin,
} = require('../src/news/min/min-store');
const {
  revisionOfConfig,
  applyKeywordActions,
  commitKeywordActions,
} = require('../src/news/min/keyword-actions');

function storeFixture() {
  return {
    schema_version: 1,
    updated_at: null,
    candidates: [
      { id: 'pending-1', review_status: 'pending', top_selected: false },
      { id: 'approved-1', review_status: 'approved', top_selected: false },
      { id: 'discarded-1', review_status: 'discarded', top_selected: true },
    ],
  };
}

const KEYWORD_LIST = {
  kind: 'keyword_refine_candidates',
  candidates: [
    { word: 'DeepSeek', category: 'tool', candidate_type: 'repeated', count: 4 },
    { word: 'multimodal', category: 'concept', candidate_type: 'emerging', count: 2 },
  ],
  adopted_keywords: ['DeepSeek', 'DeepSeek'],
};

test('reviewPendingCandidates：只把明确 pending id 转为 approved/discarded', () => {
  const source = storeFixture();
  const revision = revisionOfMinStore(source);
  const result = reviewPendingCandidates(source, ['pending-1', 'approved-1', 'missing'], 'approved', {
    expectedRevision: revision,
    now: '2026-08-30T00:00:00.000Z',
  });

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missing, ['missing']);
  assert.deepEqual(result.not_pending, ['approved-1']);
  assert.equal(result.store.candidates[0].review_status, 'approved');
  assert.equal(result.store.candidates[1].review_status, 'approved');
  assert.equal(result.store.candidates[2].review_status, 'discarded');
  assert.equal(source.candidates[0].review_status, 'pending', '纯 mutation 不修改输入');
  assert.throws(
    () => reviewPendingCandidates(source, ['pending-1'], 'pending', { expectedRevision: revision }),
    /只允许 pending/,
  );
});

test('commitMinStoreMutation：expected revision 冲突时不调用写者', () => {
  const source = storeFixture();
  let writes = 0;
  const result = commitMinStoreMutation(
    current => reviewPendingCandidates(current, ['pending-1'], 'discarded', {
      expectedRevision: revisionOfMinStore(current),
      now: '2026-08-30T00:00:00.000Z',
    }),
    {
      store: source,
      expectedRevision: revisionOfMinStore(source),
      now: '2026-08-30T00:00:00.000Z',
      writeStore(next, runId, options) {
        writes += 1;
        assert.equal(options.expectedRevision, revisionOfMinStore(source));
        assert.equal(runId, 'workbench-test');
        assert.equal(next.candidates[0].review_status, 'discarded');
      },
      runId: 'workbench-test',
    },
  );
  assert.equal(result.changed, true);
  assert.equal(writes, 1);

  assert.throws(
    () => commitMinStoreMutation(
      current => reviewPendingCandidates(current, ['pending-1'], 'approved'),
      { store: source, expectedRevision: 'stale-revision', writeStore: () => { writes += 1; } },
    ),
    error => error.code === 'REVISION_CONFLICT',
  );
  assert.equal(writes, 1, '陈旧 revision 不得写入');
});

test('setApprovedTopSelectedMin：仅 approved 候选可显式 set/unset，且不触碰公开投影', () => {
  const source = storeFixture();
  const revision = revisionOfMinStore(source);
  const setResult = setApprovedTopSelectedMin(source, ['approved-1', 'pending-1', 'discarded-1', 'ghost'], true, {
    expectedRevision: revision,
  });
  assert.equal(setResult.updated, 1);
  assert.deepEqual(setResult.not_approved, ['pending-1', 'discarded-1']);
  assert.deepEqual(setResult.missing, ['ghost']);
  assert.equal(setResult.store.candidates.find(item => item.id === 'approved-1').top_selected, true);
  assert.equal(setResult.store.candidates.find(item => item.id === 'pending-1').top_selected, false);
  assert.equal(setResult.store.candidates.find(item => item.id === 'discarded-1').top_selected, true);
  assert.equal(setResult.store.public_items, undefined, 'mutation 只返回候选层，不生成发布投影');

  const unsetResult = setApprovedTopSelectedMin(setResult.store, ['approved-1'], false, {
    expectedRevision: revisionOfMinStore(setResult.store),
  });
  assert.equal(unsetResult.store.candidates.find(item => item.id === 'approved-1').top_selected, false);
  assert.throws(
    () => setApprovedTopSelectedMin(source, ['approved-1'], 'false', { expectedRevision: revision }),
    /boolean/,
  );
});

test('applyKeywordActions：只能从固定清单采纳子集，并只改变 ai_keywords', () => {
  const config = {
    schema_version: 1,
    collection: { enabled: true },
    keywords: { ai_keywords: ['Claude'], other: 'preserve' },
    manual_folder: 'keep-me',
  };
  const result = applyKeywordActions(config, KEYWORD_LIST, { expectedRevision: revisionOfConfig(config) });
  assert.deepEqual(result.config.keywords.ai_keywords, ['Claude', 'DeepSeek']);
  assert.equal(result.config.keywords.other, 'preserve');
  assert.equal(result.config.collection.enabled, true);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(config.keywords.ai_keywords, ['Claude'], '纯 mutation 不修改输入配置');

  assert.throws(
    () => applyKeywordActions(config, { ...KEYWORD_LIST, adopted_keywords: ['outside'] }, {
      expectedRevision: revisionOfConfig(config),
    }),
    /不在 candidates/,
  );
  assert.throws(
    () => applyKeywordActions(config, KEYWORD_LIST, { expectedRevision: 'stale-revision' }),
    error => error.code === 'REVISION_CONFLICT',
  );
});

test('commitKeywordActions：expected revision 通过后原子写配置，空变更不写', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-workbench-keywords-'));
  const configPath = path.join(dir, 'news-config-v2.json');
  const config = { keywords: { ai_keywords: [] }, collection: { enabled: false } };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  try {
    const result = commitKeywordActions(KEYWORD_LIST, {
      configPath,
      expectedRevision: revisionOfConfig(config),
      runId: 'workbench-keyword-test',
    });
    assert.equal(result.written, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), {
      keywords: { ai_keywords: ['DeepSeek'] },
      collection: { enabled: false },
    });

    let writes = 0;
    const second = commitKeywordActions(KEYWORD_LIST, {
      configPath,
      expectedRevision: revisionOfConfig(JSON.parse(fs.readFileSync(configPath, 'utf8'))),
      writeConfig: () => { writes += 1; },
    });
    assert.equal(second.written, false);
    assert.equal(writes, 0, '幂等关键词应用不写配置');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
