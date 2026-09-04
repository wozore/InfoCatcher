'use strict';

const contract = require('./catalog-contract');
const validator = require('./catalog-snapshot-validator');
const snapshotStore = require('./catalog-snapshot-store');
const revision = require('./catalog-revision');
const profile = require('./catalog-profile-contract');
const completeness = require('./catalog-record-completeness');
const builders = require('./catalog-record-builders');
const changePlanner = require('./catalog-change-planner');
const research = require('./catalog-research');
const synthesis = require('./catalog-synthesis');
const synthesisPrompt = require('./catalog-synthesis-prompt');
const synthesisAi = require('./deepseek-catalog-ai');

module.exports = {
  ...contract,
  ...validator,
  ...snapshotStore,
  ...revision,
  ...profile,
  ...completeness,
  ...builders,
  ...changePlanner,
  ...research,
  ...synthesis,
  ...synthesisPrompt,
  ...synthesisAi,
};
