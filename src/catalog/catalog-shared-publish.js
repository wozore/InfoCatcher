'use strict';

const { writeCatalogReleaseDates } = require('../shared/catalog-release-dates');
const { loadCatalogSnapshot } = require('./core/index');

/**
 * catalog-shared-publish.js — catalog → comparison 方向共享投影发布
 *
 * catalog 每次落盘后把 api_model/product_variant 的 release_date 投影成
 * 共享段 `data/shared/catalog-release-dates.json`（comparison 反查只读），
 * 使 comparison 不再直接读 catalog 私有文件。
 * 这是可再生的派生投影：发布失败只 console.warn 降级，不进事务回滚链；
 * comparison 读端校验 + 空默认兜底，下次 catalog 落盘自动刷新。
 */

const ALLOWED_KINDS = new Set(['api_model', 'product_variant']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value) {
  return ISO_DATE_RE.test(String(value || '')) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/** 从五模块快照确定性投影 catalog release_date 条目（纯逻辑，不依赖文件）。 */
function buildCatalogReleaseDates(snapshot) {
  const details = snapshot['tool-level3'] || [];
  const cards = snapshot['tool-card'] || [];
  const toolKeyByDetail = new Map();
  for (const card of cards) {
    const ref = card.detail_ref;
    if (ref && ref.kind === 'tool-level3' && ref.id && card.tool_key) toolKeyByDetail.set(ref.id, card.tool_key);
  }
  const entries = [];
  for (const detail of details) {
    if (!ALLOWED_KINDS.has(detail.detail_kind)) continue;
    if (!isIsoDate(detail.release_date)) continue;
    entries.push({
      detail_id: detail.id,
      detail_kind: detail.detail_kind,
      vendor_key: detail.vendor_key || null,
      title: detail.title || null,
      tool_key: toolKeyByDetail.get(detail.id) || null,
      release_date: detail.release_date,
    });
  }
  entries.sort((a, b) => String(a.detail_id).localeCompare(String(b.detail_id)));
  return entries;
}

/** 发布到共享段；失败降级（派生投影，可再生），不抛。 */
function publishCatalogReleaseDates(snapshot) {
  const entries = buildCatalogReleaseDates(snapshot);
  const result = writeCatalogReleaseDates(entries);
  if (!result.ok) console.warn('⚠️ catalog release_date 共享投影发布失败：', (result.errors || [result.error]).join('; '));
  return result;
}

/** 事务提交后便捷发布：重读已落盘快照再投影（统一各提交体入口，不抛）。 */
function publishCatalogReleaseDatesAfterCommit() {
  try {
    const { snapshot } = loadCatalogSnapshot();
    return publishCatalogReleaseDates(snapshot);
  } catch (error) {
    console.warn('⚠️ catalog release_date 共享投影发布失败：', error.message);
    return { ok: false, code: 'SHARED_CATALOG_RELEASE_DATES_PUBLISH_FAILED', error: error.message };
  }
}

module.exports = { buildCatalogReleaseDates, publishCatalogReleaseDates, publishCatalogReleaseDatesAfterCommit };
