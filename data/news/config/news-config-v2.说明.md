# news-config-v2.json 配置说明

> 热点管线 v2 的全部业务开关集中在此文件。**JSON 不支持注释**，故用本表说明每个配置项的含义、默认值、单位与影响。
> 改动配置后重跑 `node scripts/build-news.js --min` 生效。

## schedule —— 抓取周期与时刻

| 字段 | 默认值 | 说明 |
|---|---|---|
| `youtube_cron` | `"0 22 */3 * *"` | YouTube 抓取 cron（北京时间）。`0 22 */3 * *` = 每 3 天 22:00 一次。采集窗口 = 本次 22:00 → 3 天前 22:00 |
| `youtube_tz` | `"Asia/Shanghai"` | YouTube 抓取时区 |
| `youtube_window_days` | `3` | YouTube 采集窗口天数（回看 N 天内的新视频） |
| `x_cron_first` | `"0 14 * * *"` | X 第一次抓取（北京时间 14:00，抓当天 0:00–14:00 博主内容） |
| `x_cron_second` | `"0 0 * * *"` | X 第二次抓取（北京时间 0:00，抓昨天 14:00–今天 0:00 博主内容） |
| `x_tz` | `"Asia/Shanghai"` | X 抓取时区 |

## collection —— 配额上限 / 公开数量 / 审核量 / 网络

| 字段 | 默认值 | 说明 |
|---|---|---|
| `youtube_search_max_per_run` | `100` | 每次运行 search.list 调用上限（独立桶 100 次/天硬上限） |
| `youtube_search_cost_units` | `1` | 单次 search.list 配额成本（单位） |
| `youtube_daily_quota_units` | `10000` | YouTube 合并桶每日配额（videos/comments/categories 共享） |
| `youtube_videos_batch_size` | `50` | videos.list 单批查询视频数上限 |
| `youtube_comments_top_n` | `10` | 每条视频抓取的评论数（点赞最高的前 N 条） |
| `youtube_fallback_enabled` | `true` | search 桶耗尽时自动降级 videos.list mostPopular（热门榜，合并桶计费） |
| `youtube_fallback_popular_pages` | `2` | 降级热门榜最多翻页数（每页 50 条） |
| `x_credits_per_run` | `3750` | X 每次抓取的 credits 预算上限（= 250 条推文） |
| `x_credits_per_tweet` | `15` | X 单条推文 credits 成本 |
| `x_credits_per_article` | `100` | X 长文（Twitter Article）单篇 credits 成本 |
| `max_output_items_daily` | `5` | 每日公开热点最大数（无 YouTube 时 = 5，即"3~5"的上限） |
| `min_output_items_daily` | `3` | 每日公开热点目标最小数（R1 拍板，投影不强凑；不足 3 条按实际显示） |
| `max_output_with_youtube` | `8` | 当日有 YouTube 候选进池时公开最大数（"3~8"的上限） |
| `review_top_pure_x` | `10` | 纯 X 日人工审 top N（`min-review list --top` 缺省值） |
| `review_top_with_youtube` | `15` | 有 YouTube 日人工审 top N（同上） |
| `concurrency` | `5` | 并发上限：YouTube 评论抓取 + AI 分类/审核并发池 |
| `request_timeout_ms` | `15000` | 单次网络请求超时（毫秒） |
| `max_retries` | `2` | 网络请求失败重试次数 |
| `retry_base_ms` | `750` | 重试退避基数（毫秒，递增） |
| `twitter_api_base_url` | `https://api.twitterapi.io` | TwitterAPI.io 基地址 |

## long_term_quality —— 来源长期质量分

| 字段 | 默认值 | 说明 |
|---|---|---|
| `observation_period_count` | `3` | 观察期：频道视频数 ≤3 走观察分（20–60） |
| `observation_score_range` | `[20, 60]` | 观察分区间（三率加权压缩映射） |
| `window_n` | `10` | 长期分滑动窗口取最近 N 个样本 |
| `window_months_youtube` | `6` | YouTube 长期分窗口时限（月，超过不计入） |
| `window_months_x` | `2` | X 长期分窗口时限（月） |
| `min_samples` | `5` | 样本数 ≥5 走真实长期分（0–100）；3~4 走观察分；<3 中性 |
| `neutral_score` | `50` | 样本不足时长期分中性值 |

## review —— 审核档位

| 字段 | 默认值 | 说明 |
|---|---|---|
| `l1_input_include_comments` | `true` | L1 AI 审核是否把点赞最高 N 条评论拼进输入 |
| `l1_comments_top_n` | `10` | L1 审核取评论条数（点赞最高前 N） |
| `l1_confidence_auto_discard` | `0.9` | L1 判 discard 且置信度 ≥ 此值才自动剔除 |
| `l2_enabled` | `true` | 是否生成 L2 AI 辅助建议（供人工参考，不自动改状态） |

## keywords —— 关键词表与提纯

| 字段 | 默认值 | 说明 |
|---|---|---|
| `ai_keywords` | `[20 词]` | AI 关键词表：L0 硬过滤判定 + 提纯剔除基准 + 采集搜索词 |
| `refine_high_frequency_top_n` | `5` | 提纯高频候选取前 N 个 |

## x_accounts —— X 博主名单

`[31 个 handle]`：X 采集的博主名单（`热点信息源清单.md` X 部分全部保留）。

## feedback —— 工具/概念反哺

| 字段 | 默认值 | 说明 |
|---|---|---|
| `tool_feedback` | `true` | 从 approved summary 提取工具名 → 比对工具库 → 缺则待补卡 |
| `concept_feedback` | `true` | 从 approved summary 提取概念名 → 比对概念库 → 缺则待补卡 |

## transcripts —— 字幕通知

| 字段 | 默认值 | 说明 |
|---|---|---|
| `notify_count` | `"3to5"` | 每次通知字幕的视频数区间（`"3to5"` 取低值 3；数值原样取） |

## scoring —— 评分权重

| 字段 | 默认值 | 说明 |
|---|---|---|
| `weights.long_term_quality` | `0.20` | 长期专业质量权重 |
| `weights.recent_timeliness` | `0.15` | 时效权重（指数衰减） |
| `weights.light_user_experience` | `0.05` | 轻度用户体验权重（实测/上手等信号词） |
| `weights.source_reliability` | `0.15` | 来源可靠性权重（仅 X，看认证；YouTube 并入长期质量） |
| `weights.interaction_quality` | `0.15` | 互动质量权重（三率：综合参与率主 + 赞评比修正 + 点赞率最小加分） |
| `weights.type_preference` | `0.30` | 类型偏好权重（实用 > 技术，最高项） |
| `type_preference_score.*` | 见下表 | 各内容类型的类型分 |
| `neutral_score` | `50` | 评分中性兜底值 |

**type_preference_score**（类型偏好分，对应权重 0.30）：

| 类型 | 分 | 含义 |
|---|---|---|
| `ai_tool` | 90 | AI 工具（实用，最高） |
| `ai_product` | 90 | AI 产品（实用，最高） |
| `ai_concept` | 60 | AI 概念 |
| `ai_industry` | 60 | AI 行业事件 |
| `ai_technology` | 40 | AI 技术/论文（实用度低，最低） |
| `other` | 50 | 其他 |
| `unclassified` | 50 | 未分类 |

## manual_folder —— 人工维护文件夹

`"data/manual"`：需人工修改的内容（字幕清单 / 关键词提纯候选 / 待补工具卡）统一输出到此目录，固定格式生成，入库但不发布到站点。
