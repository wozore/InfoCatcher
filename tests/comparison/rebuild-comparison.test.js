'use strict';

/**
 * rebuild-comparison.test.js — 模型对比管线核心回归
 *
 * 覆盖：主键对齐（含 models-alias 覆盖自动规则）、15 config 合并、维度归一化、
 * 综合分缺源按比例重分配、性价比 min-max、单源模型、无综合分模型、
 * LiveBench CSV 聚合与 llm-stats RSC 解析。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { rebuildIntegrated, buildAliasMap, lmarenaParse, livebenchParse, openrouterCanonical } = require('../../src/comparison/rebuild-comparison');
const { parseCsv, aggregateGroups } = require('../../src/comparison/fetch-livebench');
const { extractFlightChunks, extractInitialData } = require('../../src/comparison/fetch-llm-stats');
const { validateLmarenaSnapshot, normalizeLmarena, normalizeIndex } = require('../../src/comparison/compare-schema');

const FIXTURES = path.join(__dirname, 'fixtures', 'raw');
const readFixture = name => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));

function buildSnapshots() {
  return {
    openrouter: readFixture('openrouter.json'),
    lmarena: readFixture('lmarena.json'),
    livebench: readFixture('livebench.json'),
    llm_stats: readFixture('llm-stats.json'),
  };
}

test('rebuild：对齐 4 源、归一化、综合分缺源重分配、性价比', () => {
  const result = rebuildIntegrated({ snapshots: buildSnapshots(), aliasEntries: [], write: false });
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.models.length, 8); // gpt/claude/o3/qwen/deepseek/kimi/midjourney/runway-gen-4
  const byCanonical = new Map(result.models.map(model => [model.canonical, model]));

  // GPT-5.6 Sol：4 源、非开源 → 综合分 {lmarena:.65, livebench:.35}
  const gpt = byCanonical.get('gpt-5.6-sol');
  assert.ok(gpt, 'gpt-5.6-sol 存在');
  assert.equal(gpt.open_source, false);
  assert.equal(gpt.single_source, false);
  assert.deepEqual(gpt.degrees, { lmarena: ['High'], livebench: ['high'] });
  assert.deepEqual(gpt.default_degree, { lmarena: 'High', livebench: 'high' });
  assert.equal(gpt.composite.method, 'proportional_redistribute');
  assert.deepEqual(gpt.composite.weights, { lmarena: 0.65, livebench: 0.35 });
  // agent 0.09 → (0.39/0.5)*100=78；lbAvg=(84+86+83+80+79+75+82)/7≈81.29；.65*78+.35*81.29≈79.15
  assert.ok(Math.abs(gpt.composite.score - 79.1) < 0.3, `gpt composite ≈79.1，实际 ${gpt.composite.score}`);
  assert.equal(gpt.dimensions.reasoning.source, 'livebench');
  assert.equal(gpt.dimensions.reasoning.value, 84);
  // 数学推理：aime_2025 优先（llm_stats）
  assert.equal(gpt.dimensions.math_reasoning.source, 'llm_stats');
  assert.equal(gpt.dimensions.math_reasoning.value, 92);
  assert.equal(gpt.dimensions.math_reasoning.note, 'aime_2025');
  // 性价比：综合分 ÷ 平均每 M 价 → 0-100
  assert.ok(gpt.value && gpt.value.score >= 0 && gpt.value.score <= 100, 'gpt 有性价比');

  // Claude Opus 5：变体 High/XHigh
  const claude = byCanonical.get('claude-opus-5');
  assert.ok(claude);
  assert.deepEqual(claude.degrees.lmarena, ['High', 'XHigh']);
  assert.equal(claude.default_degree.lmarena, 'High');
  assert.ok(claude.lmarena_scores.agent.High && claude.lmarena_scores.agent.XHigh);
  assert.equal(claude.license, 'Proprietary');
  assert.equal(claude.context_length, 1000000);

  // o3-mini：无 LMArena → 综合分按重分配退化为纯 LiveBench；livebench 变体 high/low
  const o3 = byCanonical.get('o3-mini');
  assert.ok(o3);
  assert.equal(o3.single_source, false);
  assert.deepEqual(o3.degrees.livebench, ['high', 'low']);
  assert.equal(o3.composite.method, 'proportional_redistribute');
  assert.deepEqual(o3.composite.weights, { livebench: 1 }); // 非开源公式 {lmarena, livebench} 仅 livebench 可用
  assert.ok(Math.abs(o3.composite.score - 76.7) < 0.3, `o3 composite ≈76.7，实际 ${o3.composite.score}`);
  assert.equal(o3.dimensions.reasoning.value, 88); // livebench high
  assert.equal(o3.dimensions.math_reasoning.value, 94); // aime 优先于 livebench math

  // qwen：开源 + llm_stats → 三源公式，livebench 缺源按比例重分配
  const qwen = byCanonical.get('qwen3.8-27b');
  assert.ok(qwen);
  assert.equal(qwen.open_source, true);
  assert.deepEqual(new Set(Object.keys(qwen.composite.weights)), new Set(['lmarena', 'llm_stats']));
  assert.equal(Math.abs(qwen.composite.weights.lmarena - 0.6429) < 0.001, true);
  assert.equal(Math.abs(qwen.composite.weights.llm_stats - 0.3571) < 0.001, true);
  assert.ok(Math.abs(qwen.composite.score - 80.8) < 0.3, `qwen composite ≈80.8，实际 ${qwen.composite.score}`);

  // midjourney：单源 lmarena、无综合分；Elo 榜单值 min-max 归一化为 100
  const mid = byCanonical.get('midjourney-v7');
  assert.ok(mid);
  assert.equal(mid.single_source, true);
  assert.equal(mid.composite, null);
  assert.equal(mid.dimensions.text_to_image.value, 100);

  // kimi：无 lmarena/livebench → 无综合分，仅 llm_stats/openrouter
  const kimi = byCanonical.get('kimi-k3');
  assert.ok(kimi);
  assert.equal(kimi.composite, null);
  assert.equal(kimi.dimensions.long_context.value, 92); // index_long_context 53.6 → (73.6/80)*100

  // runway：单源 lmarena（视频模型）
  const runway = byCanonical.get('runway-gen-4');
  assert.ok(runway);
  assert.equal(runway.single_source, true);
  assert.ok(runway.dimensions.text_to_video);
});

test('rebuild：models-alias 覆盖自动主键规则', () => {
  const snapshots = buildSnapshots();
  snapshots.openrouter.data = snapshots.openrouter.data.filter(item => item.id === 'openai/gpt-5.6-sol');
  const aliasEntries = [
    { canonical: 'renamed-gpt', aliases: { openrouter: ['openai/gpt-5.6-sol'], lmarena: ['GPT-5.6 Sol (High)'] } },
  ];
  const result = rebuildIntegrated({ snapshots, aliasEntries, write: false });
  assert.equal(result.ok, true);
  const models = new Map(result.models.map(model => [model.canonical, model]));
  assert.ok(models.has('renamed-gpt'), 'alias 覆盖后 canonical 为 renamed-gpt');
  assert.equal(models.get('renamed-gpt').display, 'GPT-5.6 Sol');
});

test('rebuild：raw 快照缺失 → 拒绝重建（全绿才重建）', () => {
  const result = rebuildIntegrated({ snapshots: { openrouter: {}, lmarena: null, livebench: null, llm_stats: null }, write: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('raw 快照缺失')));
});

test('主键规范化：lmarena 程度/日期、livebench degree、openrouter vendor 前缀', () => {
  assert.deepEqual(lmarenaParse('Claude Opus 5 (High)'), { base: 'Claude Opus 5', degree: 'High' });
  assert.deepEqual(lmarenaParse('Midjourney v7'), { base: 'Midjourney v7', degree: null });
  assert.deepEqual(livebenchParse('o3-mini-2025-01-31-high'), { base: 'o3-mini', degree: 'high' });
  assert.deepEqual(livebenchParse('deepseek-v4-flash'), { base: 'deepseek-v4-flash', degree: null });
  assert.equal(openrouterCanonical('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(openrouterCanonical('openai/gpt-5.6-sol-20260814'), 'gpt-5.6-sol'); // 日期多版本取最新
});

test('LiveBench CSV 解析与类别聚合', () => {
  const csv = [
    'model,code_completion,code_generation,math_comp,typos',
    'o3-mini-high,80,84,92,70',
    'o3-mini-low,60,64,82,55',
  ].join('\n');
  const categories = { Coding: ['code_completion', 'code_generation'], Mathematics: ['math_comp'], Language: ['typos'] };
  const rows = parseCsv(csv);
  const groups = aggregateGroups(rows, categories);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].model, 'o3-mini-high');
  assert.equal(groups[0].coding, 82); // (80+84)/2
  assert.equal(groups[0].math, 92);
  assert.equal(groups[0].language, 70);
});

test('llm-stats RSC flight payload 提取 initialData', () => {
  const html = '<script>self.__next_f.push([1,"21:[[\\"$\\",\\"$L2c\\",null,{\\"initialData\\":[{\\"model_id\\":\\"claude-opus-5\\",\\"index_general\\":56.28}]}]]"])</script>';
  const initialData = extractInitialData(extractFlightChunks(html));
  assert.ok(initialData);
  assert.equal(initialData[0].model_id, 'claude-opus-5');
  assert.equal(initialData[0].index_general, 56.28);
});

test('LMArena snapshot 白名单校验 fail-closed（缺列拒绝）', () => {
  const scoreRow = { model_name: 'A', organization: 'o', license: 'L', score: 0.1, score_ci_lower: 0, score_ci_upper: 0.2, observation_count: 1, session_count: 1, rank: 1, category: 'overall', leaderboard_publish_date: '2026-01-01' };
  const ratingRow = { model_name: 'A', organization: 'o', license: 'L', rating: 1300, rating_lower: 1290, rating_upper: 1310, variance: 8, vote_count: 10, rank: 1, category: 'overall', leaderboard_publish_date: '2026-01-01' };
  const agentConfigs = ['agent', 'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit'];
  const configs = {};
  for (const config of ['agent', 'text', 'vision', 'webdev', 'search', 'text_to_image', 'image_edit', 'image_to_video', 'text_to_video', 'video_edit', 'agent_praise_complaint', 'agent_steerability', 'agent_bash_recovery_steps', 'agent_tool_hallucination', 'agent_task_outcome_explicit']) {
    configs[config] = [agentConfigs.includes(config) ? scoreRow : ratingRow];
  }
  assert.equal(validateLmarenaSnapshot({ fetched_at: 'x', configs }).ok, true);
  const bad = { fetched_at: 'x', configs: { agent: [{ model_name: 'A' }] } };
  const result = validateLmarenaSnapshot(bad);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test('归一化口径（契约 §2）', () => {
  assert.ok(Math.abs(normalizeLmarena(0.1219) - 84.38) < 0.001);
  assert.ok(Math.abs(normalizeLmarena(-0.2) - 20) < 0.001);
  assert.ok(Math.abs(normalizeIndex(56.28) - 95.35) < 0.001);
  assert.equal(normalizeIndex(-20), 0);
});

test('buildAliasMap 命中登记表', () => {
  const map = buildAliasMap([{ canonical: 'x', aliases: { openrouter: ['vendor/x-2026'], livebench: ['x-high'] } }]);
  assert.equal(map.openrouter['vendor/x-2026'], 'x');
  assert.equal(map.livebench['x-high'], 'x');
});
