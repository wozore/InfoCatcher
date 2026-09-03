'use strict';

const { AI_PROTOCOLS } = require('./protocols');

const anthropic = Object.freeze({
  name: 'anthropic',
  label: 'Anthropic',
  protocol: AI_PROTOCOLS.MESSAGES,
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  messagesEndpoint: 'https://api.anthropic.com/v1/messages',
  defaultModel: null,
  implemented: false,
});

module.exports = anthropic;
