'use strict';

const fs = require('fs');
const path = require('path');
const { CATALOG_FILES, CATALOG_GENERATOR_FILES, DIRS } = require('../shared/paths');
const { validateCatalogSnapshot } = require('../catalog/core/index');

const TARGET_FIELD_BY_KIND = Object.freeze({
  tool: 'last_updated_date',
  api_model: 'release_date',
  product_variant: 'release_date',
});

const SOURCE_DATE_PATTERNS = Object.freeze({
  update: /changelog|change[- ]log|release[-_ ]?notes|releases?|update|更新日志|更新记录/i,
  release: /announcement|introducing|launch|release(?:s|d)?(?:\/tag)?|new models|发布日期|首发|首次|ga/i,
});

function readItems(file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(payload) ? payload : payload.items || [];
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function dateFromNote(note) {
  return String(note || '').match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0] || null;
}

function repairFieldFromNote(note) {
  const value = String(note || '');
  if (/release_date|发布日期|首次|首发|首次公开|公开发布日期|\bGA\b|release/i.test(value)) return 'release_date';
  if (/last_updated_date|产品级最近更新|最近更新|更新日期|更新时间/i.test(value)) return 'last_updated_date';
  return null;
}

function loadRepairEvidence(toolsDir = DIRS.tools) {
  const evidence = new Map();
  for (const fileName of fs.readdirSync(toolsDir).filter(name => name.endsWith('.json')).sort()) {
    const filePath = path.join(toolsDir, fileName);
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    const note = payload?.repair_note;
    const detailId = String(note || '').match(/tool-level3:[A-Za-z0-9-]+/)?.[0];
    const date = dateFromNote(note);
    const field = repairFieldFromNote(note);
    if (!detailId || !date || !field) continue;
    evidence.set(detailId, { field, date, source_file: fileName, note: String(note) });
  }
  return evidence;
}

function sourceSignals(sources) {
  const list = Array.isArray(sources) ? sources : [];
  const invalid = list.some(source => !source?.title || !isHttpUrl(source.url));
  const text = list.map(source => `${source.title || ''} ${source.url || ''}`).join(' ');
  return {
    invalid,
    has_update: SOURCE_DATE_PATTERNS.update.test(text),
    has_release: SOURCE_DATE_PATTERNS.release.test(text),
  };
}

function categoryFor(item, currentDate, targetField, repairEvidence) {
  const signals = sourceSignals(item.sources);
  if (signals.invalid || !item.sources?.length) return { category: 'invalid_source', reason: '缺少可核验的 HTTP/HTTPS 官方来源' };
  if (item.detail_kind === 'subscription_plan') return { category: 'ambiguous', reason: 'subscription_plan 不适用公开日期，需人工确认是否保持无日期' };
  if (!currentDate) return { category: 'ambiguous', reason: '缺少已核验日期，需人工补充对应日期事实' };
  if (repairEvidence && repairEvidence.date === currentDate) {
    if (repairEvidence.field === targetField) {
      return { category: targetField === 'release_date' ? 'verified_release' : 'verified_update', reason: '既有人工 repair 记录明确支持当前日期字段' };
    }
    return { category: 'ambiguous', reason: `人工 repair 记录将该日期定义为 ${repairEvidence.field}，与当前 ${targetField || '无公开日期'} 目标冲突` };
  }
  if (targetField === 'last_updated_date' && signals.has_update) return { category: 'verified_update', reason: '来源标题或 URL 指向 changelog/release notes/update 资料' };
  if (targetField === 'release_date' && signals.has_release) return { category: 'verified_release', reason: '来源标题或 URL 指向发布公告/首发/release 资料' };
  return { category: 'ambiguous', reason: '来源存在，但来源类型不足以证明当前日期的具体语义' };
}

function auditCatalogDates({ items = [], repairEvidence = new Map() } = {}) {
  const rows = items.map(item => {
    const targetField = TARGET_FIELD_BY_KIND[item.detail_kind] || null;
    const currentDate = item.release_date || item.last_updated_date || null;
    const repair = repairEvidence.get(item.id) || null;
    const result = categoryFor(item, currentDate, targetField, repair);
    return {
      id: item.id,
      title: item.title,
      detail_kind: item.detail_kind,
      current_date: currentDate,
      current_field: item.release_date ? 'release_date' : item.last_updated_date ? 'last_updated_date' : null,
      target_field: targetField,
      category: result.category,
      reason: result.reason,
      sources: (item.sources || []).map(source => ({ title: source.title, url: source.url })),
      ...(repair ? { repair_evidence: { field: repair.field, date: repair.date, source_file: repair.source_file } } : {}),
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const byCategory = Object.fromEntries([...new Set(rows.map(row => row.category))].sort().map(category => [category, rows.filter(row => row.category === category).length]));
  const byDetailKind = Object.fromEntries([...new Set(rows.map(row => row.detail_kind))].sort().map(kind => [kind, rows.filter(row => row.detail_kind === kind).length]));
  return {
    schema_version: 1,
    kind: 'catalog_date_audit',
    summary: { total: rows.length, by_category: byCategory, by_detail_kind: byDetailKind },
    items: rows,
  };
}

function readCatalogSnapshot(files = CATALOG_FILES) {
  return {
    'vendor-card': readItems(files.vendorCards),
    'tool-card': readItems(files.toolCards),
    'vendor-level1': readItems(files.vendorPreviewLevel1),
    'vendor-level2': readItems(files.vendorPreviewLevel2),
    'tool-level3': readItems(files.toolPreviewLevel3),
  };
}

function createCatalogDateAudit({ files = CATALOG_FILES, toolsDir = DIRS.tools } = {}) {
  const snapshot = readCatalogSnapshot(files);
  const validation = validateCatalogSnapshot(snapshot);
  if (!validation.ok) {
    const error = new Error('正式 catalog 校验失败，拒绝生成日期审计清单');
    error.code = 'CATALOG_INVALID';
    error.details = validation.errors;
    throw error;
  }
  return auditCatalogDates({ items: snapshot['tool-level3'], repairEvidence: loadRepairEvidence(toolsDir) });
}

function writeAuditReport(report, outputPath = CATALOG_GENERATOR_FILES.dateAudit) {
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}

function runCatalogDateAudit({ outputPath = CATALOG_GENERATOR_FILES.dateAudit, dryRun = false, files, toolsDir } = {}) {
  const report = createCatalogDateAudit({ files, toolsDir });
  if (!dryRun) writeAuditReport(report, outputPath);
  return { report, outputPath: dryRun ? null : outputPath };
}

module.exports = {
  TARGET_FIELD_BY_KIND,
  auditCatalogDates,
  createCatalogDateAudit,
  loadRepairEvidence,
  repairFieldFromNote,
  runCatalogDateAudit,
  writeAuditReport,
};
