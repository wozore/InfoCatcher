'use strict';

const fs = require('fs');
const { COMPARISON_FILES } = require('../shared/paths');

function readSeriesConfig(file = COMPARISON_FILES.modelSeries) {
  if (!file || !fs.existsSync(file)) return { schema_version: 1, series: [] };
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { schema_version: 1, series: [] };
}

function words(value) {
  return String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function prefixLengthsOf(rule) {
  if (Array.isArray(rule.identity_prefixes) && rule.identity_prefixes.length) {
    return rule.identity_prefixes.map(prefix => String(prefix).length);
  }
  if (rule.identity_prefix) return [String(rule.identity_prefix).length];
  return [];
}

function matchesRule(model, rule = {}) {
  if (rule.vendor && String(rule.vendor).toLowerCase() !== String(model.vendor || '').toLowerCase()) return false;
  const identity = String(model.identity || '').toLowerCase();
  if (rule.identity && identity !== String(rule.identity).toLowerCase()) return false;
  const prefixes = prefixLengthsOf(rule).length
    ? (Array.isArray(rule.identity_prefixes) ? rule.identity_prefixes : [rule.identity_prefix])
    : [];
  if (prefixes.length && !prefixes.some(prefix => identity.startsWith(String(prefix).toLowerCase()))) return false;
  return Boolean(rule.identity || prefixes.length || rule.vendor);
}

function sortedRules(rules) {
  return [...(rules || [])].sort((a, b) => {
    const aRule = a.match || a;
    const bRule = b.match || b;
    const aMax = Math.max(...prefixLengthsOf(aRule), 0);
    const bMax = Math.max(...prefixLengthsOf(bRule), 0);
    return bMax - aMax;
  });
}

function seriesDefinitionFor(model, config) {
  const definitions = config.series || [];
  return sortedRules(definitions.map(definition => ({ ...definition, _definition: definition })))
    .find(definition => (definition.match ? matchesRule(model, definition.match) : matchesRule(model, definition)))?._definition || null;
}

function seriesInfoFor(model, config = {}) {
  const definition = seriesDefinitionFor(model, config);
  if (definition) {
    return {
      series_key: definition.series_key,
      series_display: definition.display,
      series_order: Number.isFinite(definition.order) ? definition.order : 9999,
      vendor: definition.vendor || model.vendor || 'unknown',
      theme: definition.theme || model.theme || 'general',
      definition,
    };
  }
  const family = String(model.family || model.identity || model.canonical || 'unknown');
  const vendor = String(model.vendor || 'unknown');
  return {
    series_key: `${vendor}--${family}`,
    series_display: words(family),
    series_order: 9999,
    vendor,
    theme: model.theme || 'general',
    definition: null,
  };
}

function memberInfoFor(model, seriesInfo) {
  const definition = seriesInfo.definition;
  const rules = sortedRules(definition?.member_rules || []);
  const rule = rules.find(item => matchesRule(model, item));
  const identity = String(model.identity || model.canonical || 'unknown');
  const memberKey = `${model.vendor || 'unknown'}--${identity}`;
  const baseDisplay = String(model.display || identity).replace(/\s*\([^)]*\)\s*$/, '').trim();
  return {
    member_key: memberKey,
    member_display: rule?.display || (identity === definition?.base_identity ? definition.base_display : baseDisplay),
    member_order: Number.isFinite(rule?.order) ? rule.order : 9999,
  };
}

function revisionOf(model) {
  return Array.isArray(model.revisions) && model.revisions.length ? model.revisions.join(', ') : null;
}

function variantSort(a, b) {
  if (a.revision == null && b.revision != null) return -1;
  if (a.revision != null && b.revision == null) return 1;
  return String(b.revision || '').localeCompare(String(a.revision || ''), 'en');
}

// member 主题：无主变体时取变体主题众数（并列偏 general，防数据不全的 revision 误分类通用 LLM）
function memberThemeMajority(member) {
  const counts = new Map();
  for (const variant of member.variants) {
    const theme = (member.themeByCanonical && member.themeByCanonical[variant.canonical]) || 'general';
    counts.set(theme, (counts.get(theme) || 0) + 1);
  }
  let best = 'general';
  let bestCount = -1;
  for (const [theme, count] of counts) {
    if (count > bestCount || (count === bestCount && theme === 'general')) {
      best = theme;
      bestCount = count;
    }
  }
  return best;
}

