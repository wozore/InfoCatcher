'use strict';

const AI_PROTOCOLS = Object.freeze({
  RESPONSES: 'responses',
  MESSAGES: 'messages',
  CHAT: 'chat', // OpenAI 兼容 chat/completions（本地 llama-server 或其它兼容端点）
});

module.exports = {
  AI_PROTOCOLS,
};
