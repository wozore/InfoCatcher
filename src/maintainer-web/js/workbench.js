(() => {
  'use strict';

  const API_ROOT = '/api/workbench/v1/';
  const state = {
    token: tokenFromFragment(),
    revisions: Object.create(null),
    items: { news: [], keywords: [], top: [], toolUpdates: [], concepts: [] },
    selected: { news: new Set(), keywords: new Set(), top: new Set() },
    uploads: new Map(),
    uploading: new Set(),
    refreshTail: Promise.resolve(),
    toolPreview: null,
    catalogBatch: null,
    catalogRecovery: new Map(),
    conceptPreview: null,
    loading: new Set()
  };

  const $ = (selector) => document.querySelector(selector);
  const text = (value) => value === null || value === undefined ? '' : String(value);
  const first = (object, keys, fallback = '') => {
    if (!object || typeof object !== 'object') return fallback;
    for (const key of keys) {
      if (object[key] !== undefined && object[key] !== null) return object[key];
    }
    return fallback;
  };

  function tokenFromFragment() {
    const fragment = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
    if (!fragment) return '';
    const params = new URLSearchParams(fragment);
    const namedToken = params.get('token') || params.get('access_token');
    if (namedToken) return namedToken;
    if (!fragment.includes('=')) {
      try { return decodeURIComponent(fragment); } catch (_) { return fragment; }
    }
    return '';
  }

  function unwrap(payload) {
    if (payload && payload.data && typeof payload.data === 'object') return payload.data;
    return payload;
  }

  function revisionFrom(payload) {
    const candidates = [
      payload && payload.revision,
      payload && payload.meta && payload.meta.revision,
      payload && payload.data && payload.data.revision,
      payload && payload.data && payload.data.meta && payload.data.meta.revision
    ];
    return candidates.find((value) => typeof value === 'string' && value.length > 0) || '';
  }

  function listFrom(payload, keys) {
    const value = unwrap(payload);
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    for (const key of keys) if (Array.isArray(value[key])) return value[key];
    return [];
  }

  function countFrom(value, keys) {
    const raw = first(value, keys, null);
    const number = Number(raw);
    return Number.isFinite(number) ? number : null;
  }

  class ApiError extends Error {
    constructor(status, message, payload = null) {
      super(message || `API 请求失败（${status}）`);
      this.name = 'ApiError';
      this.status = status;
      this.payload = payload;
      this.code = payload?.code || payload?.error || null;
    }
  }

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const timeoutMs = options.timeoutMs;
    const controller = timeoutMs ? new AbortController() : null;
    const signal = controller
      ? (options.signal && typeof AbortSignal.any === 'function'
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal)
      : options.signal;
    const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
    const fetchOptions = { ...options, headers };
    delete fetchOptions.timeoutMs;
    if (signal) fetchOptions.signal = signal;
    try {
      const response = await fetch(`${API_ROOT}${path}`, fetchOptions);
      let payload = null;
      try { payload = await response.json(); } catch (_) { payload = null; }
      if (!response.ok) {
        const serverMessage = payload && typeof payload.message === 'string'
          ? payload.message
          : (payload && typeof payload.error === 'string'
            ? payload.error
            : (payload && typeof payload.code === 'string' ? payload.code : ''));
        throw new ApiError(response.status, serverMessage, payload);
      }
      return payload;
    } catch (error) {
      if (controller && controller.signal.aborted && !(options.signal && options.signal.aborted)) {
        const timeout = new Error('请求超时，结果未确认，请先刷新状态后再决定是否重试。');
        timeout.code = 'CLIENT_TIMEOUT';
        throw timeout;
      }
      throw error;
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
  }

  function writeRequest(path, resource, body, options = {}) {
    const expectedRevision = state.revisions[resource];
    if (!expectedRevision) {
      const error = new Error('当前数据没有可用 revision，请先刷新后重试。');
      error.code = 'MISSING_REVISION';
      return Promise.reject(error);
    }
    return request(path, {
      method: 'POST',
      body: JSON.stringify({ ...body, expected_revision: expectedRevision }),
      ...options
    });
  }

  function setLoadState(id, label, kind = '') {
    const element = $(`#${id}`);
    if (!element) return;
    element.textContent = label;
    if (kind) element.dataset.state = kind;
    else delete element.dataset.state;
  }

  function showNotice(message, kind = 'success') {
    const notice = $('#appNotice');
    notice.textContent = message;
    notice.dataset.kind = kind;
    notice.hidden = false;
  }

  function clearNotice() {
    const notice = $('#appNotice');
    notice.textContent = '';
    notice.hidden = true;
    delete notice.dataset.kind;
  }

  function updateRevisionNote() {
    const revisions = Object.values(state.revisions).filter(Boolean);
    const note = $('#revisionNote');
    if (!revisions.length) {
      note.textContent = '等待连接工作台 API';
      return;
    }
    const unique = [...new Set(revisions)];
    note.textContent = unique.length === 1
      ? `当前数据 revision：${unique[0]}`
      : `当前载入 ${unique.length} 个数据 revision；每个写操作绑定所属队列 revision。`;
  }

  function clearChildren(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }

  function addText(parent, tagName, value, className = '') {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    node.textContent = text(value);
    parent.appendChild(node);
    return node;
  }

  function addBadge(parent, value, tone = '') {
    if (!value) return null;
    const badge = addText(parent, 'span', value, 'badge');
    if (tone) badge.dataset.tone = tone;
    return badge;
  }

  function safeHttpUrl(value) {
    const raw = text(value).trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, window.location.origin);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
    } catch (_) { return ''; }
  }

  function addSourceLink(parent, value, label = '') {
    const url = safeHttpUrl(value);
    if (!url) return;
    const link = document.createElement('a');
    link.className = 'source-link';
    link.href = url;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = label || url;
    parent.appendChild(link);
  }

  function itemId(item) {
    const value = first(item, ['id', 'item_id', 'candidate_id', 'key', 'candidate_key', 'word'], '');
    return value === '' ? '' : String(value);
  }

  function zhLocalized(item, field) {
    const zh = item && item.localizations && item.localizations.zh;
    if (!zh) return '';
    const value = zh[field];
    return value == null ? '' : String(value);
  }

  const VERDICT_ZH = { approve: '建议通过', discard: '建议丢弃', hold: '需人工细看', rejected: '建议拒绝', approved: '建议通过' };
  const BLOCKED_REASON_ZH = Object.freeze({
    AI_REVIEW_REQUIRED: '需要 AI 复核',
    AI_OUTPUT_INVALID: 'AI 复核结果无效',
    AI_FALLBACK_FAILED: 'AI 复核调用失败',
    AI_VERDICT_NOT_APPROVE: 'AI 建议未通过',
    AI_CONFIDENCE_LOW: 'AI 建议把握度不足',
    EVIDENCE_DATE_MISSING: '官方证据缺少发布日期',
    PROPOSED_DATE_MISSING: '无法形成可应用的更新日期',
    PROPOSED_DATE_NOT_AFTER_CURRENT: '拟定日期没有晚于当前日期',
    EVIDENCE_DATE_AMBIGUOUS: '官方日期存在歧义，需核验',
    CURRENT_DATE_MISSING: '缺少当前目录日期',
    PRODUCT_SURFACE_MISMATCH: '证据对应的产品表面不匹配',
    EVIDENCE_HASH_CHANGED: '官方证据已变化，需重新核验'
  });

  function blockedReasonText(reason) {
    return BLOCKED_REASON_ZH[reason] || `需要核验：${String(reason || '未知原因')}`;
  }

  function addBlockedReasons(content, reasons) {
    if (!Array.isArray(reasons) || reasons.length === 0) return;
    const summary = reasons.slice(0, 2).map(blockedReasonText).join('；');
    addText(content, 'p', `当前不能批准：${summary}${reasons.length > 2 ? `（另有 ${reasons.length - 2} 项）` : ''}`, 'item-blocked');
    if (reasons.length > 2) {
      const detail = document.createElement('details');
      detail.className = 'item-blocked-detail';
      addText(detail, 'summary', '查看完整核验项');
      addText(detail, 'p', reasons.map(blockedReasonText).join('；'));
      content.appendChild(detail);
    }
  }

  function confidenceLowerBound(value, range) {
    if (typeof range === 'string') {
      const match = range.match(/^(\d{1,3})-\d{1,3}%$/);
      if (match) return Number(match[1]) / 100;
    }
    const confidence = Number(value);
    return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : null;
  }

  function confidenceTone(value, range, verdict = '') {
    const confidence = confidenceLowerBound(value, range);
    if (confidence === null) return 'unknown';
    // 置信度有限 / 存疑待定统一使用黄色提醒
    if (confidence < 0.6 || verdict === 'hold') return 'medium'; // 黄色风格
    // 较高且判定为丢弃（识别出水文/低质/广告）使用红色
    if (verdict === 'discard' || verdict === 'rejected') return 'low'; // 红色风格
    // 较高且判定为通过/优质使用绿色
    return 'high'; // 绿色风格
  }

  function confidenceDisplay(value, range, options = {}) {
    const confidence = confidenceLowerBound(value, range);
    const verdict = options.verdict || '';
    if (confidence === null) return { prefix: '', value: '模型未提供把握度，需人工判断', suffix: '', tone: 'unknown' };
    const level = confidence < 0.6 ? '有限' : confidence < 0.8 ? '中等' : '较高';
    if (typeof range === 'string' && /^\d{1,3}-\d{1,3}%$/.test(range)) {
      return {
        prefix: '模型自评：',
        value: `${level}（${range}）`,
        suffix: '，非统计准确率',
        tone: confidenceTone(value, range, verdict)
      };
    }
    if (options.tool) {
      return {
        prefix: '模型置信度：',
        value: `${level}（${Math.round(confidence * 100)}%）`,
        suffix: '，非统计准确率',
        tone: confidenceTone(value, range, verdict)
      };
    }
    return {
      prefix: '历史模型自评：',
      value: `${level}（原始值 ${Math.round(confidence * 100)}%）`,
      suffix: '，非统计准确率；尚未提供区间',
      tone: confidenceTone(value, range, verdict)
    };
  }

  function reviewMaterials(item) {
    const fields = [
      ['title', '标题'],
      ['description', '描述'],
      ['transcript', '字幕'],
      ['summary', '内容总结']
    ];
    const present = fields.filter(([field]) => {
      const value = item && item[field];
      return value !== undefined && value !== null && String(value).trim() !== '';
    }).map(([, label]) => label);
    const missing = fields.filter(([field]) => {
      const value = item && item[field];
      return value === undefined || value === null || String(value).trim() === '';
    }).map(([, label]) => label);
    const material = present.length ? `已有${present.join('、')}` : '没有可用材料';
    return missing.length ? `审核材料：${material}；缺少${missing.join('、')}` : `审核材料：${material}`;
  }

  function itemTitle(item, extraKeys = []) {
    const zhTitle = zhLocalized(item, 'title') || zhLocalized(item, 'summary') || zhLocalized(item, 'full_name') || zhLocalized(item, 'term');
    if (zhTitle) return zhTitle;
    return first(item, ['title', 'product_name', 'name', 'term', 'label', ...extraKeys], '未命名条目');
  }

  function updateWorkspaceClearState(workspace) {
    const button = $('#clearWorkbenchButton');
    const stateNode = $('#workspaceClearState');
    if (!button || !stateNode) return;
    const clearable = workspace?.clearable === true;
    button.disabled = !clearable;
    if (clearable) {
      stateNode.textContent = '全部审核已完成，可清空';
      stateNode.dataset.state = 'success';
      stateNode.title = '仅清理临时审核工作区，不删除正式知识库和历史记录。';
      return;
    }
    const blockers = Array.isArray(workspace?.blockers) ? workspace.blockers : [];
    stateNode.textContent = blockers.length ? `不可清空：${blockers[0].message}${blockers.length > 1 ? `（另有 ${blockers.length - 1} 项）` : ''}` : '等待完成态';
    stateNode.dataset.state = blockers.length ? 'warning' : 'loading';
    stateNode.title = blockers.map(item => item.message).join('；') || '请先刷新数据。';
  }

  function renderOverview(payload) {
    const root = $('#overviewCards');
    clearChildren(root);
    const data = unwrap(payload) || {};
    const cards = [
      { label: '新闻首审', keys: ['news_pending', 'pending_news', 'news'], fallback: state.items.news.length, tone: 'attention' },
      { label: '关键词候选', keys: ['keyword_candidates', 'keywords_pending', 'keywords'], fallback: state.items.keywords.length, tone: 'attention' },
      { label: 'Top 待选', keys: ['top_candidates', 'top_pending', 'top'], fallback: state.items.top.length, tone: 'ready' },
      { label: '工具更新', keys: ['tool_updates_pending', 'updates_pending', 'tool_updates'], fallback: state.items.toolUpdates.length, tone: 'attention' }
    ];
    for (const card of cards) {
      const element = document.createElement('article');
      element.className = 'overview-card';
      element.dataset.tone = card.tone;
      const number = countFrom(data, card.keys);
      addText(element, 'span', number === null ? card.fallback : number, 'value');
      addText(element, 'span', card.label, 'label');
      const detail = first(data, [`${card.keys[0]}_detail`, `${card.keys[0]}_label`], '待工作台处理');
      addText(element, 'p', detail, 'detail');
      root.appendChild(element);
    }
  }

  function itemMeta(item) {
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const isKeyword = Boolean(item && typeof item.word === 'string');
    const rawStatus = isKeyword ? '待采纳' : first(item, ['status', 'review_status', 'state'], 'pending');
    const blocked = item && (item.blocked === true || item.is_blocked === true);
    const tone = blocked || String(rawStatus).toLowerCase() === 'blocked' ? 'blocked' : String(rawStatus).toLowerCase();
    const displayStatus = tone === 'blocked' ? 'blocked' : rawStatus;
    addBadge(meta, displayStatus, tone);
    const source = first(item, ['source', 'product_name', 'platform', 'vendor', 'category'], '');
    if (source) addText(meta, 'span', isKeyword ? `${source}类关键词` : source);
    const date = first(item, ['published_at', 'created_at', 'date', 'updated_at'], '');
    if (date) addText(meta, 'span', date);
    const id = itemId(item);
    if (id && !isKeyword) addText(meta, 'span', `ID ${id}`, 'item-id');
    return { meta, status: tone, id };
  }

  function addAiAdvice(content, advice, label = 'AI 建议', item = null, options = {}) {
    if (!advice || typeof advice !== 'object') advice = {};
    const verdict = first(advice, ['verdict', 'decision'], '');
    const confidence = advice.confidence;
    const reasons = Array.isArray(advice.reasons) ? advice.reasons : (advice.reason ? [advice.reason] : []);
    if (!verdict && !reasons.length && options.showWithoutAdvice !== true) return;
    const box = document.createElement('div');
    box.className = 'ai-advice';
    const head = document.createElement('div');
    head.className = 'ai-advice-head';
    addText(head, 'span', verdict ? `${label} · ${VERDICT_ZH[verdict] || verdict}` : label);
    const confidenceDisplayValue = confidenceDisplay(advice.confidence, advice.confidence_range, {
      tool: options.tool === true,
      verdict,
    });
    const confidenceLabel = document.createElement('span');
    confidenceLabel.className = 'ai-confidence';
    if (confidenceDisplayValue.prefix) addText(confidenceLabel, 'span', confidenceDisplayValue.prefix);
    const confidenceValue = addText(confidenceLabel, 'span', confidenceDisplayValue.value, 'ai-confidence-value');
    confidenceValue.dataset.tone = confidenceDisplayValue.tone;
    if (confidenceDisplayValue.suffix) addText(confidenceLabel, 'span', confidenceDisplayValue.suffix);
    head.appendChild(confidenceLabel);
    box.appendChild(head);
    if (item) addText(box, 'p', reviewMaterials(item), 'ai-advice-materials');
    for (const reason of reasons.slice(0, 3)) addText(box, 'p', reason, 'ai-advice-reason');
    content.appendChild(box);
  }

  function queueItem(item, resource, options = {}) {
    const isTool = Boolean(item && item.candidate_key !== undefined);
    const isKeyword = Boolean(item && typeof item.word === 'string');
    const id = itemId(item);
    const titleValue = itemTitle(item, options.titleKeys || []);
    const article = document.createElement('article');
    article.className = 'queue-item';
    const metaInfo = itemMeta(item);
    if (metaInfo.status === 'blocked') article.classList.add('is-blocked');

    const content = document.createElement('div');
    content.className = 'item-content';
    const title = addText(content, 'h3', titleValue, 'item-title');
    title.title = text(titleValue);
    content.appendChild(metaInfo.meta);
    if (isTool) {
      const dates = document.createElement('div');
      dates.className = 'item-dates';
      addText(dates, 'span', `原 ${text(item.previous_date) || '—'} → 拟 ${text(item.proposed_date) || '待定'}`);
      content.appendChild(dates);
      if (Array.isArray(item.blocked_reasons) && item.blocked_reasons.length) {
        addBlockedReasons(content, item.blocked_reasons);
      }
    }
    const summary = zhLocalized(item, 'description') || first(item, ['summary', 'description', 'excerpt', 'rationale', 'reason'], '');
    if (summary) addText(content, 'p', summary, 'item-summary');
    if (isKeyword) {
      addText(content, 'p', `提及 ${item.count == null ? 0 : item.count} 次`, 'item-summary');
    }
    const hasZhDescription = Boolean(zhLocalized(item, 'description'));
    if (isTool && !hasZhDescription) {
      addText(content, 'p', '当前内容尚未汉化，请先运行工具审核本地化。', 'item-localization-pending');
    }
    addSourceLink(content, first(item, ['url', 'source_url', 'official_url'], ''));
    const toolAdvice = isTool ? (item.ai_suggestion || item.review_decision || null) : null;
    const advice = isTool && hasZhDescription && toolAdvice
      ? { ...toolAdvice, reasons: [], reason: '' }
      : (isTool ? toolAdvice : item.ai_advice);
    const adviceLabel = isTool
      ? (item.ai_suggestion ? '审核建议（AI 复核）' : item.review_decision ? '审核建议（规则判定）' : '审核建议')
      : 'AI 建议';
    addAiAdvice(content, advice, adviceLabel, isTool ? null : item, { tool: isTool, showWithoutAdvice: isTool && !toolAdvice });
    if (isTool && !toolAdvice) {
      addText(content, 'p', '审核建议：当前未生成语义建议，请结合官方证据与状态信息判断。', 'ai-advice-materials');
    }

    if (options.selectable && id) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'item-check';
      check.dataset.selectResource = resource;
      check.dataset.itemId = id;
      check.checked = state.selected[resource].has(id);
      check.setAttribute('aria-label', `选择 ${text(titleValue)}`);
      article.insertBefore(check, article.firstChild);
    } else {
      const spacer = document.createElement('span');
      spacer.setAttribute('aria-hidden', 'true');
      article.insertBefore(spacer, article.firstChild);
    }

    if (options.actions && id) {
      const actions = document.createElement('div');
      actions.className = 'item-actions';
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'button button-danger';
      reject.textContent = options.rejectLabel || '拒绝';
      reject.addEventListener('click', () => reviewToolUpdate(id, 'rejected', reject));
      actions.appendChild(reject);
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'button button-primary';
      approve.textContent = options.approveLabel || '批准';
      approve.disabled = metaInfo.status === 'blocked';
      if (approve.disabled) approve.title = 'blocked 条目不可批准';
      approve.addEventListener('click', () => reviewToolUpdate(id, 'approved', approve));
      actions.appendChild(approve);
      content.appendChild(actions);
    }
    article.appendChild(content);
    return article;
  }

  function renderQueue(resource, rootId, items, stateId, options = {}) {
    state.items[resource] = items;
    const root = $(`#${rootId}`);
    clearChildren(root);
    if (!items.length) {
      addText(root, 'p', options.empty || '当前没有待处理条目。', 'empty-state');
    } else {
      for (const item of items) root.appendChild(queueItem(item, resource, options));
    }
    setLoadState(stateId, `${items.length} 条`, 'success');
    updateSelectionControls(resource);
  }

  const HISTORY_REASON_ZH = Object.freeze({
    newer_evidence: '已被后续证据替代',
    source_replaced: '来源已被登记表替换',
    up_to_date: '当前来源暂无新的更新',
    completed: '已完成人工处理',
    not_actionable: '当前不是可操作待办'
  });

  function renderToolUpdates(payload) {
    const value = unwrap(payload) || {};
    const items = Array.isArray(value.items) ? value.items : [];
    renderQueue('toolUpdates', 'toolUpdatesList', items, 'toolUpdatesState', { actions: true, empty: '当前没有工具更新审核项。' });
    const history = Array.isArray(value.history) ? value.history : [];
    if (!history.length) return;
    const root = $('#toolUpdatesList');
    const details = document.createElement('details');
    details.className = 'queue-history';
    addText(details, 'summary', `历史证据（${history.length}）`);
    const list = document.createElement('div');
    list.className = 'item-list';
    for (const item of history) {
      const wrapper = document.createElement('div');
      const reason = HISTORY_REASON_ZH[item.history_reason] || '已归入历史记录';
      addText(wrapper, 'p', reason, 'history-reason');
      wrapper.appendChild(queueItem(item, 'toolUpdates', { actions: false }));
      list.appendChild(wrapper);
    }
    details.appendChild(list);
    root.appendChild(details);
  }


  function renderKeywords(payload) {
    const value = unwrap(payload) || {};
    const all = Array.isArray(value.items) ? value.items : [];
    const pending = all.filter(item => !(item && (item.adopted === true || item.discarded === true)));
    renderQueue('keywords', 'keywordList', pending, 'keywordsState', {
      selectable: true,
      titleKeys: ['word'],
      empty: all.length > 0 ? '当前关键词候选已全部处理（采纳或丢弃）。' : '当前没有关键词候选。'
    });
    const note = $('#keywordSourceNote');
    if (note) {
      const source = value.source;
      if (source && source.input_count != null) {
        if (String(source.source_basis || '').startsWith('all_approved_frequency')) {
          note.textContent = `来源：覆盖全部 ${source.source_count == null ? '?' : source.source_count} 条 approved（全局词频）生成候选。`;
        } else if (String(source.source_basis || '').startsWith('all_approved_batched')) {
          const batch = (String(source.source_basis).match(/batched_(\d+)/) || [])[1];
          note.textContent = `来源：覆盖全部 ${source.source_count == null ? '?' : source.source_count} 条 approved，分批（每批 ${batch || '?'} 条）生成候选。`;
        } else {
          note.textContent = `来源：共 ${source.source_count == null ? '?' : source.source_count} 条 approved，AI 读取评分前 ${source.input_count} 条（${text(source.source_basis || '')}）生成候选。`;
        }
      } else if (all.length === 0) {
        note.textContent = '尚未生成关键词候选；点击上方「生成关键词候选」。';
      } else {
        note.textContent = '';
      }
    }
  }

  const TRANSCRIPT_STATUS_ZH = Object.freeze({ none: '无字幕', uploaded: '已上传，待总结', summarized: '已总结' });

  function renderTranscripts(payload) {
    const value = unwrap(payload) || {};
    const items = Array.isArray(value.items) ? value.items : [];
    const root = $('#transcriptList');
    clearChildren(root);
    const selectedYoutube = items.filter(item => item.top_selected === true && String(item.platform || '').toLowerCase() === 'youtube');
    const selectedKeys = new Set(selectedYoutube.map(item => transcriptCandidateKey(item.id)));
    for (const key of state.uploads.keys()) {
      if (!selectedKeys.has(key) && !state.uploading.has(key)) state.uploads.delete(key);
    }
    if (!selectedYoutube.length) {
      addText(root, 'p', '尚未选择 Top YouTube 条目；保存 Top 选择后可在此上传字幕。', 'muted');
      setLoadState('transcriptState', '0 条', 'success');
      return;
    }
    for (const item of selectedYoutube) {
      const row = document.createElement('div');
      row.className = 'transcript-row';
      addText(row, 'span', itemTitle(item), 'item-title');
      addBadge(row, TRANSCRIPT_STATUS_ZH[item.transcript_status] || item.transcript_status || '无字幕', String(item.transcript_status || 'none'));
      addSourceLink(row, item.url, '打开原视频 ↗');
      if (item.transcript_file) addText(row, 'span', item.transcript_file, 'muted');
      const key = transcriptCandidateKey(item.id);
      const status = String(item.transcript_status || 'none');
      if (status !== 'none') {
        state.uploads.delete(key);
        state.uploading.delete(key);
        root.appendChild(row);
        continue;
      }
      const pendingFile = readUploadedFile(key);
      const uploading = state.uploading.has(key);
      const pick = document.createElement('label');
      pick.className = 'file-pick';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.srt,.vtt,.txt';
      input.dataset.candidateId = key;
      pick.appendChild(input);
      pick.appendChild(document.createTextNode('选择字幕文件'));
      row.appendChild(pick);
      if (pendingFile) addText(row, 'span', `已选择：${pendingFile.name}`, 'muted');
      const upload = document.createElement('button');
      upload.type = 'button';
      upload.className = 'button button-primary';
      upload.textContent = uploading ? '上传中…' : '上传字幕';
      upload.dataset.candidateId = key;
      upload.disabled = !pendingFile || uploading;
      upload.addEventListener('click', () => uploadTranscriptFile(key, upload));
      row.appendChild(upload);
      root.appendChild(row);
    }
    setLoadState('transcriptState', `${selectedYoutube.length} 条`, 'success');
  }

  function transcriptCandidateKey(value) { return String(value); }

  function readUploadedFile(candidateId) {
    return state.uploads.get(transcriptCandidateKey(candidateId)) || null;
  }

  async function uploadTranscriptFile(candidateId, button) {
    const key = transcriptCandidateKey(candidateId);
    if (state.uploading.has(key)) return;
    const file = readUploadedFile(key);
    if (!file) {
      showNotice('请先选择字幕文件。', 'error');
      return;
    }
    state.uploading.add(key);
    button.textContent = '上传中…';
    button.disabled = true;
    try {
      const content = await file.text();
      const contentBase64 = btoa(unescape(encodeURIComponent(content)));
      const result = await writeRequest('news/transcripts/upload', 'transcripts', { candidate_id: key, filename: file.name, content_base64: contentBase64 });
      state.uploads.delete(key);
      showNotice(`字幕已保存（${Number(result?.transcript_chars || 0)} 字符）。`);
      await refreshAll();
    } catch (error) { handleMutationError(error, 'transcripts', 'transcriptState', button); }
    finally {
      state.uploading.delete(key);
      button.textContent = '上传字幕';
      button.disabled = !state.uploads.has(key);
    }
  }

  async function summarizeTranscripts(button) {
    if (!$('#transcriptCostConfirm').checked) {
      showNotice('请先勾选外部 AI 费用确认。', 'error');
      return;
    }
    const items = state.items.top.filter(item => item.top_selected === true && item.transcript_status === 'uploaded');
    const ids = items.map(item => item.id);
    if (!ids.length) {
      showNotice('没有已上传、待总结的字幕。', 'error');
      return;
    }
    button.textContent = '总结中…';
    button.disabled = true;
    try {
      const result = await writeRequest('news/transcripts/summarize', 'transcripts', { ids, confirm_cost: true }, { timeoutMs: 100000 });
      const summarizedCount = Number(result?.summarized?.length || 0);
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      await refreshAll();
      if (failed.length) {
        const reasons = failed.map(item => `${item.id}: ${item.error || '总结失败'}`).join('；');
        showNotice(`字幕总结完成：成功 ${summarizedCount} 条，失败 ${failed.length} 条。失败原因——${reasons}`, 'error');
      } else {
        showNotice(`已用 AI 总结 ${summarizedCount} 条字幕。`);
      }
    } catch (error) { handleMutationError(error, 'transcripts', 'transcriptState', button); }
    finally { button.textContent = '总结选中字幕（AI）'; button.disabled = !$('#transcriptCostConfirm').checked; }
  }

  function renderTop(payload) {
    const all = listFrom(payload, ['items', 'candidates', 'top']);
    const selected = all.filter(item => item.top_selected === true);
    const controls = $('#topSelectionControls');
    if (!selected.length) {
      if (controls) controls.hidden = false;
      renderQueue('top', 'topList', all, 'topState', {
        selectable: true,
        titleKeys: ['summary', 'description'],
        empty: (payload && payload.note) || '当前没有可选 Top 项目。',
      });
      return;
    }
    if (controls) controls.hidden = true;
    state.items.top = selected;
    const root = $('#topList');
    clearChildren(root);
    addText(root, 'p', `Top 审核已完成：已选 ${selected.length} 条。公开发布预览位于右侧；如需写入公开投影，请显式点击「重建公开投影」。`, 'panel-note');
    for (const item of selected) root.appendChild(queueItem(item, 'top', { titleKeys: ['summary', 'description'] }));
    setLoadState('topState', `已完成 · ${selected.length} 条`, 'success');
  }

  function renderConcepts(items) {
    state.items.concepts = items;
    const root = $('#conceptsList');
    clearChildren(root);
    if (!items.length) {
      addText(root, 'p', '当前没有概念预览。', 'empty-state');
    }
    for (const item of items) {
      const article = document.createElement('article');
      article.className = 'concept-item';
      const heading = addText(article, 'h3', itemTitle(item), 'item-title');
      const status = first(item, ['status', 'review_status', 'state'], 'preview');
      addBadge(heading, status, String(status).toLowerCase());
      const definition = first(item, ['definition', 'summary', 'description', 'preview'], '暂无摘要');
      addText(article, 'p', definition, 'concept-definition');
      addSourceLink(article, first(item, ['url', 'source_url', 'official_url'], ''));
      root.appendChild(article);
    }
    setLoadState('conceptsState', `${items.length} 条`, 'success');
  }

  function renderPreview(payload) {
    const root = $('#publishPreview');
    clearChildren(root);
    const items = listFrom(payload, ['items', 'top', 'hotspots', 'preview']);
    if (!items.length) {
      const value = unwrap(payload);
      const message = value && typeof value === 'object' ? first(value, ['message', 'summary'], '') : '';
      addText(root, 'p', message || '当前没有可展示的公开投影。', 'muted');
    } else {
      const heading = first(unwrap(payload), ['title', 'name'], '当前公开投影');
      addText(root, 'h4', heading);
      const list = document.createElement('ol');
      list.className = 'preview-list';
      for (const item of items) {
        const row = document.createElement('li');
        addText(row, 'span', itemTitle(item));
        const id = itemId(item);
        const detail = first(item, ['summary', 'description', 'source'], id ? `ID ${id}` : '');
        if (detail) addText(row, 'small', detail);
        list.appendChild(row);
      }
      root.appendChild(list);
    }
    setLoadState('previewState', '已加载', 'success');
  }

  function updateSelectionControls(resource) {
    const ids = { news: 'newsSelectionCount', keywords: 'keywordSelectionCount', top: 'topSelectionCount' };
    const buttons = { news: ['newsDiscardButton', 'newsApproveButton'], keywords: ['keywordDiscardButton', 'keywordAdoptButton'], top: ['topSaveButton'] };
    if (!ids[resource] || !buttons[resource]) return; // 工具更新/概念等无复选控制
    const count = state.selected[resource].size;
    $(`#${ids[resource]}`).textContent = `${count} 条已选`;
    for (const id of buttons[resource]) $(`#${id}`).disabled = count === 0 || state.loading.has(resource);
  }

  function bindSelection(resource, listId, selectAllId) {
    const list = $(`#${listId}`);
    list.addEventListener('change', (event) => {
      const target = event.target;
      if (!target.matches('input[data-select-resource]')) return;
      const id = target.dataset.itemId;
      if (target.checked) state.selected[resource].add(id);
      else state.selected[resource].delete(id);
      updateSelectionControls(resource);
    });
    $(`#${selectAllId}`).addEventListener('change', (event) => {
      const boxes = list.querySelectorAll('input[data-select-resource]');
      for (const box of boxes) {
        box.checked = event.target.checked;
        if (box.checked) state.selected[resource].add(box.dataset.itemId);
        else state.selected[resource].delete(box.dataset.itemId);
      }
      updateSelectionControls(resource);
    });
  }

  function setResourceLoading(resource, stateId, loading) {
    if (loading) {
      state.loading.add(resource);
      setLoadState(stateId, '加载中…', 'loading');
    } else {
      state.loading.delete(resource);
    }
    if (['news', 'keywords', 'top'].includes(resource)) updateSelectionControls(resource);
  }

  function resourceFailure(resource, rootId, stateId, error) {
    const root = $(`#${rootId}`);
    clearChildren(root);
    const message = error instanceof ApiError && error.status === 409
      ? '数据已变化，请刷新后重新确认。'
      : '数据加载失败，请检查 token 与工作台 API。';
    addText(root, 'p', message, 'error-state');
    setLoadState(stateId, error instanceof ApiError && error.status === 409 ? '数据冲突' : '加载失败', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
  }

  async function loadResource(resource, path, render, config) {
    setResourceLoading(resource, config.stateId, true);
    try {
      const payload = await request(path);
      const revision = revisionFrom(payload);
      if (revision) state.revisions[resource] = revision;
      render(payload);
      updateRevisionNote();
    } catch (error) {
      resourceFailure(resource, config.rootId, config.stateId, error);
      showNotice(error instanceof ApiError && error.status === 409 ? '数据 revision 已变化，请刷新后再操作。' : '部分工作台数据加载失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    } finally {
      setResourceLoading(resource, config.stateId, false);
    }
  }

  async function loadOverview() {
    setLoadState('overviewState', '加载中…', 'loading');
    try {
      const payload = await request('overview');
      const revision = revisionFrom(payload);
      if (revision) state.revisions.overview = revision;
      renderOverview(payload);
      updateWorkspaceClearState(payload?.workspace);
      setLoadState('overviewState', '已加载', 'success');
      updateRevisionNote();
    } catch (error) {
      updateWorkspaceClearState(null);
      setLoadState('overviewState', '加载失败', 'error');
      showNotice(error instanceof ApiError && error.status === 409 ? '数据 revision 已变化，请刷新后再操作。' : '待办概览加载失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    }
  }

  function handleMutationError(error, resource, stateId, button) {
    if (button) button.disabled = false;
    state.loading.delete(resource);
    const conflict = error instanceof ApiError && error.status === 409;
    const timeout = error?.code === 'CLIENT_TIMEOUT' || error?.status === 504;
    const message = conflict
      ? '操作被拒绝：数据已被修改，请刷新后重新确认。'
      : (timeout
        ? '结果未确认，请先刷新状态；不要自动重复提交。'
        : (String(error?.message || '').trim() || '操作失败，请检查当前条件后重试。'));
    setLoadState(stateId, conflict ? '数据冲突' : (timeout ? '结果未确认' : '操作失败'), conflict ? 'conflict' : (timeout ? 'warning' : 'error'));
    showNotice(message, conflict ? 'conflict' : (timeout ? 'error' : 'error'));
    updateSelectionControls(resource);
  }

  async function reviewNews(decision, button) {
    const ids = [...state.selected.news];
    if (!ids.length) return;
    state.loading.add('news');
    const originalLabel = button.textContent;
    button.textContent = '处理中…';
    button.disabled = true;
    try {
      await writeRequest('news/review', 'news', { ids, decision, status: decision });
      state.selected.news.clear();
      showNotice(decision === 'approved' ? `已批准 ${ids.length} 条新闻候选。` : `已丢弃 ${ids.length} 条新闻候选。`);
      await refreshAll();
    } catch (error) { handleMutationError(error, 'news', 'newsState', button); }
    finally { button.textContent = originalLabel; }
  }

  async function adoptKeywords(button) {
    const ids = [...state.selected.keywords];
    if (!ids.length) return;
    state.loading.add('keywords');
    const originalLabel = button.textContent;
    button.textContent = '处理中…';
    button.disabled = true;
    try {
      await writeRequest('news/keywords', 'keywords', { ids });
      state.selected.keywords.clear();
      showNotice(`已采纳 ${ids.length} 条关键词候选。`);
      await refreshAll();
    } catch (error) { handleMutationError(error, 'keywords', 'keywordsState', button); }
    finally { button.textContent = originalLabel; }
  }

  async function discardKeywords(button) {
    const ids = [...state.selected.keywords];
    if (!ids.length) return;
    state.loading.add('keywords');
    const originalLabel = button.textContent;
    button.textContent = '处理中…';
    button.disabled = true;
    try {
      await writeRequest('news/keywords/discard', 'keywords', { ids });
      state.selected.keywords.clear();
      showNotice(`已丢弃 ${ids.length} 条关键词候选（加入黑名单，不再建议）。`);
      await refreshAll();
    } catch (error) { handleMutationError(error, 'keywords', 'keywordsState', button); }
    finally { button.textContent = originalLabel; }
  }

  async function saveTop(button) {
    const ids = [...state.selected.top];
    if (!ids.length) return;
    state.loading.add('top');
    const originalLabel = button.textContent;
    button.textContent = '处理中…';
    button.disabled = true;
    try {
      await writeRequest('news/top', 'top', { ids, selected: true });
      state.selected.top.clear();
      showNotice(`已保存 ${ids.length} 条 Top 选择。`);
      await refreshAll();
    } catch (error) { handleMutationError(error, 'top', 'topState', button); }
    finally { button.textContent = originalLabel; }
  }

  async function runAction(path, button, loadingLabel, successMessage) {
    const originalLabel = button.textContent;
    button.textContent = loadingLabel;
    button.disabled = true;
    try {
      const result = await request(path, { method: 'POST', body: JSON.stringify({}) });
      showNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage);
      await refreshAll();
      return result;
    } catch (error) {
      showNotice(error.message || '操作失败，请检查当前条件后重试。', 'error');
      return null;
    } finally {
      button.textContent = originalLabel;
      button.disabled = false;
    }
  }

  function renderToolPreview(payload) {
    const root = $('#toolPreview');
    clearChildren(root);
    state.toolPreview = payload && payload.ok === true ? payload : null;
    const apply = $('#toolApplyButton');
    apply.disabled = !state.toolPreview;
    if (!state.toolPreview) {
      addText(root, 'p', payload?.code ? `无法生成预览：${text(payload.code)}` : '当前没有可 Apply 的已批准工具更新。', 'muted');
      $('#toolPreviewState').textContent = '无可用预览';
      return;
    }
    $('#toolPreviewState').textContent = `${state.toolPreview.count} 项待确认`;
    addText(root, 'p', `Catalog revision：${state.toolPreview.expected_revision}`, 'muted');
    addText(root, 'p', `确认语句：APPLY TOOL-UPDATES ${state.toolPreview.preview_hash}`, 'muted');
    const list = document.createElement('ol');
    list.className = 'preview-list';
    for (const change of state.toolPreview.changes || []) {
      const row = document.createElement('li');
      addText(row, 'span', `${text(change.title || change.detail_id || change.id || '工具')}：${text(change.before || change.previous_date || '—')} → ${text(change.after || change.proposed_date || '—')}`);
      list.appendChild(row);
    }
    root.appendChild(list);
  }

  async function generateKeywords(button) {
    await runAction('news/keywords/generate', button, '生成中…', result => {
      const count = Number(result?.candidates?.length || result?.candidate_count || 0);
      const total = Number(result?.approvedCount ?? result?.source_count ?? 0);
      const basis = total ? `覆盖全部 ${total} 条 approved` : '';
      return `已生成 ${count} 条关键词候选${basis ? `（${basis}）。` : '。'}`;
    });
  }

  async function generateTop(button) {
    await runAction('news/top/generate', button, '生成中…', result => {
      const count = Number(result?.candidates?.length || result?.count || 0);
      const input = Number(result?.ai_input_count || 0);
      const total = Number(result?.approved_count || 0);
      return `已生成 ${count} 条 Top 待选项${input ? `（基于评分前 ${input} 条 / 共 ${total || '?'} 条 approved）。` : '。'}`;
    });
  }

  async function publishNews(button) {
    await runAction('news/publish', button, '重建中…', result => `已重建公开投影（${Number(result?.items || 0)} 条）。`);
  }

  async function previewToolUpdates(button) {
    const originalLabel = button.textContent;
    button.textContent = '预览中…';
    button.disabled = true;
    try {
      const payload = await request('tool-updates/preview');
      renderToolPreview(payload);
      showNotice(payload?.ok ? `已生成 ${payload.count} 项工具更新预览。` : '当前没有可 Apply 的工具更新。');
    } catch (error) {
      renderToolPreview(null);
      showNotice(error.message || '工具更新预览失败。', 'error');
    } finally {
      button.textContent = originalLabel;
      button.disabled = false;
    }
  }

  async function applyToolUpdates(button) {
    const preview = state.toolPreview;
    const confirm = $('#toolApplyConfirm').value.trim();
    if (!preview) {
      showNotice('请先生成并核对工具更新预览。', 'error');
      return;
    }
    const expected = `APPLY TOOL-UPDATES ${preview.preview_hash}`;
    if (confirm !== expected) {
      showNotice('确认语句不匹配，未执行 Apply。', 'error');
      return;
    }
    const originalLabel = button.textContent;
    button.textContent = 'Apply 中…';
    button.disabled = true;
    try {
      const result = await request('tool-updates/apply', {
        method: 'POST',
        body: JSON.stringify({ expected_revision: preview.expected_revision, preview_hash: preview.preview_hash, confirm })
      });
      if (!result?.ok) throw new Error(result?.code || '工具更新 Apply 被拒绝');
      $('#toolApplyConfirm').value = '';
      state.toolPreview = null;
      showNotice(`已 Apply ${Number(result.applied || result.count || preview.count)} 项工具更新。`);
      await refreshAll();
    } catch (error) {
      showNotice(error.message || '工具更新 Apply 失败。', 'error');
    } finally {
      button.textContent = originalLabel;
      button.disabled = !state.toolPreview;
    }
  }

  async function reviewToolUpdate(id, decision, button) {
    const item = state.items.toolUpdates.find((candidate) => itemId(candidate) === id);
    const rawStatus = first(item, ['status', 'review_status', 'state'], '');
    const blocked = item && (item.blocked === true || item.is_blocked === true || String(rawStatus).toLowerCase() === 'blocked');
    if (blocked && decision === 'approved') {
      showNotice('blocked 条目不可批准，请先处理其证据或采集阻断。', 'error');
      return;
    }
    state.loading.add('toolUpdates');
    const originalLabel = button.textContent;
    button.textContent = '处理中…';
    button.disabled = true;
    try {
      await writeRequest(`tool-updates/${encodeURIComponent(id)}/review`, 'toolUpdates', { id, decision, status: decision });
      showNotice(decision === 'approved' ? '工具更新已批准。' : '工具更新已拒绝。');
      await refreshAll();
    } catch (error) { handleMutationError(error, 'toolUpdates', 'toolUpdatesState', button); }
    finally { button.textContent = originalLabel; }
  }

  async function loadTopAndTranscripts() {
    setResourceLoading('top', 'topState', true);
    setResourceLoading('transcripts', 'transcriptState', true);
    try {
      const payload = await request('news/top');
      const revision = revisionFrom(payload);
      if (revision) {
        state.revisions.top = revision;
        state.revisions.transcripts = revision;
      }
      renderTop(payload);
      renderTranscripts(payload);
      updateRevisionNote();
    } catch (error) {
      resourceFailure('top', 'topList', 'topState', error);
      resourceFailure('transcripts', 'transcriptList', 'transcriptState', error);
      showNotice(error instanceof ApiError && error.status === 409 ? 'Top 数据已变化，请刷新后再操作。' : 'Top 与字幕数据加载失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    } finally {
      setResourceLoading('top', 'topState', false);
      setResourceLoading('transcripts', 'transcriptState', false);
    }
  }

  async function loadPreview() {
    setLoadState('previewState', '加载中…', 'loading');
    try {
      const payload = await request('news/publish-preview');
      renderPreview(payload);
    } catch (error) {
      const root = $('#publishPreview');
      clearChildren(root);
      addText(root, 'p', error instanceof ApiError && error.status === 409 ? '预览 revision 已变化，请刷新。' : '发布预览加载失败。', 'error-state');
      setLoadState('previewState', error instanceof ApiError && error.status === 409 ? '数据冲突' : '加载失败', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
      showNotice(error instanceof ApiError && error.status === 409 ? '公开预览已变化，请刷新后确认。' : '公开发布预览加载失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    }
  }

  async function refreshAllNow() {
    clearNotice();
    const refreshButton = $('#refreshButton');
    const originalLabel = refreshButton.textContent;
    refreshButton.textContent = '刷新中…';
    refreshButton.disabled = true;
    try {
    await Promise.all([
      loadOverview(),
      loadResource('news', 'news/review', (payload) => {
        const value = unwrap(payload) || {};
        if (value.status === 'enriching') {
          const root = $('#newsList');
          clearChildren(root);
          addText(root, 'p', `🤖 ${value.message || '本地 Bonsai 正在进行 AI 初审分流与汉化，请稍候...'}`, 'panel-note');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'secondary-button';
          btn.style.marginTop = '8px';
          btn.textContent = '立即运行双通道自愈修复';
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = '正在双通道修复…';
            try {
              await request('news/repair', { method: 'POST', body: JSON.stringify({}) });
              showNotice('双通道自愈修复已完成，正在刷新…', 'success');
              refreshAll();
            } catch (err) {
              showNotice(`自愈修复失败：${err.message || err}`, 'error');
              btn.disabled = false;
              btn.textContent = '重试双通道自愈修复';
            }
          });
          root.appendChild(btn);
          setLoadState('newsState', 'AI 初审中…', 'loading');
          updateSelectionControls('news');
          return;
        }
        renderQueue('news', 'newsList', listFrom(payload, ['items', 'candidates', 'queue', 'news']), 'newsState', { selectable: true, empty: '当前没有待首审新闻。' });
      }, { rootId: 'newsList', stateId: 'newsState' }),
      loadResource('keywords', 'news/keywords', renderKeywords, { rootId: 'keywordList', stateId: 'keywordsState' }),
      loadTopAndTranscripts(),
      loadResource('toolUpdates', 'tool-updates', renderToolUpdates, { rootId: 'toolUpdatesList', stateId: 'toolUpdatesState' }),
      loadResource('concepts', 'concepts/preview', (payload) => renderConcepts(listFrom(payload, ['items', 'previews', 'concepts'])), { rootId: 'conceptsList', stateId: 'conceptsState' }),
      loadKnowledgeLoop(),
      loadConceptPreviewLoop(),
      loadPreview()
      ]);
    } finally {
      refreshButton.textContent = originalLabel;
      refreshButton.disabled = false;
    }
  }

  function refreshAll() {
    const queued = state.refreshTail.then(refreshAllNow, refreshAllNow);
    state.refreshTail = queued.catch(() => {});
    return queued;
  }

  async function reviewPending(kind, candidateKey, decision, button) {
    const resource = kind === 'tools' ? 'pendingTools' : 'pendingConcepts';
    const route = `feedback/${kind}/${encodeURIComponent(candidateKey)}/review`;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '处理中…';
    try {
      await writeRequest(route, resource, { candidate_key: candidateKey, decision });
      showNotice(decision === 'approved' ? '待补卡已批准，可进入生成计划。' : '待补卡已丢弃，后续提取不会复活它。');
      await refreshAll();
    } catch (error) { handleMutationError(error, resource, kind === 'tools' ? 'pendingToolsState' : 'pendingConceptsState', button); }
    finally { button.textContent = original; button.disabled = false; }
  }

  const PENDING_STATE_ZH = Object.freeze({
    pending_review: '待审核', approved_pending: '待生成', discarded: '已丢弃', completed: '已完成', approved: '待生成'
  });
  const BLOCKING_ZH = Object.freeze({
    NOT_REVIEWED: '尚未审核', DISCARDED: '已丢弃', ALREADY_EXISTS: '正式知识库已存在'
  });

  function renderPendingCards(kind, payload) {
    const resource = kind === 'tools' ? 'pendingTools' : 'pendingConcepts';
    const root = $(`#${resource}List`);
    clearChildren(root);
    const items = listFrom(payload, ['items']);
    state.items[resource] = items;
    if (!items.length) addText(root, 'p', '当前没有待补卡。', 'empty-state');
    for (const item of items) {
      const article = document.createElement('article'); article.className = 'queue-item';
      const content = document.createElement('div'); content.className = 'item-content';
      addText(content, 'h3', itemTitle(item), 'item-title');
      const meta = document.createElement('div'); meta.className = 'item-meta';
      addBadge(meta, item.review_status || 'pending', item.review_status || 'pending');
      const stateName = PENDING_STATE_ZH[item.workflow_state] || item.workflow_state || '待审核';
      addBadge(meta, stateName, String(item.workflow_state || 'pending_review'));
      if (kind === 'tools' && item.detail_kind_hint) addText(meta, item.detail_kind_hint);
      content.appendChild(meta);
      if (item.candidate_key) addText(content, 'p', `candidate_key：${item.candidate_key}`, 'item-id');
      const blockedText = (Array.isArray(item.blocking_reasons) ? item.blocking_reasons : [])
        .map(reason => BLOCKING_ZH[reason] || reason).join('；');
      if (blockedText) addText(content, 'p', blockedText, 'item-blocked');
      if (item.review_status === 'pending' && item.workflow_state !== 'completed') {
        const actions = document.createElement('div'); actions.className = 'item-actions';
        const discard = document.createElement('button'); discard.type = 'button'; discard.className = 'button button-danger'; discard.textContent = '丢弃'; discard.addEventListener('click', () => reviewPending(kind, item.candidate_key, 'discarded', discard)); actions.appendChild(discard);
        const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'button button-primary'; approve.textContent = '批准'; approve.addEventListener('click', () => reviewPending(kind, item.candidate_key, 'approved', approve)); actions.appendChild(approve);
        content.appendChild(actions);
      }
      article.appendChild(document.createElement('span')); article.appendChild(content); root.appendChild(article);
    }
    setLoadState(kind === 'tools' ? 'pendingToolsState' : 'pendingConceptsState', `${items.length} 条`, 'success');
  }

  function recoveryControlsFor(draft, content) {
    if (!draft.recovery_kind || draft.readiness === 'ready') return;
    const panel = document.createElement('div'); panel.className = 'recovery-panel';
    addText(panel, 'p', `${draft.error_code || 'DRAFT_BLOCKED'}：${(draft.blocking_reasons || []).join('；')}`, 'item-blocked');
    if (draft.missing_fields?.length) addText(panel, 'p', `缺失官方字段：${draft.missing_fields.join('、')}`, 'item-blocked');
    if (draft.suggested_detail_kind) addText(panel, 'p', `建议候选类型：${draft.suggested_detail_kind}`, 'item-blocked');
    const researchCanResume = draft.recovery_mode === 'research_resume' && ['evidence_required', 'seed_or_profile_required'].includes(draft.recovery_kind);
    if (draft.recovery_kind === 'manual_required' || (['evidence_required', 'seed_or_profile_required'].includes(draft.recovery_kind) && !researchCanResume)) {
      addText(panel, 'p', '此 Draft 需要人工补充资料或修正候选信息，不能通过运行配置重试。', 'muted');
      content.appendChild(panel); return;
    }
    const controls = document.createElement('div'); controls.className = 'recovery-controls';
    const configFields = Array.isArray(draft.missing_config_fields) ? draft.missing_config_fields : [];
    const inputs = new Map();
    const defaults = { model: 'glm-5.3-flash', provider: 'zhipu', protocol: 'messages', retrieval_provider: 'tavily', access_mode: 'keyless' };
    for (const field of configFields) {
      if (!['model', 'provider', 'protocol', 'retrieval_provider', 'access_mode'].includes(field)) continue;
      const label = document.createElement('label'); label.className = 'recovery-field'; label.textContent = field;
      const input = document.createElement('input'); input.type = 'text'; input.value = defaults[field] || ''; input.autocomplete = 'off'; input.spellcheck = false; label.appendChild(input); controls.appendChild(label); inputs.set(field, input);
    }
    const cost = document.createElement('label'); cost.className = 'cost-check';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.disabled = true; cost.appendChild(checkbox); addText(cost, 'span', '确认本次增量 AI 成本'); controls.appendChild(cost);
    const action = document.createElement('button'); action.type = 'button'; action.className = 'button button-quiet'; action.textContent = '生成恢复预览'; controls.appendChild(action);
    const result = document.createElement('p'); result.className = 'recovery-result'; panel.appendChild(controls); panel.appendChild(result);
    action.addEventListener('click', () => recoverDraft(draft, { action, checkbox, inputs, result }));
    content.appendChild(panel);
  }

  async function recoverDraft(draft, controls) {
    const id = draft.draft_id;
    controls.action.disabled = true;
    try {
      let plan = state.catalogRecovery.get(id);
      if (!plan) {
        const generatorOptions = {};
        for (const [field, input] of controls.inputs) generatorOptions[field] = input.value.trim();
        plan = await request(`catalog/drafts/${encodeURIComponent(id)}/recovery-plan`, { method: 'POST', body: JSON.stringify({ expected_revision: state.revisions.catalog, generator_options: generatorOptions }) });
        state.catalogRecovery.set(id, plan);
        controls.checkbox.disabled = false;
        controls.action.textContent = '确认成本并恢复';
        controls.result.textContent = `恢复模式：${plan.recovery_mode}；预计新增 responses ${plan.cost_plan?.hard_limits?.responses_calls || 0}、synthesis ${plan.cost_plan?.hard_limits?.synthesis_calls || 0} 次。`;
        return;
      }
      if (!controls.checkbox.checked) { controls.result.textContent = '请先勾选本 Draft 的增量成本确认。'; return; }
      const generatorOptions = {};
      for (const [field, input] of controls.inputs) generatorOptions[field] = input.value.trim();
      const response = await request(`catalog/drafts/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify({ expected_revision: plan.expected_revision, generator_options: generatorOptions, recovery_token: plan.recovery_token, confirm_cost: true }) });
      if (!response?.ok) throw new Error(response?.code || 'Draft 恢复被阻断');
      state.catalogRecovery.delete(id); showNotice(`${draft.candidate_name || 'Draft'} 已恢复，正在重新加载列表。`, 'success'); await refreshAll();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        state.catalogRecovery.delete(id);
        controls.checkbox.checked = false;
        controls.checkbox.disabled = true;
        controls.action.textContent = '重新生成恢复预览';
        const code = error.code || error.payload?.code || error.payload?.error;
        let msg = '恢复已被阻断，请重新生成恢复预览。';
        if (code === 'RECOVERY_TOKEN_CHANGED') {
          msg = '恢复参数或凭据已变化，已重置，请重新生成恢复预览。';
        } else if (code === 'REVISION_CONFLICT') {
          msg = 'Catalog 正式数据已发生变更，请点击顶部“刷新数据”后再试。';
        } else if (code === 'DRAFT_RECOVERY_IN_PROGRESS') {
          msg = '当前 Draft 正在恢复中，请勿重复操作。';
        }
        controls.result.textContent = msg;
        showNotice(msg, 'conflict');
      } else {
        const code = error.code || error.payload?.code || error.payload?.error;
        if (code === 'DRAFT_RECOVERY_FORBIDDEN') {
          controls.result.textContent = '该 Draft 当前状态不支持恢复，请点击顶部“刷新数据”后重试。';
          showNotice(controls.result.textContent, 'conflict');
          return;
        }
        controls.result.textContent = error.message || '恢复失败。';
        showNotice(controls.result.textContent, 'error');
      }
    } finally { controls.action.disabled = false; }
  }

  function renderCatalogDrafts(payload) {
    state.catalogDrafts = listFrom(payload, ['items', 'drafts']);
    if (payload?.catalog_revision) state.revisions.catalog = payload.catalog_revision;
    state.catalogRecovery.clear();
    const root = $('#catalogDraftList'); clearChildren(root);
    if (!state.catalogDrafts.length) addText(root, 'p', '当前没有待审核 Draft。', 'empty-state');
    for (const draft of state.catalogDrafts) {
      const row = document.createElement('article'); row.className = 'queue-item';
      const content = document.createElement('div'); content.className = 'item-content';
      addText(content, 'h3', draft.candidate_name || '工具 / 模型 Draft', 'item-title');
      addText(content, 'p', `状态：${draft.state || draft.readiness || 'unknown'}`, 'item-summary');
      if (draft.reused) addBadge(content, '已复用', 'reused');
      recoveryControlsFor(draft, content);
      row.appendChild(document.createElement('span')); row.appendChild(content); root.appendChild(row);
    }
  }

  function renderCatalogBatchPreview(payload) {
    const root = $('#catalogBatchPreview'); clearChildren(root);
    state.catalogBatch = payload?.ok ? payload : null;
    if (!payload?.ok) {
      addText(root, 'p', payload?.code === 'DRAFTS_NOT_READY' ? '暂无可 Apply 的 Draft。' : '批次预览已阻断，请刷新数据后重试。', 'muted');
      $('#catalogApplyButton').disabled = true;
      return;
    }
    addText(root, 'p', `本批 ${Number(payload.draft_count || 0)} 个 Draft，将在一次事务中更新正式知识库。`, 'item-summary');
    addText(root, 'p', `Catalog revision：${payload.expected_revision}`, 'item-id');
    const changes = payload.change_preview || {};
    const creates = Object.values(changes.creates || {}).flat();
    const updates = Array.isArray(changes.updates) ? changes.updates : [];
    const noops = Array.isArray(changes.noops) ? changes.noops : [];
    addText(root, 'p', `新增 ${creates.length}，更新 ${updates.length}，无变化 ${noops.length}`, 'item-summary');
    for (const draft of payload.drafts || []) {
      const change = draft.change_preview || {};
      addText(root, 'p', `${draft.candidate_key || draft.draft_id}：新增 ${Object.values(change.creates || {}).flat().length}，更新 ${(change.updates || []).length}`, 'item-summary');
    }
    for (const blocker of payload.blockers || []) {
      const label = blocker.candidate_key || blocker.draft_id || 'Draft';
      const reasons = Array.isArray(blocker.blocking_reasons) && blocker.blocking_reasons.length ? blocker.blocking_reasons.join('；') : '当前不可 Apply';
      addText(root, 'p', `阻断：${label}（${reasons}）`, 'item-blocked');
    }
    $('#catalogApplyButton').disabled = false;
  }

  async function loadKnowledgeLoop() {
    setLoadState('knowledgeLoopState', '加载中…', 'loading');
    try {
      const [toolsPayload, conceptsPayload, draftsPayload] = await Promise.all([request('feedback/tools'), request('feedback/concepts'), request('catalog/drafts')]);
      state.revisions.pendingTools = revisionFrom(toolsPayload); state.revisions.pendingConcepts = revisionFrom(conceptsPayload);
      renderPendingCards('tools', toolsPayload); renderPendingCards('concepts', conceptsPayload); renderCatalogDrafts(draftsPayload);
      state.catalogBatch = null;
      clearChildren($('#catalogBatchPreview')); addText($('#catalogBatchPreview'), 'p', '准备 Draft 后，可预览整批变更。', 'muted');
      $('#catalogBatchPreviewButton').disabled = !state.catalogDrafts.length;
      $('#catalogApplyButton').disabled = true;
      setLoadState('knowledgeLoopState', '已加载', 'success'); updateRevisionNote();
      const source = $('#knowledgeSourceStats'); if (source) source.textContent = `来源统计：新闻 revision ${text(state.revisions.news || '未加载')}；工具待补 ${state.items.pendingTools.length}；概念待补 ${state.items.pendingConcepts.length}`;
    } catch (error) { setLoadState('knowledgeLoopState', '加载失败', 'error'); showNotice('知识闭环数据加载失败。', 'error'); }
  }

  async function extractKnowledge(button) {
    const original = button.textContent; button.disabled = true; button.textContent = '提取中…';
    try {
      const result = await writeRequest('knowledge/extract', 'news', {});
      showNotice(`提取完成：新增/更新工具 ${Number(result?.tools_pending || 0)}、概念 ${Number(result?.concepts_pending || 0)}。`); await refreshAll();
    } catch (error) { handleMutationError(error, 'news', 'knowledgeLoopState', button); }
    finally { button.textContent = original; button.disabled = false; }
  }

  async function planCatalog(button) {
    button.disabled = true;
    try { state.catalogPlan = await request('catalog/plan'); state.revisions.catalog = state.catalogPlan.catalog_revision || ''; $('#catalogPrepareButton').disabled = !state.catalogPlan.ok; showNotice(state.catalogPlan.ok ? 'Catalog 计划已生成，请核对成本并确认。' : '当前没有可进入 Catalog 的已批准待补卡。', state.catalogPlan.ok ? 'success' : 'error'); }
    catch (error) { showNotice(error.message || 'Catalog 计划失败。', 'error'); }
    finally { button.disabled = false; }
  }
  async function prepareCatalog(button) {
    const plan = state.catalogPlan;
    if (!plan || !$('#catalogCostConfirm').checked) { showNotice('请先生成计划并确认 Catalog 成本。', 'error'); return; }
    button.disabled = true;
    try { const result = await request('catalog/prepare', { method: 'POST', body: JSON.stringify({ pending_revision: plan.pending_revision, catalog_revision: plan.catalog_revision, plan_hash: plan.plan_hash, confirm_cost: true }) }); if (!result?.ok) throw new Error(result?.code || 'Catalog Draft 准备被阻断'); showNotice('Catalog Draft 已准备，仍需逐项审核后 Apply。'); await refreshAll(); }
    catch (error) {
      const msg = (error.code || error.message) === 'PREPARE_IN_PROGRESS' ? '已有一轮 Catalog Draft 准备在执行中，请等待完成后点击“刷新数据”查看进度。' : (error.message || 'Catalog Draft 准备失败。');
      showNotice(msg, 'error');
    }
    finally { button.disabled = false; }
  }
  async function reviewCatalogDraft(draftId, button) {
    button.disabled = true;
    try { const result = await request(`catalog/drafts/${encodeURIComponent(draftId)}/review`, { method: 'POST', body: JSON.stringify({}) }); if (!result?.ok) throw new Error(result?.code || 'Draft 审核阻断'); state.catalogReview = result; $('#catalogApplyButton').disabled = false; showNotice('Draft 已通过当前 revision 审核，可输入精确确认语句 Apply。'); }
    catch (error) { showNotice(error.message || 'Draft 审核失败。', 'error'); }
    finally { button.disabled = false; }
  }
  async function previewCatalogBatch(button) {
    button.disabled = true;
    try {
      const result = await request('catalog/batch-preview');
      renderCatalogBatchPreview(result);
      if (!result?.ok) throw new Error(result?.code || 'Catalog 批次预览被阻断');
      showNotice(`Catalog 批次预览完成：${Number(result.draft_count || 0)} 个 Draft 将一次性提交。`, 'success');
    } catch (error) {
      state.catalogBatch = null; $('#catalogApplyButton').disabled = true;
      showNotice(error instanceof ApiError && error.status === 409 ? 'Catalog 数据已变化，请刷新后重新预览。' : (error.message || 'Catalog 批次预览失败。'), error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    } finally { button.disabled = !state.catalogDrafts?.length; }
  }
  async function applyCatalog(button) {
    const batch = state.catalogBatch;
    if (!batch?.ok) { showNotice('请先预览全部 Catalog Draft。', 'error'); return; }
    button.disabled = true;
    try {
      const result = await request('catalog/apply-batch', { method: 'POST', body: JSON.stringify({ draft_ids: batch.drafts.map(draft => draft.draft_id), expected_revision: batch.expected_revision, batch_token: batch.batch_token, confirm: `APPLY CATALOG DRAFTS ${batch.batch_token}` }) });
      if (!result?.ok) throw new Error(result?.code || 'Catalog Apply 被拒绝');
      state.catalogBatch = null; showNotice(result.status === 'cleanup_pending' ? 'Catalog 已更新，但仍有 Draft 待清理。' : '正式知识库已更新，但公开站点仍需显式重建 dist。'); await refreshAll();
    } catch (error) {
      state.catalogBatch = null; $('#catalogApplyButton').disabled = true;
      showNotice(error instanceof ApiError && error.status === 409 ? 'Catalog 批次已过期，请刷新后重新预览。' : (error.message || 'Catalog Apply 失败。'), error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    } finally { if (state.catalogBatch) button.disabled = false; }
  }

  async function planConcept(button) {
    button.disabled = true;
    try { state.conceptPlan = await request('concepts/plan'); $('#conceptPrepareButton').disabled = !state.conceptPlan.ok; showNotice(state.conceptPlan.ok ? '概念计划已生成，请确认成本。' : '当前没有已批准概念待补卡。', state.conceptPlan.ok ? 'success' : 'error'); }
    catch (error) { showNotice(error.message || '概念计划失败。', 'error'); }
    finally { button.disabled = false; }
  }
  async function prepareConcept(button) {
    const plan = state.conceptPlan;
    if (!plan || !$('#conceptCostConfirm').checked) { showNotice('请先生成概念计划并确认成本。', 'error'); return; }
    button.disabled = true;
    try { const result = await request('concepts/prepare', { method: 'POST', body: JSON.stringify({ pending_revision: plan.pending_revision, glossary_revision: plan.glossary_revision, plan_hash: plan.plan_hash, confirm_cost: true }) }); if (!result?.ok) throw new Error(result?.code || '概念预览准备被阻断'); showNotice('概念预览已生成，请逐项核对后 Apply。'); await refreshAll(); }
    catch (error) { showNotice(error.message || '概念预览准备失败。', 'error'); }
    finally { button.disabled = false; }
  }
  function renderKnowledgeConceptPreview(payload) {
    const root = $('#conceptPreviewList'); clearChildren(root); const items = listFrom(payload, ['items']);
    if (payload?.status === 'legacy_preview') {
      const completed = Array.isArray(payload.completed_terms) ? payload.completed_terms : [];
      addText(root, 'p', completed.length
        ? `旧版概念预览不可提交；${completed.join('、')} 已在正式概念库中，无需再次 Apply。`
        : '旧版概念预览缺少当前批次校验信息，不能 Apply；请重新生成概念预览。', 'item-blocked');
    } else if (payload?.status === 'no_preview') {
      addText(root, 'p', '尚未生成概念预览。请先生成计划并确认概念生成成本。', 'muted');
    }
    for (const item of items) { const row = document.createElement('article'); row.className = 'concept-item'; addText(row, 'h3', item.term || '未命名概念', 'item-title'); addText(row, 'p', item.summary || '暂无摘要', 'concept-definition'); root.appendChild(row); }
    state.conceptPreview = payload?.preview_hash ? payload : null; $('#conceptApplyButton').disabled = !state.conceptPreview?.preview_hash;
  }
  async function loadConceptPreviewLoop() { try { renderKnowledgeConceptPreview(await request('concepts/preview')); } catch (_) {} }
  async function applyConcept(button) {
    const preview = state.conceptPreview;
    if (!preview?.preview_hash || !preview.items?.length) { showNotice('请先生成概念预览。', 'error'); return; }
    button.disabled = true;
    try {
      const result = await request('concepts/apply', { method: 'POST', body: JSON.stringify({ apply_all: true, expected_revision: preview.base_revision }) });
      if (!result?.ok) throw new Error(result?.code || '概念 Apply 被拒绝');
      state.conceptPreview = null; showNotice('全部概念已写入正式知识库，但公开站点仍需显式重建 dist。'); await refreshAll();
    } catch (error) {
      state.conceptPreview = null; $('#conceptApplyButton').disabled = true;
      showNotice(error instanceof ApiError && error.status === 409 ? '概念预览已过期，请刷新后重新生成。' : (error.message || '概念 Apply 失败。'), error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    } finally { if (state.conceptPreview) button.disabled = false; }
  }

  async function clearWorkbench(button) {
    if (!window.confirm('确认清空工作台？\n\n仅清理已完成审核的临时队列、预览和当日人工清单；不会删除正式 Catalog、概念库或历史记录。')) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = '清理中…';
    try {
      const result = await request('workbench/clear', { method: 'POST', body: JSON.stringify({}) });
      if (!result?.ok) throw new Error(result?.message || result?.code || '工作台清理被阻断');
      state.catalogPlan = null;
      state.catalogBatch = null;
      state.catalogRecovery.clear();
      state.conceptPlan = null;
      state.conceptPreview = null;
      showNotice('工作台已清空；正式知识库与历史记录已保留。', 'success');
      await refreshAll();
    } catch (error) {
      updateWorkspaceClearState(null);
      showNotice(error.message || '工作台清理失败。', error instanceof ApiError && error.status === 409 ? 'conflict' : 'error');
    } finally {
      button.textContent = original;
    }
  }

  function start() {
    bindSelection('news', 'newsList', 'newsSelectAll');
    bindSelection('keywords', 'keywordList', 'keywordSelectAll');
    bindSelection('top', 'topList', 'topSelectAll');
    $('#newsApproveButton').addEventListener('click', (event) => reviewNews('approved', event.currentTarget));
    $('#newsDiscardButton').addEventListener('click', (event) => reviewNews('discarded', event.currentTarget));
    $('#keywordGenerateButton').addEventListener('click', (event) => generateKeywords(event.currentTarget));
    $('#keywordDiscardButton').addEventListener('click', (event) => discardKeywords(event.currentTarget));
    $('#keywordAdoptButton').addEventListener('click', (event) => adoptKeywords(event.currentTarget));
    $('#topGenerateButton').addEventListener('click', (event) => generateTop(event.currentTarget));
    $('#topSaveButton').addEventListener('click', (event) => saveTop(event.currentTarget));
    $('#publishNewsButton').addEventListener('click', (event) => publishNews(event.currentTarget));
    $('#transcriptList').addEventListener('change', (event) => {
      const target = event.target;
      if (!target.matches('input[type=file][data-candidate-id]')) return;
      const key = transcriptCandidateKey(target.dataset.candidateId);
      const file = target.files && target.files[0];
      if (file) state.uploads.set(key, file);
      else state.uploads.delete(key);
      const row = target.closest('.transcript-row');
      const button = row && row.querySelector('button[data-candidate-id]');
      if (button) button.disabled = !file || state.uploading.has(key);
    });
    $('#transcriptCostConfirm').addEventListener('change', (event) => {
      $('#transcriptSummarizeButton').disabled = !event.currentTarget.checked;
    });
    $('#transcriptSummarizeButton').addEventListener('click', (event) => summarizeTranscripts(event.currentTarget));
    $('#toolPreviewButton').addEventListener('click', (event) => previewToolUpdates(event.currentTarget));
    $('#toolApplyButton').addEventListener('click', (event) => applyToolUpdates(event.currentTarget));
    $('#knowledgeExtractButton').addEventListener('click', (event) => extractKnowledge(event.currentTarget));
    $('#catalogPlanButton').addEventListener('click', (event) => planCatalog(event.currentTarget));
    $('#catalogPrepareButton').addEventListener('click', (event) => prepareCatalog(event.currentTarget));
    $('#catalogBatchPreviewButton').addEventListener('click', (event) => previewCatalogBatch(event.currentTarget));
    $('#catalogApplyButton').addEventListener('click', (event) => applyCatalog(event.currentTarget));
    $('#conceptPlanButton').addEventListener('click', (event) => planConcept(event.currentTarget));
    $('#conceptPrepareButton').addEventListener('click', (event) => prepareConcept(event.currentTarget));
    $('#conceptApplyButton').addEventListener('click', (event) => applyConcept(event.currentTarget));
    $('#catalogCostConfirm').addEventListener('change', () => { if (state.catalogPlan) $('#catalogPrepareButton').disabled = !state.catalogPlan.ok || !$('#catalogCostConfirm').checked; });
    $('#conceptCostConfirm').addEventListener('change', () => { if (state.conceptPlan) $('#conceptPrepareButton').disabled = !state.conceptPlan.ok || !$('#conceptCostConfirm').checked; });
    $('#refreshButton').addEventListener('click', refreshAll);
    $('#clearWorkbenchButton').addEventListener('click', (event) => clearWorkbench(event.currentTarget));
    $('#previewRefreshButton').addEventListener('click', loadPreview);
    if (!state.token) {
      $('#tokenGate').hidden = false;
      $('#appNotice').hidden = false;
      showNotice('缺少 token，未发起 API 请求。', 'error');
      return;
    }
    refreshAll();
  }

  window.addEventListener('DOMContentLoaded', start, { once: true });
  window.KnowViewMaintainerWorkbench = Object.freeze({ API_ROOT, tokenFromFragment });
})();
