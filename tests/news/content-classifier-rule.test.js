/**
 * content-classifier-rule.test.js —— L0 分类层轻量回归测试
 *
 * 关键词只用于主题分类，不再作为娱乐/二创黑名单；简介 AI 披露硬排除由 review-v2.l0HardFilter 负责。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRuleBased } = require('../../src/news/classify/content-classifier');

test('分类器不因短剧/二创关键词直接排除内容', () => {
  const result = classifyRuleBased({
    title: 'AI 短剧制作工具发布：支持二创和连续剧工作流',
    description: 'AI 视频工具更新，支持模型生成和工作流编排',
  });
  assert.notEqual(result.content_type, 'other');
});

test('课程系列中的第N集不被娱乐规则误伤', () => {
  const result = classifyRuleBased({
    title: 'AI 入门课程：Transformer 原理讲解 第10集',
    description: '本课第10集讲解模型原理',
  });
  assert.equal(result.content_type, 'ai_technology');
});

test('真实 AI 产品/行业/技术内容正常分类', () => {
  const cases = [
    { title: 'OpenAI 发布 GPT-5，新功能上线', description: '模型更新，全新能力 available now', expect: 'ai_technology' },
    { title: 'AI 短剧公司获 5000 万融资', description: '微短剧行业融资事件', expect: 'ai_industry' },
    { title: '可灵 AI 动画生成模型开源', description: '开源模型发布', expect: 'ai_technology' },
    { title: 'Claude Code 上新，支持全新 agent 功能', description: '工具更新', expect: 'ai_product' },
  ];
  for (const item of cases) {
    assert.equal(classifyRuleBased(item).content_type, item.expect, item.title);
  }
});
