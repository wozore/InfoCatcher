'use strict';

const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const fs = require('fs');
const { loadCatalogSnapshot } = require('../src/catalog/catalog-snapshot-store');
const {
  prepareCatalogDraft,
  resumeCatalogDraft,
  planCatalogDraft,
  reviewCatalogDraft,
  applyCatalogDraft,
  discardCatalogDraft,
  recoverCatalogTransactions,
  probeCatalogCapabilities,
  loadGeneratorConfig,
  normalizeGeneratorOptions,
} = require('../src/catalog/catalog-assistant');
const { listDrafts } = require('../src/catalog/catalog-draft-store');

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

function readSeed(flags) {
  if (!flags.seed) throw new Error('请提供 --seed <file>');
  return JSON.parse(fs.readFileSync(flags.seed, 'utf8'));
}

function printPreview(result) {
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    return;
  }
  const draft = result.draft;
  console.log(JSON.stringify({
    draft_id: result.draft_id,
    state: draft.state,
    readiness: draft.readiness,
    base_revision: draft.base_revision,
    preview_hash: draft.preview_hash,
    change_preview: draft.change_preview,
    research_plan: draft.research_plan,
    coverage: draft.coverage,
    source_count: draft.research?.official_sources?.length || 0,
    missing_field_count: draft.coverage?.missing?.length || 0,
    layer_patches: draft.layer_patches,
    record_preview: draft.record_preview,
    cost: draft.cost || result.cost,
  }, null, 2));
}

function ask(question) {
  process.stdout.write(question);
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', value => resolve(String(value).trim()));
  });
}

async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const [command, id] = positional;
  if (command === 'probe') {
    if (!flags.confirm_cost) {
      const result = { ok: false, code: 'COST_CONFIRMATION_REQUIRED', cost: { max_ai_calls: 1 } };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const result = await probeCatalogCapabilities({ ...normalizeGeneratorOptions(loadGeneratorConfig()), confirmCost: true });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'list') {
    const result = { ok: true, drafts: listDrafts().map(draft => ({ draft_id: draft.draft_id, state: draft.state, readiness: draft.readiness })) };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'recover') {
    const result = recoverCatalogTransactions();
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'plan') {
    const seed = readSeed(flags);
    const result = planCatalogDraft(seed, normalizeGeneratorOptions(loadGeneratorConfig()));
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'new') {
    const seed = readSeed(flags);
    if (!flags.confirm_cost) {
      const result = { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const result = await prepareCatalogDraft(seed, { ...normalizeGeneratorOptions(loadGeneratorConfig()), confirmCost: true });
    printPreview(result);
    return result;
  }
  if (command === 'prepare') {
    const seed = readSeed(flags);
    const result = planCatalogDraft(seed, normalizeGeneratorOptions(loadGeneratorConfig()));
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'resume') {
    if (!id) throw new Error('请提供 draft-id');
    if (!flags.confirm_cost) {
      const result = { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const result = await resumeCatalogDraft(id, { ...normalizeGeneratorOptions(loadGeneratorConfig()), confirmCost: true });
    printPreview(result);
    return result;
  }
  if (command === 'review') {
    if (!id) throw new Error('请提供 draft-id');
    const result = reviewCatalogDraft(id);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'cancel') {
    if (!id) throw new Error('请提供 draft-id');
    const result = discardCatalogDraft(id);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'apply') {
    if (!id) throw new Error('请提供 draft-id');
    const review = reviewCatalogDraft(id);
    console.log(JSON.stringify({
      draft_id: id,
      readiness: review.draft?.readiness,
      change_preview: review.plan?.changePreview,
      coverage: review.draft?.coverage,
      layer_patches: review.draft?.layer_patches,
      record_preview: review.plan?.plannedRecords,
      cost: review.draft?.cost,
      preview_hash: review.previewHash,
      current_revision: review.currentRevision,
    }, null, 2));
    if (!review.ok || review.draft?.readiness?.status !== 'ready') return review;
    const confirmation = flags.confirm || await ask(`输入 APPLY ${id} 以确认正式写入：`);
    if (confirmation !== `APPLY ${id}`) return { ok: false, code: 'APPLY_CONFIRMATION_REQUIRED' };
    const result = applyCatalogDraft({ draftId: id, previewHash: review.previewHash, expectedRevision: review.currentRevision });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'batch') {
    // 批量生成：待补卡 → 查重 → 厂商/官方源解析 → 逐 seed 生成 → 自动 apply。
    // 用法：catalog-generator batch --file <待补卡.json> [--confirm-cost] [--dry-run] [--from-preview] [--seed-out <file>]
    if (!flags.file) throw new Error('请提供 --file <待补卡文件>（先运行 node scripts/news-cli.js min-review feedback 生成）');
    const batch = require('../src/catalog/catalog-batch');
    const cards = batch.readPendingCards(flags.file);
    const result = await batch.runBatchFromCards(cards, {
      dryRun: flags.dry_run === true,
      fromPreview: flags.from_preview === true,
      confirmCost: flags.confirm_cost === true,
      ...(flags.seed_out ? { previewFile: flags.seed_out } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'url-registry') {
    // 人工官方 URL 登记表维护（批量生成解析第一道命中源）。
    const registry = require('../src/catalog/official-url-registry');
    const [action] = positional.slice(1);
    if (action === 'list') {
      const store = registry.listUrlRegistry();
      console.log(JSON.stringify(store, null, 2));
      return { ok: true, ...store };
    }
    if (action === 'add') {
      const result = registry.addUrlRegistryEntry({
        name: flags.name,
        vendor_name: flags.vendor,
        official_url: flags.url,
        aliases: flags.alias ? String(flags.alias).split(',').map(item => item.trim()).filter(Boolean) : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (action === 'remove') {
      const result = registry.removeUrlRegistryEntry(flags.name);
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    throw new Error('用法: catalog-generator url-registry list | add --name <名> --url <URL> [--vendor <厂商>] [--alias <别名>] | remove --name <名>');
  }
  throw new Error('用法: catalog-generator probe|plan|prepare|list|recover|new|resume|review|apply|cancel|batch|url-registry');
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main, readSeed };
