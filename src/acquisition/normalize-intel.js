/**
 * normalize-intel.js — 解析/规范化/合并层
 *
 * 职责：把抓取到的原始文本（Markdown / HTML）解析为统一的定价记录，
 * 并负责价格冲突检测与 tool-intelligence.json 的增量合并。
 *
 * 从 fetch-tool-intel.js 拆分而来，仅移动代码、不重写逻辑。
 * 本文件是纯函数集合，不发起任何网络请求、不读写文件。
 */
'use strict';

// ═══════════════════════════════════════════════════════════════
// 类型定义（JSDoc 注释）
// ═══════════════════════════════════════════════════════════════

/**
 * @typedef {{ results: object[], warnings: string[], errors: string[] }} ExtractResult
 */

// ═══════════════════════════════════════════════════════════════
// L1：Markdown 表格解析器
// ═══════════════════════════════════════════════════════════════

/**
 * 从 Markdown 文本中提取所有表格。
 * 返回数组，每个元素是一个对象数组（行），行的属性名来自表头。
 * 跳过格式行（|---|---|）。
 */
function extractMarkdownTables(markdown) {
  const tables = [];
  const lines = markdown.split('\n');
  let inTable = false;
  let headerRow = null;
  let currentRows = [];
  let seenSeparator = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // 标准 Markdown 表格行以 | 开头和结尾
    if (/^\|.+\|\s*$/.test(trimmed)) {
      if (!inTable) {
        inTable = true;
        currentRows = [];
        headerRow = null;
        seenSeparator = false;
      }
      const parts = trimmed.split('|')
        .map(c => c.trim().replace(/\\\|/g, '|'))
        .filter(c => c.length > 0);

      // 检查是否是分隔行（|---|）
      if (/^[-:\s]+\|?[-:\s]+$/.test(trimmed.replace(/^\||\|$/g, '').trim()) || parts.every(p => /^[-:\s]+$/.test(p))) {
        seenSeparator = true;
        continue;
      }

      if (!headerRow) {
        headerRow = parts;
      } else {
        if (headerRow.length > 0) {
          const row = {};
          headerRow.forEach((h, i) => { if (i < parts.length) row[h] = parts[i]; });
          currentRows.push(row);
        }
      }
    } else {
      if (inTable && currentRows.length > 0) {
        tables.push(currentRows);
      }
      inTable = false;
      headerRow = null;
      currentRows = [];
    }
  }
  if (inTable && currentRows.length > 0) tables.push(currentRows);
  return tables;
}

/**
 * 解析价格字符串 "$5 / MTok" → { amount: 5, currency: 'USD', unit: 'per_1m_tokens' }
 * 也支持 "$5"、"¥0.02"、"$0.50 / MTok"、"¥1/百万tokens" 等格式
 */
function parsePriceString(str) {
  if (!str || typeof str !== 'string') return null;
  const cleaned = str.replace(/^[^0-9.$¥€£฿₩₹]+/, '').trim();
  // 优先匹配带单位格式: $5 / MTok, ¥1/百万tokens
  const withUnit = cleaned.match(/([\$¥€£฿₩₹])?\s*([\d.]+)\s*\/\s*(M(?:illion)?[Tt]ok(?:ens)?|百万tokens|[MT]ok)/);
  if (withUnit) {
    const currencyMap = { '$': 'USD', '¥': 'CNY', '€': 'EUR', '£': 'GBP', '฿': 'THB', '₩': 'KRW', '₹': 'INR' };
    return { amount: parseFloat(withUnit[2]), currency: currencyMap[withUnit[1]] || 'USD', unit: 'per_1m_tokens' };
  }
  // 退而求其次：仅货币符号+数字（HTML 表格单元格常用）
  const naked = cleaned.match(/([\$¥€£฿₩₹])?\s*([\d.]+)\s*$/);
  if (naked) {
    const currencyMap = { '$': 'USD', '¥': 'CNY', '€': 'EUR', '£': 'GBP', '฿': 'THB', '₩': 'KRW', '₹': 'INR' };
    return { amount: parseFloat(naked[2]), currency: currencyMap[naked[1]] || 'USD', unit: 'per_1m_tokens' };
  }
  return null;
}

/**
 * 从 Markdown 表格行映射到 rate_cards 格式。
 * 自动识别常见的列名模式。
 */
