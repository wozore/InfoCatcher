#!/usr/bin/env python3
"""
可信测评体系 —— 测评数据维度重要性问卷（CLI 界面）

职责拆分：
    - 渲染维度名 + 简要说明 + 1-5 重要性选项
    - 收集用户评分，提供校验提示（未填写 / 非法输入）
    - 显示提交状态
    - 调用 weights.normalize_weights 计算权重
    - 调用 storage 持久化(评分 / 归一化权重 / 问卷版本 / 提交时间)
    - 展示最终权重结果

可独立运行：python questionnaire.py
也可 import Questionnaire 复用。
"""

from __future__ import annotations

import sys
from typing import Optional

from dimensions_config import (
    EVALUATION_DIMENSIONS,
    QUESTIONNAIRE_VERSION,
    SCALE,
    SCALE_MAX,
    SCALE_MIN,
    list_scoring_dimensions,
)
from weights import WeightError, normalize_weights, weights_to_percent_report
from storage import load_latest, save_submission


QUESTIONNAIRE_TITLE = "测评数据维度重要性问卷"
QUESTIONNAIRE_INTRO = (
    "请对「可信测评体系」中各维度的重要性评分（1=完全不重要 … 5=非常重要）。\n"
    "维度与说明从《调查结果总结.md》提取；归并关系标注为「待业务确认」的维度,\n"
    "请依据您对业务的理解予以评分或留空（留空不参与权重计算）。\n"
    "权重公式: 维度权重 = 该维度评分 / 所有已填写维度评分之和。\n"
)


def _format_dimension_block(idx: int, dim: dict) -> str:
    """格式化单个可评分维度的展示块。"""
    pending_flag = " [待业务确认]" if dim.get("pending") else ""
    lines = [
        f"[{idx:02d}] {dim['name']}{pending_flag}",
        f"    所属一级维度: {dim['primary_name']}",
        f"    说明: {dim['description']}",
        f"    文档出处: {dim.get('source', '-')}",
        f"    重要性选项: {SCALE_MIN}=完全不重要  2=不太重要  3=一般  4=重要  {SCALE_MAX}=非常重要  (回车=留空)",
    ]
    return "\n".join(lines)


class Questionnaire:
    """问卷交互对象。"""

    def __init__(self, *, input_fn=input, print_fn=print):
        self._input = input_fn
        self._print = print_fn
        self.dims = list_scoring_dimensions()

    # ---- 界面 ----
    def show_intro(self) -> None:
        self._print("=" * 72)
        self._print(f"{QUESTIONNAIRE_TITLE}  ({QUESTIONNAIRE_VERSION})")
        self._print("=" * 72)
        self._print(QUESTIONNAIRE_INTRO)
        self._print(f"该版本共 {len(self.dims)} 个可评分维度 / "
                    f"{len(EVALUATION_DIMENSIONS)} 个一级维度。\n")

    # ---- 单个维度输入 ----
    def ask_score(self, idx: int, dim: dict) -> Optional[int]:
        self._print(_format_dimension_block(idx, dim))
        while True:
            raw = self._input(f"    > 请输入 {SCALE_MIN}-{SCALE_MAX} (回车留空): ").strip()
            if raw == "":
                self._print(f"    (信息提示) 已留空 {dim['name']}，该维度不参与权重计算。")
                return None
            try:
                score = int(raw)
            except ValueError:
                self._print(f"    (校验提示) 非法输入『{raw}』；请输入 {SCALE_MIN}-{SCALE_MAX} 的整数或回车留空。")
                continue
            if not (SCALE_MIN <= score <= SCALE_MAX):
                self._print(f"    (校验提示) 越界：{score} 不在 {SCALE_MIN}-{SCALE_MAX} 范围内, 请重新输入。")
                continue
            return score

    # ---- 收集 ----
    def collect(self) -> dict:
        scores: dict = {}
        self.show_intro()
        for i, dim in enumerate(self.dims, start=1):
            scores[dim["key"]] = self.ask_score(i, dim)
            self._print("-" * 40)
        return scores

    # ---- 计算与提交 ----
    def submit(self, scores: dict) -> Optional[dict]:
        # 过滤展示用加权字典
        filled = {k: v for k, v in scores.items() if v is not None}
        if not filled:
            self._print("\n(提交状态) 您未填写任何维度, 本次不会生成权重。请至少填写一项后再提交。")
            return None
        try:
            result = normalize_weights(scores)
        except WeightError as e:
            self._print(f"\n(提交状态) 权重计算失败: {e}")
            return None

        percents = weights_to_percent_report(result)
        record = save_submission(scores, result, percents, QUESTIONNAIRE_VERSION)

        self._print("\n" + "=" * 72)
        self._print("(提交状态) 已提交并保存。")
        self._print(f"问卷版本: {QUESTIONNAIRE_VERSION}")
        self._print(f"提交时间: {record['submitted_at']}")
        self._print(f"填写维度数: {len(filled)} / {len(self.dims)}")
        self._print("=" * 72)
        self._print("最终权重结果:")
        self._print_dataset(result, percents)
        return record

    def _print_dataset(self, result: dict, percents: dict) -> None:
        key_to_name = {d["key"]: d["name"] for d in self.dims}
        weights = result["weights"]
        pct = percents["percents"]
        # 按权重降序展示
        for key in sorted(weights, key=lambda k: weights[k], reverse=True):
            name = key_to_name.get(key, key)
            self._print(f"  {name:32s}  {weights[key]*100:6.2f}%   (百分位={pct.get(key, 0.0):.2f}%)")
        self._print(f"  {'总和':32s}  {result['sum']*100:6.2f}%")


def run_cli() -> None:
    q = Questionnaire()
    scores = q.collect()
    q.submit(scores)


if __name__ == "__main__":
    run_cli()