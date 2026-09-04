'use strict';

/**
 * model-identity.js — 模型身份解析（纯逻辑）
 *
 * 以 source raw 名称和人工登记表为输入，稳定区分模型实体、服务方式与评测挡位。
 * 不依据 display 合并记录：无法安全判断时保留原身份，避免把不同模型的分数混在一起。
 */

const SOURCE_KEYS = ['openrouter', 'lmarena', 'livebench', 'llm_stats'];
const OFFERING_SUFFIXES = new Set(['batch', 'free', 'fast', 'latest']);
const DEGREE_SUFFIXES = new Set(['high', 'low', 'medium', 'xhigh', 'auto', 'max']);
const EVALUATION_PROFILES = new Set(['codex-harness']);

const DEFAULT_VENDOR_ALIASES = Object.freeze({
  qwen: 'qwen',
  alibaba: 'qwen',
  alibabacloud: 'qwen',
  mistral: 'mistral',
  mistralai: 'mistral',
  zai: 'zai',
  'z-ai': 'zai',
  'zai-org': 'zai',
  zhipu: 'zai',
  zhipuai: 'zai',
  moonshot: 'moonshotai',
  moonshotai: 'moonshotai',
  kuaishou: 'kling',
  kling: 'kling',
  xunfei: 'xunfei',
  iflytek: 'xunfei',
});

const FAMILY_VENDOR_PREFIXES = Object.freeze([
  ['claude-', 'anthropic'], ['gpt-', 'openai'], ['chatgpt-', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4-', 'openai'],
  ['gemini-', 'google'], ['gemma-', 'google'], ['deepseek-', 'deepseek'], ['qwen', 'qwen'], ['glm-', 'zai'],
  ['kimi-', 'moonshotai'], ['mistral-', 'mistral'], ['ministral-', 'mistral'], ['codestral-', 'mistral'], ['magistral-', 'mistral'],
  ['grok-', 'xai'], ['minimax-', 'minimax'], ['mimo-', 'xiaomi'], ['hunyuan-', 'tencent'], ['hy3', 'tencent'],
  ['ernie-', 'baidu'], ['spark-', 'xunfei'], ['step-', 'stepfun'], ['step3-', 'stepfun'], ['longcat-', 'meituan'],
  ['llama-', 'meta'], ['muse-', 'meta'], ['command-', 'cohere'], ['nemotron-', 'nvidia'], ['kling-', 'kling'],
]);

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeVendor(value, vendorAliases = {}) {
  const key = slugify(value);
  const aliases = { ...DEFAULT_VENDOR_ALIASES, ...vendorAliases };
  return aliases[key] || key;
}

function inferVendorFromIdentity(identity) {
  const normalized = String(identity || '').toLowerCase();
  const found = FAMILY_VENDOR_PREFIXES.find(([prefix]) => normalized.startsWith(prefix));
  return found ? found[1] : null;
}

function vendorAliasesOf(registry = {}) {
  const aliases = {};
  for (const [canonical, values] of Object.entries(registry.vendor_aliases || {})) {
    const vendor = normalizeVendor(canonical);
    for (const value of Array.isArray(values) ? values : []) aliases[slugify(value)] = vendor;
    aliases[slugify(canonical)] = vendor;
  }
  return aliases;
}

/** 原始名中可安全移除的发布日期形式；返回纯日期 token，未命中则 null。 */
function extractRevision(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/(?:^|[-_\s])((?:20\d{2}|19\d{2})-\d{2}-\d{2}|(?:20\d{2}|19\d{2})\d{4}|(?:20\d{2}|19\d{2})-\d{2}|(?:20\d{2}|19\d{2})\d{2}|\d{4}|\d{2}-\d{4}|\d{2}-\d{2}-\d{2}|\d{2}-\d{2})(?=[-_\s:]|$)/);
  return match ? match[1] : null;
}

function stripRevision(raw) {
  return String(raw || '')
    .replace(/[-_\s](?:20\d{2}|19\d{2})-\d{2}-\d{2}(?=[-_\s:)\)]|$)/g, '')
    .replace(/[-_\s](?:20\d{2}|19\d{2})\d{4}(?=[-_\s:)\)]|$)/g, '')
    .replace(/[-_\s](?:20\d{2}|19\d{2})-\d{2}(?=[-_\s:)\)]|$)/g, '')
    .replace(/[-_\s](?:20\d{2}|19\d{2})\d{2}(?=[-_\s:)\)]|$)/g, '')
    .replace(/[-_\s]\d{2}-\d{4}(?=[-_\s:)\)]|$)/g, '')
    .replace(/[-_\s]\d{2}-\d{2}-\d{2}(?=[-_\s:)\)]|$)/g, '')
    .replace(/[-_\s]\d{2}-\d{2}(?=[-_\s:)\)]|$)/g, '')
    .replace(/[-_\s]\d{4}(?=[-_\s:)\)]|$)/g, '');
}

