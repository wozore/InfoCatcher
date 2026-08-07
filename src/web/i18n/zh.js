/**
 * zh.js —— 简体中文语言字典（前端 i18n 框架，试点：热点视图 + 共享工具）
 *
 * 框架约定：
 *   - 每个语言一个文件（zh.js / 未来 en.js ...），导出 { messages }；
 *   - key 命名空间：视图.元素（trending.*）/ 通用.概念（common/labels/timeAgo/metric）；
 *   - 占位符 {name} 由 i18n.js 的 t(key, {name}) 插值；
 *   - 试点接入范围：热点视图（trending）+ data.js 共享工具；
 *     其余视图（tools/search/compare/featured/glossary/scenes）文案后续接入。
 */

export const messages = {
  common: {
    reload: '重新加载',
  },

  // 通用标签（data.js 的 contentTypeLabels / SOURCE_TYPE_LABELS / platformMeta 从这里初始化）
  labels: {
    contentType: {
      ai_tool: 'AI 工具',
      ai_product: 'AI 产品',
      ai_concept: 'AI 概念',
      ai_technology: 'AI 技术动态',
      ai_industry: 'AI 行业事件',
      other: '其他',
      unclassified: '类型待确认',
    },
    sourceType: {
      youtube_video: 'YouTube 视频',
      x_post: 'X 帖子',
      bilibili_video: 'B站视频',
      bilibili_dynamic_video: 'B站视频',
      bilibili_dynamic_repost: 'B站转发动态',
      bilibili_dynamic_text: 'B站动态',
      bilibili_article: 'B站专栏',
      unknown: '来源类型未知',
    },
    platform: {
      youtube: 'YouTube',
      x: 'X',
      bilibili: 'B站',
    },
    // 热点按唯一内容发布时间分组标签（trending.js getTrendingGroupLabel）
    group: {
      today: '今天',
      yesterday: '昨天',
      last7d: '近 7 天',
      earlier: '更早',
      unknown: '时间未知',
    },
    // 字段缺失时的兜底文案（trending.js / 其他视图）
    fallback: {
      title: '标题暂不可用',
      preview: '来源描述暂不可用',
      type: '类型未知',
      platform: '平台未知',
      author: '来源信息待补充',
      sourceType: '来源类型未知',
      published: '发布时间未知',
      evidence: '暂无可展示的直接依据。当前公开投影未提供可定位的审核依据片段。',
      related: '关联资料暂不可用。当前公开投影没有稳定的工具、概念或场景关联 ID。',
      summary: '内容摘要暂不可用。',
      sourceLink: '原始来源链接暂不可用。',
    },
  },

  // 相对时间（data.js timeAgo）
  timeAgo: {
    unknown: '时间未知',
    justNow: '刚刚',
    minutes: '{n} 分钟前',
    hours: '{n} 小时前',
    days: '{n} 天前',
  },

  // 互动指标数量格式化（data.js formatMetric）
  metric: {
    tenThousand: '{n}万',
    thousand: '{n}千',
  },

  // 热点视图（trending.js + index.html trending 部分静态文案）
  trending: {
    eyebrow: '公开内容流',
    viewTitle: '浏览已收录的 AI 热点',
    viewLead: '按公开内容类型与发布时间阅读已收录的热点内容；平台、时间与依据在来源中核验，描述与互动字段缺失时会明确标注。',
    overviewTitle: '公开数据状态',
    overviewLead: '这里只显示浏览器可读取的公开热点投影；采集覆盖或更新时间不足时会明确提示。',
    directoryEyebrow: '热点目录',
    directoryTitle: '按内容类型与时间阅读',
    directoryLead: '类型来自公开 content_type；平台、时间与依据在来源中核验，不展示内部评分明细、候选溯源或审核状态。',
    controlsAria: '热点筛选与排序',
    filterTypeLabel: '内容类型',
    filterTypeAria: '公开内容类型',
    sortLabel: '排序',
    sortAria: '热点排序方式',
    countSuffix: '条内容',
    notCollected: '尚未采集',
    generated: '生成于 {time}',
    filter: {
      allTypes: '全部类型',
      cleared: '已清除热点筛选',
    },
    sort: {
      recent: '最近',
      hot: '热度',
      helpToggle: '热度说明',
      helpWithHeat: '热度排序按公开投影中的热度字段倒序，只改变阅读顺序，不改变内容类型、来源与审核状态；热度数值默认不展示。',
      helpWithoutHeat: '当前公开投影暂未提供可比较的热度字段，选择“热度”时仍按最近时间倒序；该字段由数据契约补充后自动生效，不会伪造排序。',
    },
    status: {
      loadFailed: '加载失败：公开热点数据暂时无法读取。请刷新页面重试；其他资料视图仍可使用。',
      building: '公开投影建设中：尚未生成可供浏览器读取的热点内容，请等待公开构建完成。',
      empty: '暂无公开热点：公开投影已生成，但当前没有可展示内容。',
      coverageUnavailable: '覆盖信息暂不可用：继续展示已生成的公开内容，不能据此推断全部来源的近期状态。',
      bilibiliManual: '人工收录：B站当前采用人工精选收录，自动订阅已暂停；已有内容仍保留原始链接，未收录不代表来源近期没有更新。',
      bilibiliBlocked: '部分不可用：B站自动订阅入口被服务提供方拦截，本轮已快速停止后续请求；页面继续展示上一版及人工精选内容。',
      degraded: '部分数据降级：{platforms}。缺失会降低判断置信度，不代表来源质量下降。',
      collectComplete: '采集完成：本轮自动来源采集已完成。',
      bilibiliDynamic: 'B站动态',
      reloading: '正在重新加载：正在读取公开热点数据。',
      reloaded: '热点数据已重新加载',
      reloadFailed: '热点数据重新加载失败',
    },
    card: {
      viewSource: '查看来源',
      openDetail: '打开详情',
      sourcePlatform: '来源平台',
      sourceType: '来源类型',
      sourceName: '来源名称',
      contentTime: '内容时间',
      updatedAt: '数据更新于',
      evidence: '依据片段：',
      openOriginal: '打开原始来源（将离开当前页面）',
    },
    detail: {
      close: '关闭热点详情',
      summary: '内容摘要',
      sources: '来源核验',
      related: '关联资料',
      author: '来源作者',
      tools: '工具',
      concepts: '概念',
      scenes: '场景',
      resourceUnavailable: '资料暂不可用',
    },
    metric: {
      views: '浏览',
      likes: '点赞',
      comments: '评论',
      reposts: '转发',
      replies: '回复',
    },
    empty: {
      loadFailedTitle: '热点数据加载失败',
      loadFailedMsg: '公开热点数据暂时无法读取。采集失败不会用空结果覆盖上一版数据。',
      noMatchTitle: '当前筛选没有匹配内容',
      noMatchMsg: '当前内容类型下没有可展示的热点，可清除筛选后查看全部。',
      noPublicTitle: '暂无公开热点',
      noPublicMsg: '公开投影已生成，但当前没有可展示内容。候选内容需经 AI 处理与人工审核后才会公开。',
      buildingTitle: '公开投影建设中',
      buildingMsg: '热点资料正在建立中：旧资料与新采集内容正在整理与审核，通过后逐步公开。',
      gotoAbout: '了解审核与来源规则',
      gotoTools: '返回工具库',
      clearFilters: '清除筛选',
    },
  },
};