function mapRowToRateCard(row, modelNameKey = 'Model') {
  const modelName = row[modelNameKey] || '';
  const rateCard = { label: 'Standard', currency: 'USD', unit: 'per_1m_tokens' };

  // 自动匹配列名中的关键词（支持中英文）
  // 注意：必须先检测具体匹配，再检测通用匹配
  for (const [colName, value] of Object.entries(row)) {
    const col = colName.toLowerCase().replace(/[（）\(\)]/g, '');
    const parsed = parsePriceString(value);

    if (!parsed) continue;

    // "缓存未命中" 必须优先于 "缓存"+"命中" 检测（避免 "缓存未命中" = 缓存+命中 误匹配）
    if ((col.includes('cache hit') || col.includes('cache read') || col.includes('cache refresh')
        || col.includes('缓存命中') && !col.includes('缓存未命中'))
        && (col.includes('input') || col.includes('输入') || col.includes('inp'))) {
      rateCard.input_cached = parsed.amount;
    } else if ((col.includes('base input') || col.includes('input') && !col.includes('cache') && !col.includes('output'))
        || col.includes('输入') && (col.includes('缓存未命中') || col.includes('uncached'))
        || (col.includes('输入') && !col.includes('缓存') && !col.includes('output') && !col.includes('输出'))) {
      rateCard.input_uncached = parsed.amount;
      rateCard.currency = parsed.currency;
    } else if ((col.includes('output') && !col.includes('cache') && !col.includes('input'))
        || (col.includes('输出') && !col.includes('缓存') && !col.includes('输入'))) {
      rateCard.output = parsed.amount;
    } else if (col.includes('batch input') || (col.includes('batch') && col.includes('input'))) {
      rateCard.batch_input = parsed.amount;
    } else if (col.includes('batch output') || (col.includes('batch') && col.includes('output'))) {
      rateCard.batch_output = parsed.amount;
    }
  }

  // 只有当至少有一个价格字段时才返回有效数据
  if (rateCard.input_uncached || rateCard.output) {
    return { modelName, rateCard };
  }
  return null;
}

/**
 * L1 解析入口：从 pricing.md 提取定价数据。
 */
function extractFromPricingMarkdown(markdown, tableIndex = 0) {
  const tables = extractMarkdownTables(markdown);
  if (tables.length === 0) {
    return { results: [], warnings: ['未找到 Markdown 表格'], errors: [] };
  }
  const targetTable = tables[tableIndex] || tables[0];
  const results = [];
  const warnings = [];

  for (const row of targetTable) {
    const mapped = mapRowToRateCard(row);
    if (mapped) results.push(mapped);
  }

  if (results.length === 0) {
    warnings.push('Markdown 表格解析未匹配到任何价格行');
  }

  return { results, warnings, errors: [] };
}

// ═══════════════════════════════════════════════════════════════
// L2：HTML 表格解析器（CSS 选择器模式）
// ═══════════════════════════════════════════════════════════════

/**
 * 极简的 HTML 表格提取器，不使用外部依赖：
 * 通过正则匹配 <table>...</table>，然后从中提取 <td>/<th> 内容。
 *
 * 注意：这仅在表格结构简单（无嵌套表格）时可靠。
 * 如果需要更稳健的解析，可引入 cheerio（但本项目保持零依赖）。
 */
function extractHtmlTablesSimple(html) {
  const tables = [];
  // 匹配最外层 table 标签（不处理嵌套）
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch;

  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const tableHtml = tableMatch[1];
    const rows = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let rowMatch;

    while ((rowMatch = rowRegex.exec(tableHtml)) !== null) {
      const cellRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      const cells = [];
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
        // 清除 HTML 标签，提取纯文本
        const text = cellMatch[1].replace(/<[^>]+>/g, '').trim();
        cells.push(text);
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 1) tables.push(rows);
  }
  return tables;
}

/**
 * 将 HTML 表格行（数组）转换为键值对对象。
 * 第一行作为表头。
 */
function htmlRowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.replace(/[*#]/g, '').trim());
  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const row = {};
    headers.forEach((h, idx) => {
      if (idx < rows[i].length) row[h] = rows[i][idx].trim();
    });
    results.push(row);
  }
  return results;
}

/**
 * L2 解析入口：从 HTML 提取定价数据。
 */
