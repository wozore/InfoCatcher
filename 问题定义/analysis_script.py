#!/usr/bin/env python3
"""
AI信息获取调研数据分析脚本
读取原始数据.csv和编码数据.csv，结合问卷PDF核对，完成完整统计分析。
"""

import csv
import json
import math
from collections import Counter, defaultdict
import statistics

# ============================================================
# 1. 读取数据
# ============================================================
DATA_DIR = "c:/Users/HelloWare/OneDrive/Desktop/AI信息获取软件开发/问题定义"

def read_csv(filename):
    with open(f"{DATA_DIR}/{filename}", "r", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    return rows

raw_rows = read_csv("原始数据.csv")
coded_rows = read_csv("编码数据.csv")

print(f"原始数据行数: {len(raw_rows)}")
print(f"编码数据行数: {len(coded_rows)}")

# 核对编号一致性
raw_ids = [r["编号"] for r in raw_rows]
coded_ids = [r["编号"] for r in coded_rows]
assert raw_ids == coded_ids, "编号不一致！"

N = len(raw_rows)
print(f"总样本量: {N}")

# ============================================================
# 2. 字段与编码映射核对
# ============================================================
# Question 1: 性别
gender_raw = [r["1.你的性别是"] for r in raw_rows]
gender_coded = [r["1.你的性别是"] for r in coded_rows]
gender_map = {"A.男": "1", "B.女": "2"}

# Check mapping
for raw, coded in zip(gender_raw, gender_coded):
    if raw in gender_map:
        expected = gender_map[raw]
        if coded != expected:
            print(f"WARNING: Gender mapping mismatch: raw={raw}, coded={coded}")
    elif raw == "":
        if coded != "":
            print(f"WARNING: Empty raw gender but coded={coded}")
        # This is a missing value

print(f"\n性别原始分布:")
gender_counter = Counter(gender_raw)
for k, v in gender_counter.items():
    print(f"  {k}: {v}")

missing_gender_count = gender_counter.get("", 0)
print(f"  性别缺失数: {missing_gender_count}")

known_male = gender_counter.get("A.男", 0)
known_female = gender_counter.get("B.女", 0)
print(f"\n已知性别: 男={known_male}, 女={known_female}")

# ============================================================
# 3. 缺失值检查
# ============================================================
print("\n=== 各字段缺失检查 ===")
field_missing = {}
for field in raw_rows[0].keys():
    missing = sum(1 for r in raw_rows if r.get(field, "").strip() == "")
    if missing > 0:
        field_missing[field] = missing
        # Skip system fields and open text fields
        if field not in ["IP", "UA", "Referrer", "用户标识", "用户昵称ID", "自定义字段"]:
            print(f"  {field}: {missing} missing")

# ============================================================
# 4. 重复记录检查
# ============================================================
user_ids = [r.get("用户标识", "") for r in raw_rows]
id_counts = Counter(user_ids)
duplicates = {k: v for k, v in id_counts.items() if v > 1 and k}
print(f"\n重复记录数: {len(duplicates)} (基于用户标识)")
for uid, cnt in duplicates.items():
    print(f"  用户标识 {uid}: {cnt} 条")

# ============================================================
# 5. 性别缺失值补全（男:女 = 2:1）
# ============================================================
N_missing = missing_gender_count
# 男性补全 = 最接近 2*N/3 的整数
male_impute = round(2 * N_missing / 3)
female_impute = N_missing - male_impute

print(f"\n性别缺失补全:")
print(f"  缺失人数: {N_missing}")
print(f"  应补男性: {male_impute}, 应补女性: {female_impute}")

# 确定分配：按原始行顺序分配
# 找到所有缺失性别的行索引
missing_indices = [i for i, r in enumerate(raw_rows) if r["1.你的性别是"].strip() == ""]
print(f"  缺失性别行索引(0-based): {missing_indices}")

# 前 male_impute 个缺失补男性，其余补女性
imputed_genders = ["男"] * len(raw_rows)
for idx, i in enumerate(missing_indices):
    if idx < male_impute:
        imputed_genders[i] = "男"  # 补男性
    else:
        imputed_genders[i] = "女"  # 补女性

# 已记录的性别
for i in range(len(raw_rows)):
    if raw_rows[i]["1.你的性别是"].strip() != "":
        if raw_rows[i]["1.你的性别是"] == "A.男":
            imputed_genders[i] = "男"
        else:
            imputed_genders[i] = "女"

after_male = sum(1 for g in imputed_genders if g == "男")
after_female = sum(1 for g in imputed_genders if g == "女")
print(f"  补全后: 男={after_male}, 女={after_female}")

# 创建"是否补全"标记
is_imputed = [False] * len(raw_rows)
for i in missing_indices:
    is_imputed[i] = True

# ============================================================
# 6. 统计函数
# ============================================================
def freq_table(raw_values, total=None):
    """计算单选题频数和百分比"""
    counter = Counter(raw_values)
    total = total or len(raw_values)
    result = []
    for val in sorted(counter.keys(), key=lambda x: str(x)):
        if val.strip() == "":
            continue
        result.append((val, counter[val], round(counter[val]/total*100, 1)))
    return result

def multi_freq_table(rows, fields, total=None):
    """计算多选题各选项频数和百分比"""
    total = total or len(rows)
    result = []
    for field in fields:
        count = sum(1 for r in rows if r.get(field, "").strip() != "" and r.get(field, "").strip() != "0")
        if count > 0:
            result.append((field, count, round(count/total*100, 1)))
    return result

def scale_stats(values):
    """计算量表题的描述统计"""
    nums = [int(v) for v in values if v.strip() != "" and v.strip() != "0"]
    if not nums:
        return {}
    return {
        "n": len(nums),
        "mean": round(statistics.mean(nums), 2),
        "median": statistics.median(nums),
        "stdev": round(statistics.stdev(nums), 2) if len(nums) > 1 else 0,
        "min": min(nums),
        "max": max(nums),
        "dist": {i: nums.count(i) for i in range(1, 6)}
    }

# ============================================================
# 7. 逐题统计
# ============================================================
print("\n" + "="*60)
print("统计分析结果")
print("="*60)

# --- Q1: 性别 ---
print("\n--- Q1: 性别 ---")
print(f"  原始已知: 男={known_male}, 女={known_female}, 缺失={missing_gender_count}")
print(f"  补全后: 男={after_male}({round(after_male/N*100,1)}%), 女={after_female}({round(after_female/N*100,1)}%)")

# --- Q2: 年龄段 ---
print("\n--- Q2: 年龄段 ---")
age_map = {
    "A.18岁以下": "1", "B.18-24岁": "2", "C.25-30岁": "3",
    "D.31-40岁": "4", "E.41-50岁": "5", "F.51-60岁": "6", "G.60岁以上": "7"
}
# 从原始数据统计
age_raw = Counter(r["2.你的年龄段是？"] for r in raw_rows if r["2.你的年龄段是？"].strip())
for k, v in age_raw.most_common():
    print(f"  {k}: {v}({round(v/N*100,1)}%)")

# --- Q3: 职业 ---
print("\n--- Q3: 职业 ---")
occ_raw = Counter(r["3.你目前的职业或身份是？"] for r in raw_rows if r["3.你目前的职业或身份是？"].strip())
for k, v in occ_raw.most_common():
    print(f"  {k}: {v}({round(v/N*100,1)}%)")

# Q3 填空
occ_fill = [r["3.你目前的职业或身份是？[选项填空]"] for r in raw_rows if r.get("3.你目前的职业或身份是？[选项填空]", "").strip()]
if occ_fill:
    print(f"  职业填空项: {occ_fill}")

# --- Q4: 使用的AI工具 (多选) ---
print("\n--- Q4: 使用的AI工具 (多选) ---")
q4_fields = [f for f in raw_rows[0].keys() if f.startswith("4.你目前主要使用哪些AI工具")]
# 只选是/否字段，排除填空
q4_yn_fields = [f for f in q4_fields if "[选项填空]" not in f]
q4_result = multi_freq_table(raw_rows, q4_yn_fields, N)
for field, cnt, pct in sorted(q4_result, key=lambda x: -x[1]):
    short = field.split(":")[-1] if ":" in field else field
    print(f"  {short}: {cnt}({pct}%)")

# Q4 其他填空
q4_other_texts = [r["4.你目前主要使用哪些AI工具？:其他（请注明____）[选项填空]"] for r in raw_rows
                  if r.get("4.你目前主要使用哪些AI工具？:其他（请注明____）", "").strip() != "" and r.get("4.你目前主要使用哪些AI工具？:其他（请注明____）[选项填空]", "").strip()]
if q4_other_texts:
    print(f"  '其他'具体内容: {q4_other_texts}")

# --- Q5: 使用频率 ---
print("\n--- Q5: 使用频率 ---")
freq_raw = Counter(r["5.你使用AI工具的频率是？"] for r in raw_rows if r["5.你使用AI工具的频率是？"].strip())
for k, v in freq_raw.most_common():
    print(f"  {k}: {v}({round(v/N*100,1)}%)")

# --- Q6: 使用场景 (多选) ---
print("\n--- Q6: 使用场景 (多选) ---")
q6_fields = [f for f in raw_rows[0].keys() if f.startswith("6.你主要在哪些场景下使用AI")]
q6_result = multi_freq_table(raw_rows, q6_fields, N)
for field, cnt, pct in sorted(q6_result, key=lambda x: -x[1]):
    short = field.split(":")[-1]
    print(f"  {short}: {cnt}({pct}%)")

# --- Q7: 信息渠道 (多选) ---
print("\n--- Q7: 信息渠道 (多选) ---")
q7_fields = [f for f in raw_rows[0].keys() if f.startswith("7.你获取AI工具信息的主要渠道有哪些")]
q7_result = multi_freq_table(raw_rows, q7_fields, N)
for field, cnt, pct in sorted(q7_result, key=lambda x: -x[1]):
    short = field.split(":")[-1] if ":" in field else field
    print(f"  {short}: {cnt}({pct}%)")

# --- Q8: 最大困难 (多选) ---
print("\n--- Q8: 最大困难 (多选) ---")
q8_fields = [f for f in raw_rows[0].keys() if f.startswith("8.在获取AI工具信息时")]
# 排除填空
q8_yn = [f for f in q8_fields if "[选项填空]" not in f]
q8_result = multi_freq_table(raw_rows, q8_yn, N)
for field, cnt, pct in sorted(q8_result, key=lambda x: -x[1]):
    short = field.split(":")[-1] if ":" in field else field
    print(f"  {short}: {cnt}({pct}%)")

# Q8 其他
q8_other = [r["8.在获取AI工具信息时，你遇到的最大困难是什么？:其他（请注明____）[选项填空]"] for r in raw_rows
            if r.get("8.在获取AI工具信息时，你遇到的最大困难是什么？:其他（请注明____）", "").strip() != ""
            and r.get("8.在获取AI工具信息时，你遇到的最大困难是什么？:其他（请注明____）[选项填空]", "").strip()]
if q8_other:
    print(f"  Q8'其他'内容: {q8_other}")

# --- Q9: 遇到过的情况 (多选) ---
print("\n--- Q9: 遇到过的情况 (多选) ---")
q9_fields = [f for f in raw_rows[0].keys() if f.startswith("9.你是否遇到过以下情况")]
q9_result = multi_freq_table(raw_rows, q9_fields, N)
for field, cnt, pct in sorted(q9_result, key=lambda x: -x[1]):
    short = field.split(":")[-1] if ":" in field else field
    print(f"  {short}: {cnt}({pct}%)")

# --- Q10: 信任程度 ---
print("\n--- Q10: 信任程度 ---")
q10_raw = [r["10.你对网上AI工具相关评测和推荐内容的信任程度如何？"] for r in raw_rows if r["10.你对网上AI工具相关评测和推荐内容的信任程度如何？"].strip()]
q10_counter = Counter(q10_raw)
for k, v in q10_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q10_raw)*100,1)}%)")

