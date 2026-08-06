# 热点信息操作全流程

> 本文档逐模块梳理本仓库「AI 热点」从采集、处理、审核到发布的全链路，涵盖内部候选层与双状态轴、公开资格门禁、CLI 运维与 CI 编排。所有描述均依据当前源码（`src/news/**`、`src/content/**`、`scripts/**`、`.github/workflows/**`）。
>
> 模块入口与职责索引见 [CODEBASE-MAP](../CODEBASE-MAP.md)；运维命令速查见 [operations.md](operations.md)。

---

## 一、整体架构与数据流向

```
外部平台 API（YouTube / X / Bilibili-RSSHub）   ← news-sources.json 来源清单 + news-config.json 配置
   │
   ▼
采集层  src/news/collectors/（news-youtube / news-x / news-bilibili）
   │     统一内容模型 + matchesAi 关键词过滤 + Registry 批量防重
   ▼
核心状态  src/news/core/
   ├─ news-registry.js     —— 所有检测过的内容的唯一真相源（双轴状态机）
   ├─ news-scheduler.js    —— 五层 UTC 时间窗，layer-first 历史回溯调度
   └─ news-quota.js        —— 平台独立额度账本（reserve→consume/release）
   │
   ▼
评分/关联  src/news/pipeline/
   ├─ feed-parser.js       —— RSS/XML 解析与内容标准化
   ├─ scoring.js           —— 加权评分、MAD 异常检测、商业扣分
   └─ projection.js        —— hot_score / evidence_excerpt / related_resources / 溯源 / 主题聚合 / 去重
   │
   ▼
AI 分类  src/news/classify/
   ├─ content-classifier.js —— L0 规则式兜底 + L1 DeepSeek，产出内容类型建议（ai_suggested）
   └─ llm-provider.js       —— DeepSeek API 封装（失败自动降级回 L0）
   │
   ▼
内部候选层  data/news/runtime/hotspot-candidates.json（双状态轴，不发布到 dist/）
   │        ai_processing_status（系统状态）× review_status（人工结论）
   ▼
公开资格门禁  src/news/core/news-public-gate.js
   │         审核门禁（completed + approved）+ 近期时间窗口 + 公开字段完整
   ▼
公开投影  data/news/output/hotspots.json  →  前端热点视图 / RSS（public/feed.xml）
```

**关键位置**：
- 唯一构建入口：`scripts/build-news.js` → `src/news/pipeline/build-news.js` 的 `main()` / `runCollection()`。
- 运维入口：`scripts/news-cli.js` → `src/news/cli/news-cli.js` 的 `main()`（十组命令）。
- 发布入口：`scripts/publish-news.js`（从候选层重建公开投影，决策 59）。

---

## 二、来源与配置（人工维护 + CLI）

### 2.1 数据文件

| 文件 | 路径 | 说明 |
|---|---|---|
| 来源清单 | `data/news/sources/news-sources.json` | 96 个来源，人工维护 + CLI 管理 |
| 配置 | `data/news/config/news-config.json` | 评分权重、时间层、额度、采集参数 |
| 人工条目 | `data/news/manual/news-manual-items.json` | B 站人工精选暂存（B16 决策 51/69 前的产品形态） |
| 热点信息源清单 | `resources/source-lists/热点信息源清单.md` | `sync-news-sources.js` 同步来源用 |

路径常量集中在 `src/shared/paths.js`（`NEWS_FILES` / `DIRS`），是全仓唯一数据登记点。

### 2.2 来源管理 CLI（`source` 命令组，`src/news/cli/cmd-sources.js`）

```bash
node scripts/news-cli.js source add     --platform youtube|bilibili|x --external-id ... --name ... --url ... --language ... --tag ...
node scripts/news-cli.js source import  --file <json> [--dry-run] [--allow-partial]
node scripts/news-cli.js source enable  --id ...
node scripts/news-cli.js source disable --id ...
```

`validateSource()` 校验项（全部通过才写入）：
- `platform` ∈ {youtube, bilibili, x}；
- `external_id` 格式：YouTube → `/^UC[A-Za-z0-9_-]{20,}$/`（UC 开头的 Channel ID）；Bilibili → 纯数字 UID；X → 1–15 位 `[A-Za-z0-9_]`（允许 `@` 前缀，写入时剥离）；
- `profile_url` 必须为 HTTPS；
- `content_tags` 来自允许列表 `ALLOWED_TAGS`：`横向测评 / 即时资讯 / 深度解读 / 教程实践 / 行业观点 / 轻度用户体验 / 官方来源`（7 个）；
- 同平台 `(platform, external_id)` 不重复（大小写不敏感）。

写入的来源对象含 `quality_prior` / `reliability_prior`（默认 50，评分用）、`cadence_class`、`collector` 等字段。`import` 默认全有或全无（atomic），`--allow-partial` 才写入通过校验的条目。

### 2.3 配置要点（news-config.json）

- `scoring.weights`：`long_term_quality 0.30 / recent_timeliness 0.25 / light_user_experience 0.10 / source_reliability 0.20 / interaction_quality 0.15`；`neutral_score 50`；`half_life_days` 按标签半衰期。
- `time_layers`：五层连续 UTC 半开区间 `recent-1d [0,1) / recent-7d [1,7) / recent-30d [7,30) / recent-90d [30,90) / recent-270d [90,270)`。
- `collection`：`max_output_items 100`、`output_retention_days 30`、`registry_retention_days 270`、`analysis_version "rules-v1"`、`concurrency 5`、`youtube_quota_units_per_run 1000`、`bilibili_rsshub_requests_per_run 300`、`x_max_sources_per_run 15`、`transcript_enabled false` 等。
- `anomaly`：`min_samples 30 / method "mad" / mad_threshold 3.5 / confirmed_adjustment 0`。
- `ai_keywords`：AI 关键词过滤（`matchesAi`）。
- `topic_entities`：主题聚合实体词表（`buildEvents`）。
- `light_user_signals` / `commercial_signals`：轻度体验与商业信号词表（评分用）。

