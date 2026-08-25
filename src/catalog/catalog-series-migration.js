'use strict';

/**
 * catalog-series-migration.js —— LLM 二级系列迁移规划器（阶段 2）。
 *
 * 纯确定性、零网络、零 AI。输入：SeriesPolicy + 五模块 snapshot。
 * 输出：SeriesMigrationPlan（完整 FutureSnapshot 的精确变更）与审计报告。
 *
 * 为什么需要它：普通单 seed LayerPlan 只能表达一个 target L2 的 create/replace/noop，
 * 无法表达“把已有成员从旧系列搬到新系列 / 删除旧系列 / 重写一级 level2_refs”。
 *
 * 统一算法（一个厂商内）：
 *   1. 收集政策全部目标系列（通用 general_llm 家族做重组；专用/套餐/工具家族做“改名对齐”，
 *      不重新排序成员）。OpenAI realtime/image 与 Kimi 的改名即走专用改名路径。
 *   2. 对每个目标系列选“基座”既有 L2：
 *        同 id 存在 → 用该记录原地改写成员；
 *        否则成员集完全包含某个既有 L2 → 用其中最大的一个，改成目标 id（rename/merge 保元数据）；
 *        否则 → 新建（summary/official_url/status 为空）。
 *   3. 目标成员 = policy expected_members ∩ 该厂商既有三级详情（保持 policy 顺序）。
 *   4. 删除“碎片”旧系列：既非目标、又未被当作基座、且其成员全部是本厂商记录的既有 L2
 *      （仅当厂商有 general 家族）。成员不删除，保留三级详情。
 *   5. 重写 vendor-level1.level2_refs：保留专用/套餐/工具引用，删除已消失引用，追加新目标。
 *
 * 不变式：tool-level3 与 tool-card 完全不动；被移出窗口的模型保留详情，无新父级的列入
 * orphaned 警告，绝不静默删除成员。
 */

const { normalizeSnapshot, emptySnapshot } = require('./catalog-contract');
const { detailKeyOf, detailRefIdOf } = require('./catalog-series-policy');
const { validateCatalogSnapshot } = require('./catalog-snapshot-validator');

/** 归一化成员引用：统一为完整 detail ref id。 */
function memberRef(value) {
  const id = detailRefIdOf(value);
  return id ? { kind: 'tool-level3', id } : null;
}

/** 收集厂商全部政策目标系列（含专用/套餐/工具），id → { series, general }。 */
function allTargetSeriesByVendor(policy, vendor) {
  const byId = {};
  for (const family of vendor.families || []) {
    const general = family.usage_kind === 'general_llm';
    for (const series of family.series || []) byId[series.id] = { series, general };
  }
  return byId;
}

/**
 * 规划一个厂商的二级系列重组。
 * @returns {{ plan: Array, removed: Array }}
 */
