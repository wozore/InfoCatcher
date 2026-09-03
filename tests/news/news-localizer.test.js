/**
 * news-localizer.test.js —— 内容本地化（多语言翻译）测试（content-localizer）
 *
 * 测试原理：
 *   不请求真实网络，注入 mock fetchImpl 验证：
 *     1. buildLocalizePayload 输入裁剪与占位符替换；
 *     2. normalizeLocalization 解析模型输出的 JSON 容错；
 *     3. localizeWithDeepSeek 成功/缺 key/网络失败/输出无法解析降级；
 *     4. localizeCandidate 无素材不调 LLM/成功/失败降级；
 *     5. localizeCandidates 批量、跳过已有 localizations[locale]；
 *     6. enrichCandidateLocalizations 管线钩子按开关与条件过滤、maxItems 截断；
 *     7. mergeCandidatesMin 保留既有 review_status（重新采集不重置人工结论）；
 *     8. toPublicItemMin / buildDailyProjection 透传 localizations、
 *        剔除内部痕迹 localizations_meta。
 *
 * 运行方式：node --test tests/news/news-localizer.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildLocalizePayload,
  normalizeLocalization,
  localizeWithDeepSeek,
} = require('../../src/news/classify/llm-provider');
const {
  collectLocalizeSource,
  localizeCandidate,
  localizeCandidates,
  enrichCandidateLocalizations,
} = require('../../src/news/classify/content-localizer');
const {
  mergeCandidatesMin,
  toPublicItemMin,
} = require('../../src/news/min/min-store');
const { buildDailyProjection } = require('../../src/news/min/daily-projection');

/** 构造一个 DeepSeek 成功响应（content 为模型输出文本）。 */
function deepSeekOk(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** 按 URL 返回响应的 mock fetchImpl。 */
function mockFetch(respond) {
  return async url => respond(String(url));
}

// ── 第 1 组：buildLocalizePayload（llm-provider）────

test('buildLocalizePayload 裁剪标题/描述并替换占位符', () => {
  const payload = buildLocalizePayload({
    title: 't'.repeat(300),
    description: 'd'.repeat(700),
  });
  const user = payload.messages[1].content;
  assert.ok(user.includes('t'.repeat(200)));
  assert.ok(!user.includes('t'.repeat(300)));
  assert.ok(user.includes('d'.repeat(600)));
  assert.ok(!user.includes('d'.repeat(700)));
  assert.equal(payload.temperature, 0);
  assert.equal(payload.stream, false);
  assert.equal(payload.max_tokens, 400);
});

test('buildLocalizePayload 缺素材时占位符填空', () => {
  const user = buildLocalizePayload({ title: '标题' }).messages[1].content;
  assert.ok(user.includes('标题'));
  assert.ok(user.includes('（无描述）'));
});

// ── 第 2 组：normalizeLocalization 容错 ─────────────

test('normalizeLocalization 解析标准 JSON', () => {
  const parsed = normalizeLocalization('{"title":"中文标题","description":"中文描述"}');
  assert.deepEqual(parsed, { title: '中文标题', description: '中文描述' });
});

test('normalizeLocalization 容忍 markdown 代码块与前后多余文字', () => {
  const parsed = normalizeLocalization('```json\n{"title":"标题","description":"描述"}\n```');
  assert.deepEqual(parsed, { title: '标题', description: '描述' });
  const parsed2 = normalizeLocalization('好的，翻译如下：{"title":"标题","description":"描述"}末尾');
  assert.deepEqual(parsed2, { title: '标题', description: '描述' });
});

test('normalizeLocalization 字段缺失/空串/非法返回 null', () => {
  assert.deepEqual(normalizeLocalization('{"title":"","description":"  "}'), null);   // 均空 → null
  assert.deepEqual(normalizeLocalization('{"description":"只有描述"}'), { title: '', description: '只有描述' });
  assert.equal(normalizeLocalization('不是 JSON'), null);
  assert.equal(normalizeLocalization(''), null);
});

// ── 第 3 组：localizeWithDeepSeek 降级语义 ──────────

test('localizeWithDeepSeek 缺 key：resolve 降级不 reject', async () => {
  const result = await localizeWithDeepSeek({ title: 't' }, { apiKey: '' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing_api_key');
});

test('localizeWithDeepSeek 网络失败：resolve 降级', async () => {
  const result = await localizeWithDeepSeek({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => { throw new Error('network down'); }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'network_error');
});

test('localizeWithDeepSeek 输出无法解析：invalid_translation', async () => {
  const result = await localizeWithDeepSeek({ title: 't' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('我不懂你在说什么')),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_translation');
});

test('localizeWithDeepSeek 成功：返回翻译标题/描述', async () => {
  const result = await localizeWithDeepSeek({ title: 'DeepSeek V4 released', description: 'New model' }, {
    apiKey: 'key',
    fetchImpl: mockFetch(() => deepSeekOk('{"title":"DeepSeek V4 发布","description":"新模型"}')),
  });
  assert.equal(result.ok, true);
  assert.equal(result.title, 'DeepSeek V4 发布');
  assert.equal(result.description, '新模型');
});

// ── 第 4 组：collectLocalizeSource / localizeCandidate ──

test('collectLocalizeSource 提取标题/描述（去除纯空）', () => {
  assert.deepEqual(collectLocalizeSource({ title: '标题', description: '描述' }), { title: '标题', description: '描述' });
  assert.deepEqual(collectLocalizeSource({ title: '标题' }), { title: '标题', description: '' });
  assert.deepEqual(collectLocalizeSource({}), { title: '', description: '' });
});

test('localizeCandidate 无素材：返回 no_source 不调 LLM', async () => {
  let calls = 0;
  const result = await localizeCandidate({}, {
    fetchImpl: mockFetch(() => { calls += 1; return deepSeekOk('{}'); }),
  });
  assert.equal(result.title, null);
  assert.equal(result.llm_error, 'no_source');
  assert.equal(calls, 0);
});

test('localizeCandidate 成功：含 localizer/input_chars', async () => {
  const result = await localizeCandidate({ title: '标题', description: '描述' }, {
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"title":"翻译标题","description":"翻译描述"}')),
  });
  assert.equal(result.title, '翻译标题');
  assert.equal(result.description, '翻译描述');
  assert.equal(result.localizer, 'llm_deepseek');
  assert.ok(result.generated_at);
  assert.equal(result.input_chars, '标题'.length + '描述'.length);
  assert.equal(result.llm_error, null);
});

test('localizeCandidate 失败：title/description 置 null、localizer=llm_failed', async () => {
  const result = await localizeCandidate({ title: '标题', description: '描述' }, {
    fetchImpl: mockFetch(() => deepSeekOk('无法解析')),
  });
  assert.equal(result.title, null);
  assert.equal(result.localizer, 'llm_failed');
  assert.ok(result.llm_error);
});

// ── 第 5 组：localizeCandidates 批量 ────────────────

test('localizeCandidates：批量成功写入 localizations[locale]', async () => {
  const items = [
    { id: 'a', title: 'A title', description: 'A desc' },
    { id: 'b', title: 'B title', description: 'B desc' },
  ];
  const result = await localizeCandidates(items, {
    locale: 'zh',
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"title":"中文","description":"中描述"}')),
  });
  assert.equal(result.localized, 2);
  assert.equal(result.skipped, 0);
  assert.equal(items[0].localizations.zh.title, '中文');
  assert.equal(items[1].localizations.zh.description, '中描述');
  assert.ok(items[0].localizations_meta.zh.localizer);   // 内部痕迹
});

test('localizeCandidates：跳过已有 localizations[locale] 与无素材条目', async () => {
  const items = [
    { id: 'has', title: '已有', localizations: { zh: { title: '已有中文' } } },
    { id: 'empty', title: '' },
    { id: 'new', title: '新条目' },
  ];
  const result = await localizeCandidates(items, {
    locale: 'zh',
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"title":"中文","description":"描述"}')),
  });
  assert.equal(result.localized, 1);
  assert.equal(result.skipped, 2);
  assert.equal(items[0].localizations.zh.title, '已有中文');   // 不覆盖既有
  assert.equal(items[1].localizations, undefined);
  assert.equal(items[2].localizations.zh.title, '中文');
});

test('localizeCandidates：LLM 全失败时 localized=0 且不写 localizations（回退原文）', async () => {
  const items = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
  const result = await localizeCandidates(items, {
    fetchImpl: mockFetch(() => deepSeekOk('bad output')),
  });
  assert.equal(result.localized, 0);
  assert.equal(items[0].localizations, undefined);              // 不写翻译
  assert.ok(items[0].localizations_meta.zh.llm_error);          // 留错误痕迹便于排查
});

// ── 第 6 组：enrichCandidateLocalizations 管线钩子 ───

function enrichStore(candidates) {
  return { schema_version: 1, updated_at: null, candidates };
}

test('开关关闭：不发起任何 LLM 调用，返回零计数', async () => {
  let calls = 0;
  const store = enrichStore([{ id: 'a', title: 'A' }]);
  const counts = await enrichCandidateLocalizations(store, ['a'], {
    enabled: false,
    fetchImpl: mockFetch(() => { calls += 1; return deepSeekOk('{}'); }),
  });
  assert.deepEqual(counts, { enabled: false, localized: 0, skipped: 0 });
  assert.equal(calls, 0);
});

test('开启：只处理 activeIds 内无 localizations[locale] 的候选', async () => {
  const store = enrichStore([
    { id: 'a', title: 'A' },
    { id: 'has', title: 'B', localizations: { zh: { title: '已有' } } },
    { id: 'outside', title: 'D' },
  ]);
  const counts = await enrichCandidateLocalizations(store, ['a', 'has'], {
    enabled: true,
    locale: 'zh',
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"title":"中文","description":"描述"}')),
  });
  assert.equal(counts.localized, 1);       // 只有 a 通过条件
  assert.equal(store.candidates.find(c => c.id === 'a').localizations.zh.title, '中文');
  assert.equal(store.candidates.find(c => c.id === 'has').localizations.zh.title, '已有');   // 保留既有
  assert.equal(store.candidates.find(c => c.id === 'outside').localizations, undefined);     // 不在 activeIds
});

test('受 maxItems 截断', async () => {
  const store = enrichStore([
    { id: 'a', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' },
  ]);
  const counts = await enrichCandidateLocalizations(store, ['a', 'b', 'c'], {
    enabled: true,
    maxItems: 2,
    apiKey: 'test-key',
    fetchImpl: mockFetch(() => deepSeekOk('{"title":"中文","description":"描述"}')),
  });
  assert.equal(counts.localized, 2);
  const localizedCount = store.candidates.filter(c => c.localizations).length;
  assert.equal(localizedCount, 2);
});

test('localizeCandidates：部分本地化结果不计为完成并可重试', async () => {
  const item = {
    id: 'partial',
    title: 'English title',
    description: 'English description',
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ title: '中文标题' }) } }],
    }),
  });

  const result = await localizeCandidates([item], { fetchImpl, apiKey: 'test-key' });
  assert.equal(result.localized, 0);
  assert.equal(item.localizations.zh.title, '中文标题');
  assert.equal(item.localizations.zh.description, '');
});



