'use strict';

/**
 * catalog-generator-commands.js — 五模块目录生成器 CLI 命令实现
 *
 * 职责：probe/list/recover/plan/new/prepare/resume/review/cancel/apply/remove/
 * prune/batch/url-registry 各命令的参数→选项映射、成本门禁、草稿生命周期编排
 * 与目录事务调用。CLI 契约（参数、输出 JSON、退出码语义）保持不变。
 *
 * 人类 I/O 与控制台输出经 io 注入（io.ask / io.print / io.printError），
 * 本模块不做任何终端读写——壳（scripts/catalog-generator.js）负责绑定。
 */

const fs = require('fs');
const { loadCatalogSnapshot } = require('./core/index');
const { removeCatalogRecords } = require('./transaction');
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
  listDrafts,
} = require('./draft/index');
const { planRetentionPrune, applyRetentionPrune, currentCutoffDate } = require('./catalog-retention-prune');
const { readPendingCards, runBatchFromCards } = require('./intake/index');
const {
  listUrlRegistry,
  addUrlRegistryEntry,
  removeUrlRegistryEntry,
  listProductUrlRegistry,
  addProductUrlRegistryEntry,
  removeProductUrlRegistryEntry,
  auditProductUrlRegistry,
} = require('./url-registry/index');

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

function printPreview(result, io) {
  if (!result.ok) {
    io.printError(result);
    return;
  }
  const draft = result.draft;
  io.print({
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
  });
}

/**
 * 执行目录生成器命令。`parsed` 为壳解析后的参数结构 { positional, flags }；
 * 返回值即 CLI 的结果对象（壳据 result.ok 决定退出码）。
 */
