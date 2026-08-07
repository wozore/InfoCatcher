/**
 * news-cli.js —— 热点运维命令行入口（零依赖，仅依赖项目内模块）
 *
 * 在热点管线中的位置：供维护者在终端手动运行，不与浏览器或 GitHub Actions 直接交互。
 * 所有命令只修改 JSON 数据文件，不修改采集核心代码。
 *
 * 命令分组：
 *
 *   source —— 来源管理
 *     source add     --platform youtube|bilibili|x --external-id ... --name ... --url ... --language ... --tag ...
 *     source import  --file <json> [--dry-run] [--allow-partial]
 *     source enable  --id ...
 *     source disable --id ...
 *
 *     - add: 单条添加，校验平台 ID 格式、HTTPS 主页、标签合法、同平台不重复。
 *     - import: 批量导入，默认全有或全无（atomic），--allow-partial 才写入有效条目。
 *     - enable/disable: 切换来源启用状态，不删除数据。
 *
 *   authorization —— 授权任务处理
 *     authorization list
 *     authorization continue    --id ... --until <days> [--max-quota ...] [--note ...]
 *     authorization until-first --id ... --earliest <days> --max-pages ... [--max-quota ...] [--note ...]
 *     authorization skip        --id ...
 *     authorization stop        --id ...
 *
 *   quota —— 额度管理
 *     quota resume --platform youtube|bilibili --reason ...
 *     （记录决策和时间，不修改余额；下一次构建创建新预算后自动恢复）
 *
 *   lock —— 构建锁管理
 *     lock status
 *     lock force-unlock --reason ...
 *     （status 只读；force-unlock 删除锁并写入审计，必须提供 reason）
 *
 *   registry —— Registry 保留策略（N-P2）
 *     registry prune   [--apply] [--retention-days <n>]
 *     （默认 dry-run 只预览将裁剪的记录数；--apply 才实际裁剪并归档到
 *       news-registry-pruned.json（含 run_id/规则/时间 + 记录全文，可回滚）；
 *       裁剪依据 last_seen_at 超 retention_days 天（默认取 news-config.json
 *       的 registry_retention_days=270，与采集回溯窗口一致）；
 *       build-news 每轮结束也会自动执行同等裁剪）
 *
 *   review —— 热点审核状态管理（B16 决策 46/48/50/55/56/57/69/70；content-reviewer 决策见 §7.4）
 *     review list    [--status pending|approved|held|discarded] [--ai-verdict approve|hold|discard] [--platform ...] [--limit N]
 *     review summary
 *     review set     --id <id> --status pending|approved|held|discarded [--reason ...] [--reviewer ...]
 *     review batch   --ids <id1,id2,...> --status approved [--reason ...] [--reviewer ...]
 *     review apply-ai [--verdicts discard,hold] [--min-confidence N] [--dry-run]
 *     review log     [--candidate-id <id>] [--action ...] [--limit N]
 *     （set 单条设置审核状态；batch 只处理显式列出的 ids，不支持隐式「全部」；
 *       ai_processing_status 未 completed 时禁止设为 approved；
 *       每次流转写入 reviewer / reviewed_at / from_status / candidate_version，决策 70；
 *       每次流转同时追加到追加式审核事件日志 review-events.json（决策 70：只追加、不改写历史），
 *       review log 用于查看历史流转记录；
 *       --reviewer 缺省回退到 GITHUB_ACTOR / USER / cli；
 *       --ai-verdict 按 AI 审核建议（ai_review.verdict）筛选待审队列；
 *       apply-ai 批量应用候选上已生成的 AI 建议（discard/hold，永不 approve；
 *       confidence 低于 --min-confidence 或候选非 pending 的跳过），默认 dry-run 只预览）
 *
 *   transcript —— 视频字幕/文字稿处理（B16 决策 51/52/54/61/67）
 *     transcript status --id <id>
 *     transcript fetch  --id <id> [--base-url ...] [--lang ...]
 *     （fetch 尝试获取 YouTube 自动字幕：缺失/过短 → held，技术失败 → error；
 *       成功且此前因字幕原因 held 的候选重置为 pending 等待复审，决策 52；
 *       完整字幕写入 data/news/runtime/transcripts/，不进 PR）
 *
 *   localize —— 热点内容本地化（多语言翻译，content-localizer）
 *     localize preview     --title <t> [--description <d>] [--locale zh]
 *     localize candidates  [--locale zh] [--limit N] [--dry-run]
 *     （把候选 title/description 翻译成目标语言存 localizations[locale]，
 *       原文保留顶层作溯源基线；只处理无 localizations[locale] 的候选，不重复花钱；
 *       默认 --dry-run 只预览将翻译条数，非 dry-run 才写回候选层，
 *       再运行 publish-news.js 重建公开投影即前端中文化）
 *
 *   legacy —— 旧热点数据迁移（B16 决策 64）
 *     legacy import   [--dry-run]
 *     legacy status
 *     （import 把旧 hotspots.json 导入内部候选层，标记 legacy 并以 pending
 *       进入待审核流程，不自动公开；只导入候选层中尚不存在的 id；
 *       --dry-run 只打印将导入的条数，不写文件；
 *       导入后通过 review set/batch --status approved 逐条/批量审核，
 *       再运行 publish-news.js 重建公开投影，决策 64/59）
 *
 *   min-review —— 热点管线 v2 单状态轴候选层运维（操作 min-candidates.json，不触碰旧候选层）
 *     min-review list        [--status pending|approved|discarded] [--platform ...] [--limit N]
 *     min-review set         --id <id> --status pending|approved|discarded
 *     min-review batch       --ids <id1,id2,...> --status approved
 *     min-review transcripts
 *     min-review feedback
 *     min-review refine
 *     （list 列出 v2 候选含 review_status / final_score；set/batch 写回 min-store；
 *       transcripts/feedback/refine 分别调 v2 收尾模块，把清单/待补卡/提纯候选
 *       写到 config.manual_folder 的固定格式文件，交人工确认；
 *       --store min 为显式标注 v2 数据通道，缺省即 min）
 *
 * 安全约束：
 *   - 不接受 --api-key 等凭据参数；API Key 只能由 GitHub Secrets 注入。
 *   - 校验 external_id 格式：YouTube → UC 开头、B站 → 纯数字 UID、X → 有效用户名。
 *   - 校验 profile_url 必须使用 HTTPS。
 *   - 校验 content_tags 必须来自允许列表。
 *
 * 扩展点：
 *   - 新增平台：在 PLATFORMS Set 和 validateSource() 的 ID 格式校验中增加对应分支。
 *   - 新增命令组：参照 source/authorization/quota/lock 模式，在 main() 增加 else-if 分支。
 *
 * 实现拆分：命令实现已按组拆分到 cmd-sources.js / cmd-content.js / cmd-ops.js /
 * cmd-registry.js，本文件只保留分发逻辑（parseArgs + main）并汇总 re-export。
 */

