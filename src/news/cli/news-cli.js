/**
 * news-cli.js —— 热点运维命令行分发器（零依赖，仅依赖项目内模块）
 *
 * 在热点管线中的位置：供维护者在终端手动运行（入口为 scripts/news-cli.js），
 * 不与浏览器或 GitHub Actions 直接交互。所有命令只修改 JSON 数据文件，不修改采集核心代码。
 *
 * 命令分组（热点管线 v2 主链）：
 *   min-review —— 热点管线 v2 单状态轴候选层运维（cmd-min.js，语义见该文件头）
 *   classify   —— 内容类型分类预览（cmd-content.js；批量分类由 v2 管线内建）
 *   localize   —— 内容本地化预览（cmd-content.js；批量本地化由 v2 管线内建）
 *
 * main 返回 { group, action, flags, result } 结构化结果；人类可读输出由
 * scripts/news-cli.js 壳格式化打印。目录数据经 deps.catalogApi 注入
 * （{ listToolCards, readGlossary, createEntityLedger, resolveEntityModel }）。
 */

'use strict';

const { classifyCommand, localizeCommand } = require('./cmd-content');
const { minReviewCommand } = require('./cmd-min');

// ── CLI 参数解析 ──────────────────────────────────────────

/**
 * 解析命令行参数。
 * --key value  → flags.key = 'value'
 * --flag       → flags.flag = true
 * 其余参数      → positional[]
 */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const key = value.slice(2).replace(/-/g, '_');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { positional, flags };
}

// ── 入口 ──────────────────────────────────────────────────

async function main(argv = process.argv.slice(2), deps = {}) {
  const { positional, flags } = parseArgs(argv);
  const [group, action] = positional;
  if (group === 'min-review') return minReviewCommand(action, flags, deps);
  if (group === 'classify') return classifyCommand(action, flags, deps);
  if (group === 'localize') return localizeCommand(action, flags, deps);
  throw new Error('用法: news-cli.js min-review|classify|localize <action> [options]');
}

module.exports = {
  parseArgs,
  minReviewCommand,
  main,
};
