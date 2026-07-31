#!/usr/bin/env python3
"""
InfoCatcher 调查数据分析脚本
从脱敏编码 CSV 读取 112 条记录，输出逐题统计、交叉分析和勘误校准。
"""

import csv, math, statistics, json
from collections import Counter, defaultdict

# ============================================================
# 路径：指向脱敏后的编码数据
# ============================================================
CSV_PATH = "resources/survey/survey-data-coded.csv"
PDF_PATH = "resources/survey/questionnaire.pdf"

def read_csv(path):
    with open(path, "r", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))

rows = read_csv(CSV_PATH)
N = len(rows)
print(f"总样本量: {N}")
print(f"数据文件: {CSV_PATH}")
print()

# ============================================================
# 勘误表（与原报告对比）
# ============================================================
print("=" * 60)
print("勘误校准（对比原报告")
print("=" * 60)

# 1. 性别：原始已知男45/女42/缺失25
# 原报告按行序确定性补全（前17男、后8女）→ 男62、女50
# 下方给出比例插补（按已知男女比 45:42）与原报告行序法对比
raw_male = sum(1 for r in rows if r.get("1.你的性别是", "").strip() == "1")
raw_female = sum(1 for r in rows if r.get("1.你的性别是", "").strip() == "2")
raw_missing = N - raw_male - raw_female
known_ratio = raw_male / (raw_male + raw_female)
prop_m = round(raw_missing * known_ratio)
prop_f = raw_missing - prop_m

print(f"\n1. 性别补全后比例")
print(f"   原始已知: 男{raw_male}, 女{raw_female}, 缺失{raw_missing}({round(raw_missing/N*100,1)}%)")
print(f"   比例插补({raw_male}:{raw_female}): 男{raw_male+prop_m}={round((raw_male+prop_m)/N*100,1)}%, 女{raw_female+prop_f}={round((raw_female+prop_f)/N*100,1)}%")
print(f"   原报告行序法(17:8): 男62=55.4%(报告写55.9%疑用N=111), 女50=44.6%")
print(f"   注意: 两种插补相差约4人, 含性别的交叉分析需谨慎解读")

# 构建插补性别列表 — 使用比例法（与原报告不同，交叉分析用此列表）
imputed_genders = []
imputed_m_count = 0
for r in rows:
    raw = r.get("1.你的性别是", "").strip()
    if raw == "1":
        imputed_genders.append("男")
    elif raw == "2":
        imputed_genders.append("女")
    else:
        imputed_genders.append("男" if imputed_m_count < prop_m else "女")
        imputed_m_count += 1

male_count = sum(1 for g in imputed_genders if g == "男")
female_count = N - male_count
print(f"   本次交叉分析使用比例插补: 男{male_count}, 女{female_count}")

# 2. Q7 朋友推荐
q7_yn = [f for f in rows[0].keys() if f.startswith("7.你获取AI工具信息")]
friend_col = [f for f in q7_yn if "朋友" in f][0]
friend_count = sum(1 for r in rows if r.get(friend_col, "").strip() not in ("", "0"))
print(f"\n2. Q7 朋友推荐")
print(f"   原报告: 69/112=62.2% (69/111=62.2%, 疑报告用N=111)")
print(f"   计数校准: {friend_count}/{N}={round(friend_count/N*100,1)}%")

# 3. Q15 任务匹配困难
# 编码: A=1(能清楚判断), B=2(大多能但不确定), C=3(经常不确定), D=4(基本不确定)
q15_col = "15.面对一个具体任务（如写周报、做PPT、写代码、做论文翻译），你能快速判断该用哪个AI吗？"
q15_vals = [r.get(q15_col, "").strip() for r in rows]
q15_counter = Counter(q15_vals)
bc = sum(1 for v in q15_vals if v in ("2", "3"))    # B+C = 大多不确定 + 经常不确定
bcd = sum(1 for v in q15_vals if v in ("2", "3", "4"))  # B+C+D = 含基本不确定
print(f"\n3. Q15 任务匹配困难")
print(f"   原报告: 67.2%")
print(f"   B+C(大多不确定+经常不确定): {bc}/{N}={round(bc/N*100,1)}%")
print(f"   B+C+D(含基本不确定): {bcd}/{N}={round(bcd/N*100,1)}%")
print(f"   原报告67.2%与B+C口径({round(bc/N*100,1)}%)接近, 疑报告排除D(基本不确定)仅计B+C")

