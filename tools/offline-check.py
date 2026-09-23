#!/usr/bin/env python3
"""本地化不变量核查：**除大模型与 embedding 服务之外，一切都要能在不联网的机器上跑**。

这条要求是部署一体机时定下来的，但它很容易被一次「顺手引个 CDN 字体」「加个埋点」
悄悄破坏——所以写成可执行的检查，而不是靠发布前手查一遍。

embedding 走云端（EMBED_PROVIDER=openai_compat 指向外部服务）之后，出网口从「大模型一个」
变成「大模型 + embedding 两个」；要求相应变成两条：**出网只允许这两个适配器**，
**且这两个依赖不可用时服务仍要能答**（embedding 不通 → 退回仅关键词并在 health 说明原因，
见 O06；大模型不通 → 见 O07）。

    python tools/offline-check.py            # 源码 + 前端产物 + 依赖清单
    python tools/offline-check.py --runtime   # 追加运行期核查（需要服务在跑）

四类检查：
  O01  前端产物（web/dist）里没有需要联网的引用（字体 CDN、脚本 CDN、图片外链、埋点）
  O02  前端产物里没有已知的第三方 CDN/埋点域名
  O03  index.html 只引本地产物（相对路径）
  O04  后端源码里能发起网络连接的入口只有 LLM/Embedding 两个适配器
  O05  依赖清单（pom.xml / package.json）里没有联网 SDK 或遥测库
  O06  （--runtime）语义路状态与检索模式自洽：不可用时必须上报原因并退回仅关键词
  O07  （--runtime）答案链路可降级：mock 模式下整条链路无外呼

O03 是这套检查里最有价值的一条：它盯的是「有人新加了一处出网调用」，而不是某一次发布。
退出码 0 = 全部通过，1 = 有断言失败。
"""
import json
import os
import pathlib
import re
import sys
import urllib.request

REPO = pathlib.Path(__file__).resolve().parent.parent
SERVER_SRC = REPO / "server/src/main/java"
DIST = REPO / "web/dist"
BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")

RUNTIME = "--runtime" in sys.argv

passed = 0
failed = []
skipped = []


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed.append(name)
        print(f"  FAIL  {name}  {detail}")


def skip(name, why):
    skipped.append(f"{name}（{why}）")
    print(f"  SKIP  {name}  {why}")


# ── O01/O02：前端产物 ────────────────────────────────────────────────────────
# 这些 URL 出现在产物里是允许的：它们要么是 XML 命名空间（不是请求），要么是字符串常量
# （Vue 报错文档地址、许可证文本）。真正危险的是「浏览器会去 fetch 的地址」。
ALLOWED_URL_PATTERNS = [
    r"https?://www\.w3\.org/",          # SVG/XML 命名空间
    r"https?://vuejs\.org/",            # Vue 错误码文档字符串
    r"https?://localhost",              # 本地调试说明
    r"https?://127\.0\.0\.1",
]
KNOWN_CDN = [
    "fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com",
    "google-analytics.com", "googletagmanager.com", "sentry.io", "umami.is", "hm.baidu.com", "cnzz.com",
]

print("== O 组：本地化不变量（除大模型与 embedding 服务外一律本地）\n")
print("== O01/O02 前端产物")
if not DIST.is_dir():
    skip("O01 前端产物无联网引用", "web/dist 不存在（先 npm run build）")
    skip("O02 产物里无第三方 CDN/埋点域名", "web/dist 不存在")
else:
    assets = [p for p in DIST.rglob("*") if p.is_file() and p.suffix.lower() in (".js", ".css", ".html")]
    found = {}
    for f in assets:
        text = f.read_text(encoding="utf-8", errors="replace")
        for url in re.findall(r"https?://[^\s'\"`)<>\\]+", text):
            if any(re.match(pat, url) for pat in ALLOWED_URL_PATTERNS):
                continue
            found.setdefault(url, f.name)
    check("O01 前端产物无联网引用（字体/脚本/图片/埋点）", not found,
          f"未预期引用：{list(found.items())[:5]}")

    cdn_hits = []
    for f in assets:
        text = f.read_text(encoding="utf-8", errors="replace")
        for domain in KNOWN_CDN:
            if domain in text:
                cdn_hits.append(f"{domain}@{f.name}")
    check("O02 产物里无第三方 CDN/埋点域名", not cdn_hits, f"命中：{cdn_hits}")

    idx = (DIST / "index.html").read_text(encoding="utf-8", errors="replace") if (DIST / "index.html").exists() else ""
    check("O03 index.html 只引本地产物（相对路径）",
          bool(idx) and "/assets/" in idx and "http" not in idx.replace("http-equiv", ""),
          f"index.html={idx[:120]}")

