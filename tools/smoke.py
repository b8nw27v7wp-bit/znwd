#!/usr/bin/env python3
"""接口契约冒烟测试（只用标准库，Windows/Linux 都能跑）。

为什么要它：前端、文档、一体机部署脚本都按这套契约写；契约悄悄变了比服务起不来更难查。
用法（先让服务跑起来，再执行）：
    python tools/smoke.py                 # 默认 http://127.0.0.1:8787
    BASE=http://127.0.0.1:9900 python tools/smoke.py
    ADMIN_TOKEN=<口令> python tools/smoke.py   # 带上才跑管理接口那一整块
退出码 0 = 全部通过，1 = 有断言失败。

管理接口（诊断 + 同义词）默认要口令（REQUIRE_ADMIN_TOKEN 默认 true，回环也不例外），
所以不带 ADMIN_TOKEN 时那一块记 SKIP 并在汇总里报出来；带了口令却还是 401 则是**配置错**，
按失败处理——不能让 17 条契约断言因为配错而无声消失。
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")
# 最小合法 WAV（44 字节头 + 2 字节采样，16kHz/单声道/16bit）。两条语音接口都是
# 「先判入参形状，再看服务开不开」（见 SpeechController：形状错就 400，跟开关无关），
# 所以验「未启用时是不是 503」必须喂一个它能收下的载荷，否则拿到的是 400。
MIN_WAV_DATA_URL = "data:audio/wav;base64," + base64.b64encode(
    b"RIFF" + (38).to_bytes(4, "little") + b"WAVEfmt " + (16).to_bytes(4, "little")
    + (1).to_bytes(2, "little") + (1).to_bytes(2, "little") + (16000).to_bytes(4, "little")
    + (32000).to_bytes(4, "little") + (2).to_bytes(2, "little") + (16).to_bytes(2, "little")
    + b"data" + (2).to_bytes(4, "little") + b"\x00\x00").decode("ascii")
# 管理接口（诊断 / 同义词 / 知识清单）默认要口令：REQUIRE_ADMIN_TOKEN 默认 true，回环也不例外。
ADMIN_TOKEN_ENV = os.environ.get("ADMIN_TOKEN", "").strip()
ADMIN_HEADERS = {"authorization": f"Bearer {ADMIN_TOKEN_ENV}"} if ADMIN_TOKEN_ENV else {}
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


def request(method, path, payload=None, raw_body=None, timeout=40, headers=None, binary=False):
    data = None
    hdrs = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        hdrs["content-type"] = "application/json"
    if raw_body is not None:
        data = raw_body
        hdrs["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read()
            # 语音合成回的是二进制 WAV，decode 成文本会把音频头弄坏，所以留一条原样返回的路
            return res.status, body if binary else body.decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        body = e.read()
        return e.code, body if binary else body.decode("utf-8", "replace")


def as_json(text):
    try:
        return json.loads(text)
    except Exception:
        return None


print(f"冒烟目标：{BASE}")

# 1) 健康检查
status, body = request("GET", "/api/health")
health = as_json(body) or {}
check("health 返回 200", status == 200, f"status={status}")
check("health.ok = true", health.get("ok") is True)
check("知识已加载", int(health.get("knowledgeChunks", 0)) > 0, f"chunks={health.get('knowledgeChunks')}")
check("上报检索模式", (health.get("retrieval") or {}).get("mode") in ("hybrid", "keyword"),
      f"retrieval={health.get('retrieval')}")
check("上报阈值（评测/线上同源）", "minKeywordScore" in ((health.get("retrieval") or {}).get("thresholds") or {}))
check("上报存储与可用性", health.get("storage") == "mysql" and "storageAvailable" in health)

# 2) 语音接口：开关的两种状态都必须是「可判定的」——开了要真出 WAV，
#    没开要给前端一个明确的 503，它才能当场退回浏览器内置播报（而不是反复重试）。
print("\n语音接口")
check("health 上报语音开关与可用性", "speech" in health and "speechReady" in health,
      f"speech={health.get('speech')} ready={health.get('speechReady')}")

status, raw = request("POST", "/api/speech/synthesize", {"text": "冒烟测试，欢迎参观。"}, binary=True)
if health.get("speechReady"):
    check("合成返回 200", status == 200, f"status={status}")
    check("合成回的是 WAV 字节", isinstance(raw, bytes) and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE",
          f"head={raw[:12] if isinstance(raw, bytes) else raw!r}")
    check("合成的 WAV 有实际音频数据", isinstance(raw, bytes) and len(raw) > 44,
          f"bytes={len(raw) if isinstance(raw, bytes) else 0}")

    status, body = request("POST", "/api/speech/synthesize", {"text": "字" * 400})
    check("合成文本超长 400", status == 400 and (as_json(body) or {}).get("error") == "validation_error",
          f"status={status} body={body[:120]}")

    status, body = request("POST", "/api/speech/recognize", {"audio": "data:audio/wav;base64,aGVsbG8="})
    check("识别收到非 WAV 载荷 400", status == 400 and (as_json(body) or {}).get("error") == "validation_error",
          f"status={status} body={body[:120]}")

    status, body = request("POST", "/api/speech/recognize", {"audio": ""})
    check("识别缺音频 400", status == 400, f"status={status}")
else:
    check("未启用语音时合成返回 503", status == 503, f"status={status}")
    check("未启用时的错误码可判定", (as_json(raw) or {}).get("error") == "speech_unavailable",
          f"body={str(raw)[:160]}")
    check("未启用语音时识别同样 503",
          request("POST", "/api/speech/recognize", {"audio": MIN_WAV_DATA_URL})[0] == 503)

# 录音体积闸门在业务之前，与语音开关无关：3MB 的 base64 必须被 413 挡在门外
status, body = request("POST", "/api/speech/recognize",
                       {"audio": "data:audio/wav;base64," + "A" * (3 * 1024 * 1024)})
check("超大录音被 413 拦下", status == 413 and (as_json(body) or {}).get("error") == "payload_too_large",
      f"status={status} body={body[:120]}")

# 3) 在域问答：必须走 rag 并给出 sources
status, body = request("POST", "/api/chat", {"message": "光伏清洁无人机是做什么的？", "sessionId": "smoke-in"})
chat = as_json(body) or {}
check("问答 200", status == 200, f"status={status} body={body[:120]}")
for field in ("answer", "sources", "mode", "provider", "retrieval", "noHit", "latencyMs"):
    check(f"响应含字段 {field}", field in chat)
check("在域问题命中资料", chat.get("mode") == "rag" and chat.get("noHit") is False,
      f"mode={chat.get('mode')} noHit={chat.get('noHit')}")

# 4) 多轮追问：应带上改写信息
status, body = request("POST", "/api/chat", {"message": "那要多久？", "sessionId": "smoke-in"})
follow = as_json(body) or {}
rewrite = follow.get("rewrite") or {}
check("追问触发上下文改写", bool(rewrite.get("rewritten")) and rewrite.get("reason") != "none",
      f"rewrite={rewrite}")

# 5) 域外问答：闸门拦截，固定回复不走模型
status, body = request("POST", "/api/chat", {"message": "帮我写一首关于夏天的诗", "sessionId": "smoke-out"})
out = as_json(body) or {}
check("域外问题 noHit=true", out.get("noHit") is True, f"noHit={out.get('noHit')}")
check("域外问题不给来源", out.get("sources") == [], f"sources={out.get('sources')}")
check("域外问题 provider=gate", out.get("provider") == "gate", f"provider={out.get('provider')}")

# 6) 流式：第一帧必须是 meta
status, body = request("POST", "/api/chat/stream", {"message": "叶片检测要停机吗？", "sessionId": "smoke-stream"})
check("SSE 200 且首帧为 meta", status == 200 and body.lstrip().startswith("event:meta"), f"head={body[:60]!r}")
check("SSE 含 delta 与 done", "event:delta" in body and "event:done" in body)

# 7) 入参校验与统一错误信封
status, body = request("POST", "/api/chat", raw_body=b'{"sessionId":"x"}')
err = as_json(body) or {}
check("缺 message 返回 400", status == 400, f"status={status}")
check("错误码 validation_error", err.get("error") == "validation_error", f"error={err.get('error')}")

status, body = request("POST", "/api/chat", raw_body=b"[1,2,3]")
err = as_json(body) or {}
check("body 非对象返回 400", status == 400 and err.get("error") == "validation_error", f"status={status}")

status, body = request("POST", "/api/feedback", {"sessionId": "smoke-in", "rating": "maybe"})
check("rating 非法返回 400", status == 400, f"status={status}")

status, body = request("POST", "/api/feedback", {"sessionId": "smoke-in", "rating": "up"})
check("点赞返回 ok", status == 200 and (as_json(body) or {}).get("ok") is True, f"status={status}")

# 8) 未知路由
status, body = request("GET", "/api/does-not-exist")
check("未知路由 404 + not_found", status == 404 and (as_json(body) or {}).get("error") == "not_found",
      f"status={status}")

# 9) 只读元数据接口
# /api/knowledge/list 是管理面接口（会吐出 knowledgeDir / 索引文件绝对路径与全部文档清单），
# 和下面第 10 块一样要口令，所以从公开只读接口这一组里拿出去、带 ADMIN_HEADERS 验。
# **它的断言必须写在管理员块的守卫之内**：以前它放在守卫之前，不带 ADMIN_TOKEN 时直接拿 401 判成
# FAIL（看着像「清单坏了」，其实只是没带口令），而同一时刻管理块自己记的是 SKIP。
for path in ("/api/suggestions", "/api/suggestions?zone=wind-inspect", "/api/zones",
             "/api/openapi.json"):
    status, _ = request("GET", path)
    check(f"{path} 200", status == 200, f"status={status}")

# 10) 管理员接口：检索诊断 + 同义词热更新
# 原来这里只 print 一行 SKIP 就把整块 17 条断言跳过，汇总里既不算过也不算跳过——
# CI 实际少跑了三分之一的用例还报「通过」。改成：带了口令就必须真能用（配置错 = 失败），
# 没带才记 SKIP 并在汇总里报出来。
status, probe_body = request("GET", "/api/admin/diagnostics?q=ping", headers=ADMIN_HEADERS)
ADMIN_SKIPPED = False
if status == 401 and ADMIN_TOKEN_ENV:
    check("管理接口用 ADMIN_TOKEN 应放行（否则下面 17 条全被跳过）", False,
          f"带口令访问 /api/admin/diagnostics 得到 401；检查 ADMIN_TOKEN 与被测实例是否同源：{probe_body[:120]}")
    ADMIN_SKIPPED = True
elif status == 401:
    skip("管理员接口整块（诊断契约 / 同义词读·写·热生效·回滚）",
         "未设 ADMIN_TOKEN，服务按设计拒绝匿名访问；设上它才能验这一块")
    ADMIN_SKIPPED = True
if not ADMIN_SKIPPED:
    # 知识清单（管理面）：块数、展区分布与同义词表摘要
    status, body = request("GET", "/api/knowledge/list", headers=ADMIN_HEADERS)
    meta = as_json(body) or {}
    check("清单里带同义词表摘要", status == 200 and isinstance(meta.get("synonyms"), dict)
          and meta["synonyms"].get("count", 0) > 0,
          f"status={status} synonyms={meta.get('synonyms')}")

    q_in = urllib.parse.quote("光伏清洁无人机是做什么的？")
    status, body = request("GET", f"/api/admin/diagnostics?q={q_in}", headers=ADMIN_HEADERS)
    diag = as_json(body) or {}
    check("诊断 200", status == 200, f"status={status} body={body[:120]}")
    for field in ("query", "gated", "reason", "verdict", "hits", "thresholds", "distanceToGate"):
        check(f"诊断含字段 {field}", field in diag)
    check("在域问题不被闸门拦", diag.get("gated") is False and diag.get("hits"),
          f"gated={diag.get('gated')} hits={len(diag.get('hits') or [])}")
    check("诊断给人话结论", isinstance(diag.get("verdict"), str) and len(diag["verdict"]) > 8,
          f"verdict={diag.get('verdict')}")
    check("命中项带两路分数", all("keywordScore" in h and "vectorScore" in h for h in (diag.get("hits") or [])),
          f"hits[0]={ (diag.get('hits') or [{}])[0] }")

    q_out = urllib.parse.quote("帮我写一首关于夏天的诗")
    status, body = request("GET", f"/api/admin/diagnostics?q={q_out}", headers=ADMIN_HEADERS)
    out_diag = as_json(body) or {}
    check("域外问题诊断 gated=true", out_diag.get("gated") is True, f"gated={out_diag.get('gated')}")
    check("域外诊断说明原因", "闸门" in str(out_diag.get("verdict")), f"verdict={out_diag.get('verdict')}")

    status, body = request("GET", "/api/admin/diagnostics", headers=ADMIN_HEADERS)
    check("诊断缺 q 返回 400", status == 400 and (as_json(body) or {}).get("error") == "validation_error",
          f"status={status}")

    status, body = request("GET", "/api/admin/synonyms", headers=ADMIN_HEADERS)
    syn = as_json(body) or {}
    check("同义词表 200", status == 200 and syn.get("count", 0) > 0, f"status={status} count={syn.get('count')}")
    check("同义词表来源可追溯", bool(syn.get("source")) and bool(syn.get("file")), f"source={syn.get('source')}")
    original = {e["key"]: list(e["alternatives"]) for e in (syn.get("entries") or [])}

    if original:
        # 临时加一个探针词：ZWBROBE 本身不与语料重叠，加同义词后关键词分必须从 0 抬起来
        probe = urllib.parse.quote("ZWPROBE")
        _, body = request("GET", f"/api/admin/diagnostics?q={probe}", headers=ADMIN_HEADERS)
        before = float((as_json(body) or {}).get("keywordBestScore") or 0.0)

        probe_table = dict(original)
        probe_table["ZWPROBE"] = ["ZWPROBE", "叶片", "风叶"]
        status, body = request("PUT", "/api/admin/synonyms",
                               {"entries": probe_table, "persist": False}, headers=ADMIN_HEADERS)
        put = as_json(body) or {}
        check("同义词 PUT 200", status == 200 and put.get("ok") is True, f"status={status} body={body[:120]}")
        check("PUT 不落盘时不写文件", put.get("persistedTo") is None, f"persistedTo={put.get('persistedTo')}")
        check("PUT 声明无需重建索引", put.get("reloadRequired") is False, f"reloadRequired={put.get('reloadRequired')}")

        _, body = request("GET", f"/api/admin/diagnostics?q={probe}", headers=ADMIN_HEADERS)
        after = float((as_json(body) or {}).get("keywordBestScore") or 0.0)
        check("热更新立即生效（探针词关键词分被抬起来）", after > before,
              f"before={before} after={after}")

        status, body = request("PUT", "/api/admin/synonyms",
                               {"entries": original, "persist": False}, headers=ADMIN_HEADERS)
        restored = as_json(body) or {}
        check("还原同义词表", status == 200 and restored.get("count") == syn.get("count"),
              f"status={status} count={restored.get('count')} want={syn.get('count')}")
        _, body = request("GET", f"/api/admin/diagnostics?q={probe}", headers=ADMIN_HEADERS)
        back = float((as_json(body) or {}).get("keywordBestScore") or 0.0)
        check("还原后探针词回到原分", back == before, f"before={before} now={back}")

        status, body = request("PUT", "/api/admin/synonyms", {"entries": {}}, headers=ADMIN_HEADERS)
        check("空同义词表返回 400", status == 400, f"status={status}")

print(f"\n通过 {passed} 项，失败 {len(failed)} 项，跳过 {len(skipped)} 组")
if skipped:
    print("跳过：" + "；".join(skipped))
if failed:
    print("失败项：" + "、".join(failed))
sys.exit(1 if failed else 0)
