/**
 * concept-batch.test.js — 概念批量生成编排层回归测试
 *
 * 测试原理（仿 catalog-batch.test.js）：
 *   - 不写真实 glossary.json / 预览文件；全部用临时目录 + 注入。
 *   - min-store 用 options.store 注入；DeepSeek 合成用 options.synthesize 注入
 *     （替换真实网络）；vibe-hub 抓取用 fetchImpl + 无操作缓存注入。
 *   - dry-run / 成本门禁 / 合成失败隔离 / apply 合并保序 覆盖纯逻辑。
 *
 * 运行方式：node --test tests/catalog/concept-batch.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readPendingConcepts,
  dedupeConceptCandidates,
  collectConceptEvidence,
  planConceptCost,
  revisionOfGlossary,
  conceptPreviewHashOf,
  runConceptBatch,
  readConceptPreviews,
  applyConceptPreviews,
} = require('../../src/catalog/concept-batch');

function tmpFile(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'file.json');
}

function approvedStore(summaries) {
  return {
    schema_version: 1,
    updated_at: null,
    candidates: (summaries || []).map((summary, index) => ({
      id: `c${index}`,
      title: `标题${index}`,
      url: `https://example.com/${index}`,
      summary,
      final_score: (summaries.length - index) * 10,
      review_status: 'approved',
    })),
  };
}

function makeValue(term, overrides = {}) {
  return {
    term,
    full_name: term,
    category: '模型架构',
    summary: `${term} 的合成摘要。`,
    related_terms: ['Token'],
    source: { name: 'Mock 论文 2026', url: 'https://arxiv.org/abs/mock' },
    relevance: '影响工具选择。',
    ...overrides,
  };
}

/** 构造带校验的 schema v2 概念预览（base_revision + candidate_keys + hash）。 */
function makeV2Preview(cards, glossary, extra = {}) {
  const withKeys = cards.map(card => ({ ...card, candidate_key: `concept_${card.term}` }));
  const body = {
    schema_version: 2,
    kind: 'concept_previews',
    generated_at: new Date().toISOString(),
    base_revision: revisionOfGlossary(glossary || []),
    source_pending_revision: 'p-r1',
    candidate_keys: withKeys.map(card => card.candidate_key),
    count: withKeys.length,
    cards: withKeys,
    ...extra,
  };
  return { ...body, preview_hash: conceptPreviewHashOf(body) };
}

// ── 第 1 组：读入 ─────────────────────────────────────────────

test('readPendingConcepts 读取 cards 数组，缺 cards 拒绝', () => {
  const file = tmpFile('cb-concept-read-');
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, cards: [{ term: 'A' }, { term: 'B' }] }));
  assert.deepEqual(readPendingConcepts(file).map(card => card.term), ['A', 'B']);
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1 }));
  assert.throws(() => readPendingConcepts(file), /PENDING_CONCEPTS_INVALID/);
});

// ── 第 2 组：查重 ─────────────────────────────────────────────

test('dedupeConceptCandidates 同批 + 正式 glossary 双层去重（大小写不敏感）', () => {
  const cards = [
    { term: 'RAG' },
    { term: 'rag' }, // 同批重复（大小写不敏感）
    { term: 'Token' }, // glossary 已存在（大小写不敏感）
    { term: 'New Concept' },
  ];
  const glossary = [{ term: 'token', category: '推理与部署' }];
  const result = dedupeConceptCandidates(cards, glossary);
  assert.deepEqual(result.duplicates.map(item => item.term), ['rag']);
  assert.deepEqual(result.existing.map(item => item.term), ['Token']);
  assert.deepEqual(result.deduped.map(card => card.term), ['RAG', 'New Concept']);
});

// ── 第 3 组：证据收集 ─────────────────────────────────────────

test('collectConceptEvidence 只取 approved+summary，按 term 子串匹配、K 上限', async () => {
  const store = approvedStore([
    'DeepSeek 发布了新模型。',
    '有人用 DeepSeek 做推理。',
    'deepseek 相关评测。',
    '这是 deepseek 的第四条。',
    '无关内容。',
  ]);
  const [{ evidence }] = await collectConceptEvidence(
    [{ term: 'DeepSeek' }],
    { store, skipVibeHub: true, maxEvidencePerTerm: 3 },
  );
  assert.equal(evidence.length, 3, '匹配到 4 条但 K=3 只取前 3');
  assert.ok(evidence.every(item => item.kind === 'summary'));
  assert.ok(evidence.every(item => String(item.text).toLowerCase().includes('deepseek')));
  assert.equal(evidence[0].url, 'https://example.com/0', '按 final_score 降序取前 K');
});

