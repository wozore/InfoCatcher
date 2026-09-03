/**
 * news-cli.js —— 热点运维命令行入口（零依赖，仅依赖项目内模块）
 *
 * 在热点管线中的位置：供维护者在终端手动运行，不与浏览器或 GitHub Actions 直接交互。
 * 所有命令只修改 JSON 数据文件，不修改采集核心代码。
 *
 * 命令分组（热点管线 v2 主链）：
 *
 *   min-review —— 热点管线 v2 单状态轴候选层运维（操作 min-candidates.json）
 *     min-review list        [--status pending|approved|discarded] [--platform ...] [--limit N]
 *     min-review set         --id <id> --status pending|approved|discarded
 *     min-review batch       --ids <id1,id2,...> --status approved
 *     min-review transcripts
 *     min-review feedback
 *     min-review refine
 *     min-review ai-top
 *     min-review top-selected --ids <id1,id2,...>
 *     （list 列出 v2 候选含 review_status / final_score；set/batch 写回 min-store；
 *       transcripts/feedback/refine 分别调 v2 收尾模块，把清单/待补卡/提纯候选
 *       写到 config.manual_folder 的固定格式文件，交人工确认；
 *       ai-top 从 approved 候选调 AI 语义挑 top 待选项；top-selected 确认显示；
 *       --store min 为显式标注 v2 数据通道，缺省即 min）
 *
 *   classify —— 热点内容类型分类（content-classifier）
 *     classify preview     --title <t> [--description <d>]
 *     （L0 规则式分类零成本、可离线（默认，不配 --provider 时）。L1 AI 分类：
 *       --provider zhipu|deepseek 走外部 provider（zhipu 需 ZHIPU_API_KEY，deepseek 需
 *       DEEPSEEK_API_KEY，缺 key 时自动回退 L0，不阻塞）；--model 可覆盖 provider 默认模型）
 *
 *   localize —— 热点内容本地化（content-localizer）
 *     localize preview     --title <t> [--description <d>] [--locale zh]
 *     （纯函数预览单条翻译，不写入；批量本地化已由 v2 管线 pipeline-min 内建）
 *
 * 历史：v1 命令组（source/authorization/quota/lock/registry/review/transcript/legacy）
 * 已随 v1 候选层（hotspot-candidates.json）与 v1 管线（build-news）一并删除（2026-08-08，
 * 见 docs/热点管线-v1-删除清单.md）。v2 采集/审核/总结/本地化均在 pipeline-min 内自动完成，
 * 运维只需 min-review 审核 + publish 发布。
 *
 * 实现拆分：命令实现按组拆分到 cmd-min.js / cmd-content.js，本文件只保留分发逻辑。
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

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [group, action] = positional;
  let result;
  if (group === 'min-review') { await minReviewCommand(action, flags); return; } // 自打印人友好输出
  else if (group === 'classify') result = await classifyCommand(action, flags);
  else if (group === 'localize') result = await localizeCommand(action, flags);
  else throw new Error('用法: news-cli.js min-review|classify|localize <action> [options]');
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  minReviewCommand,
  main,
};
