#!/usr/bin/env python3
"""
可信测评体系 —— 测评数据维度配置层

本文件从《调查结果总结.md》中提取"可信测评体系"所关切的测评维度。
所有维度名称与含义均可在文档对应章节找到出处，未自行虚构层级与归并关系。

⚠️ 待业务确认说明
=================
《调查结果总结.md》§8.2 将"可信测评体系"列为 P0 功能方向，但文档仅给出用户痛点
与选型关注点，并未直接定义"可信测评体系"自身的维度清单与层级结构。
本配置以如下方式从用户已采集信息中抽取候选维度：

  - 一级维度：对 Q16「选择 AI 工具时最看重的因素」(§5.13) 的选项做语义归并。
  - 二级维度：综合 Q16 选型因素 + Q12「判断时最缺的信息」(§5.9) + Q18 痛点维度(§5.15)
    中与"测评该看重什么"直接相关的条目，逐条保留文档原话。

"一级维度 → 二级维度"的归并对应关系为推断结果，标记 [待业务确认]；
若业务方后续给出权威测评维度清单，仅需替换本文件即可，宿主(问卷/计算/存储)无需改动。
"""

from __future__ import annotations

# ============================================================
# 问卷版本：维度集合若发生变更须递增，用于持久化结果追溯
# ============================================================
QUESTIONNAIRE_VERSION = "v1.1.0-pending-business-confirm"

# 维度来源标签：区分来自本地调研文档与联网补充（便于业务确认与署名）
ORIGIN_LOCAL_SURVEY = "local-survey"     # 出自《调查结果总结.md》
ORIGIN_WEB_RESEARCH = "web-research"     # 联网补充（HELM/Credo AI/欧盟 TAI/中文实测等）

# 重要性 1-5 分制
SCALE = {
    1: "完全不重要",
    2: "不太重要",
    3: "一般",
    4: "重要",
    5: "非常重要",
}
SCALE_MIN = 1
SCALE_MAX = 5