async function runCommand(parsed = { positional: [], flags: {} }, io) {
  const { positional, flags } = parsed;
  const [command, id] = positional;
  if (command === 'probe') {
    if (!flags.confirm_cost) {
      const result = { ok: false, code: 'COST_CONFIRMATION_REQUIRED', cost: { max_ai_calls: 1 } };
      io.print(result);
      return result;
    }
    const options = generatorOptionsFromFlags(flags);
    const result = await probeCatalogCapabilities({ ...options, confirmCost: true });
    io.print(result);
    return result;
  }
  if (command === 'list') {
    const result = { ok: true, drafts: listDrafts().map(draft => ({ draft_id: draft.draft_id, state: draft.state, readiness: draft.readiness })) };
    io.print(result);
    return result;
  }
  if (command === 'recover') {
    const result = recoverCatalogTransactions();
    io.print(result);
    return result;
  }
  if (command === 'plan') {
    const seed = readSeed(flags);
    const result = planCatalogDraft(seed, normalizeGeneratorOptions(loadGeneratorConfig()));
    io.print(result);
    return result;
  }
  if (command === 'new') {
    const seed = readSeed(flags);
    if (!flags.confirm_cost) {
      const result = { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
      io.print(result);
      return result;
    }
    const result = await prepareCatalogDraft(seed, { ...generatorOptionsFromFlags(flags), confirmCost: true });
    printPreview(result, io);
    return result;
  }
  if (command === 'prepare') {
    const seed = readSeed(flags);
    const result = planCatalogDraft(seed, normalizeGeneratorOptions(loadGeneratorConfig()));
    io.print(result);
    return result;
  }
  if (command === 'resume') {
    if (!id) throw new Error('请提供 draft-id');
    if (!flags.confirm_cost) {
      const result = { ok: false, code: 'COST_CONFIRMATION_REQUIRED' };
      io.print(result);
      return result;
    }
    const result = await resumeCatalogDraft(id, { ...generatorOptionsFromFlags(flags), confirmCost: true });
    printPreview(result, io);
    return result;
  }
  if (command === 'review') {
    if (!id) throw new Error('请提供 draft-id');
    const result = reviewCatalogDraft(id);
    io.print(result);
    return result;
  }
  if (command === 'cancel') {
    if (!id) throw new Error('请提供 draft-id');
    const result = discardCatalogDraft(id);
    io.print(result);
    return result;
  }
  if (command === 'apply') {
    if (!id) throw new Error('请提供 draft-id');
    const review = reviewCatalogDraft(id);
    io.print({
      draft_id: id,
      readiness: review.draft?.readiness,
      change_preview: review.plan?.changePreview,
      coverage: review.draft?.coverage,
      layer_patches: review.draft?.layer_patches,
      record_preview: review.plan?.plannedRecords,
      cost: review.draft?.cost,
      preview_hash: review.previewHash,
      current_revision: review.currentRevision,
    });
    if (!review.ok || review.draft?.readiness?.status !== 'ready') return review;
    const confirmation = flags.confirm || await io.ask(`输入 APPLY ${id} 以确认正式写入：`);
    if (confirmation !== `APPLY ${id}`) return { ok: false, code: 'APPLY_CONFIRMATION_REQUIRED' };
    const result = applyCatalogDraft({ draftId: id, previewHash: review.previewHash, expectedRevision: review.currentRevision });
    io.print(result);
    return result;
  }
  if (command === 'remove') {
    if (!flags.targets) throw new Error('请提供 --targets <精确删除目标 JSON>');
    const payload = JSON.parse(fs.readFileSync(flags.targets, 'utf8'));
    const targets = Array.isArray(payload) ? payload : payload.targets;
    if (!Array.isArray(targets) || !targets.length) throw new Error('删除目标 JSON 必须包含非空 targets 数组');
    const label = String(flags.targets).split(/[\\/]/).pop();
    const current = loadCatalogSnapshot();
    io.print({ targets, expected_revision: flags.expected_revision || current.revision, confirmation: `REMOVE ${label}` });
    const confirmation = flags.confirm || await io.ask(`输入 REMOVE ${label} 以确认精确删除：`);
    if (confirmation !== `REMOVE ${label}`) return { ok: false, code: 'REMOVE_CONFIRMATION_REQUIRED' };
    const result = removeCatalogRecords(targets, { expectedRevision: flags.expected_revision || current.revision });
    io.print(result);
    return result;
  }
  if (command === 'prune') {
    // 14 个月滚动级联删除：cutoff 缺省读共享段 data/shared/retention.json（comparison 推进）。
    // 用法：catalog-generator prune [--cutoff <YYYY-MM|YYYY-MM-DD>] [--dry-run] [--confirm]
    const cutoffInput = flags.cutoff
      ? (String(flags.cutoff).length === 7 ? `${flags.cutoff}-01` : String(flags.cutoff))
      : currentCutoffDate();
    if (!cutoffInput) throw new Error('无法确定 cutoff：请提供 --cutoff <YYYY-MM>，或确认共享段 data/shared/retention.json 已初始化');
    const current = loadCatalogSnapshot();
    const planned = planRetentionPrune(current.snapshot, cutoffInput);
    if (!planned.ok) { io.print(planned); return planned; }
    io.print({
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
    });
    if (flags.dry_run || !planned.has_changes) return { ...planned, dry_run: flags.dry_run === true, committed: false };
    const confirmation = flags.confirm || await io.ask(`输入 PRUNE ${planned.cutoff_date} 以确认滚动删除：`);
    if (confirmation !== `PRUNE ${planned.cutoff_date}`) return { ok: false, code: 'PRUNE_CONFIRMATION_REQUIRED' };
    const result = applyRetentionPrune({ cutoffDate: planned.cutoff_date, expectedRevision: current.revision, previewHash: planned.preview_hash });
    io.print(result);
    return result;
  }
  if (command === 'batch') {
    // 批量生成：待补卡 → 查重 → 厂商/官方源解析 → 逐 seed 生成 → 自动 apply。
    // 用法：catalog-generator batch --file <待补卡.json> [--confirm-cost] [--dry-run] [--from-preview] [--seed-out <file>]
    if (!flags.file) throw new Error('请提供 --file <待补卡文件>（先运行 node scripts/news-cli.js min-review feedback 生成）');
    const cards = readPendingCards(flags.file);
    const batchOptions = generatorOptionsFromFlags(flags);
    const result = await runBatchFromCards(cards, {
      generatorOptions: batchOptions,
      accessMode: batchOptions.accessMode,
      dryRun: flags.dry_run === true,
      fromPreview: flags.from_preview === true,
      confirmCost: flags.confirm_cost === true,
      ...(flags.seed_out ? { previewFile: flags.seed_out } : {}),
    });
    io.print(result);
    return result;
  }
  if (command === 'url-registry') {
    // 人工官方 URL 登记表维护（批量生成解析第一道命中源）。
    const requestedNamespace = positional[1];
    const namespace = requestedNamespace === 'product' ? 'product' : 'vendor';
    const action = namespace === 'vendor' && !['vendor', 'product'].includes(requestedNamespace)
      ? requestedNamespace
      : positional[2];
    if (namespace === 'vendor' && action === 'list') {
      const store = listUrlRegistry();
      io.print(store);
      return { ok: true, ...store };
    }
    if (namespace === 'vendor' && action === 'add') {
      const result = addUrlRegistryEntry({
        name: flags.name,
        vendor_name: flags.vendor,
        official_url: flags.url,
        aliases: csvFlag(flags.alias),
        product_prefixes: csvFlag(flags.product_prefix),
        model_prefixes: csvFlag(flags.model_prefix),
      });
      io.print(result);
      return result;
    }
    if (namespace === 'vendor' && action === 'remove') {
      const result = removeUrlRegistryEntry(flags.name);
      io.print(result);
      return result;
    }
    if (namespace === 'product' && action === 'list') {
      const store = listProductUrlRegistry();
      io.print(store);
      return { ok: true, ...store };
    }
    if (namespace === 'product' && action === 'add') {
      const result = addProductUrlRegistryEntry({
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
      io.print(result);
      return result;
    }
    if (namespace === 'product' && action === 'remove') {
      const result = removeProductUrlRegistryEntry(flags.name);
      io.print(result);
      return result;
    }
    if (namespace === 'product' && action === 'audit') {
      const staleDays = flags.stale_days === true ? undefined : Number(flags.stale_days);
      const result = auditProductUrlRegistry({ staleDays });
      io.print(result);
      return result;
    }
    throw new Error('用法: catalog-generator url-registry vendor list|add --name <名> --url <URL> [--vendor <厂商>] [--alias <别名>] [--product-prefix <前缀,...>] [--model-prefix <前缀,...>] | remove --name <名>; url-registry product list|add --name <产品> --vendor-key <厂商键> --url <URL> [--alias <别名>] [--product-prefix <前缀,...>] [--lifecycle <状态>] [--verified-at <YYYY-MM-DD>] [--official-update-at <YYYY-MM-DD>] [--superseded-by <产品键>] | remove --name <产品> | audit [--stale-days <天数>]');
  }
  throw new Error('用法: catalog-generator probe|plan|prepare|list|recover|new|resume|review|apply|cancel|remove|prune|batch|url-registry');
}

module.exports = {
  runCommand,
  readSeed,
  tavilyAccessModeFromFlags,
  generatorOptionsFromFlags,
};