# --- Q11: 理解能力 ---
print("\n--- Q11: 理解能力 ---")
q11_raw = [r["11.看到一款AI工具的介绍时，你通常能清楚理解它到底能做什么、不能做什么吗？"] for r in raw_rows if r["11.看到一款AI工具的介绍时，你通常能清楚理解它到底能做什么、不能做什么吗？"].strip()]
q11_counter = Counter(q11_raw)
for k, v in q11_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q11_raw)*100,1)}%)")

# --- Q12: 缺少的信息 (多选) ---
print("\n--- Q12: 缺少的信息 (多选) ---")
q12_fields = [f for f in raw_rows[0].keys() if f.startswith("12.在判断一个AI工具是否适合自己时")]
q12_result = multi_freq_table(raw_rows, q12_fields, N)
for field, cnt, pct in sorted(q12_result, key=lambda x: -x[1]):
    short = field.split(":")[-1] if ":" in field else field
    print(f"  {short}: {cnt}({pct}%)")

# --- Q13: 对自己常用工具的认知 ---
print("\n--- Q13: 对自己常用工具的认知 ---")
q13_raw = [r["13.你是否清楚你常用的AI工具主要擅长什么、不擅长什么？"] for r in raw_rows if r["13.你是否清楚你常用的AI工具主要擅长什么、不擅长什么？"].strip()]
q13_counter = Counter(q13_raw)
for k, v in q13_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q13_raw)*100,1)}%)")

