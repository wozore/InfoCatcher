/**
 * cmd-sources.js —— source 命令组：来源管理（自 news-cli.js 拆分，行为不变）
 *
 *   source add     --platform youtube|bilibili|x --external-id ... --name ... --url ... --language ... --tag ...
 *   source import  --file <json> [--dry-run] [--allow-partial]
 *   source enable  --id ...
 *   source disable --id ...
 *
 *   - add: 单条添加，校验平台 ID 格式、HTTPS 主页、标签合法、同平台不重复。
 *   - import: 批量导入，默认全有或全无（atomic），--allow-partial 才写入有效条目。
 *   - enable/disable: 切换来源启用状态，不删除数据。
 *
 * 本文件是拆分后的共享基座：FILES / PLATFORMS / save 供其他命令文件复用，
 * 由 news-cli.js 汇总 re-export（避免子文件反向 require 入口造成的循环依赖）。
 * 完整 CLI 帮助见 news-cli.js 顶部。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { readJson, writeJsonAtomic } = require('../core/news-storage');
const { NEWS_FILES } = require('../../shared/paths');

/** CLI 操作的目标数据文件（均为绝对路径） */
const FILES = {
  sources: NEWS_FILES.sources,
  authorizations: NEWS_FILES.authorizations,
  quota: NEWS_FILES.quota,
  registry: NEWS_FILES.registry,
  manualItems: NEWS_FILES.manualItems,
  lock: NEWS_FILES.lock,
  audit: NEWS_FILES.adminAudit,
  candidates: NEWS_FILES.candidates,
  config: NEWS_FILES.config,
  registryPruned: NEWS_FILES.registryPruned,
};

const PLATFORMS = new Set(['youtube', 'bilibili', 'x']);
const ALLOWED_TAGS = new Set(['横向测评', '即时资讯', '深度解读', '教程实践', '行业观点', '轻度用户体验', '官方来源']);

// ── 工具函数 ──────────────────────────────────────────────

function slug(value) {
  return String(value).toLowerCase().normalize('NFKD').replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '') || 'source';
}

/** 标准化标签：支持数组或逗号/顿号分隔字符串 */
function normalizeTags(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[、,，]/);
  return [...new Set(values.map(tag => tag.trim()).filter(Boolean))];
}

/** 统一 JSON 写入入口 */
function save(file, value, prefix = 'cli') {
  writeJsonAtomic(file, value, `${prefix}-${Date.now()}`);
}

// ── 来源校验 ──────────────────────────────────────────────

/**
 * 校验并标准化一条来源输入。
 * 校验项：
 *   - platform 合法
 *   - external_id 格式匹配平台规则
 *   - profile_url 使用 HTTPS
 *   - content_tags 来自允许列表
 *   - 不与现有来源的 (platform, external_id) 重复
 *
 * @param {object} input 用户提供的来源字段
 * @param {Array} existing 已存在的来源列表（用于去重）
 * @returns {object} 标准化后的来源对象
 */
