'use strict';

const ALLOWED_TYPES = new Set([
  'bilibili_video',
  'bilibili_dynamic_text',
  'bilibili_dynamic_repost',
  'bilibili_article',
]);

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

function normalizeManualItem(input, sources, fetchedAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object') throw new Error('人工内容必须是对象');
  if (!ALLOWED_TYPES.has(input.content_type)) throw new Error(`无效 content_type: ${input.content_type || ''}`);
  const source = sources.find(item => item.id === input.source_id && item.platform === 'bilibili');
  if (!source) throw new Error(`B站来源不存在: ${input.source_id || ''}`);
  if (!String(input.title || '').trim()) throw new Error('缺少 title');
  if (!String(input.description ?? input.summary ?? '').trim()) throw new Error('缺少 description/summary');

  const parsed = parseBilibiliUrl(input.url);
  const isDynamic = input.content_type.startsWith('bilibili_dynamic_');
  if (parsed.inferredType === 'bilibili_dynamic' ? !isDynamic : parsed.inferredType !== input.content_type) {
    throw new Error(`链接类型与 content_type 不匹配: ${input.content_type}`);
  }
  const published = new Date(input.published_at);
  if (!input.published_at || Number.isNaN(published.getTime())) throw new Error('published_at 不是有效日期');

  return {
    id: `bilibili-${parsed.nativeId}`,
    platform: 'bilibili',
    native_id: parsed.nativeId,
    content_type: input.content_type,
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

module.exports = { ALLOWED_TYPES, parseBilibiliUrl, normalizeManualItem, importManualItems };
