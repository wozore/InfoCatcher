'use strict';

// 本地 Bonsai 模型 OpenAI 兼容端点（llama-server）。
// 本地化任务（news 侧 5 个 + catalog 侧 3 个）统一引用，避免散落魔法字符串。
// 分类（L1）与目录合成留 DeepSeek，不使用本常量。
const LOCAL_API_BASE = 'http://127.0.0.1:8080/v1/chat/completions';

// 本地模型名（llama-server 忽略实际值，仅作标识）
const LOCAL_MODEL = 'bonsai';

module.exports = {
  LOCAL_API_BASE,
  LOCAL_MODEL,
};