---

## 三、构建主流程（`runCollection`，5 个 Phase）

`runCollection(options)` 是核心编排函数（`src/news/pipeline/build-news.js`）。一次构建完整流程：

### Phase 1：准备
1. 读入 `config`、`sources`、旧 `hotspots`、`state`（news-state.json，缺省 `initialState()`）。
2. 创建本轮 quota ledger（`createQuotaLedger`）与 registry 内存索引（`createRegistry`）。
3. 解析平台作用域 `NEWS_PLATFORM_SCOPE`：`all`（默认）或 `bilibili-only`（诊断 B 站）。
4. B 站人工模式：`bilibili_collection_mode === 'manual'` 时，`all` 作用域下自动暂停 B 站自动化采集（`bilibiliAutomatedPaused`），只保留人工条目。
5. 读入人工条目，经 `normalizeManualItem` 规范化，跳过 Registry 中 `processing_status === 'published'` 的（防重复发布）。
6. **X 来源轮转**：从 `state.x_rotation_offset` 起循环选取 `x_max_sources_per_run`（默认 15）个 X 来源，控制日调用成本；`bilibili-only` 不选 X 来源并保留原轮转游标。
7. 注入密钥：`X_API_KEY`、`YOUTUBE_API_KEY` 经 `options` 或 `process.env`。

### Phase 2：最新 Feed 采集（本轮选中的启用来源，`collectLatestSource`）
- 并发采集受 `config.collection.concurrency`（默认 5）控制（`mapWithConcurrency`）。
- 平台分发 `collectSource()`：youtube → `collectYouTube`；x → `collectX`；bilibili → `collectBilibili`；未知平台抛 `unsupported_platform`。
- 每条采集结果经 `matchesAi(item, config)` 过滤（标题+描述命中任一 `ai_keywords` 才保留）。
- 每条原始结果写入 Registry：`bulkDiscover`，命中 AI 关键词 → `discovery_status='discovered'`，未命中 → `'filtered_non_ai'`。
- 更新 `state.sources[source.id]` 状态与 `layer_coverage`（`updateLayerState`）；`coverage.platforms` 汇总；B 站按三路由合并 `routeCoverage`（最差状态优先，`mergeStatus` 排序 `not_run < success < rotating < partial < degraded < failed`）。

### Phase 3：历史层受控回溯（YouTube + Bilibili，`runHistoricalLayerPass`）
- 只在 `all` 作用域且未被 provider 熔断时执行；fixture / 注入 collector 时默认跳过（`skipHistory`）。
- 读取 `state.history_scheduler`（`createSchedulerState` 恢复），确定当前激活时间层（`config.time_layers[0]` 兜底），`initializeLayer` 初始化。
- 对每个启用且平台为 youtube/bilibili 的来源，执行**一个受控 step**：
  - YouTube：`collectYouTubeLayerStep`（playlistItems.list + videos.list 批量详情）；
  - Bilibili：`collectBilibiliLayerStep`（video / dynamic / article 三路由）。
- 历史内容经 `normalizeHistoricalYouTube` / `normalizeHistoricalBilibili` 转为统一内容模型后合并进 `freshItems`。
- **N-P3 预算**：`max_pages_per_source_layer`（默认 3）页数上限与 `max_items_per_source_layer`（默认 150）条数上限，达限强制终态（`partial` + `stop_reason`），防病理频道无限翻页/单一来源淹没。
- 进度经 `updateSourceProgress` 持久化（page_token / pages_fetched / items_contributed / stop_reason 等，跨 run 累计）。
- `advanceLayer`：当前层所有来源达终态才推进下一层；全部完成 → `complete`。

### Phase 4：内容处理
1. 旧内容保留：`retainedOld` = 旧输出中 `isWithinPublicWindow`（近期窗口内）的条目。
2. `dedupeItems([...freshItems, ...retainedOld])`：按 `platform:native_id` 去重（保留先出现者）。
3. 按 `published_at` 倒序排序（先预解析时间戳，避免比较器重复 `new Date`）。
4. `.slice(0, config.collection.max_output_items)` 截断（默认 100）。
5. `enrichHotspotProjection` 补公开契约字段（热度/依据片段/稳定关联）。
6. `assessItem` 逐条评分 → `applyAnomalyDetection` MAD 异常 → `buildEvents` 主题聚合 → `buildProvenance` 溯源。
7. 汇总 `coverage.time_layers`（统计口径：未来归 recent-1d、超窗归 older、无效归 older，见 `TIME_LAYER_STATS_OPTS`）。

### Phase 5：持久化（严格顺序）
见「九、持久化与原子写」。

---

## 四、采集器实现（`src/news/collectors/`）

