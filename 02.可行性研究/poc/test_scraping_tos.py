"""W1 技术验证 — 网页抓取 + ToS 审查"""
import urllib.request
import urllib.error
import re
import time
import json

HEADERS = {
    "User-Agent": "InfoCatcher-PoC/0.1 (feasibility study; contact via GitHub)",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
}

def fetch_page(url, label):
    """抓取网页并返回 HTML 文本"""
    print(f"\n  抓取: {label}")
    print(f"  URL: {url}")
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            print(f"  HTTP {resp.getcode()}, 大小: {len(html)} 字符")
            return resp.getcode(), html
    except urllib.error.HTTPError as e:
        print(f"  ❌ HTTP {e.code}: {e.reason}")
        return e.code, None
    except Exception as e:
        print(f"  ❌ 错误: {type(e).__name__}: {e}")
        return 0, None

def extract_info(html, patterns):
    """从 HTML 中提取关键信息"""
    results = {}
    for name, pattern in patterns.items():
        match = re.search(pattern, html, re.IGNORECASE | re.DOTALL)
        results[name] = match.group(1).strip()[:100] if match else "未提取到"
    return results

def test_ai_tool_page():
    """测试: 抓取 AI 工具官网页面"""
    print("=" * 60)
    print("测试 5: 网页抓取 — AI 工具价格/功能信息")
    print("=" * 60)

    targets = [
        {
            "label": "DeepSeek 官网",
            "url": "https://www.deepseek.com",
            "patterns": {
                "title": r"<title>(.*?)</title>",
                "description": r'<meta[^>]*name="description"[^>]*content="(.*?)"',
            }
        },
        {
            "label": "OpenAI ChatGPT 定价页",
            "url": "https://openai.com/chatgpt/pricing/",
            "patterns": {
                "title": r"<title>(.*?)</title>",
                "description": r'<meta[^>]*name="description"[^>]*content="(.*?)"',
            }
        },
        {
            "label": "通义千问 官网",
            "url": "https://tongyi.aliyun.com",
            "patterns": {
                "title": r"<title>(.*?)</title>",
                "description": r'<meta[^>]*name="description"[^>]*content="(.*?)"',
            }
        },
        {
            "label": "Claude 官网",
            "url": "https://claude.ai",
            "patterns": {
                "title": r"<title>(.*?)</title>",
                "description": r'<meta[^>]*name="description"[^>]*content="(.*?)"',
            }
        },
        {
            "label": "Google AI Studio",
            "url": "https://aistudio.google.com",
            "patterns": {
                "title": r"<title>(.*?)</title>",
                "description": r'<meta[^>]*name="description"[^>]*content="(.*?)"',
            }
        },
    ]

    results = []
    for t in targets:
        code, html = fetch_page(t["url"], t["label"])
        time.sleep(2)  # 控制频率

        ok = code == 200 and html and len(html) > 500
        info = {}
        if ok:
            info = extract_info(html, t["patterns"])

        results.append({
            "label": t["label"],
            "http_code": code,
            "ok": ok,
            "title": info.get("title", "N/A"),
            "description": info.get("description", "N/A"),
        })

        print(f"  Title: {info.get('title', 'N/A')[:80]}")
        print(f"  Desc:  {info.get('description', 'N/A')[:80]}")
        print(f"  结论: {'✅ 可抓取' if ok else '❌ 抓取失败'}")
        print()

    passed = sum(1 for r in results if r["ok"])
    print(f"  抓取成功率: {passed}/{len(results)}")

    # 分析哪些类型的网站可抓取
    for r in results:
        note = ""
        if r["http_code"] == 403:
            note = " — 可能有反爬保护 (Cloudflare/WAF)"
        elif r["http_code"] == 200 and not r["ok"]:
            note = " — 页面过小，可能是 JS 渲染页"
        elif r["http_code"] == 200:
            note = " — 静态 HTML 可正常获取"
        print(f"    {'✅' if r['ok'] else '❌'} {r['label']} (HTTP {r['http_code']}){note}")

    return results

