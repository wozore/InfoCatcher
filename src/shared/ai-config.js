'use strict';

const fs = require('fs');
const { AI_CONFIG_FILES } = require('./paths');
const { getProvider, DEFAULT_PROVIDER_NAME } = require('./ai-provider-registry');

// 默认外部 provider 开关（统一收口在 registry 的 DEFAULT_PROVIDER_NAME）。
// config/catalog-generator.local.json 可按模块覆盖 provider/model/protocol。
const DEFAULT_PROVIDER = getProvider(DEFAULT_PROVIDER_NAME);

const DEFAULT_MODULE_CONFIGS = Object.freeze({
  catalog: Object.freeze({
    enabled: true,
    provider: DEFAULT_PROVIDER_NAME,
    retrieval_provider: 'tavily',
    model: DEFAULT_PROVIDER.defaultModel,
    protocol: DEFAULT_PROVIDER.protocol,
    timeout_ms: 180000,
    max_search_queries: 4,
    max_pages: 8,
    max_responses_calls: 12,
    max_synthesis_calls: 1,
    max_repair_calls: 1,
  }),
  news: Object.freeze({
    enabled: false,
    provider: DEFAULT_PROVIDER_NAME,
    model: DEFAULT_PROVIDER.defaultModel,
    protocol: DEFAULT_PROVIDER.protocol,
  }),
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readAiConfig(filePath = AI_CONFIG_FILES.local) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { modules: {} };
    throw error;
  }
}

function validateModuleConfig(moduleName, config) {
  const provider = getProvider(config.provider);
  if (!provider) {
    throw Object.assign(new Error(`模块 ${moduleName} 使用了不支持的 AI provider: ${config.provider}`), {
      code: 'AI_PROVIDER_UNSUPPORTED',
    });
  }
  if (config.protocol !== provider.protocol) {
    throw Object.assign(new Error(`模块 ${moduleName} 的 protocol=${config.protocol} 与 provider=${config.provider} 不匹配`), {
      code: 'AI_PROTOCOL_MISMATCH',
    });
  }
  if (moduleName === 'catalog' && config.retrieval_provider !== 'tavily') {
    throw Object.assign(new Error(`模块 ${moduleName} 的 retrieval_provider 只支持 tavily`), {
      code: 'RETRIEVAL_PROVIDER_UNSUPPORTED',
    });
  }
  return config;
}

function loadAiModuleConfig(moduleName, filePath = AI_CONFIG_FILES.local) {
  const defaults = clone(DEFAULT_MODULE_CONFIGS[moduleName] || {
    enabled: false,
    provider: DEFAULT_PROVIDER_NAME,
    protocol: DEFAULT_PROVIDER.protocol,
  });
  const raw = readAiConfig(filePath);
  const configured = raw?.modules?.[moduleName];
  const config = {
    ...defaults,
    ...(configured && typeof configured === 'object' ? configured : {}),
  };
  const provider = getProvider(config.provider);
  if (config.protocol === undefined && provider) config.protocol = provider.protocol;
  return validateModuleConfig(moduleName, config);
}

module.exports = {
  DEFAULT_MODULE_CONFIGS,
  readAiConfig,
  loadAiModuleConfig,
  validateModuleConfig,
};