# --- Q14: 犹豫不决 ---
print("\n--- Q14: 犹豫不决 ---")
q14_raw = [r["14.你是否曾在多个AI工具之间犹豫不决，不知道选哪个好？"] for r in raw_rows if r["14.你是否曾在多个AI工具之间犹豫不决，不知道选哪个好？"].strip()]
q14_counter = Counter(q14_raw)
for k, v in q14_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q14_raw)*100,1)}%)")

# --- Q15: 快速判断 ---
print("\n--- Q15: 快速判断能力 ---")
q15_raw = [r["15.面对一个具体任务（如写周报、做PPT、写代码、做论文翻译），你能快速判断该用哪个AI吗？"] for r in raw_rows if r["15.面对一个具体任务（如写周报、做PPT、写代码、做论文翻译），你能快速判断该用哪个AI吗？"].strip()]
q15_counter = Counter(q15_raw)
for k, v in q15_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q15_raw)*100,1)}%)")

# --- Q16: 选择因素 (多选, 限选4项) ---
print("\n--- Q16: 选择因素 (多选, 限选4项) ---")
q16_fields = [f for f in raw_rows[0].keys() if f.startswith("16.选择AI工具时")]
q16_result = multi_freq_table(raw_rows, q16_fields, N)
for field, cnt, pct in sorted(q16_result, key=lambda x: -x[1]):
    short = field.split(":")[-1].split("（")[0] if ":" in field else field
    print(f"  {short}: {cnt}({pct}%)")

