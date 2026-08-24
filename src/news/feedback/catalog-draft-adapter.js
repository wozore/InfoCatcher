'use strict';

const { canonicalizeUrl } = require('../../shared/tavily-client');
const { isVagueName } = require('./tool-feedback');

/**
 * 将热点待补工具候选转换为 catalog-generator 的 Seed（schema v3）。
 *
 * 批量生成链路（②→③）用：待补卡 →（厂商/官方源解析）→ 本函数 → seed → 生成器。
 *
 * detail_kind 由候选的 detail_kind_hint 决定：
 *   - 'api_model' → 具体模型（Qwen3.8-Max、Kling 2.6 Pro）
 *   - 缺省/'tool' → 具体工具（Cursor、Suno）
 * 笼统名（可灵、通义千问 等模型家族/平台名）由 isVagueName 拒绝（PENDING_CANDIDATE_VAGUE），
 * 保证批量生成绝不会把笼统名卡写进工具栏。
 *
 * @param {object} candidate 待补工具候选
 *   - name/title    必填：工具名
 *   - vendor_name/vendor_label/vendor_key/tool_key  厂商信息（可选，解析可提供）
 *   - url/official_url                             官方 URL（可选，解析可提供）
 *   - detail_kind_hint                             'api_model' | 'tool'（可选；feedback 层按实体类型填）
 *   - modality                                    api_model 的显式 Profile modality（可选）
 *   - description/source_hotspot/source_url        展示与来源字段
 * @param {object} [resolution] 厂商/官方源解析结果（可省略）
 *   - { vendor_name, official_url }
 * @returns {object} seed：detail_kind/name/vendor_name/official_url/placement/known_fields/discovery_sources
 */
function pendingCandidateToSeed(candidate, resolution = {}) {
  if (!candidate || typeof candidate !== 'object') throw new Error('PENDING_CANDIDATE_INVALID');
  const name = String(candidate.name || candidate.title || '').trim();
  if (!name) throw new Error('PENDING_CANDIDATE_NAME_REQUIRED');
  // 笼统名防御：即使上游漏网，也拒绝转 seed（工具栏不出现笼统名卡）
  if (isVagueName(name)) throw new Error('PENDING_CANDIDATE_VAGUE');
  // 官方 URL 优先级：登记表多 URL official_urls > 登记表单 official_url > 候选自带 url；去重保序，全部作 official_hint。
  const officialUrls = [...new Set([
    ...(Array.isArray(resolution.official_urls) ? resolution.official_urls : []),
    ...(resolution.official_url ? [resolution.official_url] : []),
    ...(candidate.url || candidate.official_url ? [candidate.url || candidate.official_url] : []),
  ].map(canonicalizeUrl).filter(Boolean))];
  const officialUrl = officialUrls[0] || null;
  const vendorName = String(resolution.vendor_name || candidate.vendor_name || candidate.vendor_label || '').trim() || name;
  const discoverySources = officialUrls.map(url => ({ url, kind: 'official_hint' }));
  // official_hint 参与生成器研究信任根（多个可扩展 includeDomains）；无官方域名时回落热点原文链接（hotspot 不进信任根）。
  if (!officialUrl && candidate.source_url) discoverySources.push({ url: candidate.source_url, kind: 'hotspot' });
  const placement = {
    existing_level2_ref: candidate.placement?.existing_level2_ref || null,
    ...(candidate.placement?.existing_level1_ref ? { existing_level1_ref: candidate.placement.existing_level1_ref } : {}),
    ...(candidate.placement?.new_group_title ? { new_group_title: candidate.placement.new_group_title } : {}),
  };
  return {
    detail_kind: candidate.detail_kind_hint === 'api_model' ? 'api_model' : 'tool',
    name,
    vendor_name: vendorName,
    vendor_key: candidate.vendor_key || null,
    tool_key: candidate.tool_key || null,
    ...(candidate.modality ? { modality: candidate.modality } : {}),
    official_url: officialUrl,
    placement,
    known_fields: {
      summary: candidate.description || '',
      source_hotspot: candidate.source_hotspot === true,
    },
    discovery_sources: discoverySources,
  };
}

module.exports = { pendingCandidateToSeed };
