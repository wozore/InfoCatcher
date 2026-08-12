'use strict';

const fs = require('fs');
const path = require('path');
const { DIRS } = require('./shared/paths');

const DATA_FILES = Object.freeze({
  'vendor-card': path.join(DIRS.catalog, 'vendor-cards.json'),
  'tool-card': path.join(DIRS.catalog, 'tool-cards.json'),
  'vendor-level1': path.join(DIRS.catalog, 'vendor-preview-level1.json'),
  'vendor-level2': path.join(DIRS.catalog, 'vendor-preview-level2.json'),
  'tool-level3': path.join(DIRS.catalog, 'tool-preview-level3.json'),
});

let state = null;

function failure(code, message, ref) {
  return { ok: false, error: { code, message, ...(ref ? { ref } : {}) } };
}

function success(data, meta) {
  return { ok: true, data, ...(meta ? { meta } : {}) };
}

function loadCatalogData() {
  const data = new Map();
  const indexes = new Map();
  for (const [area, file] of Object.entries(DATA_FILES)) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(payload) ? payload : payload.items;
    if (!Array.isArray(items)) throw new Error(`${file}: items 必须为数组`);
    data.set(area, items);
    indexes.set(area, new Map(items.map(item => [item.id, item])));
  }
  state = { data, indexes };
  return success(true);
}

function queryArea(area, operation, id, ids, filters, writeItems) {
  if (!DATA_FILES[area]) return failure('INVALID_AREA', `未知目录模块: ${area}`);
  if (!state) {
    try { loadCatalogData(); } catch (error) { return failure('LOAD_FAILED', error.message); }
  }
  const items = state.data.get(area) || [];
  const index = state.indexes.get(area) || new Map();
  if (operation === 'get') {
    const item = index.get(id);
    return item ? success(item) : failure('NOT_FOUND', `未找到 ${area}: ${id}`, { kind: area, id });
  }
  if (operation === 'resolve') {
    if (!id || id.kind !== area) return failure('INVALID_REF', '引用类型与目录模块不匹配', id);
    const item = index.get(id.id);
    return item ? success(item) : failure('NOT_FOUND', `未找到引用: ${id.id}`, id);
  }
  if (operation === 'replace') {
    if (area !== 'tool-level3' || !Array.isArray(writeItems)) return failure('INVALID_WRITE', '只有 tool-level3 支持批量替换');
    const file = DATA_FILES[area];
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ schema_version: 1, items: writeItems }, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
    state = null;
    return loadCatalogData();
  }
  if (operation !== 'list') return failure('INVALID_OPERATION', `不支持的操作: ${operation}`);
  let result = ids?.length ? ids.map(itemId => index.get(itemId)).filter(Boolean) : [...items];
  if (filters?.query) {
    const query = String(filters.query).trim().toLocaleLowerCase('zh-CN');
    if (query) result = result.filter(item => (item.search_terms || []).some(term => String(term).toLocaleLowerCase('zh-CN').includes(query)));
  }
  return success(result, { total: result.length });
}
function catalog(request = {}) {
  const { area, operation = 'list', id, ids, filters, items } = request;
  if (operation === 'replace') return queryArea(area, operation, id, ids, filters, items);
  if (operation === 'load') {
    try { return loadCatalogData(); } catch (error) { return failure('LOAD_FAILED', error.message); }
  }
  if (operation === 'status') return success({ loaded: Boolean(state), areas: state ? [...state.data.keys()] : [] });
  return queryArea(area, operation, id, ids, filters, items);
}

function resetCatalogForTests() {
  state = null;
}

module.exports = { catalog, DATA_FILES, resetCatalogForTests };
