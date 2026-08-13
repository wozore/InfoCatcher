/**
 * validate-intel.js — 工具情报数据校验门禁
 *
 * 职责：校验 intel-sources.json 的格式完整性，
 * 以及采集结果的数据合理性。
 *
 * 在流水线中的位置：
 *   采集前 → 校验来源配置 → 采集后 → 校验输出数据
 *
 * 返回值：
 *   0 = 校验通过（或仅警告）
 *   1 = 校验失败（阻止流水线）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ACQUISITION_FILES } = require('../shared/paths');
const { catalog } = require('../catalog-interface');

/** 支持的方法列表 */
const VALID_METHODS = new Set([
  'llms_txt', 'pricing_markdown', 'html_table', 'llms_full_html', 'html_text',
]);

/** 支持的类型列表 */
const VALID_TYPES = new Set([
  'llms_index', 'pricing', 'plans', 'documentation',
]);

/**
 * 校验来源配置文件的结构完整性。
 * @param {object} config - 解析后的 intel-sources.json
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateSourceConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['配置文件为空'], warnings: [] };
  }

  if (config.schema_version !== 1) {
    warnings.push(`未知的 schema_version: ${config.schema_version}`);
  }

  if (!Array.isArray(config.tools)) {
    errors.push('缺少 tools 数组');
    return { valid: false, errors, warnings };
  }

  const seenIds = new Set();
  for (const tool of config.tools) {
    if (!tool.tool_id) {
      errors.push('工具缺少 tool_id');
      continue;
    }

    if (seenIds.has(tool.tool_id)) {
      errors.push(`重复的 tool_id: ${tool.tool_id}`);
    }
    seenIds.add(tool.tool_id);

    if (!tool.name) warnings.push(`工具 ${tool.tool_id} 缺少 name`);

    if (!Array.isArray(tool.intel_sources) || tool.intel_sources.length === 0) {
      errors.push(`工具 ${tool.tool_id} 缺少 intel_sources 或为空`);
      continue;
    }

    const seenSourceIds = new Set();
    for (const src of tool.intel_sources) {
      if (!src.id) {
        errors.push(`工具 ${tool.tool_id} 的 intel_source 缺少 id`);
        continue;
      }
      if (seenSourceIds.has(src.id)) {
        errors.push(`工具 ${tool.tool_id} 的重复来源 id: ${src.id}`);
      }
      seenSourceIds.add(src.id);

      if (!src.url) errors.push(`来源 ${src.id} 缺少 url`);
      if (!VALID_METHODS.has(src.method)) errors.push(`来源 ${src.id} 的方法不支持: ${src.method}`);
      if (!VALID_TYPES.has(src.type)) warnings.push(`来源 ${src.id} 的类型不支持: ${src.type}`);
      if (!src.publisher) warnings.push(`来源 ${src.id} 缺少 publisher`);
      if (!Number.isFinite(src.interval_days) || src.interval_days <= 0) {
        errors.push(`来源 ${src.id} 的 interval_days 必须为正整数`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * 校验采集结果的数据合理性。
 * 确保价格不超出合理范围，必填字段不缺失。
 *
 * @param {object} intel - 三级工具详情适配结构
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateIntelData(intel) {
  const errors = [];
  const warnings = [];
  const items = Array.isArray(intel) ? intel : intel?.items || [];
  for (const item of items) {
    if (item.detail_kind !== 'api_model') continue;
    if (item.api_pricing) {
      if (item.api_pricing.status === 'conflict') warnings.push(`${item.vendor_key}/${item.id} 价格冲突待人工确认`);
      for (const card of item.api_pricing.rate_cards || []) {
        if (card.input_uncached !== undefined && (card.input_uncached <= 0 || card.input_uncached > 10000)) errors.push(`${item.vendor_key}/${item.id}: input_uncached 不合理 (${card.input_uncached})`);
        if (card.output !== undefined && (card.output <= 0 || card.output > 50000)) errors.push(`${item.vendor_key}/${item.id}: output 不合理 (${card.output})`);
        if (card.input_uncached && card.output && card.output < card.input_uncached * 0.1) warnings.push(`${item.vendor_key}/${item.id}: output (${card.output}) 远低于 input (${card.input_uncached})`);
      }
    }
    if (item.sources?.some(source => source.queried_at || source.id || source.publisher || source.source_type)) errors.push(`${item.vendor_key}/${item.id}: sources 含已删除采集字段`);
    if (item.source_refs || item.api_pricing?.rate_cards?.some(rate => rate.source_refs)) errors.push(`${item.vendor_key}/${item.id}: 含已删除 source_refs`);
  }
  return { valid: errors.length === 0, errors, warnings };
}

/** 检查日期是否超过 N 天 */
function isDateTooOld(dateStr, maxDays) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  return (Date.now() - d.getTime()) > maxDays * 86400000;
}

/**
 * 完整的校验流程。
 */
function validate(options = { silent: false }) {
  const result = { valid: true, errors: [], warnings: [] };

  // 1. 校验来源配置
  const configPath = ACQUISITION_FILES.intelSources;
  if (!fs.existsSync(configPath)) {
    result.errors.push(`来源配置文件不存在: ${configPath}`);
    result.valid = false;
    return result;
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    result.errors.push(`来源配置文件解析失败: ${e.message}`);
    result.valid = false;
    return result;
  }
  const cfgResult = validateSourceConfig(config);
  result.errors.push(...cfgResult.errors);
  result.warnings.push(...cfgResult.warnings);
  if (!cfgResult.valid) result.valid = false;

  // 2. 校验现有三级详情数据
  const detailResult = catalog({ area: 'tool-level3', operation: 'list' });
  if (detailResult.ok) {
    const intelResult = validateIntelData(detailResult.data);
    result.errors.push(...intelResult.errors);
    result.warnings.push(...intelResult.warnings);
    if (!intelResult.valid) result.valid = false;
  } else {
    result.errors.push(`工具三级详情读取失败: ${detailResult.error.message}`);
    result.valid = false;
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════
// CLI 入口
// ═══════════════════════════════════════════════════════════════

function main() {
  const silent = process.argv.includes('--silent');
  const result = validate({ silent });

  if (!silent) {
    if (result.errors.length > 0) {
      console.error('❌ 校验失败:');
      result.errors.forEach(e => console.error(`  ERROR: ${e}`));
    }
    if (result.warnings.length > 0) {
      console.log('⚠️  警告:');
      result.warnings.forEach(w => console.log(`  WARN: ${w}`));
    }
    if (result.errors.length === 0 && result.warnings.length === 0) {
      console.log('✅ 校验通过，无错误和警告');
    } else if (result.valid) {
      console.log('✅ 校验通过（有警告）');
    }
  }

  process.exit(result.valid ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { validate, validateSourceConfig, validateIntelData };