function validateSource(input, existing = []) {
  if (!PLATFORMS.has(input.platform)) throw new Error(`无效 platform: ${input.platform}`);
  if (!input.external_id) throw new Error('缺少 external_id');
  if (!input.name) throw new Error('缺少 name');

  let url;
  try { url = new URL(input.profile_url); } catch { throw new Error('profile_url 不是有效 URL'); }
  if (url.protocol !== 'https:') throw new Error('profile_url 必须使用 HTTPS');

  // 平台 ID 格式校验
  if (input.platform === 'youtube' && !/^UC[A-Za-z0-9_-]{20,}$/.test(input.external_id)) throw new Error('YouTube external_id 必须是 UC 开头的 Channel ID');
  if (input.platform === 'bilibili' && !/^\d+$/.test(input.external_id)) throw new Error('Bilibili external_id 必须是数字 UID');
  if (input.platform === 'x' && !/^[A-Za-z0-9_]{1,15}$/.test(input.external_id.replace(/^@/, ''))) throw new Error('X external_id 必须是有效用户名');

  const tags = normalizeTags(input.content_tags);
  if (!tags.length || tags.some(tag => !ALLOWED_TAGS.has(tag))) throw new Error('content_tags 缺失或包含未知标签');

  // 同平台去重（大小写不敏感）
  const normalizedExternalId = input.platform === 'x' ? input.external_id.replace(/^@/, '') : input.external_id;
  if (existing.some(source => source.platform === input.platform && String(source.external_id).toLowerCase() === normalizedExternalId.toLowerCase())) {
    throw new Error(`来源已存在: ${input.platform}:${normalizedExternalId}`);
  }

  return {
    id: `${input.platform}-${slug(normalizedExternalId)}`,
    platform: input.platform,
    external_id: normalizedExternalId,
    handle: input.platform === 'x' ? normalizedExternalId : null,
    name: input.name,
    profile_url: url.toString(),
    language: ['zh', 'en'].includes(input.language) ? input.language : 'unknown',
    primary_type: input.primary_type || null,
    content_tags: tags,
    original_tags: normalizeTags(input.original_tags),
    cadence_class: ['low_frequency', 'high_frequency'].includes(input.cadence_class) ? input.cadence_class : 'unknown',
    enabled: input.enabled !== false,
    collector: input.platform === 'youtube' ? 'youtube_rss' : input.platform === 'x' ? 'twitterapi_io' : 'rsshub_bilibili',
    reliability_prior: Number(input.reliability_prior || 50),
    quality_prior: Number(input.quality_prior || 50),
    active_60d: null,
    evidence_url: url.toString(),
    checked_at: new Date().toISOString().slice(0, 10),
    notes: input.notes || '',
    needs_review: false,
    review_notes: [],
  };
}

/**
 * 批量导入来源。
 * 默认原子操作：所有输入都通过校验后才写入，任一条失败则全部回滚。
 * 传入 allowPartial=true 时，只写入通过校验的条目。
 *
 * @returns {{ added: Array, errors: Array, committed: boolean }}
 */
function importSources(payload, inputs, allowPartial = false) {
  const sourceInputs = Array.isArray(inputs) ? inputs : inputs.sources;
  if (!Array.isArray(sourceInputs)) throw new Error('导入文件必须是数组或包含 sources 数组');
  const staged = [];
  const errors = [];
  for (let index = 0; index < sourceInputs.length; index += 1) {
    try { staged.push(validateSource(sourceInputs[index], [...payload.sources, ...staged])); }
    catch (error) { errors.push({ index, error: error.message }); }
  }
  if (errors.length && !allowPartial) return { added: [], errors, committed: false };
  payload.sources.push(...staged);
  return { added: staged, errors, committed: staged.length > 0 };
}

// ── 命令实现 ──────────────────────────────────────────────

function sourceCommand(action, flags) {
  const payload = readJson(FILES.sources, { schema_version: 1, sources: [] });

  if (action === 'add') {
    const source = validateSource({
      platform: flags.platform, external_id: flags.external_id, name: flags.name,
      profile_url: flags.url, language: flags.language, content_tags: normalizeTags(flags.tag || flags.tags),
      primary_type: flags.primary_type, cadence_class: flags.cadence,
      quality_prior: flags.quality_prior, notes: flags.notes,
    }, payload.sources);
    payload.sources.push(source);
    payload.generated_at = new Date().toISOString();
    save(FILES.sources, payload, 'source-add');
    return { added: source.id };
  }

  if (action === 'import') {
    if (!flags.file) throw new Error('source import 缺少 --file');
    const input = JSON.parse(fs.readFileSync(path.resolve(flags.file), 'utf8'));
    const result = importSources(payload, input, Boolean(flags.allow_partial));
    if (!flags.dry_run && result.committed) {
      payload.generated_at = new Date().toISOString();
      save(FILES.sources, payload, 'source-import');
    }
    return { ...result, dry_run: Boolean(flags.dry_run) };
  }

  if (action === 'enable' || action === 'disable') {
    const source = payload.sources.find(item => item.id === flags.id);
    if (!source) throw new Error(`来源不存在: ${flags.id}`);
    source.enabled = action === 'enable';
    payload.generated_at = new Date().toISOString();
    save(FILES.sources, payload, `source-${action}`);
    return { id: source.id, enabled: source.enabled };
  }

  throw new Error(`未知 source 命令: ${action}`);
}

module.exports = {
  sourceCommand, normalizeTags, validateSource, importSources,
  FILES, save, PLATFORMS,
};
