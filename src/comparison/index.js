'use strict';

/**
 * comparison/index.js — 模型对比域统一聚合门面
 */

const fetch = require('./fetch');
const identity = require('./identity');
const series = require('./series');
const core = require('./core');

module.exports = {
  ...fetch,
  ...identity,
  ...series,
  ...core,
  fetch,
  identity,
  series,
  core,
};