function extractFromHtmlTable(html, selectorHint = '') {
  const rawTables = extractHtmlTablesSimple(html);
  if (rawTables.length === 0) {
    return { results: [], warnings: ['HTML 中未找到表格'], errors: [] };
  }
  const results = [];
  const warnings = [];

  for (const tableRows of rawTables) {
    const rows = htmlRowsToObjects(tableRows);
    for (const row of rows) {
      const mapped = mapRowToRateCard(row);
      if (mapped) results.push(mapped);
    }
    if (results.length > 0) break; // 第一个有数据的表格就够了
  }

  if (results.length === 0) {
    warnings.push('HTML 表格解析未匹配到任何价格行（可能表格结构不标准）');
  }

  return { results, warnings, errors: [] };
}

// ═══════════════════════════════════════════════════════════════
// 厂商专用解析器
// ═══════════════════════════════════════════════════════════════

/**
 * DeepSeek 专用：处理竖向对比表中的定价数据。
 * 表头: [模型, deepseek-v4-flash, deepseek-v4-pro]
 * "价格" 行标记定价区起始，后续行按 类别/价格/价格 排列。
 * 例: Row[价格, 百万tokens输入（缓存命中）, 0.02元, 0.025元]
 *     Row[百万tokens输入（缓存未命中）, 1元, 3元]
 *     Row[百万tokens输出, 2元, 6元]
 */
function extractDeepSeekPricing(html) {
  const rawTables = extractHtmlTablesSimple(html);
  if (rawTables.length === 0) return { results: [], warnings: ['未找到表格'], errors: [] };

  for (const tableRows of rawTables) {
    if (tableRows.length < 3) continue;
    const headerRow = tableRows[0];
    if (headerRow.length < 2) continue;

    // 识别模型名（跳过第一列通常是"模型"标签）
    const modelStart = headerRow[0] === '模型' ? 1 : 0;
    const models = headerRow.slice(modelStart);
    const rates = models.map(name => ({
      modelName: name.replace(/\([^)]*\)/g, '').trim(),
      rateCard: { currency: 'CNY', unit: 'per_1m_tokens', label: 'Standard' },
    }));

    // 找到"价格"行标记
    let inPricing = false;
    for (let r = 0; r < tableRows.length; r++) {
      const cols = tableRows[r];
      if (cols.length < 2) continue;

      if (cols[0] === '价格') {
        inPricing = true;
        // "价格"行本身也可能包含第一个定价字段的数据
        // cols = [价格, 百万tokens输入（缓存命中）, 0.02元, 0.025元]
        // 所以 prices 从 colStart 开始
        assignPrices(cols, models.length, rates, modelStart);
        continue;
      }

      if (!inPricing) continue;

      // 到达极限行，退出定价区
      if (cols[0] === '并发限制' || cols[0] === '扣费规则') break;

      // 定价行：cols[0]=类别名, cols[1..N]=价格
      assignPrices(cols, models.length, rates, modelStart);
    }

    const results = rates.filter(r => r.rateCard.input_uncached || r.rateCard.output);
    if (results.length > 0) return { results, warnings: [], errors: [] };
  }

  return { results: [], warnings: ['未识别的 DeepSeek 定价表格式'], errors: [] };
}

/**
 * 将行中的价格分配到 rateCard。
 */