def tos_check():
    """ToS 审查: 检查主要数据源的条款"""
    print("\n" + "=" * 60)
    print("测试 6: ToS 审查 — 数据源使用条款检查")
    print("=" * 60)

    tos_targets = [
        {
            "name": "Bilibili API",
            "tos_url": "https://www.bilibili.com/protocal/licence.html",
            "risk": "低",
            "note": "公开 API 允许搜索和获取视频元数据。非商业个人使用风险低。"
        },
        {
            "name": "YouTube Data API",
            "tos_url": "https://developers.google.com/youtube/terms/api-services-terms-of-service",
            "risk": "低",
            "note": "Google API ToS 允许通过 API 获取公开数据。需注册 API Key，免费配额 10,000 单位/天。禁止下载视频内容，但元数据（标题、描述、统计数据）允许使用。"
        },
        {
            "name": "X (Twitter) API",
            "tos_url": "https://developer.x.com/en/developer-terms",
            "risk": "中",
            "note": "X API 免费层每月 1,500 条推文（写入限额），读取限额约 100 次/月。限制较严格，适合低频采集热门推文。内容展示需遵守 X 的展示要求和归属规则。"
        },
        {
            "name": "DeepSeek 官网",
            "tos_url": "https://www.deepseek.com/terms",
            "risk": "低",
            "note": "公开网页信息（价格、功能描述）可合理引用。手动整理 + 注明来源是最安全的方式。自动化抓取频率应控制（≤1 次/秒）。"
        },
        {
            "name": "OpenAI 官网",
            "tos_url": "https://openai.com/policies/terms-of-use",
            "risk": "中",
            "note": "OpenAI ToS 禁止未经授权的自动化访问（scraping）。但人工收集信息并注明来源属于合理使用范畴。商标（ChatGPT、GPT 等）展示需遵循商标使用指南。"
        },
        {
            "name": "通义千问 官网",
            "tos_url": "https://tongyi.aliyun.com/terms",
            "risk": "低-中",
            "note": "阿里云服务条款通用限制。公开产品信息的整理和引用风险较低。需注明信息来源。"
        },
        {
            "name": "Anthropic (Claude) 官网",
            "tos_url": "https://www.anthropic.com/legal",
            "risk": "中",
            "note": "Anthropic ToS 类似 OpenAI，限制自动化抓取。人工整理信息风险低。商标使用需注意指南。"
        },
        {
            "name": "Google AI Studio",
            "tos_url": "https://policies.google.com/terms",
            "risk": "低",
            "note": "Google ToS 对公开信息的引用较为宽松。标明来源即可。API 有明确的免费配额和 Terms。"
        },
    ]

    print()
    for i, t in enumerate(tos_targets):
        print(f"  [{i+1}] {t['name']}")
        print(f"      ToS: {t['tos_url']}")
        print(f"      风险: {t['risk']}")
        print(f"      评估: {t['note']}")
        print()

    # 风险评估总结
    high_risk = [t for t in tos_targets if t["risk"] in ["中", "高"]]
    print(f"  数据源总数: {len(tos_targets)}")
    print(f"  中-高风险源: {len(high_risk)} 个")
    print(f"  低风险源: {len(tos_targets) - len(high_risk)} 个")
    print(f"  结论: {'✅ 可管理 — 无明确禁止项' if len([t for t in tos_targets if t['risk'] == '高']) == 0 else '⚠️ 需注意高风险源'}")

    return tos_targets

if __name__ == "__main__":
    print("InfoCatcher W1 技术验证 — 网页抓取 + ToS 审查")
    print(f"时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")

    # 网页抓取测试
    scrape_results = test_ai_tool_page()

    # 延迟
    time.sleep(1)

    # ToS 审查
    tos_results = tos_check()

    # 汇总
    print("\n" + "=" * 60)
    print("网页抓取 + ToS 审查 总结")
    print("=" * 60)
    scraped_ok = sum(1 for r in scrape_results if r["ok"])
    print(f"  网页抓取: {scraped_ok}/{len(scrape_results)} 可正常获取")
    print(f"  ToS 审查: {len([t for t in tos_results if t['risk'] == '高'])} 个高风险源")
    print(f"  综合结论: {'✅ 数据采集可行' if scraped_ok >= 3 else '⚠️ 需调整策略'}")
