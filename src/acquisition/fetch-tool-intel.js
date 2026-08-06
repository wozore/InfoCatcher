/**
 * fetch-tool-intel.js — 工具情报自动采集引擎（编排入口）
 *
 * 职责：从厂商官方来源（llms.txt / pricing.md / HTML 表格）自动获取
 * 模型、API 价格、套餐等信息，与现有 tool-intelligence.json 做增量合并。
 *
 * 本文件保留主编排 collectIntelligence()（抓取→规范化→写入 data/）与 CLI 入口，
 * 并对拆分的子模块做汇总 re-export，保持原有导出面不变：
 *   - fetch-intel-http.js：requestText、fetchToolIntel（网络抓取层）
 *   - normalize-intel.js：解析 / 规范化 / 合并纯函数
 *
 * 三级降级链：
 *   L1: llms.txt → pricing.md → Markdown 表格解析
 *   L2: HTML 页面 → CSS 选择器 → HTML 表格提取
 *   L3: 标记为 acquisition_failed，保留旧数据（由维护者处理）
 *
 * 扩展点：
 *   - 新增厂商：在 intel-sources.json 中添加来源配置即可
 *   - 新增解析器：实现 parseIntelXxx() 函数，在 extractPricing() 中添加分支
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ACQUISITION_FILES, CATALOG_FILES } = require('../shared/paths');
const { requestText, fetchToolIntel } = require('./fetch-intel-http');
const {
  extractMarkdownTables,
  parsePriceString,
  mapRowToRateCard,
  extractFromPricingMarkdown,
  extractHtmlTablesSimple,
  htmlRowsToObjects,
  extractFromHtmlTable,
  extractDeepSeekPricing,
  assignPrices,
  detectPricingChange,
  mergeIntelData,
} = require('./normalize-intel');

// ═══════════════════════════════════════════════════════════════
// 类型定义（JSDoc 注释）
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {{ id: string, url: string, type: string, method: string, publisher: string, interval_days: number, selector?: string, table_index?: number, locale?: string }} IntelSource
 * @typedef {{ tool_id: string, name: string, intel_sources: IntelSource[] }} ToolIntelConfig
 */

// ═══════════════════════════════════════════════════════════════
// 主编排函数
// ═══════════════════════════════════════════════════════════════

/**
 * 采集入口函数。
 *
 * @param {object} options
 * @param {string} [options.toolId] — 指定采集某个工具，留空全部采集
 * @param {boolean} [options.dryRun] — 仅输出结果，不写入文件
 * @param {function} [options.fetchImpl] — 测试用 fetch 注入
 * @returns {Promise<{updated: boolean, conflictCount: number, log: string[]}>}
 */
async function collectIntelligence(options = {}) {
  const log = [];
  log.push(`[${new Date().toISOString()}] 开始工具情报采集`);
  const queriedAt = new Date().toISOString();

  // 1. 读取来源配置
  const configPath = ACQUISITION_FILES.intelSources;
  if (!fs.existsSync(configPath)) {
    throw new Error(`来源配置文件不存在: ${configPath}`);
  }
  const sourceConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  let tools = sourceConfig.tools;
  if (options.toolId) {
    tools = tools.filter(t => t.tool_id === options.toolId);
    if (tools.length === 0) throw new Error(`未找到工具: ${options.toolId}`);
  }

  // 2. 读取现有情报数据
  const intelPath = CATALOG_FILES.toolIntelligence;
  const existingIntel = JSON.parse(fs.readFileSync(intelPath, 'utf8'));

  let hasConflict = false;
  let totalConflicts = 0;

  // 3. 逐个工具采集
  for (const toolConfig of tools) {
    log.push(`--- ${toolConfig.name} (${toolConfig.tool_id}) ---`);
    const { results, log: fetchLog } = await fetchToolIntel(toolConfig, options.fetchImpl);
    log.push(...fetchLog);

    if (results.length === 0) {
      log.push(`[${toolConfig.tool_id}] 未提取到数据，跳过合并`);
      continue;
    }

    log.push(`[${toolConfig.tool_id}] 提取到 ${results.length} 条定价记录`);

    // 4. 合并到现有数据
    const lastSource = toolConfig.intel_sources[toolConfig.intel_sources.length - 1];
    const sourceId = lastSource ? lastSource.id : 'manual';
    const mergeResult = mergeIntelData(existingIntel, toolConfig.tool_id, results, sourceId, queriedAt);

    log.push(`[${toolConfig.tool_id}] 合并结果: ${mergeResult.status}`);
    if (mergeResult.conflicts.length > 0) {
      hasConflict = true;
      totalConflicts += mergeResult.conflicts.length;
      log.push(`[${toolConfig.tool_id}] ⚠️ 检测到 ${mergeResult.conflicts.length} 项价格冲突!`);
      for (const c of mergeResult.conflicts) {
        log.push(`   - ${c.item_name}: ${c.changes.map(ch => `${ch.field} ${ch.oldVal}→${ch.newVal} (${(ch.diffPct*100).toFixed(0)}%)`).join(', ')}`);
      }
    }
  }

  // 5. 更新元数据
  existingIntel.catalog_queried_at = queriedAt;

  // 6. 写入文件
  if (!options.dryRun) {
    const tmpPath = intelPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(existingIntel, null, 2), 'utf8');
    fs.renameSync(tmpPath, intelPath);
    log.push(`写入 ${intelPath}`);
  }

  log.push(`[完成] 冲突数: ${totalConflicts}`);
  return { updated: true, conflictCount: totalConflicts, log };
}

// ═══════════════════════════════════════════════════════════════
// CLI 入口
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--tool':
        options.toolId = args[++i];
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--help':
        console.log(`用法: node ${path.basename(process.argv[1])} [选项]
选项:
  --tool <id>     指定采集某个工具（留空采集全部）
  --dry-run       只打印结果，不写入文件
  --help          显示帮助`);
        process.exit(0);
    }
  }

  try {
    const result = await collectIntelligence(options);
    console.log(result.log.join('\n'));
    process.exit(result.conflictCount > 0 ? 0 : 0);  // 冲突不算失败
  } catch (error) {
    console.error('采集失败:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  requestText,
  extractMarkdownTables,
  parsePriceString,
  mapRowToRateCard,
  extractFromPricingMarkdown,
  extractHtmlTablesSimple,
  htmlRowsToObjects,
  extractFromHtmlTable,
  extractDeepSeekPricing,
  assignPrices,
  detectPricingChange,
  mergeIntelData,
  fetchToolIntel,
  collectIntelligence,
};