# 4. Q16 选择因素（限选4项）
q16_fields = [f for f in rows[0].keys() if f.startswith("16.选择AI工具时")]
q16_results = []
for f in q16_fields:
    cnt = sum(1 for r in rows if r.get(f, "").strip() not in ("", "0"))
    q16_results.append((f.split(":")[-1] if ":" in f else f, cnt, round(cnt/N*100, 1)))
q16_results.sort(key=lambda x: -x[1])

# Q16 限选合规检验
q16_per_resp = []
for r in rows:
    n = sum(1 for f in q16_fields if r.get(f, "").strip() not in ("", "0"))
    q16_per_resp.append(n)
q16_over4 = sum(1 for n in q16_per_resp if n > 4)
q16_max = max(q16_per_resp)

# 合规样本(≤4项)统计
q16_ok = [r for r in rows if sum(1 for f in q16_fields if r.get(f, "").strip() not in ("", "0")) <= 4]
N_ok = len(q16_ok)
q16_ok_results = []
for f in q16_fields:
    cnt = sum(1 for r in q16_ok if r.get(f, "").strip() not in ("", "0"))
    q16_ok_results.append((f.split(":")[-1] if ":" in f else f, cnt, round(cnt/N_ok*100, 1)))
q16_ok_results.sort(key=lambda x: -x[1])

print(f"\n4. Q16 选择因素（限选4项）")
print(f"   违规>4项: {q16_over4}/{N}人({round(q16_over4/N*100,1)}%), 最多{q16_max}项")
print(f"   原报告前3: 84.7%/77.5%/52.3%")
print(f"   全样本(N={N})前3: {q16_results[0][2]}%/{q16_results[1][2]}%/{q16_results[2][2]}%")
print(f"   合规样本(N={N_ok})前3: {q16_ok_results[0][2]}%/{q16_ok_results[1][2]}%/{q16_ok_results[2][2]}%")
print(f"   注意: {q16_over4}人违规多选虚高全样本百分比, 建议以合规样本为准")

# 5. Q18 看不懂介绍
q18_fields = [f for f in rows[0].keys() if f.startswith("18.")]
hard_col = [f for f in q18_fields if "看不太" in f or "看不懂" in f]
if hard_col:
    vals = [int(r[hard_col[0]]) for r in rows if r.get(hard_col[0], "").strip() not in ("", "0")]
    mean_hard = round(statistics.mean(vals), 2)
    print(f"\n5. Q18 看不懂介绍均值")
    print(f"   原报告: 2.79（一处）/ 2.78（表中）")
    print(f"   脚本输出: {mean_hard}")

# 6. Q20 整体影响
q20_col = "20.总的来说，AI信息获取和工具选择的困难，对你的影响程度如何？"
q20_map = {"1": "A.影响很大", "2": "B.影响较大", "3": "C.有一定影响", "4": "D.影响不大", "5": "E.没什么影响"}
q20_vals = [r.get(q20_col, "").strip() for r in rows]
q20_counter = Counter(q20_vals)
big = sum(q20_counter.get(v, 0) for v in ("1", "2"))
some = q20_counter.get("3", 0)
little = sum(q20_counter.get(v, 0) for v in ("4", "5"))
print(f"\n6. Q20 整体影响程度")
print(f"   原报告: 29.7%/57.7%/12.6% (中/后两项 64/111=57.7%, 14/111=12.6% 疑用N=111)")
print(f"   校准值: {round(big/N*100,1)}%/{round(some/N*100,1)}%/{round(little/N*100,1)}%")
print(f"   计数: 很大+较大={big}, 有一定影响={some}, 不大+无影响={little} (N={N})")

print("\n" + "=" * 60)
print("逐题统计")
print("=" * 60)

# --- Q1 性别 ---
print("\n--- Q1: 性别 ---")
print(f"  补全后: 男={male_count}({round(male_count/N*100,1)}%), 女={female_count}({round(female_count/N*100,1)}%)")

# --- Q2 年龄段 ---
print("\n--- Q2: 年龄段 ---")
age_col = "2.你的年龄段是？"
age_map = {"1": "18岁以下", "2": "18-24岁", "3": "25-30岁", "4": "31-40岁", "5": "41-50岁"}
age_counter = Counter(r.get(age_col, "").strip() for r in rows if r.get(age_col, "").strip() not in ("", "0"))
for k in sorted(age_counter.keys()):
    print(f"  {age_map.get(k, k)}: {age_counter[k]}({round(age_counter[k]/N*100,1)}%)")

