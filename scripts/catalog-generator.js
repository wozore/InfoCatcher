'use strict';

const { loadDotEnv } = require('../src/shared/env');
loadDotEnv();

const fs = require('fs');
const { loadCatalogSnapshot } = require('../src/catalog/catalog-snapshot-store');
const { removeCatalogRecords } = require('../src/catalog/catalog-transaction-store');
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

function csvFlag(value) {
  return value === undefined || value === true
    ? undefined
    : String(value).split(',').map(item => item.trim()).filter(Boolean);
}

function tavilyAccessModeFromFlags(flags = {}) {
  const value = flags.tavily_access_mode;
  if (value === undefined || value === true) {
    throw new Error('TAVILY_ACCESS_MODE_REQUIRED: 联网目录命令必须显式提供 --tavily-access-mode keyed|keyless');
  }
  const mode = String(value).trim().toLowerCase();
  if (!['keyed', 'keyless'].includes(mode)) {
    throw new Error(`TAVILY_ACCESS_MODE_INVALID: 不支持的 Tavily access mode: ${value}`);
  }
  return mode;
}

function generatorOptionsFromFlags(flags = {}) {
  const accessMode = tavilyAccessModeFromFlags(flags);
  return {
    ...normalizeGeneratorOptions(loadGeneratorConfig()),
    accessMode,
  };
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
    const options = generatorOptionsFromFlags(flags);
    const result = await probeCatalogCapabilities({ ...options, confirmCost: true });
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
    const result = await prepareCatalogDraft(seed, { ...generatorOptionsFromFlags(flags), confirmCost: true });
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
    const result = await resumeCatalogDraft(id, { ...generatorOptionsFromFlags(flags), confirmCost: true });
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
  if (command === 'remove') {
    if (!flags.targets) throw new Error('请提供 --targets <精确删除目标 JSON>');
    const payload = JSON.parse(fs.readFileSync(flags.targets, 'utf8'));
    const targets = Array.isArray(payload) ? payload : payload.targets;
    if (!Array.isArray(targets) || !targets.length) throw new Error('删除目标 JSON 必须包含非空 targets 数组');
    const label = String(flags.targets).split(/[\\/]/).pop();
    const current = loadCatalogSnapshot();
    console.log(JSON.stringify({ targets, expected_revision: flags.expected_revision || current.revision, confirmation: `REMOVE ${label}` }, null, 2));
    const confirmation = flags.confirm || await ask(`输入 REMOVE ${label} 以确认精确删除：`);
    if (confirmation !== `REMOVE ${label}`) return { ok: false, code: 'REMOVE_CONFIRMATION_REQUIRED' };
    const result = removeCatalogRecords(targets, { expectedRevision: flags.expected_revision || current.revision });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'prune') {
    // 14 个月滚动级联删除：cutoff 缺省读共享段 data/shared/retention.json（comparison 推进）。
    // 用法：catalog-generator prune [--cutoff <YYYY-MM|YYYY-MM-DD>] [--dry-run] [--confirm]
    const { planRetentionPrune, applyRetentionPrune, currentCutoffDate } = require('../src/catalog/catalog-retention-prune');
    const cutoffInput = flags.cutoff
      ? (String(flags.cutoff).length === 7 ? `${flags.cutoff}-01` : String(flags.cutoff))
      : currentCutoffDate();
    if (!cutoffInput) throw new Error('无法确定 cutoff：请提供 --cutoff <YYYY-MM>，或确认共享段 data/shared/retention.json 已初始化');
    const current = loadCatalogSnapshot();
    const planned = planRetentionPrune(current.snapshot, cutoffInput);
    if (!planned.ok) { console.log(JSON.stringify(planned, null, 2)); return planned; }
    console.log(JSON.stringify({
      kind: 'catalog_retention_prune',
      cutoff_date: planned.cutoff_date,
      has_changes: planned.has_changes,
      expired_details: planned.expired_details,
      tool_cards: planned.tool_cards,
      vendor_level2s: planned.vendor_level2s,
      vendor_level1s: planned.vendor_level1s,
      vendor_cards: planned.vendor_cards,
      featured_dangling: planned.featured_dangling,
      expected_revision: current.revision,
      preview_hash: planned.preview_hash,
      confirmation: `PRUNE ${planned.cutoff_date}`,
    }, null, 2));
    if (flags.dry_run || !planned.has_changes) return { ...planned, dry_run: flags.dry_run === true, committed: false };
    const confirmation = flags.confirm || await ask(`输入 PRUNE ${planned.cutoff_date} 以确认滚动删除：`);
    if (confirmation !== `PRUNE ${planned.cutoff_date}`) return { ok: false, code: 'PRUNE_CONFIRMATION_REQUIRED' };
    const result = applyRetentionPrune({ cutoffDate: planned.cutoff_date, expectedRevision: current.revision, previewHash: planned.preview_hash });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (command === 'batch') {
    // 批量生成：待补卡 → 查重 → 厂商/官方源解析 → 逐 seed 生成 → 自动 apply。
    // 用法：catalog-generator batch --file <待补卡.json> [--confirm-cost] [--dry-run] [--from-preview] [--seed-out <file>]
    if (!flags.file) throw new Error('请提供 --file <待补卡文件>（先运行 node scripts/news-cli.js min-review feedback 生成）');
    const batch = require('../src/catalog/catalog-batch');
    const cards = batch.readPendingCards(flags.file);
    const batchOptions = generatorOptionsFromFlags(flags);
    const result = await batch.runBatchFromCards(cards, {
      generatorOptions: batchOptions,
      accessMode: batchOptions.accessMode,
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
    const requestedNamespace = positional[1];
    const namespace = requestedNamespace === 'product' ? 'product' : 'vendor';
    const action = namespace === 'vendor' && !['vendor', 'product'].includes(requestedNamespace)
      ? requestedNamespace
      : positional[2];
    if (namespace === 'vendor' && action === 'list') {
      const store = registry.listUrlRegistry();
      console.log(JSON.stringify(store, null, 2));
      return { ok: true, ...store };
    }
    if (namespace === 'vendor' && action === 'add') {
      const result = registry.addUrlRegistryEntry({
        name: flags.name,
        vendor_name: flags.vendor,
        official_url: flags.url,
        aliases: csvFlag(flags.alias),
        product_prefixes: csvFlag(flags.product_prefix),
        model_prefixes: csvFlag(flags.model_prefix),
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (namespace === 'vendor' && action === 'remove') {
      const result = registry.removeUrlRegistryEntry(flags.name);
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (namespace === 'product' && action === 'list') {
      const store = registry.listProductUrlRegistry();
      console.log(JSON.stringify(store, null, 2));
      return { ok: true, ...store };
    }
    if (namespace === 'product' && action === 'add') {
      const result = registry.addProductUrlRegistryEntry({
        name: flags.name,
        vendor_key: flags.vendor_key,
        official_url: flags.url,
        aliases: csvFlag(flags.alias),
        product_prefixes: csvFlag(flags.product_prefix),
        lifecycle: flags.lifecycle || 'active',
        last_verified_at: flags.verified_at,
        last_official_update_at: flags.official_update_at,
        superseded_by: flags.superseded_by,
      });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (namespace === 'product' && action === 'remove') {
      const result = registry.removeProductUrlRegistryEntry(flags.name);
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (namespace === 'product' && action === 'audit') {
      const staleDays = flags.stale_days === true ? undefined : Number(flags.stale_days);
      const result = registry.auditProductUrlRegistry({ staleDays });
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    throw new Error('用法: catalog-generator url-registry vendor list|add --name <名> --url <URL> [--vendor <厂商>] [--alias <别名>] [--product-prefix <前缀,...>] [--model-prefix <前缀,...>] | remove --name <名>; url-registry product list|add --name <产品> --vendor-key <厂商键> --url <URL> [--alias <别名>] [--product-prefix <前缀,...>] [--lifecycle <状态>] [--verified-at <YYYY-MM-DD>] [--official-update-at <YYYY-MM-DD>] [--superseded-by <产品键>] | remove --name <产品> | audit [--stale-days <天数>]');
  }
  throw new Error('用法: catalog-generator probe|plan|prepare|list|recover|new|resume|review|apply|cancel|remove|prune|batch|url-registry');
}

if (require.main === module) {
  main().then(result => { if (result?.ok === false) process.exitCode = 1; }).catch(error => {
    console.error(`❌ ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, main, readSeed, tavilyAccessModeFromFlags, generatorOptionsFromFlags };
