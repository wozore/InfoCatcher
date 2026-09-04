'use strict';

/**
 * empty-model-filter.js — 无数据模型自动过滤（纯逻辑）
 *
 * 对比页只展示有可对比评测数据的模型。构建后的模型若无任何有效评测维度、
 * 也无综合分，则该 identity 视为空壳；当同一 identity 的**所有** revision
 * 均无数据时整组从 integrated 中移除，任一 revision 有数据则整组保留
 * （避免误杀有数据的主变体）。
 *
 * 这是代码规则而非人工清单，随抓取数据动态生效——模型日后获得评测数据会
 * 自动回归，无需维护排除登记表。与 model-exclusions.json（人工永久排除）
 * 职责分离：前者是数据驱动，后者是人工裁决。
 */

/** 模型是否有任何可对比的评测数据：任一有效维度 或 综合分。 */
function hasComparisonData(model) {
  if (model.composite && Number.isFinite(model.composite.score)) return true;
  const dimensions = model.dimensions || {};
  return Object.values(dimensions).some(dim => dim && Number.isFinite(dim.value));
}

/**
 * 按 identity 分组过滤空壳模型。
 * @param {object[]} models 已 buildModelRecord + computeValues 的完整模型
 * @returns {{kept: object[], filtered: object[]}}
 */
function filterEmptyModels(models = []) {
  const byIdentity = new Map();
  for (const model of models) {
    const key = `${model.vendor || 'unknown'}--${model.identity}`;
    let group = byIdentity.get(key);
    if (!group) {
      group = { anyData: false, models: [] };
      byIdentity.set(key, group);
    }
    group.models.push(model);
    if (!group.anyData && hasComparisonData(model)) group.anyData = true;
  }
  const kept = [];
  const filtered = [];
  for (const group of byIdentity.values()) {
    if (group.anyData) kept.push(...group.models);
    else filtered.push(...group.models);
  }
  return { kept, filtered };
}

module.exports = { hasComparisonData, filterEmptyModels };