test('collectConceptEvidence 过滤未 approved / 无 summary / 不匹配条目', async () => {
  const store = {
    schema_version: 1,
    updated_at: null,
    candidates: [
      { id: 'a', title: 'a', summary: 'RAG 技术介绍', review_status: 'pending' }, // 未 approved
      { id: 'b', title: 'b', summary: '', review_status: 'approved' }, // 无 summary
      { id: 'c', title: 'c', summary: 'RAG 与向量库', review_status: 'discarded' }, // 已剔除
      { id: 'd', title: 'd', summary: 'RAG 幻觉控制', review_status: 'approved' }, // 有效
    ],
  };
  const [{ evidence }] = await collectConceptEvidence([{ term: 'RAG' }], { store, skipVibeHub: true });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].title, 'd');
});

test('collectConceptEvidence 纯 ASCII term 尝试 vibe-hub，中文 term 跳过，失败静默', async () => {
  const store = approvedStore(['Chat UI 设计。', '上下文窗口 限制模型输入长度。']);
  let fetchedSlugs = [];
  const options = {
    store,
    fetchImpl: async () => { fetchedSlugs.push('called'); return { ok: false, status: 404, text: async () => '' }; },
    readCache: () => null,
    writeCache: () => {},
  };
  const results = await collectConceptEvidence(
    [{ term: 'Chat UI' }, { term: '上下文窗口' }],
    options,
  );
  assert.equal(fetchedSlugs.length, 1, '中文 term 不发 vibe-hub 请求');
  assert.equal(results[0].evidence.length, 1, 'vibe-hub 404 静默跳过，保留摘要主证据');
  assert.equal(results[1].evidence.length, 1, '中文 term 只有摘要证据');
});

// ── 第 4 组：成本估算 ─────────────────────────────────────────

test('planConceptCost 每概念 1 次合成，vibe-hub 不计成本', () => {
  const estimate = planConceptCost([{}, {}, {}]);
  assert.deepEqual(estimate.cost, { responses_calls: 3, synthesis_calls: 3 });
  assert.deepEqual(estimate.per_concept, { responses_calls: 1, synthesis_calls: 1 });
  assert.equal(planConceptCost([]).concepts, 0);
});

// ── 第 5 组：批量编排 ─────────────────────────────────────────

test('runConceptBatch dry-run 只查重+本地证据+成本，零 AI 零网络零写入', async () => {
  const store = approvedStore(['New Concept 的摘要。']);
  let synthesizeCalls = 0;
  const previewFile = tmpFile('cb-dry-');
  const result = await runConceptBatch(
    [{ term: 'New Concept', review_status: 'approved' }],
    { store, glossary: [], dryRun: true, synthesize: async () => { synthesizeCalls += 1; return { ok: true, value: {} }; }, previewFile },
  );
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(synthesizeCalls, 0);
  assert.equal(result.estimate.cost.synthesis_calls, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].evidence.length, 1);
  assert.equal(fs.existsSync(previewFile), false, 'dry-run 不写预览文件');
});

