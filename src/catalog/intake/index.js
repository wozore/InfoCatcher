'use strict';

const batch = require('./catalog-batch');
const resolution = require('./resolution');
const adapters = require('./catalog-adapters');

module.exports = { ...batch, ...resolution, ...adapters };
