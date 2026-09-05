/**
 * search-index.js — 搜索索引构建与内存匹配
 * 提供分层关键词索引（场景层 → 内容层 → 热点概念层）与概念边界探测。
 */

import { state, dataLoadFailures } from '../state.js';
import { getToolSearchText } from '../data/data-catalog.js';
import { getLocalizedField } from '../ui/i18n.js';

export function hotspotField(item, field) {
  return getLocalizedField(item, field) || item[field] || '';
}

export function extractKeywords(query, wordTable) {
  const needle = String(query || '').trim().toLocaleLowerCase('zh-CN').normalize('NFKC');
  if (!needle) return [];
  const seen = new Set();
  const hits = [];
  for (const entry of wordTable || []) {
    const word = String(entry?.word || '').trim();
    if (!word || word.length < 2) continue;
    const key = word.toLocaleLowerCase('zh-CN').normalize('NFKC');
    if (seen.has(key)) continue;
    if (needle.includes(key)) {
      seen.add(key);
      hits.push(entry);
    }
  }
  return hits.sort((a, b) => String(b.word).length - String(a.word).length);
}

function buildSceneWordTable() {
  const table = [];
  for (const scene of state.scenes || []) {
    for (const word of [scene.name, ...(scene.search_terms || [])]) {
      if (word && String(word).trim().length >= 2) table.push({ word, source: scene });
    }
  }
  return table;
}

function matchToolsByKeywords(keywords) {
  if (!keywords.length) return [];
  const needles = keywords.map(word => String(word).toLocaleLowerCase('zh-CN').normalize('NFKC')).filter(Boolean);
  return state.tools
    .map(tool => {
      const text = getToolSearchText(tool);
      const hits = needles.filter(needle => text.includes(needle));
      return { tool, score: hits.length };
    })
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.tool);
}

function deriveWordForms(word) {
  const text = String(word || '').trim();
  if (!text || text.length < 2) return [];
  const first = text.split(/[\s\-_.:/·,，、（）()]+/)[0].trim();
  const forms = [text];
  if (first && first.length >= 2 && first !== text) forms.push(first);
  return forms;
}

function buildToolWordTable() {
  const table = [];
  for (const tool of state.tools || []) {
    for (const word of [tool.title, tool.vendor_label, ...(tool.search_terms || [])]) {
      for (const form of deriveWordForms(word)) {
        if (form.length >= 2) table.push({ word: form, source: tool });
      }
    }
  }
  return table;
}

function buildConceptWordTable() {
  const table = [];
  for (const concept of state.glossary || []) {
    for (const word of [concept.term, concept.full_name]) {
      if (word && String(word).trim().length >= 2) table.push({ word, source: concept });
    }
  }
  return table;
}

function buildHotspotWordTable() {
  const table = [];
  for (const item of state.hotspots.items || []) {
    const title = String(hotspotField(item, 'title') || '');
    const tokens = title.match(/[A-Za-z0-9][A-Za-z0-9-]*/g) || [];
    for (const token of new Set(tokens)) {
      if (token.length >= 3) table.push({ word: token, source: item });
    }
  }
  return table;
}

export function getSearchMatches(query) {
  const normalizedQuery = String(query || '').trim();
  const unavailable = [...dataLoadFailures].filter(key => ['tools', 'hotspots', 'glossary'].includes(key));
  if (!normalizedQuery) return { query: normalizedQuery, layer: null, demoKey: null, demoHint: '', keywords: [], tools: [], unavailable };

  const sceneHits = extractKeywords(normalizedQuery, buildSceneWordTable());
  if (sceneHits.length) {
    const scene = sceneHits[0].source;
    const keywords = sceneHits.map(hit => hit.word);
    return { query: normalizedQuery, layer: 'scene', demoKey: scene.id, demoHint: scene.description || '', keywords, scene, tools: matchToolsByKeywords(keywords), unavailable };
  }

  const contentHits = extractKeywords(normalizedQuery, buildToolWordTable());
  if (contentHits.length) {
    const keywords = contentHits.map(hit => hit.word);
    return { query: normalizedQuery, layer: 'content', demoKey: 'content', demoHint: '', keywords, tools: matchToolsByKeywords(keywords), unavailable };
  }

  const conceptHits = extractKeywords(normalizedQuery, buildConceptWordTable());
  const hotspotHits = extractKeywords(normalizedQuery, buildHotspotWordTable());
  if (conceptHits.length || hotspotHits.length) {
    const concepts = [...new Set(conceptHits.map(hit => hit.source))];
    const hotspotItems = [...new Set(hotspotHits.map(hit => hit.source))];
    const keywords = [...new Set([...conceptHits, ...hotspotHits].map(hit => hit.word))];
    return { query: normalizedQuery, layer: 'knowledge', demoKey: 'knowledge', demoHint: '', keywords, concepts, hotspots: hotspotItems, tools: [], unavailable };
  }

  return { query: normalizedQuery, layer: null, demoKey: null, demoHint: '', keywords: [], tools: [], unavailable };
}