test('runConceptBatch 无 --confirm-cost 返回 COST_CONFIRMATION_REQUIRED', async () => {
  const store = approvedStore([]);
  const result = await runConceptBatch([{ term: 'A', review_status: 'approved' }, { term: 'B', review_status: 'approved' }], { store, glossary: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'COST_CONFIRMATION_REQUIRED');
  assert.deepEqual(result.cost_estimate.cost, { responses_calls: 2, synthesis_calls: 2 });
});

test('runConceptBatch --confirm-cost 合成写预览文件，失败隔离保留', async () => {
  const store = approvedStore(['Good Term 摘要。', 'Bad Term 摘要。', 'Good Term 第二条。']);
  const calls = [];
  const synthesize = async ({ card, ledger }) => {
    calls.push(card.term);
    ledger.reserve('synthesis_calls', 1); // 对齐真实 adapter 的预占行为
    if (card.term === 'Bad Term') return { ok: false, code: 'DEEPSEEK_CONCEPT_SYNTHESIS_FAILED', error: 'mock 失败' };
    return { ok: true, value: makeValue(card.term) };
  };
  const previewFile = tmpFile('cb-batch-');
  const result = await runConceptBatch(
    [{ term: 'Good Term', review_status: 'approved' }, { term: 'Bad Term', review_status: 'approved' }],
    { store, glossary: [], confirmCost: true, synthesize, previewFile, skipVibeHub: true },
  );
  assert.equal(result.ok, true);
  assert.equal(result.dry_run, false);
  assert.equal(result.cards.length, 1, '只有成功的进入预览');
  assert.equal(result.cards[0].term, 'Good Term');
  assert.equal(result.cards[0].status, 'pending');
  assert.equal(result.cards[0].evidence_count, 2, 'Good Term 命中 2 条摘要');
  assert.deepEqual(result.failed, [{ term: 'Bad Term', reason: 'mock 失败' }]);
  assert.equal(result.cost.spent.synthesis_calls, 2, '成功+失败各预占 1 次合成');
  const preview = JSON.parse(fs.readFileSync(previewFile, 'utf8'));
  assert.equal(preview.kind, 'concept_previews');
  assert.equal(preview.count, 1);
  assert.equal(preview.cards[0].term, 'Good Term');
});

test('runConceptBatch 集成 vibe-hub：纯 ASCII term 补充证据进入 evidence_count', async () => {
  const store = approvedStore(['Chat UI 的摘要。']);
  const html = '<html><head><script id="vibehub-page-jsonld" type="application/ld+json">'
    + JSON.stringify({ '@graph': [{ '@type': 'DefinedTerm', name: '聊天界面 Chat UI', alternateName: [], description: 'vibe-hub 定义。' }] })
    + '</script></head><body><p>vibe-hub 正文。</p></body></html>';
  const previewFile = tmpFile('cb-vibe-');
  const result = await runConceptBatch(
    [{ term: 'Chat UI', review_status: 'approved' }],
    {
      store,
      glossary: [],
      confirmCost: true,
      previewFile,
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }),
      readCache: () => null,
      writeCache: () => {},
      synthesize: async ({ card, evidence }) => ({ ok: true, value: makeValue(card.term, { summary: evidence.map(e => e.kind).join(',') }) }),
    },
  );
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].evidence_count, 2, '摘要主证据 + vibe-hub 补充');
  assert.equal(result.cards[0].summary, 'summary,vibe-hub');
});

test('runConceptBatch 只消费 approved 概念卡，未审核/已丢弃卡进入 skipped', async () => {
  const store = approvedStore(['Approved Concept 的摘要。']);
  let synthesizeCalls = 0;
  const previewFile = tmpFile('cb-gate-');
  const result = await runConceptBatch(
    [
      { term: 'Approved Concept', review_status: 'approved' },
      { term: 'Discarded Concept', review_status: 'discarded' },
      { term: 'Pending Concept', review_status: 'pending' },
      { term: 'Legacy Concept' }, // v1 无 review_status → 视为未审核
    ],
    { store, glossary: [], confirmCost: true, skipVibeHub: true, previewFile, synthesize: async ({ card }) => { synthesizeCalls += 1; return { ok: true, value: makeValue(card.term) }; } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.skipped.skippedNotApproved.length, 3);
  assert.deepEqual(result.skipped.skippedNotApproved.map(item => item.term).sort(), ['Discarded Concept', 'Legacy Concept', 'Pending Concept']);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].term, 'Approved Concept');
  assert.equal(synthesizeCalls, 1, '只有 approved 卡参与付费合成');
});

// ── 第 6 组：人工 apply ───────────────────────────────────────

