'use strict';

/**
 * identity/index.js — 模型身份与审计子域门面
 */

const modelIdentity = require('./model-identity');
const identityReview = require('./identity-review');
const identityReviewAi = require('./identity-review-ai');
const modelExclusions = require('./model-exclusions');
const emptyModelFilter = require('./empty-model-filter');

module.exports = {
  ...modelIdentity,
  ...identityReview,
  ...identityReviewAi,
  ...modelExclusions,
  ...emptyModelFilter,
};
