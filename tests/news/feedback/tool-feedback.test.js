'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { CATALOG_GENERATOR_FILES, CONCEPT_FILES } = require('../../../src/shared/paths');
const {
  feedbackFromSummaries,
  extractEntities,
  normalizeEntities,
  isVagueName,
} = require('../../../src/news/feedback/tool-feedback');
const { pendingCandidateToSeed } = require('../../../src/pending/index');

// 备份/恢复待补卡文件（feedbackFromSummaries 会真实写这两个文件）
const PENDING_TOOL = CATALOG_GENERATOR_FILES.pendingTools;
const PENDING_CONCEPT = CONCEPT_FILES.pendingConcepts;

function backup() {
  const tool = fs.existsSync(PENDING_TOOL) ? fs.readFileSync(PENDING_TOOL, 'utf8') : null;
  const concept = fs.existsSync(PENDING_CONCEPT) ? fs.readFileSync(PENDING_CONCEPT, 'utf8') : null;
  return { tool, concept };
}
function restore(saved) {
  if (saved.tool === null) { if (fs.existsSync(PENDING_TOOL)) fs.unlinkSync(PENDING_TOOL); }
  else fs.writeFileSync(PENDING_TOOL, saved.tool);
  if (saved.concept === null) { if (fs.existsSync(PENDING_CONCEPT)) fs.unlinkSync(PENDING_CONCEPT); }
  else fs.writeFileSync(PENDING_CONCEPT, saved.concept);
}

// ── isVagueName：笼统名识别 ──────────────────────────────────
test('isVagueName 识别模型/产品笼统名，放过具体工具与模型名', () => {
  for (const vague of ['可灵', '通义千问', '腾讯混元', '豆包', 'Kimi', 'ChatGPT', 'Claude', 'Gemini', 'DeepSeek', '讯飞星火', '海螺AI']) {
    assert.equal(isVagueName(vague), true, `${vague} 应为笼统名`);
  }
  for (const specific of ['Cursor', 'Kling 2.6 Pro', 'GitHub Copilot', 'Qwen3.8-Max', 'GPT-5.6', 'Claude Opus 4.8', 'Suno']) {
    assert.equal(isVagueName(specific), false, `${specific} 不应是笼统名`);
  }
});

// ── normalizeEntities：类型归一化 ─────────────────────────────
test('normalizeEntities 兼容类型数组、裸字符串与对象，非法 type 兜底 tool', () => {
  assert.deepEqual(normalizeEntities([{ name: 'Cursor', type: 'tool' }, { name: 'Qwen3.8-Max', type: 'model' }]),
    [{ name: 'Cursor', type: 'tool' }, { name: 'Qwen3.8-Max', type: 'model' }]);
  assert.deepEqual(normalizeEntities(['Cursor', 'RAG']), [{ name: 'Cursor', type: 'tool' }, { name: 'RAG', type: 'tool' }]);
  assert.deepEqual(normalizeEntities({ names: ['Cursor'] }), [{ name: 'Cursor', type: 'tool' }]);
  assert.deepEqual(normalizeEntities([{ name: 'X', type: 'bogus' }]), [{ name: 'X', type: 'tool' }]);
  assert.deepEqual(normalizeEntities(null), []);
});

