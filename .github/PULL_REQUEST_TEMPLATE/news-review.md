# 热点审核 PR（批次：`batch-YYYYMMDD-HHMMSS`）

> 由 `collect-news.yml` 在每轮采集后自动创建（决策 46/58/59）。本 PR 只包含**内部候选层**与运行状态，不包含公开投影；公开投影在合并后由 `publish-news.yml` 重建。

## 审核对象

- 候选文件：`data/news/runtime/hotspot-candidates.json`
- 每条候选包含独立状态轴：
  - `ai_processing_status`：`not_requested` / `queued` / `processing` / `completed` / `error`
  - `review_status`：`pending` / `approved` / `held` / `discarded`

## 如何审核

1. 打开 `data/news/runtime/hotspot-candidates.json`，查看每条候选的原始标题、来源链接、发布时间、AI 处理状态与待设审核状态。
2. 为每条候选设置 `review_status`：
   - `approved`：通过，可进入公开投影（需 `ai_processing_status = completed`）；
   - `held`：暂缓决定，等待补充材料后复审（建议填写 `hold_reason`）；
   - `discarded`：丢弃，不公开。
3. 批量通过**明确选中**的候选（决策 56），不支持隐式「全部通过」：
   ```bash
   node scripts/news-cli.js review set --id <id> --status approved
   node scripts/news-cli.js review batch --ids <id1,id2> --status approved
   ```
4. 未处理的候选保持 `pending`。

## 合并后行为

- 合并本 PR 到 `main` 后，`publish-news.yml` 自动从候选层经公开资格门禁重建 `hotspots.json` 与 RSS，并触发部署。
- 仅 `ai_processing_status = completed` **且** `review_status = approved` 的候选会公开（决策 69）。
- 校验失败时保留上一版公开投影，不会用空结果覆盖（决策 59）。

## 异常处理

- 来源争议、处理失败或规则误判，请用「热点审核异常」Issue 模板记录，而不是在 PR 中直接改写（决策 47）。
