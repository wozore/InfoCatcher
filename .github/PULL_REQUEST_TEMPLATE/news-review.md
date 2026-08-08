# 热点审核 PR（批次：`batch-YYYYMMDD-HHMMSS`）

> 由 `collect-news.yml` 在每轮采集后自动创建。本 PR 只包含**内部候选层**，不包含公开投影；公开投影在合并后由 `publish-news.yml` 重建。

## 审核对象

- 候选文件：`data/news/runtime/min-candidates.json`
- v2 单状态轴 `review_status`：`pending` / `approved` / `discarded`（不再有 `ai_processing_status` 轴）

## 如何审核

1. 打开 `data/news/runtime/min-candidates.json`，查看每条候选的原始标题、来源链接、发布时间与待设审核状态。
2. 为每条候选设置 `review_status`：
   - `approved`：通过，可进入公开投影；
   - `discarded`：丢弃，不公开。
3. 批量通过**明确选中**的候选，不支持隐式「全部通过」：
   ```bash
   node scripts/news-cli.js min-review set --id <id> --status approved
   node scripts/news-cli.js min-review batch --ids <id1,id2> --status approved
   ```
4. 未处理的候选保持 `pending`。

## 合并后行为

- 合并本 PR 到 `main` 后，`publish-news.yml` 自动从候选层经公开资格门禁重建 `hotspots.json` 与 RSS，并触发部署。
- 仅 `review_status = approved` 的候选会公开。
- 校验失败时保留上一版公开投影，不会用空结果覆盖。

## 异常处理

- 来源争议、处理失败或规则误判，请用「热点审核异常」Issue 模板记录，而不是在 PR 中直接改写。
