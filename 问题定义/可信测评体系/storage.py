#!/usr/bin/env python3
"""
可信测评体系 —— 持久化层（本地存储 / Mock 后端）

当前项目无后端接口，采用本地 JSON 文件作为 Mock 后端，
保存：各维度评分、归一化权重、问卷版本、提交时间。

存储结构（单一对象 / 一次提交一条记录）：
{
    "questionnaire_version": "v1.0.0-...",
    "submitted_at": "2026-07-14T12:34:56",
    "scores":    { "%B_" }}
    "weights":   { "sum": 1.0, "weights": { ... } },
    "percents":  { "sum": 100.0, "percents": { ... } }
}

提供以下函数：
    save_submission(scores, weights_result, percents, version) -> record
    load_all()        -> list[record]
    load_latest()     -> record | None
    reset()           -> 清空（仅用于测试与本地清档）
存储路径默认位于本模块同级目录下 ./submissions.json，可通过环境变量
    AI_EVAL_STORAGE 覆盖。
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional

# 模块目录，便于默认存储路径落在程序同侧
_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))


def _storage_path() -> str:
    """返回存储文件的绝对路径，允许 env 覆盖。"""
    env = os.environ.get("AI_EVAL_STORAGE")
    if env:
        return os.path.abspath(env)
    return os.path.join(_MODULE_DIR, "submissions.json")


def _now_iso() -> str:
    """生成 ISO8601 提交时间（不依赖 datetime.now 的微秒时区细节）。"""
    # 使用 datetime（ok 在普通运行态调用），提交时间属业务字段，非 workflow 调度使用
    from datetime import datetime
    # 用本地时间 + 时区偏移，保证可读且可比较
    # naive localtime → 加上本地 UTC 偏移
    import time
    utc_offset_sec = -time.timezone if (time.daylight == 0) else -time.altzone
    sign = "+" if utc_offset_sec >= 0 else "-"
    hh = abs(utc_offset_sec) // 3600
    mm = (abs(utc_offset_sec) % 3600) // 60
    return datetime.now().strftime(f"%Y-%m-%dT%H:%M:%S{sign}{hh:02d}:{mm:02d}")


def _read_file(path: str) -> list:
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        # 损坏文件不动，备份后从空起步（避免丢原文档）
        backup = path + ".bak"
        try:
            os.replace(path, backup)
        except OSError:
            pass
        return []
    if isinstance(data, list):
        return data
    # 老结构兼容：若是对象则包成单元素列表
    if isinstance(data, dict):
        return [data]
    return []


def _write_file(path: str, records: list) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)               # 原子写


def save_submission(
    scores: dict,
    weights_result: dict,
    percents: dict,
    version: str,
    *, submitted_at: Optional[str] = None,
) -> dict:
    """
    保存一次问卷提交记录，返回写入的记录字典。

    scores:          原始评分 {key: int|None|str}
    weights_result:  normalize_weights 的返回值
    percents:        weights_to_percent_report 的返回值
    version:         问卷版本
    submitted_at:    提交时间(覆盖用，测试里注入避免 Date.now)
    """
    path = _storage_path()
    records = _read_file(path)
    record = {
        "questionnaire_version": version,
        "submitted_at": submitted_at if submitted_at is not None else _now_iso(),
        "scores": dict(scores),
        "weights": weights_result,
        "percents": percents,
    }
    records.append(record)
    _write_file(path, records)
    return record


def load_all() -> list:
    """返回全部提交记录(按写入顺序)。"""
    return _read_file(_storage_path())


def load_latest() -> Optional[dict]:
    """返回最后一条提交记录，无记录返回 None。"""
    records = load_all()
    return records[-1] if records else None


def reset() -> int:
    """
    清空存储文件，返回被清除的记录数。
    仅用于测试与本地清档；生产环境请勿调用。
    """
    path = _storage_path()
    records = _read_file(path)
    count = len(records)
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    return count


if __name__ == "__main__":
    # 便利入口：打印最近一次提交
    latest = load_latest()
    if latest is None:
        print("（尚无提交记录）")
    else:
        print(json.dumps(latest, ensure_ascii=False, indent=2))