'use strict';

/**
 * fetch/index.js — 模型对比数据源抓取子域门面
 */

const compareHttp = require('./compare-http');
const fetchOpenRouter = require('./fetch-openrouter');
const fetchLivebench = require('./fetch-livebench');
const fetchLlmStats = require('./fetch-llm-stats');
const fetchLmarena = require('./fetch-lmarena');

module.exports = {
  ...compareHttp,
  ...fetchOpenRouter,
  ...fetchLivebench,
  ...fetchLlmStats,
  ...fetchLmarena,
};