function attachSeriesMetadata(models, config = {}) {
  const groups = new Map();
  const byCanonical = new Map();
  for (const model of models || []) {
    const series = seriesInfoFor(model, config);
    const member = memberInfoFor(model, series);
    Object.assign(model, {
      series_key: series.series_key,
      series_display: series.series_display,
      member_key: member.member_key,
      member_display: member.member_display,
      member_order: member.member_order,
    });
    byCanonical.set(model.canonical, { model, series, member });
    const seriesGroup = groups.get(series.series_key) || {
      series_key: series.series_key,
      display: series.series_display,
      vendor: series.vendor,
      theme: series.theme,
      order: series.series_order,
      members: new Map(),
    };
    const memberGroup = seriesGroup.members.get(member.member_key) || {
      member_key: member.member_key,
      display: member.member_display,
      order: member.member_order,
      variants: [],
      themeByCanonical: {},
    };
    memberGroup.variants.push({
      canonical: model.canonical,
      display: model.display,
      revision: revisionOf(model),
      composite_score: model.composite?.score ?? null,
      sources: Object.keys(model.source_names || {}),
    });
    memberGroup.themeByCanonical[model.canonical] = model.theme || 'general';
    seriesGroup.members.set(member.member_key, memberGroup);
    groups.set(series.series_key, seriesGroup);
  }

  const series = [...groups.values()].map(group => {
    const members = [...group.members.values()].map(member => {
      member.variants.sort(variantSort);
      const preferred = member.variants.find(variant => variant.revision == null);
      const theme = preferred
        ? ((member.themeByCanonical && member.themeByCanonical[preferred.canonical]) || 'general')
        : memberThemeMajority(member);
      return {
        member_key: member.member_key,
        display: member.display,
        order: member.order,
        default_canonical: (preferred || member.variants[0]).canonical,
        variant_count: member.variants.length,
        variants: member.variants,
        theme,
      };
    }).sort((a, b) => a.order - b.order || a.display.localeCompare(b.display, 'zh-CN'));
    const scores = members.flatMap(member => member.variants.map(variant => variant.composite_score).filter(Number.isFinite));
    return {
      series_key: group.series_key,
      display: group.display,
      vendor: group.vendor,
      theme: group.theme,
      order: group.order,
      member_count: members.length,
      model_count: members.reduce((sum, member) => sum + member.variant_count, 0),
      max_composite_score: scores.length ? Math.max(...scores) : null,
      members,
    };
  }).sort((a, b) => b.max_composite_score - a.max_composite_score || a.order - b.order || a.display.localeCompare(b.display, 'zh-CN'));

  const memberMeta = new Map();
  for (const group of series) {
    for (const member of group.members) {
      for (const variant of member.variants) memberMeta.set(variant.canonical, { group, member });
    }
  }
  return { series, memberMeta, byCanonical };
}

function validateSeriesProjection(series, models) {
  const modelKeys = new Set((models || []).map(model => model.canonical));
  const ownership = new Map();
  const errors = [];
  for (const group of series || []) {
    if (!group.series_key || !group.display || !Array.isArray(group.members) || !group.members.length) {
      errors.push(`系列 ${group.series_key || '<missing>'} 为空或结构无效`);
      continue;
    }
    for (const member of group.members) {
      if (!member.member_key || !Array.isArray(member.variants) || !member.variants.length) {
        errors.push(`系列 ${group.series_key} 含空成员`);
        continue;
      }
      if (!modelKeys.has(member.default_canonical)) errors.push(`系列 ${group.series_key} 默认成员 ${member.default_canonical} 不存在`);
      for (const variant of member.variants) {
        if (!modelKeys.has(variant.canonical)) errors.push(`系列 ${group.series_key} 引用了不存在模型 ${variant.canonical}`);
        const previous = ownership.get(variant.canonical);
        if (previous && previous !== group.series_key) errors.push(`模型 ${variant.canonical} 同时属于 ${previous} 与 ${group.series_key}`);
        ownership.set(variant.canonical, group.series_key);
      }
    }
  }
  if (ownership.size !== modelKeys.size) {
    for (const canonical of modelKeys) if (!ownership.has(canonical)) errors.push(`模型 ${canonical} 未归入任何系列`);
  }
  return errors;
}

module.exports = {
  readSeriesConfig,
  seriesInfoFor,
  memberInfoFor,
  attachSeriesMetadata,
  validateSeriesProjection,
};
