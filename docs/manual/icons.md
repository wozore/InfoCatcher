# 品牌图标维护说明

## 目录结构

品牌图标不是 catalog 数据字段，而是前端的独立展示资产：

```text
src/web/icons/
├── manifest.json
├── vendor/   # 厂商 logo
├── tool/     # 独立工具 logo
├── series/   # 模型系列 logo；会被该系列所有三级详情继承
└── model/    # 单个模型 logo；覆盖 series logo
```

构建时 `scripts/build-dist.js` 会整体复制 `src/web`，所以不需要手动复制到 `dist`。浏览器加载的是 `icons/manifest.json`。

## 如何准备厂商 icon

优先使用厂商官方提供的品牌资源（Brand Guidelines、Press Kit、Media Kit 或官网 favicon），下载 SVG；如果官网只提供 PNG，使用透明背景、至少 128×128 像素的 PNG。不要从搜索结果页直接截图，也不要使用带第三方水印的图片。

可用的官方入口示例：

- OpenAI：<https://openai.com/brand>
- Anthropic：<https://www.anthropic.com/brand>
- Google：<https://about.google/brand-resource-center/logos-list/>
- DeepSeek：<https://www.deepseek.com/>
- 智谱：<https://www.zhipuai.cn/>
- 百度：<https://brand.baidu.com/>
- 科大讯飞：<https://www.iflytek.com/>
- xAI：<https://x.ai/>
- Mistral AI：<https://mistral.ai/>
- Cohere：<https://cohere.com/brand>
- 快手：<https://www.kuaishou.com/>
- MiniMax：<https://www.minimaxi.com/>

对于单色、无特殊官方资产要求的厂商，也可以使用 [Simple Icons](https://simpleicons.org/) 的 SVG。其图标仓库采用 CC0 许可；文件名不一定等于厂商名，例如 Mistral AI 的文件名是 `mistralai.svg`。使用时仍以厂商官方品牌规范为准。

### 建议的文件处理

1. 将文件复制到 `src/web/icons/vendor/`。
2. 文件名使用稳定的小写 kebab-case，例如 `openai.svg`、`zhipu.svg`。
3. SVG 保持原始 `viewBox`，不要把外部 URL、脚本或事件处理器放进 SVG。
4. 在 `manifest.json` 的 `vendor` 中增加一行。
5. 运行 `node scripts/validate.js`，确认路径和 JSON 正确。

## manifest 配置

键必须使用 catalog 的稳定键，而不是展示标题：

```json
{
  "vendor": {
    "openai": "vendor/openai.svg",
    "anthropic": "vendor/anthropic.svg"
  },
  "tool": {
    "cursor": "tool/cursor.svg"
  },
  "series": {
    "gpt-5.6": "series/gpt-5.6.svg"
  },
  "model": {
    "gpt-5-5": "model/gpt-5-5.svg"
  }
}
```

### 可选颜色配置

Simple Icons 通常只有单色 path。如果希望使用十六进制颜色给单色 SVG 上色，可以把原本的字符串写法改成对象写法，增加可选的 `color`：

```json
{
  "vendor": {
    "anthropic": {
      "path": "vendor/anthropic.svg",
      "color": "#D97757"
    },
    "google": "vendor/google.svg"
  }
}
```

- `path` 必填，仍然相对于 `src/web/icons/`。
- `color` 可选，支持 `#RGB`、`#RRGGBB` 和 `#RRGGBBAA`。
- 不写 `color` 时，继续使用原 SVG 的颜色；现有字符串写法完全兼容。
- 配置 `color` 后，前端会读取 SVG 内容并内联着色成该十六进制颜色（data URI `<img>`），颜色只落在图标形状上，不会染到整个格子；这适合 Simple Icons 轮廓，不会把单色轮廓自动变成 Google 等品牌的多色 Logo。
- 真正的 RGB 多色 Logo，应直接替换为厂商官方彩色 SVG，并省略 `color`。

路径相对于 `src/web/icons/`，不要写 `/vendor/openai.svg`，也不要写 `../`。

### 三级详情的继承规则

三级详情的图标优先级为：

```text
model[单个模型 slug]
  → series[父级模型系列 slug]
  → vendor[厂商 vendor_key]
  → catalog 原有 emoji
```

例如：

- `series.gpt-5.6` 配置后，`gpt-5.6-sol`、`gpt-5.6-terra` 等父系列下的三级详情都会显示该图标。
- 如果只想替换 `gpt-5-5`，在 `model.gpt-5-5` 配置；它会覆盖所属系列或厂商图标。
- **二级预览页本身不显示 icon**。series 配置的作用是让其下三级详情统一继承。

## 兜底和安全

- manifest 加载失败、文件未配置或路径不存在时，页面继续显示 catalog 原有 emoji，不会阻塞页面。
- `validate.js` 会拒绝绝对路径和包含 `..` 的路径，并检查登记文件是否真实存在。
- logo 是装饰性内容，渲染时使用空 `alt`；厂商/工具名称仍由旁边的文本显示。