### 4.1 YouTube（news-youtube.js）
- **最新 Feed**：`collectYouTube` 用免费 RSS feed `https://www.youtube.com/feeds/videos.xml?channel_id=...`（无配额限制），取 `youtube_max_per_source`（默认 15）条；随后 `enrichYouTubeStatistics` 用 Data API `videos.list`（part=statistics）补充浏览量/点赞/评论，每次 1 quota unit，无 API Key 降级 `rss_only`。
- **历史回溯**：`collectYouTubeLayerStep` ——
  1. `resolveUploadsPlaylist` 用 `channels.list`（1 unit）解析 uploads playlist ID，成功后跨批次复用（存 scheduler progress）；
  2. `playlistItems.list`（1 unit/页）取一页（`youtube_playlist_page_size` 默认 50）；
  3. `playlistCandidates` 把条目按 `classifyTimeLayer` 归层；`min_age_days >= 30` 的历史层标记 `backfill_candidate`；
  4. `bulkDiscover` 防重，仅对 `isNew || needsExpensiveProcessing` 的记录 `fetchVideoDetails`（`videos.list`，每批 ≤50，1 unit/批）；
  5. 详情拉取后立即 `updateLifecycle(processing_status='details_fetched', details_fetched=true)`；
  6. 停止条件：额度不足 `quota_paused`（保存 `resume_page_token`，下次优先恢复）、达 `stop_after_new_videos_per_source_layer`（默认 1）→ `partial`、无下一页或跨层 → `complete/observed_empty`。

### 4.2 X / Twitter（news-x.js）
- `collectX`：TwitterAPI.io `/twitter/user/last_tweets`，带 `X-API-Key` 请求头，`x_max_pages_per_source`（默认 1）页，cursor 分页。
- **额度计费实况（与注释不符，见第十五节）**：news-x.js 顶部注释称"每次请求经 `requestText` 的 `beforeAttempt` 计入 quota"，但 `collectX` 实际调用 `requestText` 时**未传 `beforeAttempt` 回调**，且 `createQuotaLedger` 只建 youtube/bilibili 两个平台账本——X 请求实际不经过 quota ledger。X 的成本控制靠来源轮转（`x_max_sources_per_run`）与 `x_max_pages_per_source=1` 实现。
- `normalizeTweet`：兼容多套字段命名（`id/id_str/tweetId/rest_id`、`text/full_text` 等）；全缺时以推文 JSON hash 兜底 `native_id`；缺正文或时间返回 `null`（不进入管线）；`source_type='x_post'`。
- 无 `X_API_KEY` 时抛 `missing_api_key`。

### 4.3 Bilibili（news-bilibili.js）
- 只使用 RSSHub 公开路由（`rsshub_base_url`，默认 `https://rsshub.app`），不调用 B 站内部 API、不逆向 SDK、不绕过风控（产品约束）。
- `collectBilibili`：三路由 `video / dynamic / article`，各取 `bilibili_max_per_route`（默认 15）条；`routeCoverage` 逐路由记录成功/降级。
- `probeBilibiliProvider`：`bilibili-only` 作用域下先探活，遇 Cloudflare challenge 快速熔断（`provider_circuit_open`）。
- `collectBilibiliLayerStep`：三路由→`classifyVisibleEntries` 归层→Registry 防重；状态判定：
  - 任一路由额度不足 → `quota_paused`；
  - 有路由失败 → 有内容 `partial` / 无内容 `temporarily_failed`；
  - **历史层（≥30 天）且无内容 → `history_unsupported`（原因 `rsshub_feed_has_no_historical_pagination`）**——是"接口能力不足"而非"内容为空"，避免误判；
  - 其余 → `complete / observed_empty`。

### 4.4 视频字幕/文字稿（news-transcripts.js，B16 决策 51/52/54/61/67）
- 对 YouTube 候选做字幕 enrichment，默认配置关闭（`transcript_enabled: false`）。
- 获取：YouTube 自动字幕 `timedtext` 端点（`fmt=json3`），按语言列表（`zh-Hans/zh-Hant/zh/en`）依次请求，首个可用语言胜出；`min_chars 80`。
- **结果映射（决策 52）**：
  - 成功 → 写 `candidate.transcript`（元数据 + 证据片段 `transcript_evidence`），不改状态轴；
  - 字幕缺失/过短 → `markHeld`（`review_status='held'` + `hold_reason`），等待补充后复审；
  - 技术获取失败 → `markAiError`（`ai_processing_status='error'` + `error_type`/`retryable`）。
  - 成功且此前因字幕原因 held → 重置为 `pending`（`transcript_recovery`）由管理者再审。
- 完整字幕写入 `data/news/runtime/transcripts/<id>.json`（内部、不发布、不进 PR）；候选只带元数据 + 短证据片段。

---

## 五、记录、去重与调度（`src/news/core/`）

### 5.1 Registry（news-registry.js）—— 唯一真相源
- **唯一键**：首选 `platform:native_id`；无原生 ID 用 `platform:url-<sha256 前 24 位>`；键含平台前缀，不同平台不冲突。
- **内存三索引**：`byKey` / `byUrl`（`platform:canonicalUrl`，URL 级去重）/ `bySource`（`source_id → Set(key)`）。
- **双轴状态机**：
  - `discovery_status`（发现阶段）：`discovered / backfill_candidate / filtered_non_ai / duplicate_observation / quota_paused / waiting_authorization / temporarily_failed / permanently_failed`；
  - `processing_status`（处理阶段）：`pending / details_fetched / analysis_pending / assessed / published / failed`。
- `updateLifecycle` 校验状态合法性；`needsExpensiveProcessing` 返回 true（未拉详情 / 未完成分析 / 分析版本升级）才允许进详情抓取或 AI 分析。
- **裁剪（N-P2）**：`pruneRegistry` 以 `last_seen_at` 起算超过 `registry_retention_days`（默认 270）天的记录；dry-run 只预览；`apply` 同步移除三索引并记 `stats.last_prune` 审计摘要；裁剪批次归档到 `news-registry-pruned.json`（可审计回滚）。边界半开：恰好 270 天保留。build 每轮结束自动裁剪；CLI `registry prune [--apply]` 亦可手动触发。

