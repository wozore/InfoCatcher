'use strict';

/**
 * core/index.js — 模型对比核心管线子域门面
 */

const compareSchema = require('./compare-schema');
const compareStore = require('./compare-store');
const rebuildCanonical = require('./rebuild-canonical');
const rebuildCollector = require('./rebuild-collector');
const rebuildDimensions = require('./rebuild-dimensions');
const rebuildComparison = require('./rebuild-comparison');
const runComparison = require('./run-comparison');

module.exports = {
  ...compareSchema,
  ...compareStore,
  ...rebuildCanonical,
  ...rebuildCollector,
  ...rebuildDimensions,
  ...rebuildComparison,
  ...runComparison,
};