test('mergeCandidatesMin 保留既有 review_status，重新采集不重置人工结论', () => {
  const prev = { schema_version: 1, updated_at: null, candidates: [
    { id: 'a', title: '旧', review_status: 'approved', top_selected: true, localizations: { zh: { title: '旧中文', description: '旧描述' } } },
  ] };
  // 下一轮 incoming 无 review_status（本轮未重新审核）→ 保留既有 approved
  const store1 = mergeCandidatesMin(prev, [{ id: 'a', title: '新标题' }]);
  assert.equal(store1.candidates[0].review_status, 'approved');
  assert.equal(store1.candidates[0].top_selected, true);
});

test('mergeCandidatesMin 保留既有字幕、总结和本地化加工结果', () => {
  const previous = {
    candidates: [{
      id: 'processed',
      review_status: 'approved',
      transcript: '人工上传字幕',
      transcript_file: 'processed/source.srt',
      transcript_summarized_at: '2026-09-02T10:00:00Z',
      transcript_summary_llm: 'deepseek',
      summary: '既有总结',
      summary_key_points: ['既有要点'],
      localizations: { zh: { title: '既有中文标题', description: '既有中文描述' } },
      localizations_meta: { zh: { localizer: 'llm_deepseek' } },
    }],
  };

  const merged = mergeCandidatesMin(previous, [{
    id: 'processed',
    title: '重新采集标题',
    review_status: 'pending',
  }]);
  const candidate = merged.candidates[0];

  assert.equal(candidate.review_status, 'approved');
  assert.equal(candidate.transcript, '人工上传字幕');
  assert.equal(candidate.transcript_file, 'processed/source.srt');
  // 字幕付费总结的保护元数据必须原子保留，否则保护失效、工作台状态错乱
  assert.equal(candidate.transcript_summarized_at, '2026-09-02T10:00:00Z');
  assert.equal(candidate.transcript_summary_llm, 'deepseek');
  assert.equal(candidate.summary, '既有总结');
  assert.deepEqual(candidate.summary_key_points, ['既有要点']);
  assert.deepEqual(candidate.localizations, { zh: { title: '既有中文标题', description: '既有中文描述' } });
  assert.deepEqual(candidate.localizations_meta, { zh: { localizer: 'llm_deepseek' } });
});



