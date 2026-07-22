> **环归属**：环 B（先行就位）— 项目初期即可接收纠错与反馈，不等 MVP 完成。
>
> ---

# 为 InfoCatcher 贡献

感谢你愿意帮助改进 InfoCatcher！本项目是一个开源、免费、不接受厂商赞助的 AI 工具信息对比平台。每一条数据都标注来源，每一项评测都公开方法。

## 贡献方式

### 纠错数据（最简单）

发现某个 AI 工具的信息有误或过时？

- **方式 A：提交 Issue**（推荐，无需编程）
  点击 [数据纠错 Issue](https://github.com/wozore/infocatcher/issues/new?template=data-correction.yml)，填写结构化表单。

- **方式 B：直接改数据文件**
  编辑 `mvp/data/tools.json`，修改对应的工具条目，提交 PR。

### 推荐新工具

知道一个好用的 AI 工具但 InfoCatcher 还没收录？

1. 提交 [新工具推荐 Issue](https://github.com/wozore/infocatcher/issues/new?template=new-tool.yml)
2. 填写工具名称、分类、适用场景、免费/付费信息、你的使用体验

### 改进评测

认为某个工具的评分不准确？

1. 提交 Issue，说明哪个工具的哪个维度评分不合理
2. 提供你的理由和依据（最好有对比测试或具体用例）
3. 维护者会复核并在必要时调整

### 改进代码

- 查看 [Issues](https://github.com/wozore/infocatcher/issues) 中标记 `help wanted` 的任务
- Fork 仓库 → 修改 → 提交 PR
- 确保 PR 描述说明了改了**什么**和**为什么**

## 数据规范

所有工具数据存储在 `mvp/data/tools.json`。每个工具包含：

| 字段 | 说明 | 是否必填 |
|------|------|:---:|
| `name` | 工具名称 | ✅ |
| `vendor` | 开发商/公司 | ✅ |
| `url` | 官网链接 | ✅ |
| `category` | 分类（对话/AI编程/AI图像/AI视频/AI搜索/AI办公/AI音频/AI音乐） | ✅ |
| `scenes` | 适用场景（写论文/写周报/写代码/翻译文档/...） | ✅ |
| `free_tier` | 免费层说明 | ✅ |
| `paid_tiers` | 付费层级列表 | ✅ |
| `access_barrier` | 访问门槛 | ✅ |
| `access_level` | 开放/受限 | ✅ |
| `strengths` | 核心优势 | ✅ |
| `weaknesses` | 主要不足 | ✅ |
| `best_for` | 最适合场景 | ✅ |
| `not_for` | 不适合场景 | ✅ |
| `rating_overall` | 综合评分 (1-5) | ✅ |
| `rating_chinese` | 中文支持评分 (1-5) | ✅ |
| `rating_ease` | 易用性评分 (1-5) | ✅ |
| `rating_price` | 性价比评分 (1-5) | ✅ |
| `last_updated` | 最后更新日期 (YYYY-MM-DD) | ✅ |
| `source` | 信息来源 | ✅ |
| `chinese_note` | 中文支持备注 | 可选 |

### 评分标准

| 分数 | 含义 |
|:---:|------|
| 1 | 极差 |
| 2 | 较差 |
| 3 | 一般 |
| 4 | 良好 |
| 5 | 优秀 |

**综合评分**综合考虑以下维度后的整体判断，不是四个子评分的简单平均。

## 行为准则

- 提交的信息必须有**可验证的来源**（官方页面链接、截图等）
- 不接受来自 AI 工具厂商或其代理的"优化"提交——本项目的**利益声明**是不接收厂商赞助
- 评测意见分歧时，维护者拥有最终决定权，但会公开决策理由
- 友善、建设性地参与讨论

## 审核流程

```
提交(PR/Issue)
    │
    ▼
AI 自动初审（格式校验、一致性检查）
    │
    ├── 通过 ──→ 自动合并（小改动）
    │
    └── 标记可疑 ──→ 人工审核
                        │
                        ├── 通过 ──→ 合并 + 更新 last_updated
                        │
                        └── 驳回 ──→ 在 Issue/PR 中说明理由
```

审核通常在 **2-3 天内**完成。

---

> InfoCatcher 是一个学习项目，也是一个开源公益项目。你的每一次纠错和贡献，都在帮助更多人做出更明智的 AI 工具选择。
