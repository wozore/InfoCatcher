'use strict';

const { canonicalizeUrl } = require('../../shared/tavily-client');

/**
 * 将热点待补工具候选转换为 catalog-generator 的 Seed（schema v3）。
 *
 * 批量生成链路（②→③）用：待补卡 →（厂商/官方源解析）→ 本函数 → seed → 生成器。
 *
 * @param {object} candidate 待补工具候选
 *   - name/title    必填：工具名
 *   - vendor_name/vendor_label/vendor_key/tool_key  厂商信息（可选，解析可提供）
 *   - url/official_url                             官方 URL（可选，解析可提供）
 *   - description/source_hotspot/source_url        展示与来源字段
 * @param {object} [resolution] 厂商/官方源解析结果（可省略）
 *   - { vendor_name, official_url }
 * @returns {object} seed：detail_kind/name/vendor_name/official_url/placement/known_fields/discovery_sources
 */
function pendingCandidateToSeed(candidate, resolution = {}) {
  if (!candidate || typeof candidate !== 'object') throw new Error('PENDING_CANDIDATE_INVALID');
  const name = String(candidate.name || candidate.title || '').trim();
  if (!name) throw new Error('PENDING_CANDIDATE_NAME_REQUIRED');
  const officialUrl = canonicalizeUrl(resolution.official_url || candidate.url || candidate.official_url || '') || null;
  const vendorName = String(resolution.vendor_name || candidate.vendor_name || candidate.vendor_label || '').trim() || name;
  const discoverySources = [];
  // official_hint 参与生成器研究信任根；无官方域名时回落热点原文链接（hotspot 不进信任根）。
  if (officialUrl) discoverySources.push({ url: officialUrl, kind: 'official_hint' });
  else if (candidate.source_url) discoverySources.push({ url: candidate.source_url, kind: 'hotspot' });
  return {
    detail_kind: 'tool',
    name,
    vendor_name: vendorName,
    vendor_key: candidate.vendor_key || null,
    tool_key: candidate.tool_key || null,
    official_url: officialUrl,
    // Q-A 决策：不设 new_group_title，deriveKeys 回退 seed.name 作二级分组名（匹配"GPT-5.6"家族组约定）。
    placement: { existing_level2_ref: null },
    known_fields: {
      summary: candidate.description || '',
      source_hotspot: candidate.source_hotspot === true,
    },
    discovery_sources: discoverySources,
  };
}

module.exports = { pendingCandidateToSeed };