# --- Q17: 选错工具 ---
print("\n--- Q17: 选错工具 ---")
q17_raw = [r["17.你是否曾因为不了解不同AI工具之间的差异，而选错了工具（或错过了更适合的工具）？"] for r in raw_rows if r["17.你是否曾因为不了解不同AI工具之间的差异，而选错了工具（或错过了更适合的工具）？"].strip()]
q17_counter = Counter(q17_raw)
for k, v in q17_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q17_raw)*100,1)}%)")

# --- Q18: 困扰程度评分 (1-5) ---
print("\n--- Q18: 困扰程度评分（1-5） ---")
q18_fields_coded = [f for f in coded_rows[0].keys() if f.startswith("18.")]
for field in q18_fields_coded:
    values = [r[field] for r in coded_rows if r.get(field, "").strip() != "" and r.get(field, "").strip() != "0"]
    stats = scale_stats(values)
    short = field.split(":")[-1] if ":" in field else field
    if stats:
        print(f"  {short}: N={stats['n']}, M={stats['mean']}, Mdn={stats['median']}, SD={stats['stdev']}")
        dist_str = ", ".join([f"{k}分:{v}人" for k, v in sorted(stats['dist'].items())])
        print(f"    分布: {dist_str}")

# --- Q19: 影响最大的问题 ---
print("\n--- Q19: 影响最大的问题 ---")
q19_raw = [r["19.以上问题中，哪一类对你影响最大？"] for r in raw_rows if r.get("19.以上问题中，哪一类对你影响最大？", "").strip()]
q19_counter = Counter(q19_raw)
for k, v in q19_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q19_raw)*100,1)}%)")

