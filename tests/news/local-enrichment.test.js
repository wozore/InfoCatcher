/**
 * local-enrichment.test.js — 本地 Bonsai 初审、摘要与翻译编排测试
 *
 * 运行方式：node --test tests/news/local-enrichment.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  needsL1Review,
  needsSummary,
  needsLocalize,
  needsRepair,
  countRepairWork,
} = require('../../src/news/min/enrichment-core');
const {
  countEnrichmentWork,
  enrichMinCandidates,
} = require('../../src/news/min/local-enrichment');
const {
  repairIncompleteCandidates,
} = require('../../src/news/min/min-repair');

// ── 第 1 组：纯函数判定 ─────────────────────────────────────

test('needsL1Review：只有 pending 且无有效 verdict 的条目需要审核', () => {
  assert.equal(needsL1Review(null), false);
  assert.equal(needsL1Review({}), true); // 默认无 review_status 视作待审
  assert.equal(needsL1Review({ review_status: 'discarded' }), false);
  assert.equal(needsL1Review({ review_status: 'approved' }), false);

  // pending 且未完成审核
  assert.equal(needsL1Review({ review_status: 'pending' }), true);
  assert.equal(needsL1Review({
    review_status: 'pending',
    l1_review: { verdict: null, llm_error: 'offline' },
  }), true);

  // pending 但已有确定 verdict（例如人工或 L1 已给出的 hold）
  assert.equal(needsL1Review({
    review_status: 'pending',
    l1_review: { verdict: 'hold', confidence: 0.5 },
  }), false);
});

test('needsSummary：非 discarded 且无 summary 且有素材的条目需要摘要', () => {
  assert.equal(needsSummary(null), false);
  assert.equal(needsSummary({ review_status: 'discarded', title: '有标题' }), false);
  assert.equal(needsSummary({ review_status: 'pending', title: '' }), false);
  assert.equal(needsSummary({ review_status: 'pending', title: 'AI 资讯' }), true);
  assert.equal(needsSummary({
    review_status: 'pending',
    title: 'AI 资讯',
    summary: '已有摘要内容',
  }), false);
  assert.equal(needsSummary({
    review_status: 'approved',
    transcript: '视频字幕文本',
  }), true);
});

test('needsLocalize：非 discarded 且无对应语言翻译且有素材的条目需要本地化', () => {
  assert.equal(needsLocalize(null), false);
  assert.equal(needsLocalize({ review_status: 'discarded', title: 'Title' }), false);
  assert.equal(needsLocalize({ review_status: 'pending', title: '' }), false);
  assert.equal(needsLocalize({ review_status: 'pending', title: 'Title' }), true);
  assert.equal(needsLocalize({
    review_status: 'pending',
    title: 'Title',
    localizations: { zh: { title: '中文标题', description: '中文描述' } },
  }), false);
  // 假翻译（原样复述英文）不算已本地化，必须重新修复
  assert.equal(needsLocalize({
    review_status: 'pending',
    title: 'Title',
    localizations: { zh: { title: 'Title', description: 'Echo description' } },
  }), true);
  assert.equal(needsLocalize({
    review_status: 'approved',
    description: 'English description',
  }, 'en'), true);
});

test('countEnrichmentWork：准确统计各项待处理工作量并支持过滤选项', () => {
  const candidates = [
    { id: '1', review_status: 'discarded', title: 'T1' },
    { id: '2', review_status: 'pending', title: 'T2' }, // review(L1), summary, localize
    {
      id: '3',
      review_status: 'approved',
      title: 'T3',
      summary: 'S3',
      localizations: { zh: { title: '中文标题' } },
    }, // 不需要任何处理
    {
      id: '4',
      review_status: 'pending',
      title: 'T4',
      l1_review: { verdict: 'hold' }, // 需要 L2 建议补齐 + summary + localize
    },
  ];

  const res1 = countEnrichmentWork(candidates);
  assert.equal(res1.total, 4);
  assert.equal(res1.review, 2); // candidate 2 缺 L1，candidate 4 仅缺 L2 建议
  assert.equal(res1.summary, 2); // candidate 2, 4
  assert.equal(res1.localize, 2); // candidate 2, 4
  assert.equal(res1.hasWork, true);

  // L2 关闭时 candidate 4 不再计入审核工作量
  const resL2Off = countEnrichmentWork(candidates, { l2Enabled: false });
  assert.equal(resL2Off.review, 1);

  // 测试 skip 选项
  const res2 = countEnrichmentWork(candidates, { skipReview: true, skipSummary: true });
  assert.equal(res2.review, 0);
  assert.equal(res2.summary, 0);
  assert.equal(res2.localize, 2);

  // 测试 force 选项
  const res3 = countEnrichmentWork(candidates, { force: true });
  assert.equal(res3.review, 2); // candidate 2, 4 (pending 项)
  assert.equal(res3.summary, 3); // candidate 2, 3, 4 (非 discarded 项)
  assert.equal(res3.localize, 3); // candidate 2, 3, 4 (非 discarded 项)
});

// ── 第 2 组：主流程编排 enrichMinCandidates ────────────────

test('enrichMinCandidates：分批处理、调用 mock、每批落盘', async () => {
  const candidates = [
    { id: 'c1', review_status: 'pending', title: 'Title 1', description: 'Desc 1' },
    { id: 'c2', review_status: 'pending', title: 'Title 2', description: 'Desc 2' },
    { id: 'c3', review_status: 'pending', title: 'Title 3', description: 'Desc 3' },
  ];
  const store = { schema_version: 1, updated_at: null, candidates };
  const config = { collection: { concurrency: 2 } };

  const writtenBatches = [];
  const writeStore = (s, runId) => {
    writtenBatches.push({ runId, count: s.candidates.length });
  };

  const batchDoneLogs = [];
  const onBatchDone = info => {
    batchDoneLogs.push(info);
  };

  // Mock reviewCandidate：c1 高置信 approve，c2 高置信 discard，c3 hold
  const reviewCandidateMock = async item => {
    if (item.id === 'c1') {
      return { verdict: 'approve', confidence: 0.95, reasons: ['好的工具'] };
    }
    if (item.id === 'c2') {
      return { verdict: 'discard', confidence: 0.95, reasons: ['广告内容'] };
    }
    return { verdict: 'hold', confidence: 0.6, reasons: ['信息不足'] };
  };

  // Mock fetchImpl for DeepSeek summary & localize
  const fetchImplMock = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '模拟摘要',
              key_points: ['要点一'],
              title: '翻译标题',
              description: '翻译描述',
            }),
          },
        }],
      }),
    };
  };

  const result = await enrichMinCandidates(store, config, {
    batchSize: 2,
    writeStore,
    onBatchDone,
    reviewCandidate: reviewCandidateMock,
    fetchImpl: fetchImplMock,
  });

  // 3 条数据，batchSize=2，应切成 2 批
  assert.equal(result.totalCandidates, 3);
  assert.equal(result.processed, 3);
  assert.equal(result.batches, 2);
  assert.equal(result.reviewed, 3);
  assert.equal(result.autoApproved, 1); // c1
  assert.equal(result.autoDiscarded, 1); // c2
  assert.equal(result.pending, 1); // c3

  // 关键契约核实：c2 在审核后被判定为 discarded，绝不消费摘要与翻译算力！
  // 只有 c1 和 c3 消费摘要与翻译，因此 summarized/localized 应为 2
  assert.equal(result.summarized, 2);
  assert.equal(result.localized, 2);

  // 落盘检查
  assert.equal(writtenBatches.length, 2);
  assert.equal(writtenBatches[0].runId, 'min-enrich-batch-1');
  assert.equal(writtenBatches[1].runId, 'min-enrich-batch-2');

  // 回调检查
  assert.equal(batchDoneLogs.length, 2);
  assert.equal(batchDoneLogs[0].batchIndex, 1);
  assert.equal(batchDoneLogs[0].totalBatches, 2);

  // 状态检查
  assert.equal(candidates[0].review_status, 'approved');
  assert.equal(candidates[0].summary, '模拟摘要');
  assert.equal(candidates[0].localizations?.zh?.title, '翻译标题');

  assert.equal(candidates[1].review_status, 'discarded');
  assert.equal(candidates[1].summary, undefined);
  assert.equal(candidates[1].localizations, undefined);

  assert.equal(candidates[2].review_status, 'pending');
  assert.equal(candidates[2].summary, '模拟摘要');
  assert.equal(candidates[2].localizations?.zh?.title, '翻译标题');
});

test('enrichMinCandidates：dryRun 模式下不写盘', async () => {
  const candidates = [{ id: 'c1', review_status: 'pending', title: 'T1' }];
  const store = { schema_version: 1, updated_at: null, candidates };
  let wrote = false;

  const result = await enrichMinCandidates(store, {}, {
    dryRun: true,
    skipSummary: true,
    skipLocalize: true,
    writeStore: () => { wrote = true; },
    reviewCandidate: async () => ({ verdict: 'approve', confidence: 0.95 }),
  });

  assert.equal(result.dryRun, true);
  assert.equal(wrote, false);
});

test('enrichMinCandidates：limit 参数限制处理条数', async () => {
  const candidates = [
    { id: 'c1', review_status: 'pending', title: 'T1' },
    { id: 'c2', review_status: 'pending', title: 'T2' },
    { id: 'c3', review_status: 'pending', title: 'T3' },
  ];
  const store = { schema_version: 1, updated_at: null, candidates };

  const result = await enrichMinCandidates(store, {}, {
    limit: 2,
    dryRun: true,
    skipSummary: true,
    skipLocalize: true,
    reviewCandidate: async () => ({ verdict: 'hold', confidence: 0.5 }),
  });

  assert.equal(result.processed, 2);
  assert.equal(result.targetsCount, 2);
});

test('enrichMinCandidates：无工作待做时快速返回', async () => {
  const candidates = [
    { id: 'c1', review_status: 'discarded', title: 'T1' },
  ];
  const store = { schema_version: 1, updated_at: null, candidates };

  const result = await enrichMinCandidates(store, {}, {
    dryRun: true,
  });

  assert.equal(result.processed, 0);
  assert.equal(result.batches, 0);
});

// ── 第 3 组：Reviewer 审查意见对抗性测试 ──────────────────

test('needsL1Review 与 force：带有 reviewed_at 的条目绝不重新审核', async () => {
  const manualItem = {
    id: 'm1',
    review_status: 'pending',
    reviewed_at: '2026-09-02T10:00:00Z',
    title: '人工审核过的数据',
  };

  assert.equal(needsL1Review(manualItem), false);

  const work = countEnrichmentWork([manualItem], { force: true });
  assert.equal(work.review, 0, 'force 模式下 review 也必须为 0');

  let reviewCalled = false;
  const store = { candidates: [manualItem] };
  await enrichMinCandidates(store, {}, {
    force: true,
    skipSummary: true,
    skipLocalize: true,
    writeStore: () => {},
    reviewCandidate: async () => {
      reviewCalled = true;
      return { verdict: 'discard', confidence: 0.99 };
    },
  });

  assert.equal(reviewCalled, false, '不应调用 reviewCandidate');
  assert.equal(manualItem.review_status, 'pending', '状态不应被推翻');
});

test('needsSummary 与 force：带有 transcript_summarized_at 的条目受保护，不被重写', async () => {
  const protectedItem = {
    id: 'p1',
    review_status: 'pending',
    title: '字幕深度总结',
    summary: '高阶付费 DeepSeek 字幕总结',
    transcript_summarized_at: '2026-09-02T10:00:00Z',
  };

  assert.equal(needsSummary(protectedItem), false);

  const work = countEnrichmentWork([protectedItem], { force: true });
  assert.equal(work.summary, 0, 'force 模式下受保护的 summary 计数为 0');

  const store = { candidates: [protectedItem] };
  await enrichMinCandidates(store, {}, {
    force: true,
    skipReview: true,
    skipLocalize: true,
    writeStore: () => {},
    fetchImpl: async () => {
      throw new Error('不应触发 fetch');
    },
  });

  assert.equal(protectedItem.summary, '高阶付费 DeepSeek 字幕总结');
});

test('executeCandidateReview：高置信 approved 时清理旧的 discard 标记', async () => {
  const candidate = {
    id: 'd1',
    review_status: 'pending',
    discard_reason: 'old_reason',
    discard_stage: 'l0',
    title: '优质内容',
  };
  const store = { candidates: [candidate] };

  await enrichMinCandidates(store, {}, {
    writeStore: () => {},
    skipSummary: true,
    skipLocalize: true,
    reviewCandidate: async () => ({ verdict: 'approve', confidence: 0.95 }),
  });

  assert.equal(candidate.review_status, 'approved');
  assert.equal(candidate.discard_reason, undefined);
  assert.equal(candidate.discard_stage, undefined);
});

// ── 第 4 组：双通道自愈修复机制 repairIncompleteCandidates 测试 ─

test('needsRepair 与 countRepairWork：准确识别残缺项并统计', () => {
  // discarded 绝不需要修复
  assert.equal(needsRepair({ review_status: 'discarded', title: 'T' }), false);

  // pending 缺 L1 审核
  assert.equal(needsRepair({ review_status: 'pending', title: 'T' }), true);

  // pending 有 L1 但缺 L2 ai_advice
  assert.equal(needsRepair({
    review_status: 'pending',
    title: 'T',
    l1_review: { verdict: 'hold', confidence: 0.5 },
    ai_advice: null,
  }), true);

  // pending 审核完整但缺少 summary
  assert.equal(needsRepair({
    review_status: 'pending',
    title: 'T',
    l1_review: { verdict: 'hold', confidence: 0.5 },
    ai_advice: { verdict: 'hold', confidence: 0.5 },
    summary: '',
    localizations: { zh: { title: '已翻译' } },
  }), true);

  // pending 审核完整但缺少 localizations
  assert.equal(needsRepair({
    review_status: 'pending',
    title: 'T',
    l1_review: { verdict: 'hold', confidence: 0.5 },
    ai_advice: { verdict: 'hold', confidence: 0.5 },
    summary: '已有摘要',
  }), true);

  // pending 全部齐全
  assert.equal(needsRepair({
    review_status: 'pending',
    title: 'T',
    l1_review: { verdict: 'hold', confidence: 0.5 },
    ai_advice: { verdict: 'hold', confidence: 0.5 },
    summary: '已有摘要',
    localizations: { zh: { title: '已翻译' } },
  }), false);

  // approved 缺少 summary
  assert.equal(needsRepair({
    review_status: 'approved',
    title: 'T',
    l1_review: { verdict: 'approve', confidence: 0.9 },
    summary: '',
    localizations: { zh: { title: '已翻译' } },
  }), true);

  // approved 且全部齐全（注意：approved 条目无 ai_advice，绝不能误判为需要修复！）
  assert.equal(needsRepair({
    review_status: 'approved',
    title: 'T',
    l1_review: { verdict: 'approve', confidence: 0.9 },
    ai_advice: null,
    summary: '已有摘要',
    localizations: { zh: { title: '已翻译' } },
  }), false);

  // 已有人工审核标记 reviewed_at 的条目且内容齐全，不需修复
  assert.equal(needsRepair({
    review_status: 'pending',
    reviewed_at: '2026-09-02T10:00:00Z',
    title: 'T',
    summary: '已有摘要',
    localizations: { zh: { title: '已翻译' } },
  }), false);

  // countRepairWork 统计
  const candidates = [
    { id: '1', review_status: 'discarded', title: 'T1' },
    { id: '2', review_status: 'pending', title: 'T2' }, // 缺 review, summary, localize
    {
      id: '3',
      review_status: 'approved',
      title: 'T3',
      summary: '',
      localizations: { zh: { title: '中文标题' } },
    }, // 缺 summary
    {
      id: '4',
      review_status: 'approved',
      title: 'T4',
      summary: 'S4',
      localizations: { zh: { title: '中文标题' } },
    }, // 完整
  ];

  const work = countRepairWork(candidates);
  assert.equal(work.total, 2); // id 2, 3
  assert.equal(work.review, 1); // id 2
  assert.equal(work.summary, 2); // id 2, 3
  assert.equal(work.localize, 1); // id 2
  assert.equal(work.hasWork, true);
});

test('repairIncompleteCandidates：零成本优先与本地失败回退外部', async () => {
  // item1: 本地 A 成功
  // item2: 本地 A 失败，外部 B 成功（回退生效）
  const candidates = [
    { id: 'c1', review_status: 'pending', title: 'Title 1', description: 'Desc 1' },
    { id: 'c2', review_status: 'pending', title: 'Title 2', description: 'Desc 2' },
  ];
  const store = { schema_version: 1, updated_at: null, candidates };

  // mock 通道 A：仅 c1 成功，c2 抛错失败
  const fetchImplA = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '来自本地A的摘要',
              key_points: ['要点A'],
              title: '本地A翻译',
              description: '本地A描述',
            }),
          },
        }],
      }),
    };
  };

  const reviewCandidateA = async item => {
    if (item.id === 'c1') {
      return { verdict: 'approve', confidence: 0.92, reasons: ['本地A通过'] };
    }
    return { verdict: null, reasons: [], confidence: 0, llm_error: 'local_failed' };
  };

  // mock 通道 B：c1 和 c2 都能成功返回外部结果
  const fetchImplB = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '来自外部B的摘要',
              key_points: ['要点B'],
              title: '外部B翻译',
              description: '外部B描述',
            }),
          },
        }],
      }),
    };
  };

  const reviewCandidateB = async item => {
    if (item.id === 'c2') {
      return { verdict: 'discard', confidence: 0.95, reasons: ['外部B判定广告'] };
    }
    return { verdict: 'approve', confidence: 0.88, reasons: ['外部B通过'] };
  };

  let savedRunId = null;
  const writeStore = (s, runId) => {
    savedRunId = runId;
  };

  const result = await repairIncompleteCandidates(store, {}, {
    fetchImplA,
    fetchImplB,
    reviewCandidateA,
    reviewCandidateB,
    writeStore,
  });

  assert.equal(result.totalTargets, 2);
  assert.equal(result.repairedReview, 2);
  assert.equal(savedRunId, 'min-repair-dual-channel');

  // c1: 应该优先采纳本地 A 的结果（零成本优先）
  assert.equal(candidates[0].review_status, 'approved');
  assert.equal(candidates[0].summary, '来自本地A的摘要');
  assert.equal(candidates[0].localizations?.zh?.title, '本地A翻译');

  // c2: 本地 A 失败，回退采纳外部 B 的结果（B 判定为 discarded）
  assert.equal(candidates[1].review_status, 'discarded');
  // discarded 项绝不吸纳摘要与翻译修复
  assert.equal(candidates[1].summary, undefined);
  assert.equal(candidates[1].localizations, undefined);
});

test('repairIncompleteCandidates：本地通道假翻译不抢占外部真翻译', async () => {
  // 通道 A（本地）返回"原样复述英文"的假翻译；通道 B（外部）返回真中文。
  // 合并质量门禁必须让 B 的真翻译胜出，绝不允许假翻译抢占合并结果。
  const candidates = [
    { id: 'c1', review_status: 'pending', title: 'Echo Title', description: 'Echo description' },
  ];
  const store = { schema_version: 1, updated_at: null, candidates };

  const fetchImplA = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '回声摘要',
            key_points: ['要点'],
            title: 'Echo Title',          // 假翻译：原样复述
            description: 'Echo description',
          }),
        },
      }],
    }),
  });
  const reviewCandidateA = async () => ({ verdict: 'hold', confidence: 0.5, reasons: ['本地挂起'] });

  const fetchImplB = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '外部真摘要',
            key_points: ['要点'],
            title: '外部真翻译标题',
            description: '外部真翻译描述',
          }),
        },
      }],
    }),
  });
  const reviewCandidateB = async () => ({ verdict: 'hold', confidence: 0.5, reasons: ['外部挂起'] });

  const originalKey = process.env.ZHIPU_API_KEY;
  process.env.ZHIPU_API_KEY = 'secret-test-key';
  let result;
  try {
    result = await repairIncompleteCandidates(store, {}, {
      fetchImplA,
      fetchImplB,
      reviewCandidateA,
      reviewCandidateB,
      writeStore: () => {},
    });
  } finally {
    if (originalKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = originalKey;
  }

  assert.equal(result.totalTargets, 1);
  // 本地 A 的假翻译不得抢占；必须采纳外部 B 的真中文
  assert.equal(candidates[0].localizations?.zh?.title, '外部真翻译标题');
  assert.equal(candidates[0].localizations?.zh?.description, '外部真翻译描述');
});

test('repairIncompleteCandidates：瞬时失败自动延迟重试（限流自愈）', async () => {
  // 外部 B 通道首次调用返回 429 失败，延迟重试后成功 → 条目仍应被修复
  const candidates = [
    { id: 'c1', review_status: 'pending', title: 'Rate limited title', description: 'Rate limited description' },
  ];
  const store = { schema_version: 1, updated_at: null, candidates };

  const reviewCandidateA = async () => ({ verdict: null, confidence: 0, reasons: [], llm_error: 'local_failed' });
  const reviewCandidateB = async () => ({ verdict: 'hold', confidence: 0.5, reasons: ['外部挂起'] });

  let bLocalizeCalls = 0;
  const fetchImplB = async () => {
    bLocalizeCalls += 1;
    if (bLocalizeCalls === 1) {
      return { ok: false, status: 429, json: async () => ({ error: 'rate_limited' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '重试后摘要',
              key_points: ['要点'],
              title: '重试后真翻译',
              description: '重试后真描述',
            }),
          },
        }],
      }),
    };
  };

  const originalKey = process.env.ZHIPU_API_KEY;
  process.env.ZHIPU_API_KEY = 'secret-test-key';
  let result;
  try {
    result = await repairIncompleteCandidates(store, {}, {
      fetchImplA: async () => { throw new Error('local_offline'); },
      fetchImplB,
      reviewCandidateA,
      reviewCandidateB,
      channelB: { concurrency: 1 },
      retryDelayMs: 1,
      writeStore: () => {},
    });
  } finally {
    if (originalKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = originalKey;
  }

  assert.ok(bLocalizeCalls >= 2, '外部通道至少调用两次（首轮 + 重试）');
  assert.equal(candidates[0].localizations?.zh?.title, '重试后真翻译');
  assert.equal(candidates[0].summary, '重试后摘要');
  assert.equal(result.repairedLocalize, 1);
});

test('repairIncompleteCandidates：显式跳过阶段时不重新纳入对应残缺项', async () => {
  const candidate = {
    id: 'skip-1',
    review_status: 'pending',
    title: '待处理条目',
  };
  const store = { candidates: [candidate] };
  let reviewCalled = false;
  let fetchCalled = false;

  const result = await repairIncompleteCandidates(store, {}, {
    skipReview: true,
    skipSummary: true,
    skipLocalize: true,
    dryRun: true,
    reviewCandidate: async () => {
      reviewCalled = true;
      return { verdict: 'approve', confidence: 0.99 };
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('不应触发模型请求');
    },
  });

  assert.equal(result.totalTargets, 0);
  assert.equal(result.remainingIncomplete, 0);
  assert.equal(reviewCalled, false);
  assert.equal(fetchCalled, false);
});

test('repairIncompleteCandidates：approved 条目缺少 ai_advice 不计入审核修复', async () => {
  const candidate = {
    id: 'approved-1',
    review_status: 'approved',
    title: '已通过条目',
    summary: '',
    localizations: { zh: { title: '已有中文标题' } },
  };
  const store = { candidates: [candidate] };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '补齐的摘要',
            key_points: ['要点'],
          }),
        },
      }],
    }),
  });

  const result = await repairIncompleteCandidates(store, {}, {
    fetchImplA: fetchImpl,
    fetchImplB: fetchImpl,
    dryRun: true,
  });

  assert.equal(result.totalTargets, 1);
  assert.equal(result.repairedReview, 0);
  assert.equal(result.repairedSummary, 1);
  assert.equal(candidate.review_status, 'approved');
  assert.equal(candidate.summary, '补齐的摘要');
});


test('repairIncompleteCandidates：L2 关闭时已有 L1 的 pending 不重复修复', async () => {
  const candidate = {
    id: 'l2-off',
    review_status: 'pending',
    title: '已有 L1 结论',
    l1_review: { verdict: 'hold', confidence: 0.5 },
    ai_advice: null,
    summary: '已有摘要',
    localizations: { zh: { title: '已有标题' } },
  };
  const store = { candidates: [candidate] };

  const result = await repairIncompleteCandidates(store, { review: { l2_enabled: false } }, {
    dryRun: true,
    reviewCandidate: async () => { throw new Error('不应重复审核'); },
    fetchImpl: async () => { throw new Error('不应请求模型'); },
  });

  assert.equal(result.totalTargets, 0);
  assert.equal(result.remainingIncomplete, 0);
});

test('repairIncompleteCandidates：空白摘要与空本地化对象可以被补齐', async () => {
  const candidate = {
    id: 'empty-fields',
    review_status: 'pending',
    title: '需要补齐字段',
    l1_review: { verdict: 'hold', confidence: 0.5 },
    ai_advice: { verdict: 'hold', confidence: 0.5 },
    summary: '   ',
    localizations: { zh: {} },
  };
  const store = { candidates: [candidate] };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            summary: '有效摘要',
            key_points: ['要点'],
            title: '有效标题',
            description: '有效描述',
          }),
        },
      }],
    }),
  });

  const result = await repairIncompleteCandidates(store, {}, {
    fetchImplA: fetchImpl,
    fetchImplB: fetchImpl,
    dryRun: true,
  });

  assert.equal(result.totalTargets, 1);
  assert.equal(result.repairedSummary, 1);
  assert.equal(result.repairedLocalize, 1);
  assert.equal(candidate.summary, '有效摘要');
  assert.equal(candidate.localizations.zh.title, '有效标题');
});

test('repairIncompleteCandidates：外部通道按 provider 开关读取密钥，本地通道不携带外部 key', async () => {
  const candidate = {
    id: 'local-key',
    review_status: 'approved',
    title: '需要摘要',
    summary: '',
    localizations: { zh: { title: '已有标题' } },
  };
  const store = { candidates: [candidate] };
  const originalKey = process.env.ZHIPU_API_KEY;
  const originalDeepseekKey = process.env.DEEPSEEK_API_KEY;
  const localHeaders = [];
  const externalHeaders = [];
  const response = {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ summary: '摘要', key_points: [] }) } }],
    }),
  };
  process.env.ZHIPU_API_KEY = 'secret-test-key';
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const result = await repairIncompleteCandidates(store, {}, {
      fetchImplA: async (_url, init) => {
        localHeaders.push(init.headers.Authorization);
        return response;
      },
      fetchImplB: async (_url, init) => {
        externalHeaders.push(init.headers['x-api-key'] || init.headers.Authorization);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ summary: '摘要', key_points: [] }) }],
          }),
        };
      },
      dryRun: true,
    });
    assert.equal(result.repairedSummary, 1);
  } finally {
    if (originalKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = originalKey;
    if (originalDeepseekKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalDeepseekKey;
  }
  assert.deepEqual(localHeaders, ['Bearer local-bonsai']);
  assert.deepEqual(externalHeaders, ['secret-test-key']);
});


test('repairIncompleteCandidates：默认限制外部修复目标数量', async () => {
  const candidates = Array.from({ length: 101 }, (_, index) => ({
    id: `limit-${index}`,
    review_status: 'pending',
    title: `条目 ${index}`,
  }));
  const store = { candidates };

  const result = await repairIncompleteCandidates(store, {}, {
    skipSummary: true,
    skipLocalize: true,
    dryRun: true,
    reviewCandidate: async () => ({ verdict: 'approve', confidence: 0.99 }),
  });

  assert.equal(result.totalTargets, 100);
  assert.equal(result.remainingIncomplete, 1);
});

test('repairIncompleteCandidates：可显式关闭外部通道', async () => {
  const candidate = { id: 'no-external', review_status: 'pending', title: '仅本地修复' };
  const store = { candidates: [candidate] };
  let externalReviewCalled = false;

  const result = await repairIncompleteCandidates(store, {}, {
    skipSummary: true,
    skipLocalize: true,
    externalEnabled: false,
    dryRun: true,
    reviewCandidateA: async () => ({ verdict: 'approve', confidence: 0.99 }),
    reviewCandidateB: async () => {
      externalReviewCalled = true;
      return { verdict: 'discard', confidence: 0.99 };
    },
  });

  assert.equal(result.repairedReview, 1);
  assert.equal(externalReviewCalled, false);
  assert.equal(candidate.review_status, 'approved');
});


test('needsSummary：保护标记存在但 summary 为空时允许重试补齐', () => {
  assert.equal(needsSummary({
    review_status: 'pending',
    title: 'T',
    transcript_summarized_at: '2026-09-01T00:00:00Z',
    summary: '   ',
  }), true);
  assert.equal(needsSummary({
    review_status: 'pending',
    title: 'T',
    transcript_summarized_at: '2026-09-01T00:00:00Z',
  }), true);
  // 有效摘要 + 保护标记 → 不重试
  assert.equal(needsSummary({
    review_status: 'pending',
    title: 'T',
    transcript_summarized_at: '2026-09-01T00:00:00Z',
    summary: '有效字幕总结',
  }), false);
});

test('enrichMinCandidates：仅缺 L2 建议的条目只补建议，不重跑 L1 不改状态', async () => {
  const candidate = {
    id: 'l2-only',
    review_status: 'pending',
    title: '已有初审结论',
    l1_review: { verdict: 'hold', confidence: 0.5, reasons: [] },
    summary: '已有摘要',
    localizations: { zh: { title: '中文标题', description: '中文描述' } },
  };
  const store = { candidates: [candidate] };

  const work = countEnrichmentWork([candidate]);
  assert.equal(work.review, 1);
  assert.equal(work.summary, 0);
  assert.equal(work.localize, 0);

  let reviewCalls = 0;
  const result = await enrichMinCandidates(store, {}, {
    skipSummary: true,
    skipLocalize: true,
    writeStore: () => {},
    reviewCandidate: async () => {
      reviewCalls += 1;
      return { verdict: 'hold', confidence: 0.5, reasons: ['人工参考建议'] };
    },
  });

  assert.equal(reviewCalls, 1, '只应调用一次 L2 建议，绝不重跑 L1');
  assert.equal(result.reviewed, 1);
  assert.equal(result.pending, 1);
  assert.equal(candidate.review_status, 'pending', 'L2 建议不得改动审核状态');
  assert.equal(candidate.l1_review.verdict, 'hold');
  assert.equal(candidate.summary, '已有摘要');
  assert.deepEqual(candidate.ai_advice.reasons, ['人工参考建议']);
});

test('enrichMinCandidates：force 失败时回滚既有摘要与翻译', async () => {
  const candidate = {
    id: 'force-rollback',
    review_status: 'pending',
    title: 'Title',
    description: 'Desc',
    l1_review: { verdict: 'hold', confidence: 0.5 },
    summary: '既有摘要',
    summary_key_points: ['既有要点'],
    localizations: { zh: { title: '既有标题', description: '既有描述' } },
  };
  const store = { candidates: [candidate] };

  await enrichMinCandidates(store, {}, {
    force: true,
    skipReview: true,
    writeStore: () => {},
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'server error' }),
  });

  // 模型失败时既有摘要与翻译必须原样保留，不得因 force 预删除而丢失
  assert.equal(candidate.summary, '既有摘要');
  assert.deepEqual(candidate.summary_key_points, ['既有要点']);
  assert.equal(candidate.localizations.zh.title, '既有标题');
  assert.equal(candidate.localizations.zh.description, '既有描述');
});

test('limit 校验：非法值拒绝，0 表示零目标', async () => {
  const store = { candidates: [{ id: 'c1', review_status: 'pending', title: 'T' }] };
  await assert.rejects(
    () => enrichMinCandidates(store, {}, { dryRun: true, limit: 'abc' }),
    /非负整数/
  );
  await assert.rejects(
    () => repairIncompleteCandidates(store, {}, { dryRun: true, limit: 'abc' }),
    /非负整数/
  );
  const zero = await enrichMinCandidates(store, {}, {
    dryRun: true, limit: 0, skipSummary: true, skipLocalize: true,
  });
  assert.equal(zero.targetsCount, 0);
});

test('repairIncompleteCandidates：写回遇到并发修改时安全合并，人工结论优先', async () => {
  const candidate = {
    id: 'concurrent-1',
    review_status: 'pending',
    title: 'Title',
    description: 'Desc',
  };
  const store = { schema_version: 1, updated_at: null, candidates: [candidate] };

  // 模拟双通道请求期间维护者通过工作台人工 approved 该条目（带 reviewed_at），摘要仍缺
  const freshStore = {
    schema_version: 1,
    updated_at: null,
    candidates: [{
      id: 'concurrent-1',
      review_status: 'approved',
      reviewed_at: '2026-09-03T08:00:00Z',
      title: 'Title',
      description: 'Desc',
    }],
  };

  const reviewCandidateA = async () => ({ verdict: 'approve', confidence: 0.95, reasons: [] });
  const fetchImplA = async () => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ summary: '通道A摘要', key_points: ['要点'] }) } }] }),
  });

  const written = [];
  const result = await repairIncompleteCandidates(store, {}, {
    reviewCandidateA,
    fetchImplA,
    reviewCandidateB: async () => { throw new Error('外部通道结果不应被采纳'); },
    fetchImplB: async () => { throw new Error('外部通道结果不应被采纳'); },
    readStore: () => structuredClone(freshStore),
    writeStore: (s, runId) => written.push({ store: s, runId }),
  });

  assert.equal(result.repairedReview, 1);
  assert.equal(written.length, 1);
  const merged = written[0].store.candidates[0];
  // 人工结论优先：approved + reviewed_at 保留，AI 的 l1_review/ai_advice 不覆盖
  assert.equal(merged.review_status, 'approved');
  assert.equal(merged.reviewed_at, '2026-09-03T08:00:00Z');
  assert.equal(merged.l1_review, undefined);
  // 仍缺失的摘要被通道 A 结果补齐
  assert.equal(merged.summary, '通道A摘要');
});

test('repairIncompleteCandidates：严格遵守不变量门禁（人工审核与受保护字幕）', async () => {
  const manualItem = {
    id: 'm1',
    review_status: 'pending',
    reviewed_at: '2026-09-02T12:00:00Z', // 人工已审
    title: '人工审核过的数据',
    description: '人工描述',
  };

  const protectedItem = {
    id: 'p1',
    review_status: 'approved',
    title: 'YouTube优质视频',
    description: '视频简介',
    transcript_summarized_at: '2026-09-02T10:00:00Z', // 受保护字幕总结
    summary: '高质量付费字幕深度总结',
  };

  const store = { schema_version: 1, candidates: [manualItem, protectedItem] };

  const reviewCandidateMock = async () => {
    return { verdict: 'discard', confidence: 0.99, reasons: ['尝试篡改'] };
  };

  const fetchImplMock = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: '篡改的普通摘要',
              key_points: [],
              title: '修复翻译',
              description: '修复翻译描述',
            }),
          },
        }],
      }),
    };
  };

  await repairIncompleteCandidates(store, {}, {
    reviewCandidate: reviewCandidateMock,
    fetchImpl: fetchImplMock,
    dryRun: true,
  });

  // 不变量 1：人工审核状态与 reviewed_at 绝不被推翻
  assert.equal(manualItem.review_status, 'pending');
  assert.equal(manualItem.reviewed_at, '2026-09-02T12:00:00Z');

  // 不变量 2：受保护的字幕总结绝不被覆盖
  assert.equal(protectedItem.summary, '高质量付费字幕深度总结');
  assert.equal(protectedItem.transcript_summarized_at, '2026-09-02T10:00:00Z');
  // 但其缺失的 localizations 可以被正常补齐
  assert.equal(protectedItem.localizations?.zh?.title, '修复翻译');
});

test('repairIncompleteCandidates：无残缺项时快速返回', async () => {
  const store = {
    candidates: [
      {
        id: 'c1',
        review_status: 'approved',
        summary: '摘要',
        localizations: { zh: { title: '标题' } },
      },
    ],
  };

  const result = await repairIncompleteCandidates(store, {}, { dryRun: true });
  assert.equal(result.totalTargets, 0);
  assert.equal(result.repairedReview, 0);
  assert.equal(result.remainingIncomplete, 0);
});
