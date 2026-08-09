/**
 * review-v2-disclosure.test.js —— YouTube AI 生成披露 L0 硬排除测试
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { l0HardFilter } = require('../../src/news/min/review-v2');

const config = { keywords: { ai_keywords: ['ai', 'gemini', '模型'] } };
const base = {
  platform: 'youtube',
  title: 'AI 视频标题',
  url: 'https://www.youtube.com/watch?v=test',
  published_at: '2026-08-09T00:00:00.000Z',
};

test('L0：中文 AI 生成披露模板直接硬排除', () => {
  const result = l0HardFilter({
    ...base,
    description: '内容制作方式\n由 AI 生成\n声音或影像内容经过加工或完全由 AI 生成。',
  }, config);
  assert.deepEqual(result, { pass: false, reason: 'ai_generated_disclosure' });
});

test('L0：AI使用披露模板直接硬排除', () => {
  const result = l0HardFilter({
    ...base,
    description: 'AI使用披露：本视频的画面由AI生成式工具制作。剧本创意、剪辑编排及整体叙事方向为人工原创。AI仅作为辅助创作工具使用。',
  }, config);
  assert.deepEqual(result, { pass: false, reason: 'ai_generated_disclosure' });
});

test('L0：英文 AI Disclosure 模板直接硬排除', () => {
  const result = l0HardFilter({
    ...base,
    description: 'AI Disclosure: The visuals in this video were generated using AI tools.',
  }, config);
  assert.deepEqual(result, { pass: false, reason: 'ai_generated_disclosure' });
});

test('L0：普通 AI-generated 文本不直接排除', () => {
  const result = l0HardFilter({
    ...base,
    description: 'This is an AI-generated tutorial explaining RAG and model evaluation.',
  }, config);
  assert.equal(result.pass, true);
});

test('L0：披露硬排除只作用于 YouTube，不误伤 X', () => {
  const result = l0HardFilter({
    ...base,
    platform: 'x',
    description: 'AI使用披露：本视频的画面由AI生成式工具制作。',
  }, config);
  assert.equal(result.pass, true);
});