# --- Q3 职业 ---
print("\n--- Q3: 职业 ---")
occ_col = "3.你目前的职业或身份是？"
occ_map = {"1": "学生", "2": "职场人士", "3": "管理者", "4": "自由职业", "5": "程序员",
           "6": "创作者", "7": "教育科研", "8": "待业", "9": "其他"}
occ_counter = Counter(r.get(occ_col, "").strip() for r in rows if r.get(occ_col, "").strip() not in ("", "0"))
for k in sorted(occ_counter.keys()):
    print(f"  {occ_map.get(k, k)}: {occ_counter[k]}({round(occ_counter[k]/N*100,1)}%)")

# --- Q4 工具 ---
print("\n--- Q4: 使用的AI工具（多选，分母N=112）---")
q4_fields = [f for f in rows[0].keys() if f.startswith("4.") and "填空" not in f and "其他（请注明）" not in f]
q4_clean = [f for f in q4_fields if "[" not in f]
def multi_count(fields):
    for f in fields:
        cnt = sum(1 for r in rows if r.get(f, "").strip() not in ("", "0"))
        short = f.split(":")[-1] if ":" in f else f
        yield short, cnt, round(cnt/N*100, 1)
for name, cnt, pct in sorted(multi_count(q4_clean), key=lambda x: -x[1]):
    print(f"  {name}: {cnt}({pct}%)")

# --- Q5 频率 ---
print("\n--- Q5: 使用频率 ---")
freq_col = "5.你使用AI工具的频率是？"
freq_map = {"1": "每天使用", "2": "每周使用几次", "3": "偶尔使用"}
freq_counter = Counter(r.get(freq_col, "").strip() for r in rows if r.get(freq_col, "").strip() not in ("", "0"))
for k in sorted(freq_counter.keys()):
    print(f"  {freq_map.get(k, k)}: {freq_counter[k]}({round(freq_counter[k]/N*100,1)}%)")

# --- Q6 场景 ---
print("\n--- Q6: 使用场景（多选）---")
q6_fields = [f for f in rows[0].keys() if f.startswith("6.你主要在哪些场景下使用AI")]
for name, cnt, pct in sorted(multi_count(q6_fields), key=lambda x: -x[1]):
    print(f"  {name}: {cnt}({pct}%)")

# --- Q7 渠道 ---
print("\n--- Q7: 信息渠道（多选）---")
q7_fields = [f for f in rows[0].keys() if f.startswith("7.你获取AI工具信息")]
for name, cnt, pct in sorted(multi_count(q7_fields), key=lambda x: -x[1]):
    print(f"  {name}: {cnt}({pct}%)")

# --- Q8 困难 ---
print("\n--- Q8: 最大困难（多选）---")
q8_fields = [f for f in rows[0].keys() if f.startswith("8.") and "填空" not in f and "其他（请注明）" not in f]
for name, cnt, pct in sorted(multi_count(q8_fields), key=lambda x: -x[1]):
    print(f"  {name}: {cnt}({pct}%)")

# --- Q9 经历 ---
print("\n--- Q9: 曾遇到情况（多选）---")
q9_fields = [f for f in rows[0].keys() if f.startswith("9.你是否遇到过")]
for name, cnt, pct in sorted(multi_count(q9_fields), key=lambda x: -x[1]):
    short = name.split(":")[-1] if ":" in name else name
    print(f"  {short}: {cnt}({pct}%)")

# --- Q10 信任 ---
print("\n--- Q10: 网上评测信任 ---")
q10_col = "10.你对网上AI工具相关评测和推荐内容的信任程度如何？"
q10_map = {"1": "难分辨", "2": "不太信任", "3": "比较信任", "4": "未关注"}
q10_counter = Counter(r.get(q10_col, "").strip() for r in rows if r.get(q10_col, "").strip() not in ("", "0"))
q10_total = sum(q10_counter.values())
for k in sorted(q10_counter.keys()):
    print(f"  {q10_map.get(k, k)}: {q10_counter[k]}({round(q10_counter[k]/q10_total*100,1)}%)")

