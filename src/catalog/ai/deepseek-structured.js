'use strict';

/**
 * deepseek-structured.js —— 向后兼容 re-export shim。
 * 所有多协议路由、JSON 提取、预算预占与诊断能力均已收拢至 src/shared/llm-gateway.js。
 * 业务消费者无需修改。
 */

const gateway = require('../../shared/llm-gateway');

module.exports = {
  extractJsonValues: gateway.extractJsonValues,
  diagnosticsOf: gateway.diagnosticsOf,
  toExternalChatPayload: gateway.toExternalChatPayload,
  requestStructuredJson: gateway.requestStructuredJson,
};
