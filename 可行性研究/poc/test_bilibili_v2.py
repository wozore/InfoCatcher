"""W1 技术验证 — Bilibili API 重试 (增强请求头)"""
import urllib.request
import json
import gzip
import io

def fetch_bilibili(url):
    """Bilibili 专用请求 — 模拟浏览器行为"""
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate",
        "Referer": "https://www.bilibili.com/",
        "Origin": "https://www.bilibili.com",
        "Connection": "keep-alive",
        "Cache-Control": "no-cache",
    }
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            # 处理 gzip
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            return resp.getcode(), json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            if e.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
        except:
            pass
        return e.code, raw.decode("utf-8", errors="ignore")[:300]
    except Exception as e:
        return 0, str(e)

# 测试搜索 API (使用 web 搜索接口，非 API 接口)
print("Bilibili API 重试 (增强请求头)")
print("=" * 60)

# 方法1: 使用搜索建议接口 (轻量，鉴权宽松)
print("\n1. 搜索建议 API:")
url = "https://s.search.bilibili.com/main/suggest?term=AI%E5%B7%A5%E5%85%B7%E6%8E%A8%E8%8D%90"
code, data = fetch_bilibili(url)
print(f"   HTTP {code}")
if code == 200:
    print(f"   建议数: {len(data) if isinstance(data, list) else 'N/A'}")
    print(f"   ✅ 可用")
else:
    print(f"   ❌ {str(data)[:200]}")

# 方法2: 使用 wbi 搜索接口 (主搜索接口)
print("\n2. 主搜索 API (无 wbi 签名):")
url = "https://api.bilibili.com/x/web-interface/wbi/search/all/v2?keyword=AI%E5%B7%A5%E5%85%B7&page=1"
code, data = fetch_bilibili(url)
print(f"   HTTP {code}")
if code == 200:
    result_count = len(data.get("data", {}).get("result", [])) if isinstance(data, dict) else 0
    print(f"   结果数: {result_count}")
    print(f"   {'✅ 可用' if result_count > 0 else '⚠️ 无结果 (可能需要 wbi 签名)'}")
else:
    print(f"   ❌ {str(data)[:200]}")

# 方法3: 视频详情 (已知可用，验证一致性)
print("\n3. 视频详情 API (验证):")
url = "https://api.bilibili.com/x/web-interface/view?bvid=BV1Nc411f7Bm"
code, data = fetch_bilibili(url)
print(f"   HTTP {code}")
if code == 200 and isinstance(data, dict):
    title = data.get("data", {}).get("title", "N/A")
    print(f"   标题: {title[:60]}")
    print(f"   ✅ 可用")
else:
    print(f"   ❌")

# 方法4: 热门 API (换一个 endpoint)
print("\n4. 热门推荐 API:")
url = "https://api.bilibili.com/x/web-interface/index/top/feed/rcmd?fresh_type=3&ps=20"
code, data = fetch_bilibili(url)
print(f"   HTTP {code}")
if code == 200 and isinstance(data, dict):
    items = data.get("data", {}).get("item", [])
    print(f"   推荐数: {len(items)}")
    print(f"   {'✅ 可用' if len(items) > 0 else '⚠️ 无结果'}")
else:
    print(f"   ❌ {str(data)[:200]}")

# 方法5: 分区视频列表 (科技区 rid=188)
print("\n5. 分区视频列表 API (科技区):")
url = "https://api.bilibili.com/x/web-interface/dynamic/region?rid=188&pn=1&ps=5"
code, data = fetch_bilibili(url)
print(f"   HTTP {code}")
if code == 200 and isinstance(data, dict):
    dd = data.get("data")
    if isinstance(dd, list):
        print(f"   视频数: {len(dd)}")
        for a in dd[:3]:
            print(f"   - {a.get('title', 'N/A')[:50]}")
        print(f"   {'✅ 可用' if len(dd) > 0 else '⚠️ 无结果'}")
    elif isinstance(dd, dict):
        archives = dd.get("archives", [])
        print(f"   视频数: {len(archives)}")
        for a in archives[:3]:
            print(f"   - {a.get('title', 'N/A')[:50]}")
        print(f"   {'✅ 可用' if len(archives) > 0 else '⚠️ 无结果 (data格式变化)'}")
    else:
        print(f"   ⚠️ data 字段类型异常: {type(dd).__name__}")
else:
    print(f"   ❌ {str(data)[:200]}")