### 5.2 调度器（news-scheduler.js）—— 五层时间窗 + layer-first
- `classifyTimeLayer(publishedAt, layers, nowUtcMs, opts)`：`ageDays=(now-published)/86400000`，未来/超窗/无效默认归 `null`（采集器语义）；统计口径传 `{future:'recent', overflow:'older', invalid:'older'}` 保证恒有层标识。
- `validateTimeLayers` 校验连续性与 `max_age_days` 递增（validate.js 自动检查）。
- 状态持久化在 `news-state.json` 的 `history_scheduler` 段：`active_layer`、每来源×层的 `page_token / pages_fetched / items_observed / items_contributed / new_video_count / duplicate_count / filtered_count / stop_reason` 等，跨构建断点续跑。
- `TERMINAL_STATUSES`（可推进）：`complete / observed_empty / partial / history_unsupported / skipped_by_user`；`BLOCKING_STATUSES`（阻止推进）：`quota_paused / running / temporarily_failed / waiting_authorization`。
- `advanceLayer`：当前层所有来源达终态才推进；最后一层完成 → `complete`。
- `eligibleForLowFrequencyBackfill`：低频高质量回溯资格（`low_frequency_backfill` 配置 + 来源 `cadence_class`/`quality_prior`/`ai_relevance`/近期新视频数）。

### 5.3 额度账本（news-quota.js）
- 每轮构建独立预算，`createQuotaLedger` 只建两个平台账本：YouTube 按 quota units（默认 1000/轮）、Bilibili 按 HTTP attempts（默认 300/轮）。**X 平台不在额度账本内**（见 4.2 实况说明）。
- 三步计费：`reserveQuota`（预留，返回 reservationId）→ `consumeQuota`（请求已发出，无论成败都计费）→ `releaseReservation`（预留后不发，极少见）。
- 状态切换：`remaining===0 → exhausted`；不足以支付当前 cost → `quota_paused`；`remaining ≤ quota_low_watermark`（默认 5）→ `low_watermark` 低水位早停（N-P3）；`reserved !== 0` 在 `finishQuotaLedger` 时 → `incomplete_reservations`。
- `withQuota` 便捷封装：reserve → 执行 → 成功/失败 consume，失败在 error 上附加 `quotaReservationId`。
- 为什么不是全局额度：GitHub Actions 每次触发独立进程，无法跨运行持久化动态余额；`quota resume` 只记录决策和时间，不修改余额，下一次构建创建新预算后自动恢复。

### 5.4 授权任务（news-authorization.js）
- 触发条件：五层时间窗（0–270 天）全部完成后，某来源在所有层的新视频数均为 0 且无重复/过滤项可处理 → 默认范围已穷尽，创建 `pending` 授权任务。
- 四种决策（`decideAuthorization`）：`continue`（回溯到指定天数）、`until-first`（持续回溯直到第一条新视频）、`skip`、`stop`。
- 安全约束：时间边界必须 > `searched_range_days` 且 ≤ 3650 天；`max_quota`/`max_pages` 必须是正整数；状态 authorized/skipped/stopped 后不能重复授权。
- CLI：`authorization list / continue / until-first / skip / stop`。

### 5.5 公开资格门禁（news-public-gate.js）
- **公开总规则（决策 49/63/69/72 组合）**：
  1. **审核门禁**（news-candidates.js `isPublicEligible`）：`ai_processing_status === 'completed'` 且 `review_status === 'approved'`；
  2. **近期时间窗口**：以内容 `published_at` 判断（非抓取时间），默认 30 天（`output_retention_days`）；未来时间超容错（默认 6 小时）或发布时间缺失 → `future/missing` → 标记 `held`，不进公开；
  3. **公开字段完整**：标题、来源链接、发布时间必须完整（`hasCompletePublicFields`）。
- `filterPublicItems` / `filterProjectionByWindow`：hotspots 构建、publish-news 与 RSS 生成共用同一规则（决策 72 防口径漂移）；投影过滤时同步剔除悬空引用（events/provenance/assessments 只保留引用到存活条目的记录）。
- `markAnomalousTimeCandidates`：对候选层中发布时间缺失或未来超容错的候选标记 `held`（决策 63），变更记入只追加审核事件日志。

---

## 六、评分、关联与去重（`src/news/pipeline/`）

### 6.1 评分（scoring.js）
- **公式**：
  ```
  基础分 = 0.30×long_term_quality + 0.25×recent_timeliness + 0.10×light_user_experience
         + 0.20×source_reliability + 0.15×interaction_quality
  最终分 = clamp(基础分 - 商业推广扣分 - 异常调整, 0, 100)
  ```
- `recent_timeliness`：指数衰减 `100 × exp(-ln2 × 年龄天数 / half_life_days[tag])`（标签半衰期不同）。
- `long_term_quality` = `source.quality_prior`；`source_reliability` = `source.reliability_prior`。
- `detectLightExperience`：命中 ≥2 类轻度用户体验信号 → 加分；证据不足保持中性 50。
- `detectCommercial`：命中 `commercial_signals` 或 `explicit_links` 中的 affiliate 链接 → 扣分（`commercial_penalties`），证据不足 0 扣分。
- `bilibili_dynamic_repost`：质量分 × 0.6，轻度体验分固定中性（纯转发贡献低）。
- `applyAnomalyDetection`：按 `source_id` 分组，用互动量加权对数指数做 **MAD 鲁棒异常检测**（样本 ≥ `min_samples` 30，`robust_z > mad_threshold 3.5` → `review` + 分数调整）；不足样本 → `insufficient_sample`。
- `HEAT_DEFINITION`：hot_score 表示条目在来源平台内的相对互动量级（0–100），仅平台内可比，不构成跨平台权威综合热度。

