'use strict';

const { AI_PROTOCOLS } = require('./protocols');

const deepseek = Object.freeze({
  name: 'deepseek',
  label: 'DeepSeek',
  protocol: AI_PROTOCOLS.RESPONSES,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  responsesEndpoint: 'https://api.deepseek.com/responses',
  chatEndpoint: 'https://api.deepseek.com/chat/completions',
  defaultModel: 'deepseek-v4-flash',
});

module.exports = { deepseek };