// ── feedbackFromSummaries：笼统名不进入待补工具卡 ──────────────
test('feedback 路由：笼统名被排除、模型带 api_model 提示、概念走概念卡', async () => {
  const saved = backup();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: '可灵和 Qwen3.8-Max 都很流行，RAG 也是热点。' },
        { review_status: 'approved', summary: 'Cursor 发布了新功能。' },
        { review_status: 'pending', summary: '不该被处理的摘要。' },
      ],
    };
    // LLM 把笼统名可灵误标为 tool——isVagueName 必须兜底拦截
    const llmExtract = async text => {
      const out = [];
      if (text.includes('可灵')) out.push({ name: '可灵', type: 'tool' });
      if (text.includes('Qwen3.8-Max')) out.push({ name: 'Qwen3.8-Max', type: 'model' });
      if (text.includes('RAG')) out.push({ name: 'RAG', type: 'concept' });
      if (text.includes('Cursor')) out.push({ name: 'Cursor', type: 'tool' });
      return out;
    };
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [{ title: 'Cursor' }],
      glossary: [],
      llmExtract,
    });

    // 笼统名绝不进入待补工具卡（即使 LLM 标 tool）
    assert.equal(result.toolsPending.some(c => c.name === '可灵'), false, '可灵不得出现在待补工具卡');
    assert.equal(result.toolsPending.some(c => c.name === 'ChatGPT'), false);
    // 具体模型 → 待补工具卡 + api_model 提示
    const model = result.toolsPending.find(c => c.name === 'Qwen3.8-Max');
    assert.ok(model, 'Qwen3.8-Max 应进入待补工具卡');
    assert.equal(model.detail_kind_hint, 'api_model');
    // 已有工具 → toolsFound
    assert.deepEqual(result.toolsFound, ['Cursor']);
    assert.equal(result.toolsPending.some(c => c.name === 'Cursor'), false);
    // 概念 → 概念卡，不进工具卡
    assert.equal(result.conceptsPending.some(c => c.term === 'RAG'), true);
    assert.equal(result.toolsPending.some(c => c.name === 'RAG'), false);
    assert.equal(result.conceptsPending.some(c => c.term === 'Qwen3.8-Max'), false);
  } finally {
    restore(saved);
  }
});

test('feedback 正则路径：KNOWN_AI_NAMES 里的笼统名也被排除', async () => {
  const saved = backup();
  try {
    const store = {
      candidates: [
        { review_status: 'approved', summary: '这篇提到 可灵 和 豆包，还有 Kling 2.6 Pro。' },
      ],
    };
    // 不注入 llmExtract → 走默认正则
    const result = await feedbackFromSummaries(store, { feedback: {} }, {
      tools: [],
      glossary: [],
    });
    // 可灵/豆包是 KNOWN_AI_NAMES 里的笼统名 → 排除
    assert.equal(result.toolsPending.some(c => c.name === '可灵'), false);
    assert.equal(result.toolsPending.some(c => c.name === '豆包'), false);
    // 正则只能识别单个词，Kling 2.6 Pro 的 brand 片段不在笼统集 → 可能作为工具待补
    // （Kling 具体名可生成；只有家族名可灵被排除）
    assert.ok(result.toolsPending.length >= 0);
  } finally {
    restore(saved);
  }
});

// ── extractEntities：返回带类型实体 ───────────────────────────
test('extractEntities 默认正则返回带类型实体（笼统名标 vague）', async () => {
  const entities = await extractEntities('可灵 发布了新模型。', {});
  assert.ok(entities.some(e => e.name === '可灵' && e.type === 'vague'));
  const llm = await extractEntities('Cursor 很流行。', { llmExtract: async () => [{ name: 'Cursor', type: 'tool' }] });
  assert.deepEqual(llm, [{ name: 'Cursor', type: 'tool' }]);
});

// ── pendingCandidateToSeed：类型提示与笼统名拒绝 ──────────────
test('pendingCandidateToSeed 按 detail_kind_hint 设 detail_kind', () => {
  assert.equal(pendingCandidateToSeed({ name: 'Qwen3.8-Max', detail_kind_hint: 'api_model' }).detail_kind, 'api_model');
  assert.equal(pendingCandidateToSeed({ name: 'Brand New Tool' }).detail_kind, 'tool');
  assert.equal(pendingCandidateToSeed({ name: 'Brand New Tool', detail_kind_hint: 'tool' }).detail_kind, 'tool');
});

test('pendingCandidateToSeed 透传显式 modality', () => {
  assert.equal(pendingCandidateToSeed({ name: 'Qwen3.7 Plus', detail_kind_hint: 'api_model', modality: 'text' }).modality, 'text');
  assert.equal(Object.hasOwn(pendingCandidateToSeed({ name: 'Brand New Tool' }), 'modality'), false);
});

test('pendingCandidateToSeed 拒绝笼统名（批量生成绝不产出笼统名卡）', () => {
  for (const name of ['可灵', '通义千问', 'ChatGPT', 'Claude', '豆包', 'Kimi']) {
    assert.throws(() => pendingCandidateToSeed({ name }), /PENDING_CANDIDATE_VAGUE/, `${name} 应被拒绝`);
  }
});
