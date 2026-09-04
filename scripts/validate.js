/**
 * scripts/validate.js — 数据与契约完整性校验入口（薄包装）
 * 先跑零依赖规范门禁 check-standards（违规退出码 1），通过后 require 即运行
 * src/maintenance/validate 的聚合校验（catalog + news + 开发原则门禁），
 * 校验结束由该模块 process.exit(0/1)，供 CI 全部工作流依赖。
 */
'use strict';

const { main: checkStandards } = require('./check-standards');
if (!checkStandards()) process.exit(1);

require('../src/maintenance/validate');
