'use strict';

const AI_PROTOCOLS = Object.freeze({
  RESPONSES: 'responses',
  MESSAGES: 'messages',
});

const AI_PROVIDERS = Object.freeze({
  deepseek: Object.freeze({
    name: 'deepseek',
    label: 'DeepSeek',
    protocol: AI_PROTOCOLS.RESPONSES,
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    responsesEndpoint: 'https://api.deepseek.com/responses',
    defaultModel: 'deepseek-v4-flash',
  }),
  openai: Object.freeze({
    name: 'openai',
    label: 'OpenAI',
    protocol: AI_PROTOCOLS.RESPONSES,
    apiKeyEnv: 'OPENAI_API_KEY',
    responsesEndpoint: 'https://api.openai.com/v1/responses',
    defaultModel: null,
  }),
  anthropic: Object.freeze({
    name: 'anthropic',
    label: 'Anthropic',
    protocol: AI_PROTOCOLS.MESSAGES,
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    messagesEndpoint: 'https://api.anthropic.com/v1/messages',
    defaultModel: null,
    implemented: false,
  }),
});

function getProvider(name = 'deepseek') {
  return AI_PROVIDERS[name] || null;
}

function resolveProvider(name = 'deepseek') {
  const provider = getProvider(name);
  if (!provider) {
    return { ok: false, code: 'AI_PROVIDER_UNSUPPORTED', error: `不支持的 AI provider: ${name}` };
  }
  return { ok: true, provider };
}

function apiKeyForProvider(provider, explicitApiKey) {
  return explicitApiKey ?? process.env[provider.apiKeyEnv];
}

module.exports = {
  AI_PROTOCOLS,
  AI_PROVIDERS,
  getProvider,
  resolveProvider,
  apiKeyForProvider,
};
