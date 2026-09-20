#!/usr/bin/env python3
"""接口契约冒烟测试（只用标准库，Windows/Linux 都能跑）。

为什么要它：前端、文档、一体机部署脚本都按这套契约写；契约悄悄变了比服务起不来更难查。
用法（先让服务跑起来，再执行）：
    python tools/smoke.py                 # 默认 http://127.0.0.1:8787
    BASE=http://127.0.0.1:9900 python tools/smoke.py
退出码 0 = 全部通过，1 = 有断言失败。
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")
passed = 0
failed = []


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed.append(name)
        print(f"  FAIL  {name}  {detail}")


def request(method, path, payload=None, raw_body=None, timeout=40, headers=None):
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
            body = res.read().decode("utf-8", "replace")
            return res.status, body
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


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

# 2) 在域问答：必须走 rag 并给出 sources
status, body = request("POST", "/api/chat", {"message": "光伏清洁无人机是做什么的？", "sessionId": "smoke-in"})
chat = as_json(body) or {}
check("问答 200", status == 200, f"status={status} body={body[:120]}")
for field in ("answer", "sources", "mode", "provider", "retrieval", "noHit", "latencyMs"):
    check(f"响应含字段 {field}", field in chat)
check("在域问题命中资料", chat.get("mode") == "rag" and chat.get("noHit") is False,
      f"mode={chat.get('mode')} noHit={chat.get('noHit')}")

# 3) 多轮追问：应带上改写信息
status, body = request("POST", "/api/chat", {"message": "那要多久？", "sessionId": "smoke-in"})
follow = as_json(body) or {}
rewrite = follow.get("rewrite") or {}
check("追问触发上下文改写", bool(rewrite.get("rewritten")) and rewrite.get("reason") != "none",
      f"rewrite={rewrite}")

# 4) 域外问答：闸门拦截，固定回复不走模型
status, body = request("POST", "/api/chat", {"message": "帮我写一首关于夏天的诗", "sessionId": "smoke-out"})
out = as_json(body) or {}
check("域外问题 noHit=true", out.get("noHit") is True, f"noHit={out.get('noHit')}")
check("域外问题不给来源", out.get("sources") == [], f"sources={out.get('sources')}")
check("域外问题 provider=gate", out.get("provider") == "gate", f"provider={out.get('provider')}")

# 5) 流式：第一帧必须是 meta
status, body = request("POST", "/api/chat/stream", {"message": "叶片检测要停机吗？", "sessionId": "smoke-stream"})
check("SSE 200 且首帧为 meta", status == 200 and body.lstrip().startswith("event:meta"), f"head={body[:60]!r}")
check("SSE 含 delta 与 done", "event:delta" in body and "event:done" in body)

# 6) 入参校验与统一错误信封
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

# 7) 未知路由
status, body = request("GET", "/api/does-not-exist")
check("未知路由 404 + not_found", status == 404 and (as_json(body) or {}).get("error") == "not_found",
      f"status={status}")

# 8) 只读元数据接口
for path in ("/api/suggestions", "/api/suggestions?zone=wind-inspect", "/api/zones", "/api/knowledge/list",
             "/api/openapi.json"):
    status, _ = request("GET", path)
    check(f"{path} 200", status == 200, f"status={status}")

status, body = request("GET", "/api/knowledge/list")
meta = as_json(body) or {}
check("清单里带同义词表摘要", isinstance(meta.get("synonyms"), dict) and meta["synonyms"].get("count", 0) > 0,
      f"synonyms={meta.get('synonyms')}")

# 9) 管理员接口：检索诊断 + 同义词热更新
ADMIN_HEADERS = {"authorization": f"Bearer {os.environ['ADMIN_TOKEN']}"} if os.environ.get("ADMIN_TOKEN") else {}
status, _ = request("GET", "/api/admin/diagnostics?q=ping", headers=ADMIN_HEADERS)
if status == 401:
    print("  SKIP  管理员接口（未配置 ADMIN_TOKEN，按设计拒绝匿名访问）")
else:
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

print(f"\n通过 {passed} 项，失败 {len(failed)} 项")
if failed:
    print("失败项：" + "、".join(failed))
    sys.exit(1)