function planVendorMigration(policy, vendor, level2s, detailIdToVendor) {
  const targets = allTargetSeriesByVendor(policy, vendor);
  const targetIds = new Set(Object.keys(targets));
  const existingById = new Map(level2s.map(l2 => [l2.id, l2]));

  const plan = [];
  const consumedIds = new Set();

  for (const [id, { series, general }] of Object.entries(targets)) {
    const members = (series.expected_members || [])
      .map(memberRef)
      .filter(ref => ref && detailIdToVendor.get(ref.id) === vendor.vendor_key);
    const memberIdSet = new Set(members.map(m => m.id));

    // 基座选择
    let base = existingById.get(id) || null;
    let mergeSources = [];
    if (!base) {
      // 成员集完全被目标包含的既有 L2（重命名/合并基座），取成员最多者保元数据
      const candidates = level2s.filter(l2 => {
        const have = (l2.detail_refs || []).map(r => r.id);
        return have.length > 0 && have.every(h => memberIdSet.has(h));
      });
      candidates.sort((a, b) => (b.detail_refs || []).length - (a.detail_refs || []).length);
      if (candidates.length) {
        base = candidates[0];
        mergeSources = candidates;
      }
    }

    // 非通用家族且无既有成员对应的目标：绝不凭空新建（零漂移）
    if (!general && !base && members.length === 0) continue;

    // 无既有成员且无基座的目标：不创建空系列（无论通用/专用）
    if (members.length === 0 && !base) continue;
    // 有基座但政策成员未匹配（空）：保留基座现有成员，避免误清空旧系列
    const effectiveMembers = members.length
      ? members
      : (base ? (base.detail_refs || []).map(ref => ({ kind: 'tool-level3', id: ref.id })) : []);

    const record = base
      ? {
          ...base,
          id,
          level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${vendor.vendor_key}` },
          vendor_key: vendor.vendor_key,
          title: series.title,
          detail_refs: effectiveMembers,
        }
      : {
          id,
          level1_ref: { kind: 'vendor-level1', id: `vendor-level1:${vendor.vendor_key}` },
          vendor_key: vendor.vendor_key,
          title: series.title,
          official_url: '',
          summary: '',
          status: 'unknown',
          detail_refs: effectiveMembers,
        };

    plan.push({
      id,
      general,
      create: !base,
      oldId: base ? base.id : null,
      removeIds: mergeSources.map(source => source.id).filter(id => id !== base?.id),
      record,
      members: members.map(m => m.id),
    });
    if (base) {
      consumedIds.add(base.id);
      for (const source of mergeSources) consumedIds.add(source.id);
    }
  }

  // 碎片删除：既非目标、又未被消费、且成员全为本厂商记录的既有 L2
  const removed = [];
  for (const l2 of level2s) {
    if (targetIds.has(l2.id)) continue;
    if (consumedIds.has(l2.id)) continue;
    if (!vendor.families.some(f => f.usage_kind === 'general_llm')) continue;
    const allVendorRecords = (l2.detail_refs || []).every(r => detailIdToVendor.get(r.id) === vendor.vendor_key);
    if (!allVendorRecords) continue;
    removed.push({ id: l2.id, title: l2.title, members: (l2.detail_refs || []).map(r => r.id) });
  }

  return { plan, removed };
}

/**
 * 生成完整迁移计划。
 * @returns {{ ok:true, snapshot, changes, id_map, members_moved, removed_level2, orphaned, warnings, validation }}
 */
function planSeriesMigration(policy, snapshotInput) {
  const snapshot = normalizeSnapshot(snapshotInput);
  const warnings = [];

  const detailIdToVendor = new Map();
  for (const detail of snapshot['tool-level3']) detailIdToVendor.set(detail.id, detail.vendor_key);

  const level2ByVendor = new Map();
  for (const l2 of snapshot['vendor-level2']) {
    if (!level2ByVendor.has(l2.vendor_key)) level2ByVendor.set(l2.vendor_key, []);
    level2ByVendor.get(l2.vendor_key).push(l2);
  }

  const next = emptySnapshot();
  next['vendor-card'] = [...snapshot['vendor-card']];
  next['tool-card'] = [...snapshot['tool-card']];
  next['vendor-level1'] = snapshot['vendor-level1'].map(l1 => ({ ...l1, level2_refs: [...(l1.level2_refs || [])] }));
  next['vendor-level2'] = snapshot['vendor-level2'].map(l2 => ({ ...l2, detail_refs: [...(l2.detail_refs || [])] }));
  next['tool-level3'] = [...snapshot['tool-level3']];

  const changes = [];
  const removedLevel2 = [];
  const targetIdsByVendor = new Map();
  const newParentByDetail = new Map(); // detail key → 新 L2 id

  for (const vendor of policy.vendors) {
    const l2s = level2ByVendor.get(vendor.vendor_key) || [];
    if (!l2s.length) continue;
    const hasGeneral = vendor.families.some(f => f.usage_kind === 'general_llm');
    if (!hasGeneral) continue;

    const { plan, removed } = planVendorMigration(policy, vendor, l2s, detailIdToVendor);
    const targetIds = new Set(plan.map(p => p.id));
    targetIdsByVendor.set(vendor.vendor_key, targetIds);

    // 1. 应用 L2 create/rename/merge（replace 原地替换或按旧 id 移除后插入）
    for (const item of plan) {
      if (item.create) {
        next['vendor-level2'].push(item.record);
        changes.push({ area: 'vendor-level2', id: item.id, operation: 'create', note: `新建 ${item.record.title}` });
      } else if (item.oldId && item.oldId !== item.id) {
        // rename/merge：移除旧基座条目，按原位置插入新记录
        const idx = next['vendor-level2'].findIndex(x => x.id === item.oldId);
        next['vendor-level2'].splice(idx >= 0 ? idx : next['vendor-level2'].length, idx >= 0 ? 1 : 0, item.record);
        changes.push({ area: 'vendor-level2', id: item.id, operation: 'replace', note: `由 ${item.oldId} 重组为 ${item.record.title}` });
      } else {
        const sameIdx = next['vendor-level2'].findIndex(x => x.id === item.id);
        next['vendor-level2'][sameIdx] = item.record;
        changes.push({ area: 'vendor-level2', id: item.id, operation: 'replace', note: `重组为 ${item.record.title}` });
      }
      for (const member of item.members) newParentByDetail.set(detailKeyOf(member), item.id);
      // 移除被本目标合并（非基座）的旧条目，防止旧 id 残留
      for (const removeId of item.removeIds || []) {
        const ridx = next['vendor-level2'].findIndex(x => x.id === removeId);
        if (ridx >= 0) next['vendor-level2'].splice(ridx, 1);
      }
    }

    // 2. 删除碎片旧系列
    for (const r of removed) {
      removedLevel2.push(r);
      next['vendor-level2'] = next['vendor-level2'].filter(x => x.id !== r.id);
      changes.push({ area: 'vendor-level2', id: r.id, operation: 'remove', note: `删除碎片系列 ${r.title}` });
    }
  }

  // 3. 成员搬迁报告：逐 detail 比较迁移前后父级
  const oldParentByDetail = new Map();
  for (const l2 of snapshot['vendor-level2']) {
    for (const ref of l2.detail_refs || []) oldParentByDetail.set(detailKeyOf(ref.id), l2.id);
  }
  const membersMoved = [];
  const idMap = {};
  const oldParentSet = new Set(snapshot['vendor-level2'].map(x => x.id));
  const removedSet = new Set(removedLevel2.map(r => r.id));
  for (const [key, newParent] of newParentByDetail) {
    const oldParent = oldParentByDetail.get(key);
    if (!oldParent) continue;
    if (oldParent !== newParent) {
      membersMoved.push({ detail: `tool-level3:${key}`, from: oldParent, to: newParent });
      if (removedSet.has(oldParent)) {
        if (!idMap[oldParent]) idMap[oldParent] = [];
        if (!idMap[oldParent].includes(newParent)) idMap[oldParent].push(newParent);
      }
    }
  }

  // 4. 孤儿成员：只报告“迁移前有父级、迁移后失去父级”的新孤儿（理论应为空）。
  //    政策厂商既有的浮空详情（如 OpenAI 的 chatgpt-* 订阅/工具卡）属既有数据问题，写入 warnings 而非孤儿。
  const policyVendorKeys = new Set(policy.vendors.map(v => v.vendor_key));
  const parentedBeforeKeys = new Set();
  for (const l2 of snapshot['vendor-level2']) {
    for (const ref of l2.detail_refs || []) parentedBeforeKeys.add(detailKeyOf(ref.id));
  }
  const parentedAfterKeys = new Set();
  for (const l2 of next['vendor-level2']) {
    for (const ref of l2.detail_refs || []) parentedAfterKeys.add(detailKeyOf(ref.id));
  }
  const orphaned = [];
  for (const detail of snapshot['tool-level3']) {
    const key = detailKeyOf(detail.id);
    if (!policyVendorKeys.has(detail.vendor_key)) continue;
    if (parentedBeforeKeys.has(key) && !parentedAfterKeys.has(key)) {
      orphaned.push({ detail: detail.id, vendor_key: detail.vendor_key });
    } else if (!parentedBeforeKeys.has(key) && !parentedAfterKeys.has(key)) {
      warnings.push({ code: 'PRE_EXISTING_UNPARENTED', detail: detail.id, vendor_key: detail.vendor_key });
    }
  }

  // 5. 重写 L1.level2_refs
  for (const l1 of next['vendor-level1']) {
    const vendorTargets = targetIdsByVendor.get(l1.vendor_key);
    const oldRefs = l1.level2_refs || [];
    const nextRefs = [];
    const seen = new Set();
    for (const ref of oldRefs) {
      if (!ref || !ref.id || seen.has(ref.id)) continue;
      if (!next['vendor-level2'].some(x => x.id === ref.id)) continue; // 已重命名/删除
      nextRefs.push({ kind: 'vendor-level2', id: ref.id });
      seen.add(ref.id);
    }
    if (vendorTargets) {
      for (const id of vendorTargets) {
        if (!seen.has(id) && next['vendor-level2'].some(x => x.id === id)) {
          nextRefs.push({ kind: 'vendor-level2', id });
          seen.add(id);
        }
      }
    }
    l1.level2_refs = nextRefs;
    changes.push({ area: 'vendor-level1', id: l1.id, operation: 'replace', note: `重写 level2_refs（${nextRefs.length} 项）` });
  }

  const validation = validateCatalogSnapshot(next);

  return {
    ok: true,
    snapshot: next,
    changes,
    id_map: idMap,
    members_moved: membersMoved,
    removed_level2: removedLevel2,
    orphaned,
    warnings,
    validation,
  };
}

module.exports = { planSeriesMigration };
