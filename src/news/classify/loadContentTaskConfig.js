/**
 * loadContentTaskConfig.js —— 内容加工任务的 provider/model 配置解析（news 域唯一 env 读取点）。
 *
 * 收口 classify / summarize / review / localize 四个任务的
 * KNOWVIEW_*_PROVIDER、KNOWVIEW_*_MODEL 与 INFOCATCHER_*_PROVIDER、INFOCATCHER_*_MODEL
 * 环境变量读取（信息获取软件时期的旧变量名继续生效），业务模块经本模块取值，
 * 保证 process.env 直读只出现在 env.js、providers 注册表与 load*Config 文件。
 */

'use strict';

function providerEnvNames(task) {
  return [`KNOWVIEW_${task}_PROVIDER`, `INFOCATCHER_${task}_PROVIDER`];
}

function modelEnvNames(task) {
  return [`KNOWVIEW_${task}_MODEL`, `INFOCATCHER_${task}_MODEL`];
}

/** provider 解析：options.provider 优先，其次环境变量；都缺省时回退 fallback。 */
function providerOf(task, options, fallback) {
  if (options && options.provider) return options.provider;
  const names = providerEnvNames(task);
  return process.env[names[0]] || process.env[names[1]] || fallback;
}

/** model 解析：options.model 优先，其次环境变量；都缺省时 undefined（由调用方决定兜底）。 */
function modelOf(task, options) {
  if (options && options.model) return options.model;
  const names = modelEnvNames(task);
  return process.env[names[0]] || process.env[names[1]];
}

module.exports = {
  providerOf,
  modelOf,
};