# --- Q20: 整体影响程度 ---
print("\n--- Q20: 整体影响程度 ---")
q20_raw = [r["20.总的来说，AI信息获取和工具选择的困难，对你的影响程度如何？"] for r in raw_rows if r.get("20.总的来说，AI信息获取和工具选择的困难，对你的影响程度如何？", "").strip()]
q20_counter = Counter(q20_raw)
for k, v in q20_counter.most_common():
    print(f"  {k}: {v}({round(v/len(q20_raw)*100,1)}%)")

# --- Q21: 开放题 1 ---
print("\n--- Q21: 开放题（最近一次因不了解AI工具感到困惑的经历）---")
q21_texts = [r["21.请回忆最近一次因不了解AI工具而感到困惑或遇到麻烦的经历，简要描述一下。"] for r in raw_rows
             if r.get("21.请回忆最近一次因不了解AI工具而感到困惑或遇到麻烦的经历，简要描述一下。", "").strip() and r["21.请回忆最近一次因不了解AI工具而感到困惑或遇到麻烦的经历，简要描述一下。"].strip() != "无" and r["21.请回忆最近一次因不了解AI工具而感到困惑或遇到麻烦的经历，简要描述一下。"].strip() != "先不写"]
print(f"  有效回答数: {len(q21_texts)}")

# --- Q22: 开放题 2 ---
print("\n--- Q22: 开放题（最头疼的是什么）---")
q22_texts = [r["22.如果用一句话总结，你在获取AI信息、选择AI工具这件事上，最头疼的是什么？"] for r in raw_rows
             if r.get("22.如果用一句话总结，你在获取AI信息、选择AI工具这件事上，最头疼的是什么？", "").strip() and r["22.如果用一句话总结，你在获取AI信息、选择AI工具这件事上，最头疼的是什么？"].strip() != "无" and r["22.如果用一句话总结，你在获取AI信息、选择AI工具这件事上，最头疼的是什么？"].strip() != "先不写"]
print(f"  有效回答数: {len(q22_texts)}")

# ============================================================
# 8. 交叉分析
# ============================================================
print("\n" + "="*60)
print("交叉分析")
print("="*60)

# 性别 vs Q17（是否选错工具）
print("\n--- 性别 vs Q17（选错工具经历）---")
gender_vs_q17 = defaultdict(list)
for i, r in enumerate(raw_rows):
    if r["17.你是否曾因为不了解不同AI工具之间的差异，而选错了工具（或错过了更适合的工具）？"].strip():
        gender_vs_q17[imputed_genders[i]].append(r["17.你是否曾因为不了解不同AI工具之间的差异，而选错了工具（或错过了更适合的工具）？"])
for g in ["男", "女"]:
    c = Counter(gender_vs_q17[g])
    total = sum(c.values())
    print(f"  {g}(N={total}):")
    for k, v in c.most_common():
        print(f"    {k}: {v}({round(v/total*100,1)}%)")
print(f"  *注意: 性别含{missing_gender_count}例按2:1补全数据*")

# 职业 vs Q17
print("\n--- 职业 vs Q17（选错工具经历）---")
occ_vs_q17 = defaultdict(list)
for r in raw_rows:
    occ = r["3.你目前的职业或身份是？"]
    q17 = r["17.你是否曾因为不了解不同AI工具之间的差异，而选错了工具（或错过了更适合的工具）？"]
    if occ.strip() and q17.strip():
        occ_vs_q17[occ].append(q17)