test('toPublicItemMin 保留 localizations、剔除 localizations_meta', () => {
  const publicItem = toPublicItemMin({
    id: 'a', title: '原文', review_status: 'approved',
    localizations: { zh: { title: '中文' } },
    localizations_meta: { zh: { localizer: 'llm_deepseek' } },
  });
  assert.deepEqual(publicItem.localizations, { zh: { title: '中文' } });
  assert.equal(publicItem.localizations_meta, undefined);
  assert.equal(publicItem.review_status, undefined);            // 内部状态仍剔除
});

test('buildDailyProjection 透传 localizations 到公开投影', () => {
  const store = {
    schema_version: 1,
    updated_at: '2026-08-02T00:00:00Z',
    candidates: [
      {
        id: 'a', platform: 'x', native_id: 'n', source_type: 'x_post',
        title: '英文', description: 'English', url: 'https://x.com/a',
        published_at: '2026-08-01T00:00:00Z', source_id: 'src', metrics: {},
        review_status: 'approved', top_selected: true,
        localizations: { zh: { title: '中文标题', description: '中文描述' } },
        localizations_meta: { zh: { localizer: 'llm_deepseek' } },
      },
    ],
  };
  const projection = buildDailyProjection(store, {}, { now: '2026-08-02T00:00:00Z' });
  assert.equal(projection.items.length, 1);
  assert.deepEqual(projection.items[0].localizations, { zh: { title: '中文标题', description: '中文描述' } });
  assert.equal(projection.items[0].localizations_meta, undefined);
});
