const DATA_FILES = {
  'vendor-card': 'data/catalog/vendor-cards.json',
  'tool-card': 'data/catalog/tool-cards.json',
  'vendor-level1': 'data/catalog/vendor-preview-level1.json',
  'vendor-level2': 'data/catalog/vendor-preview-level2.json',
  'tool-level3': 'data/catalog/tool-preview-level3.json',
};

const state = {
  loaded: false,
  loading: null,
  data: new Map(),
  indexes: new Map(),
};

function failure(code, message, ref) {
  return { ok: false, error: { code, message, ...(ref ? { ref } : {}) } };
}

function success(data, meta) {
  return { ok: true, data, ...(meta ? { meta } : {}) };
}

function buildIndex(items) {
  return new Map((Array.isArray(items) ? items : []).map(item => [item.id, item]));
}

async function loadCatalog() {
  if (state.loaded) return success(true);
  if (state.loading) return state.loading;
  state.loading = Promise.all(Object.entries(DATA_FILES).map(async ([area, file]) => {
    const response = await fetch(file);
    if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
    const payload = await response.json();
    const items = Array.isArray(payload) ? payload : payload.items;
    if (!Array.isArray(items)) throw new Error(`${file}: items 必须为数组`);
    state.data.set(area, items);
    state.indexes.set(area, buildIndex(items));
  })).then(() => {
    state.loaded = true;
    return success(true);
  }).catch(error => {
    state.data.clear();
    state.indexes.clear();
    return failure('LOAD_FAILED', error.message);
  }).finally(() => {
    state.loading = null;
  });
  return state.loading;
}

function queryArea(area, operation, id, ids, filters) {
  if (!DATA_FILES[area]) return failure('INVALID_AREA', `未知目录模块: ${area}`);
  if (!state.loaded) return failure('NOT_READY', '目录数据尚未加载');
  const items = state.data.get(area) || [];
  const index = state.indexes.get(area) || new Map();
  if (operation === 'get') {
    const item = index.get(id);
    return item ? success(item) : failure('NOT_FOUND', `未找到 ${area}: ${id}`, { kind: area, id });
  }
  if (operation === 'resolve') {
    if (!id || id.kind !== area) return failure('INVALID_REF', `引用类型与目录模块不匹配`, id);
    const item = index.get(id.id);
    return item ? success(item) : failure('NOT_FOUND', `未找到引用: ${id.id}`, id);
  }
  if (operation !== 'list') return failure('INVALID_OPERATION', `不支持的操作: ${operation}`);

  let result = ids?.length ? ids.map(itemId => index.get(itemId)).filter(Boolean) : [...items];
  if (filters?.query) {
    const query = String(filters.query).trim().toLocaleLowerCase('zh-CN');
    if (query) result = result.filter(item => (item.search_terms || []).some(term => String(term).toLocaleLowerCase('zh-CN').includes(query)));
  }
  if (area === 'vendor-card') {
    if (filters?.category && filters.category !== 'all') result = result.filter(item => (item.categories || []).includes(filters.category));
    if (filters?.access && filters.access !== 'all') result = result.filter(item => item.access_level === filters.access);
    if (filters?.price === 'free') result = result.filter(item => item.price_status === 'free');
    if (filters?.price === 'paid') result = result.filter(item => item.price_status !== 'free');
  }
  if (area === 'tool-card') {
    if (filters?.category && filters.category !== 'all') result = result.filter(item => (item.categories || []).includes(filters.category));
    if (filters?.access && filters.access !== 'all') result = result.filter(item => item.access_level === filters.access);
    if (filters?.price === 'free') result = result.filter(item => item.price_badge === 'free');
    if (filters?.price === 'paid') result = result.filter(item => item.price_badge !== 'free');
  }
  return success(result, { total: result.length });
}

function catalog(request = {}) {
  const { area, operation = 'list', id, ids, filters } = request;
  if (operation === 'load') return loadCatalog();
  if (operation === 'status') return success({ loaded: state.loaded, areas: [...state.data.keys()] });
  return queryArea(area, operation, id, ids, filters);
}

export { catalog };
