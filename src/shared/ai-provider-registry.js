'use strict';

/**
 * ai-provider-registry.js —— 向后兼容代理出口。
 * 底层各厂商元数据与独立协议已拆分至 src/shared/providers/ 模块目录，
 * 本文件保留全量对外导出以维持项目现有消费者零变动。
 */

module.exports = require('./providers');
