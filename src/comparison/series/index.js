'use strict';

/**
 * series/index.js — 模型系列与日期子域门面
 */

const modelSeries = require('./model-series');
const releaseDate = require('./release-date');
const revisionDate = require('./revision-date');

module.exports = {
  ...modelSeries,
  ...releaseDate,
  ...revisionDate,
};
