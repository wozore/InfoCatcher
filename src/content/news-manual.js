/**
 * news-manual.js — B 站人工整理条目的规范化与导入
 *
 * 数据流：人工录入的原始 JSON → parseBilibiliUrl 校验/推断链接 → normalizeManualItem
 * 规范化为标准条目 → importManualItems 去重并合并进 payload.items。
 * 产物与采集管线共用同一 items 结构（含 metrics/explicit_links 等占位字段），
 * 人工条目因此无需特殊渲染路径即可进入下游。
 */
'use strict';

// B16 决策 65：ALLOWED_SOURCE_TYPES 是来源媒体类型（B 站），内容类型由 content_type 字段单独表达。
const ALLOWED_SOURCE_TYPES = new Set([
  'bilibili_video',
  'bilibili_dynamic_text',
  'bilibili_dynamic_repost',
  'bilibili_article',
]);

/**
 * 校验并解析单个 B 站公开链接。
 * @returns {{url: string, nativeId: string, inferredType: string}} url 为规范化后的完整 URL。
 * inferredType 只能区分到 视频/动态/专栏 三级：视频与专栏可精确到单一 source_type；
 * 动态（含 t.bilibili.com 短链与 /opus/ 路径）统一推断为 'bilibili_dynamic'，
 * 精确变体由调用方按 source_type 前缀放行（见 normalizeManualItem）。
 * @throws 非 HTTPS / 非 bilibili.com 域名 / 无法识别时抛错。
 */
function parseBilibiliUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('url 不是有效 URL'); }
  if (url.protocol !== 'https:') throw new Error('B站内容 url 必须使用 HTTPS');
  const host = url.hostname.toLowerCase();
  if (!['www.bilibili.com', 'bilibili.com', 't.bilibili.com'].includes(host)) {
    throw new Error('只允许 bilibili.com 的公开内容链接');
  }

  const path = url.pathname.replace(/\/$/, '');
  let match = path.match(/^\/video\/(BV[A-Za-z0-9]+|av\d+)$/i);
  if (match) return { url: url.toString(), nativeId: match[1], inferredType: 'bilibili_video' };
  match = path.match(/^\/(?:opus\/)?(\d+)$/);
  if (host === 't.bilibili.com' && match) return { url: url.toString(), nativeId: `dynamic-${match[1]}`, inferredType: 'bilibili_dynamic' };
  match = path.match(/^\/opus\/(\d+)$/);
  if (match) return { url: url.toString(), nativeId: `dynamic-${match[1]}`, inferredType: 'bilibili_dynamic' };
  match = path.match(/^\/read\/(cv\d+)$/i);
  if (match) return { url: url.toString(), nativeId: match[1].toLowerCase(), inferredType: 'bilibili_article' };
  throw new Error('无法从链接识别 BV/av、动态/Opus ID 或 cv 专栏 ID');
}

/**
 * 将单条人工录入规范化为标准 news item。
 * 契约：source_id 必须存在于 sources（bilibili 平台）中；title/description 必填；
 * 链接推断类型与声明的 source_type 必须匹配；published_at 必须是有效日期。
 * 生成的 id 恒为 `bilibili-${nativeId}`，native_id 直接采用链接中的 BV/av/动态/专栏 ID。
 */
function normalizeManualItem(input, sources, fetchedAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object') throw new Error('人工内容必须是对象');
  if (!ALLOWED_SOURCE_TYPES.has(input.source_type)) throw new Error(`无效 source_type: ${input.source_type || ''}`);
  const source = sources.find(item => item.id === input.source_id && item.platform === 'bilibili');
  if (!source) throw new Error(`B站来源不存在: ${input.source_id || ''}`);
  if (!String(input.title || '').trim()) throw new Error('缺少 title');
  if (!String(input.description ?? input.summary ?? '').trim()) throw new Error('缺少 description/summary');

  const parsed = parseBilibiliUrl(input.url);
  // URL 推断只能到「动态」这一级，而 source_type 有 dynamic_text/dynamic_repost 等细粒度变体，
  // 故动态类只需 URL 是动态即放行；非动态类（video/article）则必须与推断类型精确一致。
  const isDynamic = input.source_type.startsWith('bilibili_dynamic_');
  if (parsed.inferredType === 'bilibili_dynamic' ? !isDynamic : parsed.inferredType !== input.source_type) {
    throw new Error(`链接类型与 source_type 不匹配: ${input.source_type}`);
  }
  const published = new Date(input.published_at);
  if (!input.published_at || Number.isNaN(published.getTime())) throw new Error('published_at 不是有效日期');

  return {
    id: `bilibili-${parsed.nativeId}`,
    platform: 'bilibili',
    native_id: parsed.nativeId,
    source_type: input.source_type,
    content_type: input.content_type || 'unclassified',
    content_type_status: input.content_type_status || 'unclassified',
    url: parsed.url,
    title: String(input.title).trim().slice(0, 300),
    description: String(input.description ?? input.summary).trim().slice(0, 600),
    published_at: published.toISOString(),
    fetched_at: fetchedAt,
    author_id: source.id,
    author_name: source.name,
    source_id: source.id,
    language: source.language,
    source_tags: Array.isArray(source.content_tags) ? source.content_tags : [],
    thumbnail: null,
    metrics: { views: null, likes: null, comments: null, reposts: null, replies: null },
    explicit_links: [],
    acquisition_method: 'manual_curated',
  };
}

/**
 * 批量导入人工条目：先逐条校验并暂存（staged），全部无错（或 allowPartial）才提交进 payload.items。
 * 去重键为 `bilibili:${native_id}`，同时比对既有 items 与本批内暂存项，避免批内自重复。
 * @returns {{added: object[], errors: Array<{index: number, error: string}>, committed: boolean}}
 * 有错且 !allowPartial 时返回 committed:false 且不写入任何条目（原子性）。
 */
function importManualItems(payload, inputs, sources, allowPartial = false, fetchedAt = new Date().toISOString()) {
  const values = Array.isArray(inputs) ? inputs : inputs?.items;
  if (!Array.isArray(values)) throw new Error('导入文件必须是数组或包含 items 数组');
  payload.items ||= [];
  const existing = new Set(payload.items.map(item => `bilibili:${item.native_id}`));
  const staged = [];
  const errors = [];
  for (let index = 0; index < values.length; index += 1) {
    try {
      const item = normalizeManualItem(values[index], sources, fetchedAt);
      const key = `bilibili:${item.native_id}`;
      if (existing.has(key) || staged.some(entry => entry.native_id === item.native_id)) throw new Error(`内容已存在: ${key}`);
      staged.push(item);
    } catch (error) { errors.push({ index, error: error.message }); }
  }
  if (errors.length && !allowPartial) return { added: [], errors, committed: false };
  payload.items.push(...staged);
  return { added: staged, errors, committed: staged.length > 0 };
}

module.exports = { ALLOWED_SOURCE_TYPES, parseBilibiliUrl, normalizeManualItem, importManualItems };
