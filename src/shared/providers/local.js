'use strict';

const { AI_PROTOCOLS } = require('./protocols');

const local = Object.freeze({
  name: 'local',
  label: 'Local Bonsai',
  protocol: AI_PROTOCOLS.CHAT,
  apiKeyEnv: null,
  chatEndpoint: 'http://127.0.0.1:8080/v1/chat/completions',
  defaultModel: 'bonsai',
});

module.exports = local;