# ============================================================
# 维度配置：一级 → 二级
#
# 每个维度字段：
#   key         统一标识（程序内部使用）
#   name        展示名（来自文档相关条目原话）
#   description 简要说明（描述该维度在"可信测评"中评测什么）
#   source      文档出处标注
#   pending     是否为"待业务确认"项（归并/命名层面的推断）
# ============================================================
EVALUATION_DIMENSIONS = [
    {
        "key": "capability",
        "name": "能力与质量",
        "description": "AI 工具在核心能力上的真实表现，包括功能是否满足需求、输出质量与准确性。",
        "pending": True,          # 归并方式待业务确认
        "sub_dimensions": [
            {
                "key": "functional_fit",
                "name": "功能是否满足需求",
                "description": "工具功能能否覆盖具体使用场景的需求。",
                "source": "Q16 §5.13 选择因素（84.8%）",
                "pending": False,
            },
            {
                "key": "output_quality",
                "name": "输出质量和准确性",
                "description": "工具生成内容的质量、准确度与可靠性。",
                "source": "Q16 §5.13 选择因素（76.8%）/ Q18 §5.15「AI 输出质量不理想」",
                "pending": False,
            },
            {
                "key": "scenario_performance",
                "name": "具体场景下的真实表现",
                "description": "工具在具体场景（写周报/做 PPT/写代码/翻译等）下的真实表现。",
                "source": "Q12 §5.9 缺失信息（72.3%）",
                "pending": False,
            },
            {
                # 联网补充：中文 AI 绘图/视频测评常用「可控性」维度（ControlNet/参数/出图可调度）
                "key": "controllability",
                "name": "可控性",
                "description": "用户对生成结果的可控程度（如参数调参、ControlNet、风格/内容约束、输出可复现性）。",
                "source": "web: 中文 AI 绘图测评对比维度（Midjourney/SD/文心一格）",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
        ],
    },
    {
        "key": "trustworthiness",
        "name": "可信度与客观性",
        "description": "评测本身是否客观、可分辨、去营销，是否提供真实横向对比与用户反馈。",
        "pending": True,          # 归并方式待业务确认
        "sub_dimensions": [
            {
                "key": "cross_comparison",
                "name": "同类工具横向对比",
                "description": "提供同类工具的直接对比，而非孤立介绍。",
                "source": "Q12 §5.9 缺失信息（52.7%）",
                "pending": False,
            },
            {
                "key": "real_user_feedback",
                "name": "真实用户评价与反馈",
                "description": "提供真实用户而非 KOL 的使用评价和反馈。",
                "source": "Q12 §5.9 缺失信息（39.3%）/ §8.2 P2 真实用户评价社区",
                "pending": False,
            },
            {
                "key": "review_authenticity",
                "name": "评测客观、可分辨广告",
                "description": "评测可分辨客观评价与付费广告，避免软文与夸大宣传。",
                "source": "Q18 §5.15「分不清评测真假」/ Q10 §5.10（仅 10.7% 信任）/ Q9 §5.9",
                "pending": False,
            },
            {
                "key": "marketing_gap",
                "name": "宣传与实际体验一致性",
                "description": "关注宣传效果与实际使用体验是否一致，规避『被宣传吸引但失望』。",
                "source": "Q18 §5.15「工具宣传和实际体验差距大」/ Q21 §5.18 主题①",
                "pending": False,
            },
        ],
    },
    {
        "key": "usability",
        "name": "易用性与上手成本",
        "description": "工具的学习曲线、上手难度及访问便利性。",
        "pending": True,          # 归并方式待业务确认
        "sub_dimensions": [
            {
                "key": "ease_of_use",
                "name": "使用体验与上手难度",
                "description": "工具的使用体验如何、上手门槛高低。",
                "source": "Q16 §5.13 选择因素（41.1%）",
                "pending": False,
            },
            {
                "key": "learning_cost",
                "name": "学习成本评估",
                "description": "对上手难度和学习成本的明确评估。",
                "source": "Q12 §5.9 缺失信息（24.1%）",
                "pending": False,
            },
            {
                "key": "accessibility",
                "name": "访问便利（是否需科学上网）",
                "description": "访问是否方便、是否需要科学上网等门槛。",
                "source": "Q16 §5.13 选择因素（17.0%）/ §7.2 支付门槛",
                "pending": False,
            },
            {
                # 联网补充：HELM efficiency 维 / Credo AI Model Trust Scores「speed」
                "key": "response_efficiency",
                "name": "响应速度与效率",
                "description": "响应延迟、tokens/秒、并发与吞吐、能耗与资源占用等运行效率。",
                "source": "web: HELM efficiency 维 / Credo AI Model Trust Scores「speed」",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
            {
                # 联网补充：企业选型框架 ecosystem fit / 中文实测「集成与 API 能力」+「社区支持」
                "key": "ecosystem_integration",
                "name": "生态集成与社区支持",
                "description": "API/SDK 完备度、与现有工具链兼容性（如 OpenAI 兼容调用）、文档质量与开发者社区活跃度。",
                "source": "web: 企业 AI 选型框架 ecosystem fit / 中文文本 AI 测评「集成性/社区支持/文档质量」",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
        ],
    },
    {
        "key": "cost",
        "name": "价格与权益透明性",
        "description": "价格、免费额度、会员权益与使用限制的透明度，对应『付费焦虑』。",
        "pending": True,          # 归并方式待业务确认
        "sub_dimensions": [
            {
                "key": "price_value",
                "name": "价格与性价比",
                "description": "工具的价格与性价比是否清晰、值不值得付费。",
                "source": "Q16 §5.13 选择因素（51.8%）/ Q18 §5.15「不确定是否值得付费」M=3.46（最高）",
                "pending": False,
            },
            {
                "key": "free_quota",
                "name": "免费额度与会员权益",
                "description": "是否有免费版/免费额度是否足够、会员权益的清晰说明。",
                "source": "Q16 §5.13（35.7%）/ Q12 §5.9（35.7%）",
                "pending": False,
            },
            {
                "key": "usage_limits",
                "name": "使用限制透明度",
                "description": "对使用限制的透明信息说明。",
                "source": "Q12 §5.9 缺失信息（25.9%）",
                "pending": False,
            },
            {
                # 联网补充：企业选型框架「TCO Beyond Licensing」
                "key": "total_cost_of_ownership",
                "name": "总拥有成本（TCO）",
                "description": "除订阅价外，部署、培训、运维、数据准备与迁移等隐性/长期成本。",
                "source": "web: 企业 AI 工具选型框架 TCO Beyond Licensing",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
        ],
    },
    {
        "key": "compliance_localization",
        "name": "合规与本地化",
        "description": "数据安全、隐私政策、内容版权、商用许可与中文支持的实际情况。",
        "pending": True,          # 归并方式待业务确认
        "sub_dimensions": [
            {
                "key": "data_privacy",
                "name": "数据安全与隐私政策",
                "description": "数据安全与隐私政策说明是否充分。",
                "source": "Q16 §5.13（18.8%）/ Q12 §5.9（17.0%）",
                "pending": False,
            },
            {
                "key": "copyright_license",
                "name": "内容版权与商用许可",
                "description": "内容版权与商用许可信息是否说明。",
                "source": "Q12 §5.9 缺失信息（6.2%）",
                "pending": True,   # 该候选维度选择率低，是否纳入测评待业务确认
            },
            {
                "key": "chinese_support",
                "name": "中文支持真实情况",
                "description": "是否支持中文、中文表现的真实情况。",
                "source": "Q16 §5.13（17.9%）/ Q12 §5.9（6.2%）",
                "pending": False,
            },
        ],
    },
    {
        # 联网补充一级维度：模型本身的可信与安全属性。
        # 依据 Stanford HELM 七维、Credo AI Model Trust Scores、欧盟 TAI 七原则、
        # EvalCommunity 评测标准、Springer 可信框架等。文档（调研结果总结）未覆盖，
        # 全部二级维度标记 pending，待业务确认是否纳入面向学生群体的测评体系。
        "key": "model_trust_and_safety",
        "name": "模型可信与安全",
        "description": "模型本身的可信与安全属性：鲁棒性、不确定性标定、幻觉抑制、毒性、公平、可解释性。",
        "pending": True,
        "origin": ORIGIN_WEB_RESEARCH,
        "sub_dimensions": [
            {
                "key": "robustness",
                "name": "鲁棒性（抗扰动）",
                "description": "输入含错字/扰动/对抗提示或分布偏移时，性能是否稳定。",
                "source": "web: HELM robustness 维",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
            {
                "key": "calibration",
                "name": "不确定性标定",
                "description": "模型表达的置信度与实际正确性是否一致（能否『承认不会』而非过度自信）。",
                "source": "web: HELM calibration 维 / Credo AI Model Trust Scores",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
            {
                "key": "hallucination_reliability",
                "name": "幻觉抑制/事实可靠性",
                "description": "是否倾向于编造不存在的事实、引用、软件包等；事实可靠性。",
                "source": "web: Stanford Legal RAG 幻觉研究 / OWASP LLM09 Overreliance / IBM",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
            {
                "key": "toxicity_harm",
                "name": "毒性/有害内容安全",
                "description": "生成有害、冒犯或不当内容的倾向，以及安全护栏是否到位。",
                "source": "web: HELM toxicity 维 / 欧盟 TAI 安全原则",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
            {
                "key": "fairness_bias",
                "name": "公平性与偏见",
                "description": "是否对不同人群/群体表现系统差异，输出是否含偏见或刻板印象。",
                "source": "web: HELM fairness/bias 维 / EvalCommunity 评测标准 / 欧盟 TAI",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
            {
                "key": "explainability_transparency",
                "name": "可解释性/透明度",
                "description": "能否说明为何如此输出，是否提供 Model Card/能力局限披露等透明信息。",
                "source": "web: EvalCommunity Transparency&Explainability / MDPI 四维 SAFE / NIST AI RMF",
                "pending": True,
                "origin": ORIGIN_WEB_RESEARCH,
            },
        ],
    },
]


# ============================================================
# 便利函数：把配置展平成"可评分维度"的有序列表
# ============================================================
def list_scoring_dimensions() -> list[dict]:
    """
    返回 QUESTIONNAIRE 中所有可被评分的二级维度的有序列表（保留层级上下文）。
    用于问卷渲染与权重计算。
    """
    items: list[dict] = []
    for primary in EVALUATION_DIMENSIONS:
        primary_origin = primary.get("origin", ORIGIN_LOCAL_SURVEY)
        for sub in primary["sub_dimensions"]:
            items.append({
                "key": sub["key"],
                "name": sub["name"],
                "description": sub["description"],
                "primary_key": primary["key"],
                "primary_name": primary["name"],
                "source": sub.get("source", ""),
                "pending": sub.get("pending", False),
                "origin": sub.get("origin", primary_origin),
            })
    return items


# 待业务确认项汇总（供界面与输出使用）
def list_pending_items() -> list[str]:
    items: list[str] = []
    for primary in EVALUATION_DIMENSIONS:
        if primary.get("pending"):
            items.append(f"一层归并「{primary['name']}」的分组方式")
    for sub in list_scoring_dimensions():
        if sub.get("pending"):
            items.append(f"二级维度「{sub['name']}」是否纳入测评")
    return items


if __name__ == "__main__":
    dims = list_scoring_dimensions()
    print(f"问卷版本: {QUESTIONNAIRE_VERSION}")
    print(f"一级维度数: {len(EVALUATION_DIMENSIONS)}  二级(可评分)维度数: {len(dims)}")
    print(f"待业务确认项数: {len(list_pending_items())}")
    print("-" * 60)
    for primary in EVALUATION_DIMENSIONS:
        flag = " [待业务确认]" if primary.get("pending") else ""
        porigin = "联网补充" if primary.get("origin", ORIGIN_LOCAL_SURVEY) == ORIGIN_WEB_RESEARCH else "本地调研"
        print(f"【一级·{porigin}】{primary['name']}{flag}")
        for sub in primary["sub_dimensions"]:
            sflag = " [待业务确认]" if sub.get("pending") else ""
            sorigin = "联网补充" if sub.get("origin", primary.get("origin", ORIGIN_LOCAL_SURVEY)) == ORIGIN_WEB_RESEARCH else "本地调研"
            print(f"    - {sub['name']}{sflag}  ({sub.get('source', '')})  [{sorigin}]")