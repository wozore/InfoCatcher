'use strict';

const { AI_PROTOCOLS } = require('./protocols');

const openai = Object.freeze({
  name: 'openai',
  label: 'OpenAI',
  protocol: AI_PROTOCOLS.RESPONSES,
  apiKeyEnv: 'OPENAI_API_KEY',
  responsesEndpoint: 'https://api.openai.com/v1/responses',
  chatEndpoint: 'https://api.openai.com/v1/chat/completions',
  defaultModel: null,
});

module.exports = openai;