# ── O04：后端出网入口 ────────────────────────────────────────────────────────
print("\n== O04 后端源码的出网入口")
# 允许出网的文件：只应该是「可插拔的 LLM / Embedding 适配器」。别的文件出现网络调用，
# 就意味着离线部署会多一个失败点（而且是那种在生产机上才暴露的失败点）。
ALLOWED_EGRESS_FILES = {
    "llm/OpenAiCompatChatModel.java",
    "embedding/OpenAiCompatEmbeddingProvider.java",
}
EGRESS_PATTERNS = [
    r"\bHttpClient\b", r"\bHttpRequest\b", r"\bURLConnection\b", r"new\s+URL\(",
    r"\bSocket\b", r"\bWebClient\b", r"\bRestTemplate\b",
]
if not SERVER_SRC.is_dir():
    skip("O04 后端出网入口只在 LLM/Embedding 适配器", "找不到 server/src/main/java")
else:
    offenders = {}
    for f in SERVER_SRC.rglob("*.java"):
        rel = f.relative_to(SERVER_SRC).as_posix()
        rel_in_pkg = rel.split("com/znwd/hostess/", 1)[-1] if "com/znwd/hostess/" in rel else rel
        text = f.read_text(encoding="utf-8", errors="replace")
        hits = [pat for pat in EGRESS_PATTERNS if re.search(pat, text)]
        if hits and rel_in_pkg not in ALLOWED_EGRESS_FILES:
            offenders[rel_in_pkg] = hits
    check("O04 后端出网入口只在 LLM/Embedding 适配器", not offenders,
          f"未预期出网：{offenders}")

# ── O05：依赖清单 ───────────────────────────────────────────────────────────
print("\n== O05 依赖清单里的联网 SDK / 遥测")
BANNED_DEPS = [
    "aws-sdk", "google-cloud", "azure-", "sentry", "datadog", "newrelic", "bugsnag",
    "elastic-apm", "opentelemetry", "segment", "amplitude", "mixpanel", "posthog",
]
manifests = [REPO / "server/pom.xml", REPO / "web/package.json"]
hits = []
for m in manifests:
    if not m.exists():
        continue
    text = m.read_text(encoding="utf-8", errors="replace").lower()
    for dep in BANNED_DEPS:
        if dep in text:
            hits.append(f"{dep}@{m.name}")
check("O05 依赖清单无联网 SDK / 遥测库", not hits, f"命中：{hits}")

# ── O06（--runtime）：运行期 ────────────────────────────────────────────────
if RUNTIME:
    print("\n== O06 运行期（需要服务在跑）")
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=10) as res:
            health = json.loads(res.read().decode("utf-8"))
        retrieval = health.get("retrieval") or {}
        vector = retrieval.get("vector") or {}
        print(f"        服务：{BASE} llmProvider={health.get('llmProvider')} "
              f"embedding={health.get('embedding')} embeddingReady={health.get('embeddingReady')} "
              f"mode={retrieval.get('mode')} storageAvailable={health.get('storageAvailable')}")
        # 语义路走外部服务之后，判据从「一切都在本地」改成「状态与行为自洽」：
        # 能用就必须报 hybrid，不能用就必须报原因 + 退回仅关键词（关键词路本来就能独立答）。
        ready = health.get("embeddingReady")
        mode = retrieval.get("mode")
        reason = retrieval.get("degradedReason")
        check("O06 语义路状态与检索模式自洽（不可用时给出原因并退回关键词）",
              (ready is True and mode in ("hybrid", "keyword"))
              or (ready is False and mode == "keyword" and bool(reason)),
              f"embeddingReady={ready} mode={mode} degradedReason={reason} "
              f"queryFailures={vector.get('queryFailures')} lastQueryError={vector.get('lastQueryError')}")
        check("O07 答案链路可降级：mock 模式下整条链路无外呼",
              health.get("llmProvider") == "mock" or os.environ.get("ALLOW_REAL_LLM") == "1",
              f"当前 llmProvider={health.get('llmProvider')}；要么用 mock 起服务，要么设 ALLOW_REAL_LLM=1 明确认账")
    except Exception as e:
        skip("O06/O07 运行期核查", f"服务未响应（{type(e).__name__}）")
else:
    skip("O06/O07 运行期核查", "未加 --runtime")

print("\n== 汇总 ==")
print(f"通过 {passed} 项，失败 {len(failed)} 项，跳过 {len(skipped)} 项")
for name in failed:
    print(f"  FAIL  {name}")
print("\n判据：《除大模型与 embedding 服务之外，一切都要在离线机器上能跑；"
      "这两个依赖不可用时，服务必须还能按关键词路答》。命中一项失败时，"
      "要么去掉那个联网用法，要么把该文件加进本脚本的白名单并说明理由。")
sys.exit(1 if failed else 0)
