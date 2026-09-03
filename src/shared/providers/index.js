'use strict';

const { AI_PROTOCOLS } = require('./protocols');
const zhipu = require('./zhipu');
const deepseek = require('./deepseek');
const local = require('./local');
const openai = require('./openai');
const anthropic = require('./anthropic');

const AI_PROVIDERS = Object.freeze({
  zhipu,
  deepseek,
  local,
  openai,
  anthropic,
});

// ═══════════════════════════════════════════════════════════════
// 外部 provider 全局开关：所有模块的默认外部 AI 供应商都收敛到这一个常量。
// 切换回 DeepSeek 等其它 provider 只需改这里（或经
// config/catalog-generator.local.json / 环境变量按模块覆盖）。
// ═══════════════════════════════════════════════════════════════
const DEFAULT_PROVIDER_NAME = 'zhipu';

function getProvider(name = DEFAULT_PROVIDER_NAME) {
  return AI_PROVIDERS[name] || null;
}

function resolveProvider(name = DEFAULT_PROVIDER_NAME) {
  const provider = getProvider(name);
  if (!provider) {
    return { ok: false, code: 'AI_PROVIDER_UNSUPPORTED', error: `不支持的 AI provider: ${name}` };
  }
  return { ok: true, provider };
}

function apiKeyForProvider(provider, explicitApiKey) {
  if (!provider || !provider.apiKeyEnv) {
    return explicitApiKey || 'local';
  }
  return explicitApiKey ?? process.env[provider.apiKeyEnv];
}

module.exports = {
  AI_PROTOCOLS,
  AI_PROVIDERS,
  DEFAULT_PROVIDER_NAME,
  getProvider,
  resolveProvider,
  apiKeyForProvider,
};
