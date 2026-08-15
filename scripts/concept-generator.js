'use strict';

/**
 * concept-generator.js —— AI 概念库生成器 CLI（薄包装；src/ 为纯逻辑）
 *
 * 与五模块目录生成器（catalog-generator）分离：概念批量生成产出的是
 * data/catalog/glossary.json（AI 概念知识库），不是五模块厂商/工具目录，
 * 故独立成入口。核心逻辑全在 src/catalog/concept-batch.js：
 *
 *   batch --file <待补概念卡.json> [--dry-run | --confirm-cost]
 *     dry-run        只查重 + 本地 approved 摘要证据 + 成本估算（零 AI 零网络）
 *     confirm-cost   抓 vibe-hub 补充证据 + DeepSeek 合成，写预览文件并停下
 *   preview          查看 data/manual/concept-previews.json（只读）
 *   apply [--terms a,b]  把预览写入正式 glossary.json（默认全部 pending，--terms 指定子集）
 *
 * 两段式确认纪律：batch 只合成出预览文件，apply 等维护者人工确认后才原子写正式库。
 */

const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const concept = require('../src/catalog/concept-batch');
const { loadGeneratorConfig, normalizeGeneratorOptions } = require('../src/catalog/catalog-assistant');

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

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [command] = positional;
  if (command === 'batch') {
    if (!flags.file) throw new Error('请提供 --file <待补概念卡文件>（先运行 node scripts/news-cli.js min-review feedback 生成）');
    const cards = concept.readPendingConcepts(flags.file);
    const result = await concept.runConceptBatch(cards, {
      dryRun: flags.dry_run === true,
      confirmCost: flags.confirm_cost === true,
      ...normalizeGeneratorOptions(loadGeneratorConfig()), // model/provider/timeout 等透传合成
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.ok && !result.dry_run) {
      console.log('\n✅ 概念预览已写入 data/manual/concept-previews.json；请查看后执行 `apply` 写入正式 glossary.json。');
    }
    return result;
  }
  if (command === 'preview') {
    const result = concept.readConceptPreviews();
    console.log(JSON.stringify(result, null, 2));
    return { ok: true, ...(result || { message: '尚无概念预览文件 data/manual/concept-previews.json' }) };
  }
  if (command === 'apply') {
    const terms = flags.terms ? String(flags.terms).split(',').map(item => item.trim()).filter(Boolean) : undefined;
    const result = concept.applyConceptPreviews(undefined, { ...(terms ? { terms } : {}) });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  throw new Error('用法: concept-generator batch --file <待补卡.json> [--confirm-cost|--dry-run] | preview | apply [--terms a,b]');
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main };
