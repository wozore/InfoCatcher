/**
 * loadCollectorConfig.js —— 热点采集器的 API key 解析（news 域唯一采集 env 读取点）。
 * X_API_KEY / YOUTUBE_API_KEY 只在本文件与 env.js、providers 注册表读取；
 * 采集器经 options 显式传 key（CI secret 注入或本机 .env 加载后生效）。
 */

'use strict';

function xApiKeyOf(options) {
  return (options && options.xApiKey) || process.env.X_API_KEY;
}

function youtubeApiKeyOf(options) {
  return (options && options.apiKey) || process.env.YOUTUBE_API_KEY;
}

module.exports = {
  xApiKeyOf,
  youtubeApiKeyOf,
};