# --- Q11 理解 ---
print("\n--- Q11: 介绍理解 ---")
q11_col = "11.看到一款AI工具的介绍时，你通常能清楚理解它到底能做什么、不能做什么吗？"
q11_map = {"1": "能理解", "2": "大致能懂但术语障碍", "3": "看不太懂", "4": "基本看不懂"}
q11_counter = Counter(r.get(q11_col, "").strip() for r in rows if r.get(q11_col, "").strip() not in ("", "0"))
q11_total = sum(q11_counter.values())
for k in sorted(q11_counter.keys()):
    print(f"  {q11_map.get(k, k)}: {q11_counter[k]}({round(q11_counter[k]/q11_total*100,1)}%)")

# --- Q12 缺信息 ---
print("\n--- Q12: 最缺信息（多选）---")
q12_fields = [f for f in rows[0].keys() if f.startswith("12.在判断一个AI工具")]
for name, cnt, pct in sorted(multi_count(q12_fields), key=lambda x: -x[1]):
    short = name.split(":")[-1] if ":" in name else name
    print(f"  {short}: {cnt}({pct}%)")

# --- Q13 认知 ---
print("\n--- Q13: 常用工具认知 ---")
q13_col = "13.你是否清楚你常用的AI工具主要擅长什么、不擅长什么？"
q13_map = {"1": "非常清楚", "2": "大致但不确定", "3": "凭感觉", "4": "不清楚"}
q13_counter = Counter(r.get(q13_col, "").strip() for r in rows if r.get(q13_col, "").strip() not in ("", "0"))
for k in sorted(q13_counter.keys()):
    print(f"  {q13_map.get(k, k)}: {q13_counter[k]}({round(q13_counter[k]/N*100,1)}%)")

# --- Q14 犹豫 ---
print("\n--- Q14: 多工具犹豫 ---")
q14_col = "14.你是否曾在多个AI工具之间犹豫不决，不知道选哪个好？"
q14_map = {"1": "经常", "2": "偶尔", "3": "很少", "4": "无需选择"}
q14_counter = Counter(r.get(q14_col, "").strip() for r in rows if r.get(q14_col, "").strip() not in ("", "0"))
for k in sorted(q14_counter.keys()):
    print(f"  {q14_map.get(k, k)}: {q14_counter[k]}({round(q14_counter[k]/N*100,1)}%)")

# --- Q15 匹配 ---
print("\n--- Q15: 任务匹配 ---")
q15_map = {"1": "清楚", "2": "大多能但不确定", "3": "经常不确定", "4": "基本不确定"}
for k in sorted(q15_counter.keys()):
    print(f"  {q15_map.get(k, k)}: {q15_counter[k]}({round(q15_counter[k]/N*100,1)}%)")

# --- Q16 因素 ---
print("\n--- Q16: 选择因素（多选，限4项）---")
print(f"  违规>4项: {q16_over4}人({round(q16_over4/N*100,1)}%), 最多{q16_max}项")
print(f"  【全样本 N={N}】（含违规多选）:")
for name, cnt, pct in sorted(q16_results, key=lambda x: -x[1]):
    print(f"  {name}: {cnt}({pct}%)")
print(f"  【合规样本 N={N_ok}】（≤4项）:")
for name, cnt, pct in sorted(q16_ok_results, key=lambda x: -x[1]):
    print(f"  {name}: {cnt}({pct}%)")

# --- Q17 选错 ---
print("\n--- Q17: 选错工具 ---")
q17_col = "17.你是否曾因为不了解不同AI工具之间的差异，而选错了工具（或错过了更适合的工具）？"
q17_map = {"1": "多次", "2": "一两次", "3": "不确定", "4": "没有"}
q17_counter = Counter(r.get(q17_col, "").strip() for r in rows if r.get(q17_col, "").strip() not in ("", "0"))
for k in sorted(q17_counter.keys()):
    print(f"  {q17_map.get(k, k)}: {q17_counter[k]}({round(q17_counter[k]/N*100,1)}%)")

# --- Q18 困扰量表 ---
print("\n--- Q18: 困扰评分（1-5）---")
for field in q18_fields:
    vals = [int(r[field]) for r in rows if r.get(field, "").strip() not in ("", "0")]
    if not vals:
        continue
    short = field.split(":")[-1] if ":" in field else field
    m = round(statistics.mean(vals), 2)
    md = statistics.median(vals)
    sd = round(statistics.stdev(vals), 2) if len(vals) > 1 else 0
    high = sum(1 for v in vals if v >= 4)
    print(f"  {short}: M={m}, Mdn={md}, SD={sd}, 4-5分={high}({round(high/len(vals)*100,1)}%)")

