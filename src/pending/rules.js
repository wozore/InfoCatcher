'use strict';

function normalizeToolToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9一-龥]+/g, '');
}

const VAGUE_FAMILY_NAMES = new Set([
  '通义千问', '腾讯混元', '豆包', 'kimi', '天工ai', '可灵',
  'chatgpt', 'claude', 'gemini', 'deepseek', '智谱清言', '智谱',
  '文心一言', '讯飞星火', '海螺ai', 'grok', 'mistral', 'cohere',
]);

function isVagueName(name) {
  return VAGUE_FAMILY_NAMES.has(String(name || '').trim().toLowerCase());
}

function toolExists(toolName, tools) {
  const needle = String(toolName || '').toLowerCase();
  if (!needle) return false;
  const needleNorm = normalizeToolToken(toolName);
  return (tools || []).some(tool => {
    const title = String(tool.title || tool.name || '');
    const key = String(tool.tool_key || tool.id || '');
    const vendor = String(tool.vendor_label || tool.vendor_name || '').toLowerCase();
    const titleLower = title.toLowerCase();
    const keyLower = key.toLowerCase();
    if (needleNorm && (normalizeToolToken(title) === needleNorm || normalizeToolToken(key) === needleNorm)) return true;
    return (title && titleLower.includes(needle)) || (key && keyLower.includes(needle))
      || (vendor && vendor.includes(needle)) || (needle.includes(titleLower) && title)
      || (needle.includes(keyLower) && key);
  });
}

function conceptExists(conceptName, glossary) {
  const needle = String(conceptName || '').toLowerCase();
  if (!needle) return false;
  return (glossary || []).some(entry => {
    const term = String(entry.term || '').toLowerCase();
    const fullName = String(entry.full_name || '').toLowerCase();
    return (term && term.includes(needle)) || (fullName && fullName.includes(needle))
      || (needle.includes(term) && term) || (needle.includes(fullName) && fullName);
  });
}

module.exports = { isVagueName, toolExists, conceptExists };