function assignPrices(cols, modelCount, rates, modelStart) {
  let label = (cols[0] || '').trim();
  let priceStart = 1;

  // "价格"标记行：cols = [价格, 缓存命中标签, price1, price2, ...]
  if (label === '价格') {
    label = (cols[1] || '').trim();  // 真正的类别名在第二列
    priceStart = 2;                   // 价格从第三列开始
  }

  for (let i = 0; i < modelCount && (priceStart + i) < cols.length; i++) {
    const cellText = (cols[priceStart + i] || '').trim();
    const amountMatch = cellText.match(/([\d.]+)\s*元/);
    if (!amountMatch) continue;

    const amount = parseFloat(amountMatch[1]);
    const rateCard = rates[i].rateCard;

    if (label.includes('缓存命中')) {
      rateCard.input_cached = amount;
    } else if (label.includes('缓存未命中')) {
      rateCard.input_uncached = amount;
    } else if (label.includes('输出')) {
      rateCard.output = amount;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// 冲突检测与数据合并
// ═══════════════════════════════════════════════════════════════

/** 价格变化阈值（超过此比例自动标记冲突） */
const CONFLICT_THRESHOLD = 0.2;

/**
 * 检测新旧价格的差异。
 * 返回 { changed: boolean, changes: Array<{field, oldVal, newVal, diffPct}>, hasConflict: boolean }
 */
function detectPricingChange(oldRateCard, newRateCard) {
  const changes = [];
  for (const field of ['input_uncached', 'input_cached', 'output']) {
    const oldVal = oldRateCard[field];
    const newVal = newRateCard[field];
    if (oldVal !== undefined && newVal !== undefined && oldVal !== newVal) {
      const diffPct = Math.abs(newVal - oldVal) / oldVal;
      changes.push({ field, oldVal, newVal, diffPct });
    }
  }
  const hasConflict = changes.some(c => c.diffPct >= CONFLICT_THRESHOLD);
  return { changed: changes.length > 0, changes, hasConflict };
}

/**
 * 将提取的新数据合并到现有的 tool-intelligence.json 中。
 *
 * @param {object} existingIntel — 现有的 tool-intelligence.json 内容
 * @param {string} toolId — 工具 ID（如 "claude"）
 * @param {Array<{modelName: string, rateCard: object}>} newData — 新提取的定价数据
 * @param {string} sourceId — 来源 ID
 * @param {string} queriedAt — ISO 时间戳
 * @returns {{ updated: boolean, conflicts: object[], status: string }}
 */
function mergeIntelData(existingIntel, toolId, newData, sourceId, queriedAt) {
  const collection = existingIntel.collections.find(c => c.tool_id === toolId);
  if (!collection) {
    return { updated: false, conflicts: [], status: 'tool_not_found' };
  }

  const conflicts = [];
  let updated = false;

  // 更新来源记录
  if (!collection.sources) collection.sources = [];
  const sourceEntry = collection.sources.find(s => s.id === sourceId);
  if (sourceEntry) {
    sourceEntry.queried_at = queriedAt;
  } else {
    collection.sources.push({
      id: sourceId,
      url: '',  // 由调用方填充
      title: '',
      publisher: collection.name || toolId,
      source_type: 'official',
      queried_at: queriedAt,
    });
  }

  // 匹配已知的叶子节点
  for (const item of collection.items) {
    if (item.node_type !== 'leaf' || !item.api_pricing) continue;

    // 尝试通过名称匹配
    const matchedData = newData.find(d =>
      item.name.toLowerCase().includes(d.modelName.toLowerCase()) ||
      d.modelName.toLowerCase().includes(item.name.toLowerCase())
    );
    if (!matchedData) continue;

    const change = detectPricingChange(item.api_pricing.rate_cards?.[0] || {}, matchedData.rateCard);
    if (!change.changed) continue;

    if (change.hasConflict) {
      conflicts.push({
        tool_id: toolId,
        item_id: item.id,
        item_name: item.name,
        changes: change.changes,
        source_id: sourceId,
        queried_at: queriedAt,
        status: 'pending_review',
      });
      // 标记冲突但不修改数据
      item.api_pricing.status = 'conflict';
      item.api_pricing.conflict_detected_at = queriedAt;
    } else {
      // 小幅变化自动更新
      Object.assign(item.api_pricing.rate_cards[0], matchedData.rateCard);
      item.api_pricing.status = 'provided';
      item.api_pricing.updated_at = queriedAt;
      // 更新 source_refs
      if (!item.api_pricing.source_refs.includes(sourceId)) {
        item.api_pricing.source_refs.push(sourceId);
      }
    }
    updated = true;
  }

  // 更新整个 collection 的状态
  if (conflicts.length > 0) {
    collection.status = 'conflict';
  } else if (updated) {
    collection.status = 'verified';
  }

  return { updated, conflicts, status: conflicts.length > 0 ? 'conflict' : updated ? 'updated' : 'no_change' };
}

module.exports = {
  extractMarkdownTables,
  parsePriceString,
  mapRowToRateCard,
  extractFromPricingMarkdown,
  extractHtmlTablesSimple,
  htmlRowsToObjects,
  extractFromHtmlTable,
  extractDeepSeekPricing,
  assignPrices,
  detectPricingChange,
  mergeIntelData,
};