export function getSearchResultAvailability(matches) {
  if (!matches.layer) return { type: 'no-match', message: '当前问题没有匹配到已收录的场景、工具或概念资料。' };
  if (matches.layer === 'knowledge') return { type: 'success', message: '' };
  if (matches.unavailable.includes('tools')) {
    return { type: 'error', message: '匹配所需的工具资料当前不可用，请刷新页面后重试。' };
  }
  if (!matches.tools.length) return { type: 'no-match', message: '当前场景没有匹配到可展示的工具资料。' };
  return { type: 'success', message: '' };
}

export function getSearchResultProjection(query) {
  const matches = getSearchMatches(query);
  return { matches, tools: matches.layer === 'scene' || matches.layer === 'content' ? matches.tools : [] };
}

export function getSearchHotspotRanking(query, limit = 5) {
  const needle = String(query || '').trim().toLocaleLowerCase('zh-CN');
  const ranked = (state.hotspots.items || []).map(item => {
    const haystack = [hotspotField(item, 'title'), hotspotField(item, 'description'), hotspotField(item, 'summary')].filter(Boolean).join('\n').toLocaleLowerCase('zh-CN');
    let score = 0;
    if (needle) {
      let idx = haystack.indexOf(needle);
      while (idx >= 0) { score += 1; idx = haystack.indexOf(needle, idx + needle.length); }
    }
    const ts = new Date(item.published_at).getTime();
    return { item, score, ts: Number.isFinite(ts) ? ts : 0 };
  });
  ranked.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return ranked.slice(0, limit).map(entry => entry.item);
}

export function isSearchConceptTextNode(node) {
  const parent = node.parentElement;
  if (!parent || !node.nodeValue?.trim()) return false;
  if (parent.closest('a, button, input, textarea, select, code, pre, time, [data-search-concept], #searchConceptPopover')) return false;
  return Boolean(parent.closest('[data-search-concept-text]'));
}

const CONCEPT_EXCLUSION = new Set(['API', 'Token', 'Temperature', 'A/B测试']);

export function getSearchConceptPatterns() {
  return (state.glossary || []).flatMap(concept => [
    { text: concept.term, concept },
    ...(concept.full_name && concept.full_name !== concept.term ? [{ text: concept.full_name, concept }] : [])
  ]).filter(item => item.text?.trim() && !CONCEPT_EXCLUSION.has(item.text)).sort((a, b) => b.text.length - a.text.length);
}

export function searchConceptHasBoundary(text, index, patternText) {
  if (!/[A-Za-z0-9]/.test(patternText)) return true;
  const before = text[index - 1];
  const after = text[index + patternText.length];
  const isWordChar = ch => ch !== undefined && /[A-Za-z0-9]/.test(ch);
  return !isWordChar(before) && !isWordChar(after);
}

export function findSearchConcept(text, patterns) {
  const lower = text.toLocaleLowerCase('zh-CN');
  let best = null;
  patterns.forEach(pattern => {
    const patternLower = pattern.text.toLocaleLowerCase('zh-CN');
    let index = lower.indexOf(patternLower);
    while (index >= 0) {
      if (searchConceptHasBoundary(text, index, pattern.text)) {
        if (!best || index < best.index || (index === best.index && pattern.text.length > best.pattern.text.length)) {
          best = { index, pattern };
        }
        break;
      }
      index = lower.indexOf(patternLower, index + 1);
    }
  });
  return best;
}