### 6.2 解析与标准化（feed-parser.js）
- `parseFeed`：同时解析 Atom（`<entry>`）与 RSS（`<item>`），保留 `raw_block` 供抽取显式链接；缺失标题/URL/时间之一即过滤。
- `decodeXml`：剥离 CDATA、解码 5 个实体、去残留标签、折叠空白。
- `normalizeRssItem`：统一内容模型，`id = ${platform}-${hash(nativeId)}`，`description` 截断 600 字符，`explicit_links` 从 raw_block 提取（去重、规范化，≤10）。
- `normalizeUrl`：只保留 http/https，去 hash 片段与追踪参数（`utm_*`/`feature`/`si`/`spm_id_from`）——同链接不同追踪变体视为同一 URL。
- `inferBilibiliType`：B 站动态细分类（`bilibili_article / bilibili_dynamic_repost / bilibili_dynamic_video / bilibili_dynamic_text`）。
- `requestText`：带重试与额度回调；`quota_paused` / `cloudflare_challenge` 立即终止重试；重试间隔 `retry_base_ms × (attempt+1)`。
- `historicalPageToken`：优先 `resume_page_token`（额度中断恢复），其次 `page_token`。

### 6.3 投影与关联（projection.js）
- `computeHotScores`：同一平台内按互动量级归一化到 0–100（无互动数据为 `null`，前端按"最近"回退）。
- `buildEvidenceExcerpt`：取描述（描述兜底标题）受控节选 ≤160 字符；纯链接或空文本返回 `null`，不伪造原文。
- `resolveRelatedResources`（URL 精确身份匹配）：条目 URL / 显式链接与工具目录规范 URL 完全一致才关联（决策 89）。
- `matchRelatedByTitle`（标题词边界匹配，B16-R7 方案 A）：中文按子串包含 + 前后非中文；ASCII 按 `\b` 词边界（"ChatGPT"不命中"ChatGPTX"）；泛词（`RELATED_TITLE_STOPWORDS`）剔除；工具名不过滤 stopword；单热点上限 3 条，按 工具→概念→场景 优先级截断。
- `buildProvenance`（溯源）：识别重复观察（`duplicate_observation`）、转载（`repost`）、引用（`citation`）、原创（`original`），附置信度与证据。
- `buildEvents`（主题聚合）：按确定性关键词 / 显式 URL / 人工 `topic_key` 归组，保留各自观点不合并为单一结论；组内官方来源 → `official_source_present`。
- `dedupeItems`：按 `platform:native_id` 去重（与 Registry 主键一致），保留先出现条目；跨平台重复由 provenance 保留，不在此合并（决策 46/47）。
- `getToolUrlIndex` / `getRelatedLexicon`：惰性加载工具目录 URL 索引与标题匹配词表（一次构建只读一次，读取失败降级空表）。
- `upgradeHotspotsProjection` / `migrateContentTypeProjection`：就地迁移工具（`--upgrade-hotspots` / `--migrate-content-type`）。

---

## 七、AI 内容分类（`src/news/classify/`）

### 7.1 两级分类（content-classifier.js，决策 65/66/79）
- **L0 规则式基线**：零依赖、零成本、可离线。六类正则 + catalog 词典（tools/glossary）命中，优先级：
  1. 行业事件（`INDUSTRY_RE`：融资/监管/财务/安全/人事/会议）→ `ai_industry`；
  2. 模型/技术/研究（`MODEL_NAME_RE` + `TECHNOLOGY_RE`）→ `ai_technology`；
  3. 工具使用/评测（工具名 + 使用/评测词）→ `ai_tool`；
  4. 产品发布/更新（工具名或 AI 产品信号 + 发布词）→ `ai_product`；
  5. 概念/术语/教育 → `ai_concept`；
  6. 兜底 → `other`。
- **L1 AI 分类**：`INFOCATCHER_CLASSIFY_PROVIDER=deepseek` 或存在 `DEEPSEEK_API_KEY` 时启用；任何失败（缺 key/网络/超时/输出无法映射）自动回退 L0（`classifier='rule_based_fallback'`），**不阻塞采集管线**。
- 内容类型状态机：`content_type_status: unclassified → ai_suggested → reviewed`（`ai_suggested`=AI 建议待审，`reviewed`=人工确认）。
- `classifyCandidates`：批量建议，跳过无标题项与已 `reviewed`（人工结论）项，双保险防止 AI 覆盖人工确认；L1 并发池默认 5。
- `confirmContentType`：`ai_suggested → reviewed`（人工审核确认，记录 reviewer/时间）。

### 7.2 DeepSeek 提供方（llm-provider.js）
- 默认模型 `deepseek-chat`，API `https://api.deepseek.com/chat/completions`；`temperature 0 / max_tokens 8 / stream false`。
- 输入裁剪：标题 ≤200、描述 ≤600 字符（控成本）。
- 系统提示强制输出单一枚举；`normalizeLabel` 容忍引号/句号/多余文字/中文标签并映射回六类。
- 失败语义：任何错误 resolve `{ ok: false }` 降级对象，绝不 reject。
- `ai_confidence`：DeepSeek 无 token 概率，固定经验值 0.85 仅表示"调用成功"，不作为审核依据（审核以人工 reviewed 为准）。