'use strict';

const {
  sourceCommand, normalizeTags, validateSource, importSources, FILES,
} = require('./cmd-sources');
const { contentCommand, classifyCommand, transcriptCommand, localizeCommand } = require('./cmd-content');
const { authorizationCommand, quotaCommand, lockCommand, optionalNumber } = require('./cmd-ops');
const { registryCommand, reviewCommand, legacyCommand } = require('./cmd-registry');
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
  if (group === 'source') result = sourceCommand(action, flags);
  else if (group === 'content') result = contentCommand(action, flags);
  else if (group === 'authorization') result = authorizationCommand(action, flags);
  else if (group === 'quota') result = quotaCommand(action, flags);
  else if (group === 'lock') result = lockCommand(action, flags);
  else if (group === 'registry') result = registryCommand(action, flags);
  else if (group === 'review') result = reviewCommand(action, flags);
  else if (group === 'min-review') { await minReviewCommand(action, flags); return; } // 自打印人友好输出
  else if (group === 'classify') result = await classifyCommand(action, flags);
  else if (group === 'transcript') result = await transcriptCommand(action, flags);
  else if (group === 'localize') result = await localizeCommand(action, flags);
  else if (group === 'legacy') result = legacyCommand(action, flags);
  else throw new Error('用法: news-cli.js source|content|authorization|quota|lock|registry|review|min-review|classify|transcript|localize|legacy <action> [options]');
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
  parseArgs, normalizeTags, validateSource, importSources, optionalNumber,
  contentCommand, reviewCommand, minReviewCommand, transcriptCommand, legacyCommand, main, FILES,
};