# --- Q19 最大问题 ---
print("\n--- Q19: 自认为影响最大的问题 ---")
q19_col = "19.以上问题中，哪一类对你影响最大？"
q19_items = [r.get(q19_col, "").strip() for r in rows if r.get(q19_col, "").strip() not in ("", "0")]
q19_counter = Counter(q19_items)
q19_map = {"1": "信息太分散", "2": "更新太快跟不上", "3": "不知道哪些工具值得关注",
           "4": "看不懂介绍", "5": "不知任务适用性", "6": "分不清评测真假",
           "7": "宣传与体验落差", "8": "价格不透明", "9": "不确定是否值得付费",
           "10": "缺少真实案例", "11": "多工具间难选择"}
for k, v in q19_counter.most_common():
    label = q19_map.get(k, k)
    print(f"  {label}: {v}({round(v/len(q19_items)*100,1)}%)")

# --- Q20 整体影响 ---
print("\n--- Q20: 整体影响程度 ---")
q20_label_map = {"1": "影响很大", "2": "影响较大", "3": "有一定影响", "4": "影响不大", "5": "无影响"}
for k, v in q20_counter.most_common():
    label = q20_label_map.get(k, k)
    print(f"  {label}: {v}({round(v/N*100,1)}%)")

# --- Q21 Q22 开放题计数 ---
print("\n--- Q21+Q22: 开放题 ---")
q21_col = "21.请回忆最近一次因不了解AI工具而感到困惑或遇到麻烦的经历，简要描述一下。"
q21_text = [r[q21_col].strip() for r in rows if r.get(q21_col, "").strip() not in ("", "0", "无", "先不写")]
q22_col = "22.如果用一句话总结，你在获取AI信息、选择AI工具这件事上，最头疼的是什么？"
q22_text = [r[q22_col].strip() for r in rows if r.get(q22_col, "").strip() not in ("", "0", "无", "先不写")]
print(f"  Q21 有效回答数: {len(q21_text)}")
print(f"  Q22 有效回答数: {len(q22_text)}")

# ============================================================
# 交叉分析
# ============================================================
print("\n" + "=" * 60)
print("交叉分析")
print("=" * 60)

# 性别 × Q17
print("\n--- 性别 × 选错经历（Q17）---")
for g in ["男", "女"]:
    g_q17 = [rows[i][q17_col].strip() for i in range(N) if imputed_genders[i] == g and rows[i].get(q17_col, "").strip() not in ("", "0")]
    err = sum(1 for v in g_q17 if v in ("1", "2"))
    print(f"  {g}(N={len(g_q17)}): 选错={err}({round(err/len(g_q17)*100,1)}%)")
print(f"  *22.5%性别为插补值*")

# 使用频率 × Q18 信息分散
print("\n--- 使用频率 × Q18信息分散度 ---")
q18_disp_col = [f for f in q18_fields if "分散" in f][0]
for fv in ["1", "2", "3"]:
    idxs = [i for i, r in enumerate(rows) if r.get(freq_col, "").strip() == fv]
    vals = [int(rows[i][q18_disp_col]) for i in idxs if rows[i].get(q18_disp_col, "").strip() not in ("", "0")]
    if vals:
        print(f"  {freq_map.get(fv, fv)}(N={len(vals)}): M={round(statistics.mean(vals),2)}, ≥4分={round(sum(1 for v in vals if v>=4)/len(vals)*100,1)}%")

# Q18 排序
print("\n--- Q18 维度均值排序（从高到低）---")
q18_rank = []
for field in q18_fields:
    vals = [int(r[field]) for r in rows if r.get(field, "").strip() not in ("", "0")]
    if vals:
        short = field.split(":")[-1] if ":" in field else field
        q18_rank.append((short, round(statistics.mean(vals), 2)))
for short, m in sorted(q18_rank, key=lambda x: -x[1]):
    print(f"  {short}: {m}")

print(f"\n=== 分析完成 ===")
print(f"总样本量: {N}")
print(f"性别缺失: {raw_missing} ({round(raw_missing/N*100,1)}%), 按已知比例({raw_male}:{raw_female})插补")
print(f"补全后: 男={male_count}({round(male_count/N*100,1)}%), 女={female_count}({round(female_count/N*100,1)}%)")
print(f"Q16限选违规: {q16_over4}人未遵守限选4项规定, 合规样本N={N_ok}")
print(f"注意: 原报告多处百分比疑以N=111计算, 本脚本以N={N}为准")