test('applyConceptPreviews v2 全量校验后合并保序追加，任一项冲突则整批零写入', () => {
  const glossaryFile = tmpFile('cb-apply-');
  fs.writeFileSync(glossaryFile, JSON.stringify([
    { term: 'Existing', category: '模型架构', summary: 's', source: { name: 'n' } },
  ]));
  const glossary = JSON.parse(fs.readFileSync(glossaryFile, 'utf8'));
  const expectedRevision = revisionOfGlossary(glossary);

  // 任一 term 已存在 → 整批拒绝，glossary 不变（all-or-nothing，不做部分跳过）
  const conflicting = makeV2Preview([makeValue('New A'), makeValue('Existing')], glossary);
  const rejected = applyConceptPreviews(conflicting, { glossaryFile, glossary, expectedRevision, terms: ['New A', 'Existing'] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'CONCEPT_TERM_ALREADY_EXISTS');
  assert.deepEqual(JSON.parse(fs.readFileSync(glossaryFile, 'utf8')).map(entry => entry.term), ['Existing'], '冲突时零写入');

  // 全部合法 → 保留现有顺序，追加新条
  const clean = makeV2Preview([makeValue('New A'), makeValue('New C')], glossary);
  const result = applyConceptPreviews(clean, { glossaryFile, glossary, expectedRevision, terms: ['New A', 'New C'] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.added.map(item => item.term), ['New A', 'New C']);
  assert.equal(result.skipped.length, 0);
  const written = JSON.parse(fs.readFileSync(glossaryFile, 'utf8'));
  assert.deepEqual(written.map(entry => entry.term), ['Existing', 'New A', 'New C'], '保留现有顺序，追加新条');
  assert.equal(written[2].source.name, 'Mock 论文 2026');
  assert.equal(written[2].source.url, 'https://arxiv.org/abs/mock');
  assert.equal(result.glossary_count, 3);
});

test('applyConceptPreviews v1 预览被拒绝（PREVIEW_SCHEMA_UNSUPPORTED）且 hash/CAS 冲突拒写', () => {
  const glossaryFile = tmpFile('cb-apply-v1-');
  fs.writeFileSync(glossaryFile, '[]');
  const legacy = { schema_version: 1, kind: 'concept_previews', cards: [makeValue('A')] };
  const rejected = applyConceptPreviews(legacy, { glossaryFile, glossary: [] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'PREVIEW_SCHEMA_UNSUPPORTED');
  assert.deepEqual(JSON.parse(fs.readFileSync(glossaryFile, 'utf8')), []);

  const glossary = [];
  const preview = makeV2Preview([makeValue('A')], glossary);
  const tampered = { ...preview, cards: [{ ...preview.cards[0], summary: '被篡改' }] };
  const badHash = applyConceptPreviews(tampered, { glossaryFile, glossary, expectedRevision: preview.base_revision });
  assert.equal(badHash.ok, false);
  assert.equal(badHash.code, 'PREVIEW_CHANGED');
  const stale = applyConceptPreviews(preview, { glossaryFile, glossary, expectedRevision: 'sha256:stale' });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'REVISION_CONFLICT');
  assert.deepEqual(JSON.parse(fs.readFileSync(glossaryFile, 'utf8')), [], '所有冲突均零写入');
});

test('applyConceptPreviews --terms 子集只应用指定术语', () => {
  const glossaryFile = tmpFile('cb-apply-terms-');
  fs.writeFileSync(glossaryFile, '[]');
  const glossary = [];
  const preview = makeV2Preview([makeValue('A'), makeValue('B')], glossary);
  const result = applyConceptPreviews(preview, { terms: ['a'], glossary: [], glossaryFile, expectedRevision: preview.base_revision });
  assert.deepEqual(result.added.map(item => item.term), ['A'], '只应用指定子集');
  assert.equal(JSON.parse(fs.readFileSync(glossaryFile, 'utf8')).length, 1);
});


test('applyConceptPreviews apply_all 从服务端预览应用全部术语且拒绝混合模式', () => {
  const glossaryFile = tmpFile('cb-apply-all-');
  fs.writeFileSync(glossaryFile, '[]');
  const glossary = [];
  const preview = makeV2Preview([makeValue('A'), makeValue('B')], glossary);
  const result = applyConceptPreviews(preview, { applyAll: true, glossary, glossaryFile, expectedRevision: preview.base_revision });
  assert.equal(result.ok, true);
  assert.deepEqual(result.added.map(item => item.term), ['A', 'B']);
  assert.equal(JSON.parse(fs.readFileSync(glossaryFile, 'utf8')).length, 2);
  const mixed = applyConceptPreviews(preview, { applyAll: true, terms: ['A'], glossary: [], glossaryFile, expectedRevision: preview.base_revision });
  assert.equal(mixed.code, 'CONCEPT_APPLY_MODE_INVALID');
});