for occ in sorted(occ_vs_q17.keys()):
    c = Counter(occ_vs_q17[occ])
    total = sum(c.values())
    if total >= 5:  # 只显示样本量>=5的
        yes = c.get("A.是的，发生过不止一次", 0) + c.get("B.发生过一两次", 0)
        print(f"  {occ}(N={total}): 发生过选错={yes}({round(yes/total*100,1)}%)")

# 使用频率 vs Q18-1 (信息太分散困扰)
print("\n--- 使用频率 vs Q18-1 (信息太分散困扰度) ---")
freq_vs_q18_1 = defaultdict(list)
for i, r in enumerate(raw_rows):
    freq = r["5.你使用AI工具的频率是？"]
    val = coded_rows[i]["18.请对以下问题对你的困扰程度进行评分（1=完全不是问题，5=非常严重）:AI信息太分散，需要到处找"]
    if freq.strip() and val.strip():
        freq_vs_q18_1[freq].append(int(val))
for freq in ["A.每天使用", "B.每周使用几次", "C.偶尔使用（每月几次）"]:
    vals = freq_vs_q18_1.get(freq, [])
    if vals:
        print(f"  {freq}(N={len(vals)}): M={round(statistics.mean(vals),2)}, 4-5分占比={round(sum(1 for v in vals if v>=4)/len(vals)*100,1)}%")

# Q18各维度均值排序
print("\n--- Q18各维度均值排序 ---")
q18_means = {}
for field in q18_fields_coded:
    values = [int(r[field]) for r in coded_rows if r.get(field, "").strip() != "" and r.get(field, "").strip() != "0"]
    short = field.split(":")[-1]
    q18_means[short] = round(statistics.mean(values), 2)
for short, m in sorted(q18_means.items(), key=lambda x: -x[1]):
    print(f"  {short}: {m}")

# 职业 vs Q20
print("\n--- 职业 vs Q20（整体影响程度）---")
occ_vs_q20 = defaultdict(list)
for r in raw_rows:
    occ = r["3.你目前的职业或身份是？"]
    q20 = r["20.总的来说，AI信息获取和工具选择的困难，对你的影响程度如何？"]
    if occ.strip() and q20.strip():
        occ_vs_q20[occ].append(q20)
for occ in sorted(occ_vs_q20.keys()):
    c = Counter(occ_vs_q20[occ])
    total = sum(c.values())
    if total >= 5:
        severe = c.get("A.影响很大", 0) + c.get("B.影响较大", 0)
        print(f"  {occ}(N={total}): 影响很大/较大={severe}({round(severe/total*100,1)}%)")

# 交叉：使用频率 vs 认为信息太分散 (Q18-1)
print("\n--- 使用频率 vs Q18-1 平均分 ---")
for freq in ["A.每天使用", "B.每周使用几次", "C.偶尔使用（每月几次）"]:
    vals = freq_vs_q18_1.get(freq, [])
    if vals:
        high_pct = round(sum(1 for v in vals if v >= 4) / len(vals) * 100, 1)
        print(f"  {freq}: M={round(statistics.mean(vals),2)}, ≥4分={high_pct}%")

# 性别 vs Q18 各维度
print("\n--- 性别 vs Q18各维度均值 ---")
for field in q18_fields_coded:
    short = field.split(":")[-1]
    male_vals, female_vals = [], []
    for i, r in enumerate(coded_rows):
        val = r.get(field, "").strip()
        if val and val != "0":
            if imputed_genders[i] == "男":
                male_vals.append(int(val))
            else:
                female_vals.append(int(val))
    m_m = round(statistics.mean(male_vals), 2) if male_vals else 0
    m_f = round(statistics.mean(female_vals), 2) if female_vals else 0
    print(f"  {short}: 男M={m_m}(N={len(male_vals)}), 女M={m_f}(N={len(female_vals)})")

print("\n=== 分析完成 ===")
print(f"总样本量: {N}")
print(f"有效样本量: {N}")
print(f"性别缺失: {missing_gender_count}")
print(f"补全后: 男={after_male}, 女={after_female}")