---

## 八、内部候选层与双状态轴（`src/news/core/news-candidates.js`）

### 8.1 两层数据流程（决策 49）
```
采集 → 评分/溯源 → 内部候选层（data/news/runtime/hotspot-candidates.json）
                         ↓ 公开资格过滤（news-public-gate）
               公开 hotspots.json（data/news/output/hotspots.json）
```
候选层**不发布到 dist/**（build-dist.js 只拷贝 `data/catalog` 与 `data/news/output`），浏览器不直接读取。

### 8.2 双状态轴（决策 16/48/57/69）
| 状态轴 | 含义 | 取值 |
|---|---|---|
| `ai_processing_status` | AI 处理流程是否成功完成（系统状态） | `not_requested / queued / processing / completed / error` |
| `review_status` | 人工审核结论（人的决定） | `pending / approved / held / discarded` |

**公开资格门禁（决策 69）**：仅当 `ai_processing_status === 'completed'` **且** `review_status === 'approved'` 时候选才进入公开 hotspots.json。系统失败（error）与人工决定（discarded）分属不同轴，互不覆盖。

### 8.3 候选合并与审计
- `mergeCandidates`：新候选按 id 覆盖内容字段；已存在候选**保留既有** `review_status` / `ai_processing_status` / `candidate_version` / `batch_id`，避免重新采集重置人工结论；人工确认的内容类型（`content_type_status='reviewed'`）同样保留。
- 采集时打上 `batch_id`（`batch_<YYYYMMDD>`）与初版 `candidate_version`（决策 70）。
- 新候选默认 `review_status='pending'`，`ai_processing_status='completed'`（L0 规则式/既有处理产物）。
- `setReviewStatus` / `setBatchReviewStatus`：校验状态合法；`approved` 需先 `assertCanApprove`（AI 未完成禁止批准）；每次流转写完整审计字段 `reviewer / reviewed_at / from_status / candidate_version`（+ `review_reason`）。
- `markHeld`：记录 `hold_reason`；`markAiError`：记录 `error_type / retryable / retry_count`。
- `attachProjectionSnapshot`：把重建公开投影所需的 events/provenance/assessments/coverage/heat_definition 存入候选层，供 `publish-news.js` 独立重建。
- `importLegacyHotspots`（决策 64）：旧 hotspots 导入候选层，标记 `legacy: true`、`review_status='pending'` 进入待审；只导入候选层中尚不存在的 id。

### 8.4 审核事件日志（news-review-events.js，决策 70 的另一半）
- `review-events.json`：**只追加、不改写历史**的追加式日志，完整保留每次审核状态流转（candidate_id / action / from_status / review_status / review_reason / reviewer / reviewed_at / candidate_version / batch_id / logged_at）。
- 系统驱动的状态变化（如字幕 enrichment 自动 held）同样记录，`reviewer='system'`。
- 候选主记录只保存当前状态与最近一次流转；历史状态从日志追溯。

---

## 九、持久化与原子写

### 9.1 底层（news-storage.js）
- `writeJsonAtomic`：先写唯一临时文件（含 runId/PID/随机 hex，`wx` 独占）→ fsync → 同盘 rename 原子替换；失败删临时文件、目标不变。
- `readJson`：仅在 ENOENT 且传入 fallback 时返回 fallback，其他错误抛出。
- `acquireLock` / `releaseLock` / `inspectLock` / `forceUnlock`：`fs.openSync(path,'wx')` 排他创建构建锁；`releaseLock` 校验 runId 所有权；**锁从不自动过期**（N-P3 契约，并发安全）；`forceUnlock` 必须提供 reason 并写入审计 `news-admin-audit.json`。

### 9.2 写入顺序（build-news.js Phase 5，有严格依赖）
```
1. news-registry-pruned.json（裁剪归档批次，先于 registry）
2. news-registry.json
3. news-state.json
4. news-quota.json
5. pending-authorizations.json
6. hotspot-candidates.json（候选层 + 投影快照，内部、不发布）
7. hotspots.json（公开投影，最后写）
   —— 若公开投影为空（无 approved），不覆盖旧文件，保留上一版公开数据
```
候选层先写、公开投影最后写：中间任何一步失败，旧 hotspots.json 保持不变，前端不会看到半成品。

### 9.3 构建失败保护
- `!items.length && !options.allowEmpty` → 抛错，保留上一版输出（`--allow-empty` 仅调试用）。
- `main()` 外层 `acquireLock` → `runCollection` → `releaseLock`；已有构建在跑时抛 `build_locked`。
- 构建结束调用 `generateRss()`。

---

## 十、审核流程（人工介入）

### 10.1 CLI 审核命令（`review` 组，src/news/cli/cmd-registry.js）
```bash
node scripts/news-cli.js review list    [--status pending|approved|held|discarded] [--platform ...] [--limit N]
node scripts/news-cli.js review summary
node scripts/news-cli.js review set     --id <id> --status <s> [--reason ...] [--reviewer ...] [--content-type <t>]
node scripts/news-cli.js review batch   --ids <id1,id2,...> --status approved [--reason ...] [--reviewer ...]
node scripts/news-cli.js review log     [--candidate-id <id>] [--action ...] [--limit N]
```
- `set` 单条设置；`batch` 只处理**显式列出**的 ids，不支持隐式"全部"（决策 56）。
- `ai_processing_status !== completed` 时禁止设 `approved`（`assertCanApprove`）。
- 每条流转写审计字段并追加到只追加审核事件日志（决策 70）。
- `--reviewer` 缺省回退 `GITHUB_ACTOR → USER → USERNAME → 'cli'`。
- `--content-type`：审核时可同时确认内容类型（`ai_suggested → reviewed`）。

### 10.2 其他人工相关命令
- `legacy import / status`：旧热点数据迁移（决策 64）；导入后 `review set/batch --status approved` 逐条/批量审核，再 `publish-news.js` 重建公开投影。
- `transcript status/fetch`：单条字幕处理（决策 52）。
- `classify preview/candidates/hotspots/confirm`：分类建议与人工确认。
- `content add/import/list`：B 站人工条目；重复校验同时查 payload 与 Registry（`content add` 走构建锁）。

---

## 十一、发布与 CI 编排

### 11.1 publish-news.js（决策 59）
- 触发：`publish-news.yml` 在 `main` 分支 push 且变更 `data/news/runtime/hotspot-candidates.json` 时运行。
- 流程：`buildProjectionFromStore` 从候选层重建公开投影 → `enrichHotspotProjection`（补热度/依据/关联）→ `filterProjectionByWindow`（近期窗口第二道防线）→ 空投影不覆盖 → 写 `hotspots.json` + `generateRss()`。
- 只提交公开投影（hotspots.json + feed.xml），不含内部候选层，因此不会再次触发本 workflow（paths 仅监听候选层）。

### 11.2 collect-news.yml（构建工作流）
- 触发：每 3 天 UTC 02:00 定时 + 手动（`workflow_dispatch` 可选 `platform_scope`：all / bilibili-only）；concurrency 组 `collect-ai-news` 防并行。
- 步骤：checkout → `node scripts/validate.js` → `node scripts/check-secrets.js`（密钥扫描）→ 注入 Secrets 跑 `node scripts/build-news.js` → 测试生成数据 → **创建 review 分支** `news/review/<batch>` 提交候选层与运行状态 → 用 `news-cli.js review summary` 生成审核 PR。
- **关键设计（决策 46/58/59）**：采集只产生内部候选层与运行状态（不直接提交 main）；公开投影在审核 PR 合并后由 `publish-news.yml` 重建，保证"人工审核通过"才进公开。

### 11.3 审核 → 发布闭环
```
collect-news.yml 构建 → review 分支 + 审核 PR（附状态分布摘要）
   → 维护者在 PR 中逐条/批量设置 review_status（或本地 CLI review set/batch 后推送）
   → 合并 PR 到 main（hotspot-candidates.json 更新）
   → publish-news.yml 从候选层重建公开投影 + RSS
   → deploy.yml 构建 dist/ 部署 GitHub Pages
```

### 11.4 密钥与安全
- 密钥仅经 GitHub Repository Secrets 注入（`YOUTUBE_API_KEY` / `X_API_KEY` / `DEEPSEEK_API_KEY`），不进入代码、JSON、浏览器或 CLI 参数；CLI 不接受 `--api-key`。
- `check-secrets.js` 在构建前做密钥/高熵扫描（validate.js 反向依赖）。

---

## 十二、关键文件与导出速查

| 模块 | 文件 | 关键导出 |
|---|---|---|
| 构建编排入口 | [build-news.js](../src/news/pipeline/build-news.js) | `runCollection`、`main`、`classifyTimeLayer`、汇总 re-export 31 个 |
| CLI 分发 | [news-cli.js](../src/news/cli/news-cli.js) | `parseArgs`、`main`、各 command |
| 来源管理 | [cmd-sources.js](../src/news/cli/cmd-sources.js) | `sourceCommand`、`validateSource`、`importSources` |
| 内容/分类/字幕 | [cmd-content.js](../src/news/cli/cmd-content.js) | `contentCommand`、`classifyCommand`、`transcriptCommand` |
| 授权/额度/锁 | [cmd-ops.js](../src/news/cli/cmd-ops.js) | `authorizationCommand`、`quotaCommand`、`lockCommand` |
| registry/review/legacy | [cmd-registry.js](../src/news/cli/cmd-registry.js) | `registryCommand`、`reviewCommand`、`legacyCommand` |
| 存储与锁 | [news-storage.js](../src/news/core/news-storage.js) | `readJson`、`writeJsonAtomic`、`acquireLock` |
| Registry | [news-registry.js](../src/news/core/news-registry.js) | `createRegistry`、`bulkDiscover`、`pruneRegistry` |
| 调度 | [news-scheduler.js](../src/news/core/news-scheduler.js) | `classifyTimeLayer`、`advanceLayer` |
| 额度 | [news-quota.js](../src/news/core/news-quota.js) | `createQuotaLedger`、`withQuota` |
| 候选层 | [news-candidates.js](../src/news/core/news-candidates.js) | `mergeCandidates`、`buildPublicProjection`、`setReviewStatus` |
| 公开门禁 | [news-public-gate.js](../src/news/core/news-public-gate.js) | `filterPublicItems`、`filterProjectionByWindow` |
| 授权 | [news-authorization.js](../src/news/core/news-authorization.js) | `createAuthorizationTask`、`decideAuthorization` |
| 审核日志 | [news-review-events.js](../src/news/core/news-review-events.js) | `recordReviewTransition` |
| 采集 | [news-youtube.js](../src/news/collectors/news-youtube.js) | `collectYouTube`、`collectYouTubeLayerStep` |
| 采集 | [news-x.js](../src/news/collectors/news-x.js) | `collectX`、`normalizeTweet` |
| 采集 | [news-bilibili.js](../src/news/collectors/news-bilibili.js) | `collectBilibili`、`collectBilibiliLayerStep` |
| 字幕 | [news-transcripts.js](../src/news/collectors/news-transcripts.js) | `enrichYouTubeTranscripts` |
| 解析 | [feed-parser.js](../src/news/pipeline/feed-parser.js) | `parseFeed`、`normalizeRssItem` |
| 评分 | [scoring.js](../src/news/pipeline/scoring.js) | `assessItem`、`applyAnomalyDetection`、`HEAT_DEFINITION` |
| 投影 | [projection.js](../src/news/pipeline/projection.js) | `enrichHotspotProjection`、`buildProvenance`、`buildEvents` |
| AI 分类 | [content-classifier.js](../src/news/classify/content-classifier.js) | `classifyRuleBased`、`classifyCandidates`、`confirmContentType` |
| LLM | [llm-provider.js](../src/news/classify/llm-provider.js) | `classifyWithDeepSeek` |
| 人工条目 | [news-manual.js](../src/content/news-manual.js) | `normalizeManualItem`、`importManualItems` |
| RSS | [generate-rss.js](../src/content/generate-rss.js) | `getFeedItems`、`generateRss` |
| 路径 | [paths.js](../src/shared/paths.js) | `DIRS`、`NEWS_FILES` |

---

## 十三、数据文件一览（data/news/**）

| 文件 | 用途 | 是否发布到 dist/ |
|---|---|---|
| `config/news-config.json` | 评分/时间层/额度/采集配置 | —（非数据产物） |
| `sources/news-sources.json` | 来源清单 | 否（配置） |
| `manual/news-manual-items.json` | B 站人工精选暂存 | 否 |
| `runtime/news-state.json` | 构建批次与来源游标/调度状态 | 否 |
| `runtime/news-registry.json` | 所有检测过的内容唯一真相源 | 否 |
| `runtime/news-registry-pruned.json` | Registry 裁剪归档（可回滚） | 否 |
| `runtime/news-quota.json` | 平台额度账本 | 否 |
| `runtime/pending-authorizations.json` | 待授权任务 | 否 |
| `runtime/hotspot-candidates.json` | **内部候选层（双状态轴）** | 否 |
| `runtime/review-events.json` | 追加式审核事件日志 | 否 |
| `runtime/transcripts/` | 完整字幕（内部） | 否 |
| `runtime/news-admin-audit.json` | 强制解锁等审计 | 否 |
| `runtime/.news-build.lock` | 构建并发锁（不入库） | 否 |
| `output/hotspots.json` | **公开热点投影** | 是 |
| `public/feed.xml` | RSS 2.0 feed | 是 |

---

## 十四、测试与验证

- `scripts/validate.js` → `src/maintenance/validate.js`：catalog + news 数据 + 开发原则门禁聚合校验，`process.exit(0/1)`；CI 三处工作流依赖。
- `node scripts/build-news.js --fixture`：本地 fixture 确定性测试（`tests/fixtures/`），不请求 API、不消费额度、不写持久文件（`noWrite`）；用于验证标准化→过滤→评分→溯源的确定性行为。
- 测试文件：`tests/news/` 下的 news-tests / news-foundation / news-candidates / news-review-events / news-public-gate / news-transcripts / news-audit / news-rss 等。

---

## 十五、常见误区与易错点（据源码注释）

1. **时间门禁必须传数字时间戳**：`news-public-gate` 用 `now - time` 做算术，传 ISO 字符串会得到 NaN，导致未来/超窗判定静默失效（build-news.js 有专门注释提醒）。
2. **分类时间层有两种口径**：采集器/历史调度用默认（未来/超窗/无效归 null，不进层）；管线统计用 `{future:'recent', overflow:'older', invalid:'older'}`（恒有层标识）。历史上有"注释谎称转发"的独立副本，已收敛到 scheduler 单一实现。
3. **B 站历史层无内容是 `history_unsupported`**，不是 `observed_empty`（接口无日期分页能力 vs 该时段无内容）。
4. **去重键是 `platform:native_id`**：历史注释曾宣称"url+title 组合"，语义错误且会误合并；真实数据两种键零差异，故保留实现、修正注释。
5. **额度失败请求也计费**：对平台来说失败请求同样消耗资源，retry 不豁免 quota。
6. **候选层合并保留人工结论**：重新采集不会重置已审核的 review_status / reviewed 内容类型，防止 AI 建议覆盖人工确认。
7. **公开投影为空不覆盖旧文件**：候选层无 approved 时保留上一版公开数据，避免本地采集/重建误伤公开页。
8. **构建锁从不自动过期**：并发安全由"锁永久有效 + 人工 force-unlock 带理由"保证，config 无任何锁过期字段。
9. **Registry 裁剪用 `last_seen_at` 而非 `published_at`**：回溯收集的历史视频 published_at 旧但 last_seen_at 新，按发布时间裁剪会误删仍在处理的回溯记录。
10. **X 请求实际不纳入 quota ledger（注释与实现不符）**：news-x.js 顶部注释声称"每次请求经 `requestText` 的 `beforeAttempt` 计入 quota"，但 `collectX` 未传 `beforeAttempt` 回调，`createQuotaLedger` 也只建 youtube/bilibili 两平台账本。若预期 X 也应计费，需在 `collectX` 增加 beforeAttempt 回调并在 ledger 增加 x 平台；目前 X 成本仅靠来源轮转与 `x_max_pages_per_source=1` 约束。**此差异为阅读代码时发现，建议开发者核实是否有意为之。**
