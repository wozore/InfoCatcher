/**
 * scripts/validate.js — 数据与契约完整性校验入口（薄包装）
 * require 即运行 src/maintenance/validate 的聚合校验（catalog + news + 开发原则门禁），
 * 校验结束由该模块 process.exit(0/1)，供 CI 三处工作流依赖。
 */
'use strict';

require('../src/maintenance/validate');
