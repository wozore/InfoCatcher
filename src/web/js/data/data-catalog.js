/**
 * data-catalog.js — 五模块目录数据查询
 * 封装 catalog-interface.js 领域查询接口。
 */

import { catalog } from './catalog-interface.js';

export function getCatalogItems(area) {
  const result = catalog({ area, operation: 'list' });
  return result.ok ? result.data : [];
}

export function getVendorCardItems() {
  return getCatalogItems('vendor-card');
}

export function getVendorCardItem(vendorKey) {
  return getVendorCardItems().find(item => item.vendor_key === vendorKey) || null;
}

export function getToolCardItems() {
  return [...getCatalogItems('tool-card')];
}

export function getToolCardItem(toolKey, itemKey = null) {
  if (itemKey) return getToolCardItems().find(item => item.vendor_key === toolKey && item.tool_key === itemKey) || null;
  return getToolCardItems().find(item => item.tool_key === toolKey) || null;
}

export function getVendorLevel1Item(vendorKey) {
  return getCatalogItems('vendor-level1').find(item => item.vendor_key === vendorKey) || null;
}

export function getVendorLevel2Item(vendorKey, groupKey) {
  const items = getCatalogItems('vendor-level2');
  return items.find(item => item.vendor_key === vendorKey && item.id === groupKey) || null;
}

export function getVendorLevel2Items(vendorKey) {
  return getCatalogItems('vendor-level2').filter(item => item.vendor_key === vendorKey);
}

export function getToolLevel3Item(vendorKey, itemKey) {
  if (itemKey && String(itemKey).startsWith('tool-level3:')) {
    return getCatalogItems('tool-level3').find(item => item.id === itemKey) || null;
  }
  const items = getCatalogItems('tool-level3');
  return items.find(item => item.vendor_key === vendorKey && item.id === itemKey) || items.find(item => item.id === `tool-level3:${itemKey}`) || null;
}

export function getToolSearchText(tool) {
  const detail = tool.detail_ref ? getCatalogItems('tool-level3').find(item => item.id === tool.detail_ref.id) : null;
  return [
    tool.title,
    tool.vendor_label,
    ...(tool.search_terms || []),
    ...(tool.scenes || []),
    detail?.summary,
    ...(detail?.applicable_scenarios || []).flatMap(scene => [scene.title, scene.description]),
    ...(detail?.inapplicable_scenarios || []).flatMap(scene => [scene.title, scene.description])
  ].filter(Boolean).join(' ').toLowerCase();
}
