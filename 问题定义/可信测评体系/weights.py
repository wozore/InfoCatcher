#!/usr/bin/env python3
"""
可信测评体系 —— 权重计算层

归一化公式（要求）：
    维度权重 = 该维度评分 / 所有维度评分之和

输入：{ 维度key: 评分(int 1-5) }，未填写的维度不出现或值为 None。
输出：{ 维度key: 权重(0-1) }，并保证所有返回权重之和 == 1.0（处理四舍五入误差）。

设计要点：
    1. 未填写维度：不具备评分，不纳入分母，权重为 0。
    2. 非法输入：非整数、超出 1-5 范围 → 抛出 ValueError，由调用方做校验提示。
    3. 全部未填写：返回空 dict（避免 0 除法），由调用方提示用户至少填写一项。
    4. 四舍五入误差：采用"最大余数法"修正，使百分比之和精确为 100%。
"""

from __future__ import annotations

from typing import Optional

from dimensions_config import SCALE_MIN, SCALE_MAX


class WeightError(ValueError):
    """权重计算相关错误（非法输入、维度未识别等）。"""


def _coerce_score(raw: object) -> Optional[int]:
    """
    把单个原始评分规约成 int 或 None。
    规则：
      - None / 空字符串 → None（视为未填写）
      - bool → 拒绝（bool 是 int 子类，易混淆，应作非法值）
      - 可被 int() 解析的数字（含 "3" / 3.0）→ int
      - 不合法 → 抛 WeightError
    """
    if raw is None:
        return None
    if isinstance(raw, bool):                 # 见上：拒绝 True/False
        raise WeightError(f"非法评分值(布尔): {raw!r}")
    if isinstance(raw, str):
        s = raw.strip()
        if s == "":
            return None
        # 仅接受纯数字字符串，避免 "3.0" 之外 float 字符串与分数混入
        try:
            if "." in s:                       # 允许 "3.0" 这类整值浮点
                f = float(s)
                if f != int(f):
                    raise WeightError(f"评分必须为整数, 收到 {raw!r}")
                return int(f)
            return int(s)
        except ValueError:
            raise WeightError(f"非法评分值(无法解析为整数): {raw!r}")
    if isinstance(raw, float):
        if raw != int(raw):
            raise WeightError(f"评分必须为整数, 收到 {raw!r}")
        return int(raw)
    if isinstance(raw, int):
        return raw
    raise WeightError(f"不支持的评分类型: {type(raw).__name__}={raw!r}")


def _validate_range(score: int, key: str) -> None:
    """校验评分落在 [SCALE_MIN, SCALE_MAX] 区间。"""
    if not isinstance(score, int):
        raise WeightError(f"评分应为整数: {key}={score!r}")
    if score < SCALE_MIN or score > SCALE_MAX:
        raise WeightError(
            f"评分超出范围[{SCALE_MIN},{SCALE_MAX}]: {key}={score}"
        )


def compute_raw_weights(scores: dict) -> dict:
    """
    计算未做舍入处理的精确权重。

    返回 {key: float 权重}，未填写维度不出现于结果中。
    若所有维度都未填写，返回 {}。
    若传入评分非法，抛 WeightError。
    """
    if not isinstance(scores, dict):
        raise WeightError(f"scores 必须为 dict, 收到 {type(scores).__name__}")

    valid: dict[str, int] = {}
    for key, raw in scores.items():
        score = _coerce_score(raw)
        if score is None:
            continue                            # 未填写 → 不参与
        _validate_range(score, str(key))
        valid[str(key)] = score

    total = sum(valid.values())
    if total <= 0:
        return {}                              # 全部未填写或评分破坏性为 0 → 空

    return {key: score / total for key, score in valid.items()}


def normalize_weights(scores: dict, *, round_decimals: int = 4) -> dict:
    """
    生成归一化权重，并处理四舍五入误差，使权重总和精确为 1.0。

    参数:
        scores:  { 维度key: 评分 } 评分字典
        round_decimals: 权重保留小数位（默认 4 位，约 0.01% 精度）

    处理过程:
        1) 调 compute_raw_weights 得精确权重
        2) 各维度按 round_decimals 四舍五入
        3) 用"最大余数法"把舍入导致的误差分摊给舍入后最大的若干维度
        4) 再次校验 sum == 1.0

    返回: {"sum": 1.0, "weights": {key: 权重}}
         未填写维度不出现在 weights 中。

    特殊返回: {"sum": 0.0, "weights": {}}  表示全部未填写。

    抛错: 非法评分 → WeightError
    """
    if round_decimals < 0 or not isinstance(round_decimals, int):
        raise WeightError(f"round_decimals 必须为非负整数, 收到 {round_decimals!r}")

    raw_weights = compute_raw_weights(scores)
    if not raw_weights:
        return {"sum": 0.0, "weights": {}}

    # ---------- 四舍五入 + 最大余数法 ----------
    q = 10 ** round_decimals
    target = q                                   # 总份额 = 1.0 * q
    floored = {k: int(w * q) for k, w in raw_weights.items()}
    assigned = sum(floored.values())
    remainder = target - assigned                  # 需要再分配的最小单位

    # 按舍入丢弃量从大到小排序；丢弃量相同则按精确权重从大到小，保证稳定
    def loss_key(k):
        return (raw_weights[k] * q - floored[k], raw_weights[k])

    sorted_keys = sorted(raw_weights, key=loss_key, reverse=True)

    # 把 remainder 个单位分给丢弃量最大的若干维度
    adjusted = dict(floored)
    for i in range(remainder):
        adjusted[sorted_keys[i % len(sorted_keys)]] += 1

    weights = {k: v / q for k, v in adjusted.items()}

    # ---------- 最终校验 ----------
    s = sum(weights.values())
    # 浮点比较容差
    if abs(s - 1.0) > 1e-12:
        # 理论上最大余数法可保证精确，落至此说明实现有误，显式抛错而非静默
        raise WeightError(f"权重归一化失败, 总和={s} (期望1.0)")

    return {"sum": round(s, round_decimals), "weights": weights}


def weights_to_percent_report(weights_result: dict, *, decimals: int = 2) -> dict:
    """
    把归一化权重转成 0-100 的百分比展示形式（不改变总和=100% 性质）。

    用于界面与持久化时的可读展示。
    不重新做最大余数法修正，仅放大 100 倍并按小数保留；若有极小尾差，
    由 normalize_weights 在 0-1 层面已修正，此处保持线性。
    """
    weights = weights_result.get("weights", {})
    if not weights:
        return {"sum": 0.0, "percents": {}}
    percents = {k: round(w * 100, decimals) for k, w in weights.items()}
    # 因 normalize 已修正四舍五入，此处直接 round 通常即为 100；保留 fuzzy 检查
    s = round(sum(percents.values()), decimals)
    return {"sum": s, "percents": percents}