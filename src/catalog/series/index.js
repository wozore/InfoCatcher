'use strict';

const policy = require('./catalog-series-policy');
const migration = require('./catalog-series-migration');
const placement = require('./catalog-series-placement-ai');

module.exports = { ...policy, ...migration, ...placement };
