"""W1 技术验证 — Bilibili API 公开接口测试"""
import urllib.request
import json
import time

def fetch_json(url, headers=None):
    """发送 GET 请求并解析 JSON"""
    req = urllib.request.Request(url, headers=headers or {})
    req.add_header("User-Agent", "InfoCatcher-PoC/0.1 (feasibility study; contact via GitHub)")
    req.add_header("Referer", "https://www.bilibili.com")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.getcode(), json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, str(e)
    except Exception as e:
        return 0, str(e)

def test_search_ai_videos():
    """测试 Bilibili 搜索 API — 搜索 AI 相关热门视频"""
    print("=" * 60)
    print("测试 1: Bilibili 搜索 API — 关键词 'AI工具推荐'")
    print("=" * 60)

    # Bilibili 公开搜索 API (无需 API Key)
    keyword = "AI工具推荐"
    url = f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={urllib.request.quote(keyword)}&page=1"
    code, data = fetch_json(url)

    print(f"  HTTP 状态码: {code}")
    if code == 200 and isinstance(data, dict):
        result = data.get("data", {}).get("result", [])
        print(f"  搜索结果数: {len(result)} 条")
        for i, video in enumerate(result[:5]):
            print(f"  [{i+1}] {video.get('title', 'N/A')[:60]}")
            print(f"      播放: {video.get('play', 0)}, 弹幕: {video.get('video_review', 0)}")
            print(f"      作者: {video.get('author', 'N/A')}, 日期: {time.strftime('%Y-%m-%d', time.localtime(video.get('pubdate', 0)))}")
        verdict = "✅ 通过" if len(result) > 0 else "❌ 失败 — 无结果"
    else:
        verdict = f"❌ 失败 — {data}"
        print(f"  错误: {data[:200]}")

    print(f"  结论: {verdict}\n")
    return verdict.startswith("✅")

def test_search_ai_model():
    """测试搜索 AI 模型名称"""
    print("=" * 60)
    print("测试 2: Bilibili 搜索 API — 关键词 'Claude vs ChatGPT'")
    print("=" * 60)

    keyword = "Claude ChatGPT 对比"
    url = f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={urllib.request.quote(keyword)}&page=1"
    code, data = fetch_json(url)

    print(f"  HTTP 状态码: {code}")
    if code == 200 and isinstance(data, dict):
        result = data.get("data", {}).get("result", [])
        print(f"  搜索结果数: {len(result)} 条")
        for i, video in enumerate(result[:3]):
            print(f"  [{i+1}] {video.get('title', 'N/A')[:60]}")
        verdict = "✅ 通过" if len(result) > 0 else "❌ 失败"
    else:
        verdict = f"❌ 失败 — {str(data)[:200]}"
        print(f"  错误: {str(data)[:200]}")

    print(f"  结论: {verdict}\n")
    return verdict.startswith("✅")

def test_hot_ranking():
    """测试 Bilibili 热门排行榜 API"""
    print("=" * 60)
    print("测试 3: Bilibili 热门排行榜 API (科技区)")
    print("=" * 60)

    # 科技区 rid = 188 (可能已变更，但用于验证 API 连通性)
    url = "https://api.bilibili.com/x/web-interface/popular?pn=1&ps=5"
    code, data = fetch_json(url)

    print(f"  HTTP 状态码: {code}")
    if code == 200 and isinstance(data, dict):
        video_list = data.get("data", {}).get("list", [])
        print(f"  热门视频数: {len(video_list)} 条")
        # 检查是否有科技/AI 相关分类
        ai_related = [v for v in video_list if any(kw in (v.get("title", "") + v.get("desc", ""))
                      for kw in ["AI", "ChatGPT", "Claude", "人工智能", "大模型", "DeepSeek"])]
        print(f"  其中 AI 相关: {len(ai_related)} 条")
        verdict = "✅ 通过" if len(video_list) > 0 else "❌ 失败"
    else:
        verdict = f"❌ 失败 — {str(data)[:200]}"
        print(f"  错误: {str(data)[:200]}")

    print(f"  结论: {verdict}\n")
    return verdict.startswith("✅")

def test_video_info():
    """测试 Bilibili 视频详情 API"""
    print("=" * 60)
    print("测试 4: Bilibili 视频详情 API — 特定 AI 评测视频")
    print("=" * 60)

    # 使用一个已知的 AI 相关 BV 号
    bvid = "BV1Nc411f7Bm"  # AI 工具相关视频
    url = f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
    code, data = fetch_json(url)

    print(f"  HTTP 状态码: {code}")
    if code == 200 and isinstance(data, dict):
        info = data.get("data", {})
        print(f"  标题: {info.get('title', 'N/A')[:60]}")
        print(f"  描述: {info.get('desc', 'N/A')[:80]}")
        print(f"  播放: {info.get('stat', {}).get('view', 'N/A')}")
        print(f"  标签: {info.get('tname', 'N/A')}")
        verdict = "✅ 通过" if info.get("title") else "❌ 失败"
    else:
        verdict = f"❌ 失败 — {str(data)[:200]}"
        print(f"  错误: {str(data)[:200]}")

    print(f"  结论: {verdict}\n")
    return verdict.startswith("✅")

if __name__ == "__main__":
    print("InfoCatcher W1 技术验证 — Bilibili API PoC")
    print(f"时间: {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print()

    results = []
    results.append(("搜索 AI 工具推荐视频", test_search_ai_videos()))
    time.sleep(1)
    results.append(("搜索 AI 模型对比视频", test_search_ai_model()))
    time.sleep(1)
    results.append(("热门排行榜", test_hot_ranking()))
    time.sleep(1)
    results.append(("视频详情页", test_video_info()))

    print("=" * 60)
    print("Bilibili API PoC 总结")
    print("=" * 60)
    passed = sum(1 for _, r in results if r)
    for name, ok in results:
        print(f"  {'✅' if ok else '❌'} {name}")
    print(f"\n通过: {passed}/{len(results)}")
    print(f"阈值: ≥ 80% (≥ {int(len(results) * 0.8)} 项通过)")
    print(f"最终结论: {'✅ Bilibili API 可用' if passed >= len(results) * 0.8 else '⚠️ 部分不可用，需调整数据采集策略'}")
