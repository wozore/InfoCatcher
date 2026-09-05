'use strict';

const { AI_PROTOCOLS } = require('./protocols');

const zhipu = Object.freeze({
  name: 'zhipu',
  label: 'ZhipuAI',
  protocol: AI_PROTOCOLS.MESSAGES,
  apiKeyEnv: 'ZHIPU_API_KEY',
  messagesEndpoint: 'https://open.bigmodel.cn/api/anthropic/v1/messages',
  chatEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  defaultModel: 'glm-5.3-flash',
});

module.exports = { zhipu };