/** 仅把相邻的纯数字版本片段统一为点号；8b/235b/A22B 等规格不会命中。 */
function normalizeVersionSeparators(identity) {
  return String(identity || '').replace(/(\d+)-(\d+)(?=-|$)/g, '$1.$2');
}

function removeTerminalOfferings(identity) {
  let value = String(identity || '');
  const offerings = [];
  while (true) {
    const match = /-(batch|free|fast|latest)$/.exec(value);
    if (!match) break;
    offerings.unshift(match[1]);
    value = value.slice(0, match.index);
  }
  return { identity: value, offerings };
}

function removeTerminalDegree(identity) {
  const match = /-(high|low|medium|xhigh|auto|max)(?:-effort)?$/.exec(String(identity || ''));
  return match ? String(identity).slice(0, match.index) : String(identity || '');
}

function degreeOf(value) {
  const match = /^(high|low|medium|xhigh|auto|max)(?:-effort)?$/i.exec(String(value || '').trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * 拆分仅属于评测记录的语义层。未知括号 token 被保留进模型名，并暴露给离线审计；
 * 绝不因未知 token 自动与其他模型合并。
 */
function parseModelNameMetadata(source, rawName) {
  let modelName = splitSourceName(source, rawName).modelName.trim();
  const annotations = [];
  let match;
  while ((match = /\s*\(([^()]+)\)\s*$/.exec(modelName))) {
    annotations.unshift(match[1].trim());
    modelName = modelName.slice(0, match.index).trim();
  }

  let degree = null;
  let evaluationProfile = null;
  const ambiguousTokens = [];
  for (const annotation of annotations) {
    const normalized = slugify(annotation);
    const annotationDegree = degreeOf(normalized);
    if ((source === 'lmarena' || source === 'livebench') && annotationDegree && !degree) {
      degree = annotationDegree;
      continue;
    }
    if ((source === 'lmarena' || source === 'livebench') && EVALUATION_PROFILES.has(normalized) && !evaluationProfile) {
      evaluationProfile = normalized;
      continue;
    }
    if (extractRevision(`model-${normalized}`) === normalized) {
      modelName = `${modelName}-${normalized}`;
      continue;
    }
    // 不是评测元数据的括号词仍是模型名的一部分（例如 thinking、nano-banana）。
    modelName = `${modelName}-${normalized}`;
    ambiguousTokens.push(normalized);
  }

  if (source === 'lmarena' || source === 'livebench') {
    const normalized = slugify(modelName);
    const degreeMatch = /-(high|low|medium|xhigh|auto|max)(?:-effort)?$/.exec(normalized);
    if (degreeMatch) {
      modelName = normalized.slice(0, degreeMatch.index);
      degree = degree || degreeMatch[1].toLowerCase();
    } else {
      modelName = normalized;
    }
  }

  return Object.freeze({
    model_name: modelName,
    degree,
    evaluation_profile: evaluationProfile,
    ambiguous_tokens: ambiguousTokens,
  });
}

function splitSourceName(source, rawName) {
  const raw = String(rawName || '').trim();
  if (source === 'openrouter') {
    const slash = raw.lastIndexOf('/');
    return {
      vendorHint: slash > 0 ? raw.slice(0, slash) : null,
      modelName: slash > 0 ? raw.slice(slash + 1) : raw,
    };
  }
  return { vendorHint: null, modelName: raw };
}

function aliasMapOf(registry = {}) {
  const result = Object.fromEntries(SOURCE_KEYS.map(source => [source, new Map()]));
  for (const entry of registry.entries || []) {
    const modelKey = entry.model_key || entry.canonical;
    if (!modelKey) continue;
    for (const source of SOURCE_KEYS) {
      for (const raw of entry.aliases?.[source] || []) {
        const key = String(raw).trim().toLowerCase();
        if (!key) continue;
        const previous = result[source].get(key);
        if (previous && previous !== modelKey) {
          throw new Error(`别名冲突：${source}:${raw} 同时映射到 ${previous} 与 ${modelKey}`);
        }
        result[source].set(key, { ...entry, model_key: modelKey });
      }
    }
  }
  return result;
}

function identityFromModelKey(modelKey) {
  const text = String(modelKey || '');
  const marker = text.indexOf('--');
  return marker >= 0 ? text.slice(marker + 2) : text;
}

function vendorFromModelKey(modelKey) {
  const marker = String(modelKey || '').indexOf('--');
  return marker >= 0 ? String(modelKey).slice(0, marker) : null;
}

function toWords(value) {
  return String(value || '')
    .split('-')
    .filter(Boolean)
    .map(token => {
      if (/^gpt$/i.test(token)) return 'GPT';
      if (/^glm$/i.test(token)) return 'GLM';
      if (/^vl$/i.test(token)) return 'VL';
      if (/^moe$/i.test(token)) return 'MoE';
      if (/^\d+(?:\.\d+)?b$/i.test(token)) return token.toUpperCase();
      if (/^[ae]\d+b$/i.test(token)) return token.toUpperCase();
      if (/^\d+x\d+b$/i.test(token)) return token.toUpperCase();
      if (/^\d/.test(token)) return token;
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(' ');
}

/**
 * 将姓名来源转成唯一且可对比的模型身份。
 * @param {{source: string, rawName: string, vendorHint?: string, registry?: object}} input
 */
function resolveModelIdentity({ source, rawName, vendorHint = null, registry = {}, aliasMaps = null }) {
  if (!SOURCE_KEYS.includes(source)) throw new Error(`未知模型源：${source}`);
  const aliases = aliasMaps || aliasMapOf(registry);
  const rawKey = String(rawName || '').trim().toLowerCase();
  const alias = aliases[source].get(rawKey);
  const sourceName = splitSourceName(source, rawName);
  const metadata = parseModelNameMetadata(source, rawName);
  const resolvedVendor = normalizeVendor(
    alias?.vendor || vendorHint || sourceName.vendorHint || vendorFromModelKey(alias?.model_key),
    vendorAliasesOf(registry),
  );

  if (alias) {
    const modelKey = alias.model_key;
    return Object.freeze({
      model_key: modelKey,
      vendor: normalizeVendor(alias.vendor || vendorFromModelKey(modelKey) || resolvedVendor, vendorAliasesOf(registry)),
      identity: identityFromModelKey(modelKey),
      family: alias.family || identityFromModelKey(modelKey).split('-').slice(0, 2).join('-'),
      revision: alias.revision || extractRevision(metadata.model_name),
      offerings: Array.isArray(alias.offerings) ? [...alias.offerings] : [],
      degree: metadata.degree,
      evaluation_profile: metadata.evaluation_profile,
      ambiguous_tokens: metadata.ambiguous_tokens,
      display: alias.display || toWords(identityFromModelKey(modelKey)),
      kind: 'model',
      matched_alias: true,
    });
  }

  const revision = extractRevision(metadata.model_name);
  const withoutDate = stripRevision(metadata.model_name);
  const normalized = normalizeVersionSeparators(slugify(withoutDate));
  const offeringResult = removeTerminalOfferings(normalized);
  const identity = offeringResult.identity;
  const vendor = resolvedVendor || inferVendorFromIdentity(identity) || 'unknown';
  const modelKey = `${vendor}--${identity}`;
  const tokens = identity.split('-').filter(Boolean);
  const family = tokens.slice(0, Math.min(tokens.length, 2)).join('-') || identity;
  const kind = !identity ? 'ambiguous' : 'model';
  return Object.freeze({
    model_key: modelKey,
    vendor,
    identity,
    family,
    revision,
    offerings: offeringResult.offerings,
    degree: metadata.degree,
    evaluation_profile: metadata.evaluation_profile,
    ambiguous_tokens: metadata.ambiguous_tokens,
    display: toWords(identity),
    kind,
    matched_alias: false,
  });
}

function createModelIdentityResolver(registry = {}) {
  const aliasMaps = aliasMapOf(registry);
  return input => resolveModelIdentity({ ...input, registry, aliasMaps });
}

function normalizedDisplayKey(value) {
  return slugify(value).replace(/\./g, '-');
}

module.exports = {
  SOURCE_KEYS,
  slugify,
  normalizeVendor,
  stripRevision,
  normalizeVersionSeparators,
  removeTerminalOfferings,
  parseModelNameMetadata,
  createModelIdentityResolver,
  resolveModelIdentity,
  normalizedDisplayKey,
};
