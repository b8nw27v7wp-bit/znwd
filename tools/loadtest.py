#!/usr/bin/env python3
"""并发/压测工具（纯标准库，Windows/Linux 都能跑）。

为什么要有它：单测与冒烟都是「一条一条按顺序打」，证明不了多路并发下的会话隔离
（串话）、SSE 帧序（meta → delta* → done）、只读接口不受聊天限流牵连，以及客户端
硬断开后服务端还能正常接客。这个脚本把四类场景同时压上去，并如实报告 429。

429 语义：限流是预期行为，**不算失败**，但单列计数；某场景一次成功样本都没有
（全 429）时按失败处理——没验到契约就不能报绿。任何 5xx 或连接错误都算失败。

用法（先让服务跑起来，再执行）：
    py -3 tools/loadtest.py                                  # 默认 127.0.0.1:8787，非流式 8 / SSE 4 / 只读 4
    py -3 tools/loadtest.py --n 4 --streams 2                # 限流窗口小的时候降并发
    py -3 tools/loadtest.py --duration 7200                  # 长跑 2 小时（docs/test-cases.md TC-PERF-07）
    py -3 tools/loadtest.py --base http://127.0.0.1:8899 --n 24 --streams 12 --rounds 1
    ADMIN_TOKEN=<口令> py -3 tools/loadtest.py               # 带口令时把 /api/stats 也纳入只读并发
退出码 0 = 场景全过，1 = 有失败（5xx、连接错误或契约断言不过）。
"""
import argparse
import http.client
import json
import os
import socket
import struct
import sys
import threading
import time
import urllib.parse

# 冒烟输出会被 CI/Windows 控制台直接吃掉：显式 UTF-8 + errors=replace，打印失败不算失败
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 在域问题：走 rag 分支，answer 必然非空；不要用域外问题（被闸门固定拦下，压不到模型）
QUESTION = "光伏清洁无人机是做什么的？"

# 目标配置（main 里解析 --base 后填）
SCHEME = "http"
HOST = "127.0.0.1"
PORT = 8787
PREFIX = ""
TIMEOUT = 60.0
RUN_ID = "lt0"

# 只读接口：与聊天无关，不受 CHAT_RATE_PER_MIN 影响
READ_PATHS = ("/api/health", "/api/zones", "/api/suggestions")


class Sink:
    """一个场景的计数与延迟。429 单列；失败明细封顶 50 条，长跑时不撑爆内存。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.total = 0
        self.ok = 0
        self.rl = 0
        self.hard = 0
        self.fail_count = 0
        self.failures = []
        self.lat = []

    def record_ok(self, ms):
        with self.lock:
            self.total += 1
            self.ok += 1
            self.lat.append(ms)

    def record_rl(self, detail=None):
        with self.lock:
            self.total += 1
            self.rl += 1
            if detail:
                self._fail(detail)

    def record_fail(self, detail, hard=False):
        with self.lock:
            self.total += 1
            if hard:
                self.hard += 1
            self._fail(detail)

    def _fail(self, detail):
        self.fail_count += 1
        if len(self.failures) < 50:
            self.failures.append(detail)

    def snapshot(self):
        with self.lock:
            return (self.total, self.ok, self.rl, self.hard,
                    self.fail_count, list(self.failures), list(self.lat))


def new_conn():
    cls = http.client.HTTPSConnection if SCHEME == "https" else http.client.HTTPConnection
    return cls(HOST, PORT, timeout=TIMEOUT)


def as_json(text):
    try:
        return json.loads(text)
    except Exception:
        return {}


def shorten(text, limit=160):
    s = text if isinstance(text, str) else repr(text)
    return s.replace("\n", "\\n")[:limit]


def chat_body(session_id):
    # 中文必须显式 UTF-8；ensure_ascii=False 后不编码会以 GBK 发出去，后端收到乱码
    return json.dumps({"message": QUESTION, "sessionId": session_id},
                      ensure_ascii=False).encode("utf-8")


def percentile(values, p):
    if not values:
        return None
    xs = sorted(values)
    return xs[int(round((len(xs) - 1) * p))]


def chat_once(session_id, sink):
    """非流式问答：200 + answer 非空 + sessionId 回显一致；5xx/连接错误=失败。"""
    started = time.perf_counter()
    try:
        conn = new_conn()
        conn.request("POST", PREFIX + "/api/chat", body=chat_body(session_id),
                     headers={"content-type": "application/json"})
        resp = conn.getresponse()
        status = resp.status
        raw = resp.read()
        conn.close()
    except (OSError, http.client.HTTPException) as e:
        sink.record_fail(f"nonstream {session_id}: 连接错误 {e!r}", hard=True)
        return
    ms = (time.perf_counter() - started) * 1000
    if status == 429:
        sink.record_rl()
        return
    body = raw.decode("utf-8", "replace")
    if status >= 500:
        sink.record_fail(f"nonstream {session_id}: HTTP {status} {shorten(body)}", hard=True)
        return
    if status != 200:
        sink.record_fail(f"nonstream {session_id}: HTTP {status} {shorten(body)}")
        return
    data = as_json(body)
    problems = []
    if not str(data.get("answer") or "").strip():
        problems.append("answer 为空")
    if data.get("sessionId") != session_id:
        problems.append(f"sessionId 回显 {data.get('sessionId')!r} != {session_id!r}（疑似串话）")
    if problems:
        sink.record_fail(f"nonstream {session_id}: " + "；".join(problems))
    else:
        sink.record_ok(ms)


def stream_once(session_id, sink):
    """SSE 问答：首帧 meta、含 delta、末帧 done 且 answer 非空、会话回显一致。"""
    started = time.perf_counter()
    try:
        conn = new_conn()
        conn.request("POST", PREFIX + "/api/chat/stream", body=chat_body(session_id),
                     headers={"content-type": "application/json", "accept": "text/event-stream"})
        resp = conn.getresponse()
        status = resp.status
        if status == 429:
            resp.read()
            conn.close()
            sink.record_rl()
            return
        if status >= 500:
            body = resp.read().decode("utf-8", "replace")
            conn.close()
            sink.record_fail(f"sse {session_id}: HTTP {status} {shorten(body)}", hard=True)
            return
        if status != 200:
            body = resp.read().decode("utf-8", "replace")
            conn.close()
            sink.record_fail(f"sse {session_id}: HTTP {status} {shorten(body)}")
            return
        # 逐行解析 SSE：event/data 累积到空行为一帧；':' 开头是心跳注释，直接忽略
        frames = []
        event, data_lines = None, []
        for raw_line in resp:
            line = raw_line.decode("utf-8", "replace").rstrip("\r\n")
            if line == "":
                if event is not None or data_lines:
                    frames.append((event, "\n".join(data_lines)))
                event, data_lines = None, []
            elif line.startswith(":"):
                continue
            elif line.startswith("event:"):
                event = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:"):].lstrip())
        conn.close()
    except (OSError, http.client.HTTPException) as e:
        sink.record_fail(f"sse {session_id}: 连接错误 {e!r}", hard=True)
        return
    ms = (time.perf_counter() - started) * 1000
    problems = []
    if not frames:
        problems.append("没有收到任何 SSE 帧")
    else:
        if frames[0][0] != "meta":
            problems.append(f"首帧是 {frames[0][0]!r}，应为 meta")
        meta = as_json(frames[0][1]) if frames[0][0] == "meta" else {}
        if meta.get("sessionId") != session_id:
            problems.append(f"meta.sessionId={meta.get('sessionId')!r} != {session_id!r}（疑似串话）")
        seen_meta = False
        delta_count = 0
        done_data = None
        for ev, data in frames:
            if ev == "meta":
                seen_meta = True
            elif ev == "delta":
                if not seen_meta:
                    problems.append("meta 之前出现 delta")
                delta_count += 1
            elif ev == "done":
                done_data = data
        if delta_count == 0:
            problems.append("没有 delta 帧")
        if done_data is None:
            problems.append("没有 done 帧")
        else:
            done = as_json(done_data)
            if not str(done.get("answer") or "").strip():
                problems.append("done.answer 为空")
            # 服务端当前把 sessionId 回显在 meta 上（done 带 sessionToken）；done 里若
            # 也带 sessionId 就必须一致——两边都查，串话无处可藏。
            if "sessionId" in done and done.get("sessionId") != session_id:
                problems.append(f"done.sessionId={done.get('sessionId')!r} != {session_id!r}（疑似串话）")
    if problems:
        sink.record_fail(f"sse {session_id}: " + "；".join(problems))
    else:
        sink.record_ok(ms)


def reader_lane(lane, stop, sink, token):
    """只读并发：问答/流式进行时同时打 200 接口；带口令时把 /api/stats 也轮进去。"""
    paths = list(READ_PATHS)
    if token:
        paths.append("/api/stats")
    i = lane
    while not stop.is_set():
        path = paths[i % len(paths)]
        i += 1
        headers = {"authorization": f"Bearer {token}"} if path == "/api/stats" else {}
        started = time.perf_counter()
        try:
            conn = new_conn()
            conn.request("GET", PREFIX + path, headers=headers)
            resp = conn.getresponse()
            status = resp.status
            raw = resp.read()
            conn.close()
        except (OSError, http.client.HTTPException) as e:
            sink.record_fail(f"read {path}: 连接错误 {e!r}", hard=True)
            time.sleep(0.1)
            continue
        ms = (time.perf_counter() - started) * 1000
        if status == 200:
            sink.record_ok(ms)
        elif status == 429:
            # 只读接口按设计不受聊天限流影响；收到 429 就是这条前提被破坏，判失败
            sink.record_rl(detail=f"read {path}: 被限流 429（只读接口不该受聊天限流影响）")
        elif status >= 500:
            sink.record_fail(f"read {path}: HTTP {status} {shorten(raw.decode('utf-8', 'replace'))}",
                             hard=True)
        else:
            sink.record_fail(f"read {path}: HTTP {status} {shorten(raw.decode('utf-8', 'replace'))}")
        time.sleep(0.02)  # 轻微间隔：模拟真实观众刷新，不至于把只读接口打成压力工具


def interrupt_check(sink):
    """客户端中断：发一条流式后硬断开（RST），随后正常问一次必须仍 200。"""
    abort_sid = f"{RUN_ID}-int-a"
    try:
        conn = new_conn()
        conn.request("POST", PREFIX + "/api/chat/stream", body=chat_body(abort_sid),
                     headers={"content-type": "application/json", "accept": "text/event-stream"})
        resp = conn.getresponse()
        if resp.status == 200:
            resp.readline()  # 等首帧（meta），保证断开发生在服务端推送途中
        sock = conn.sock
        if sock is not None:
            try:
                # SO_LINGER=0：close 直接发 RST，模拟观众关屏/切页这种硬断开。
                # Windows 的 struct linger 是两个 u_short，Unix 是两个 int，格式跟着平台走。
                linger = struct.pack("HH" if os.name == "nt" else "ii", 1, 0)
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
            except OSError:
                pass
            sock.close()
        conn.close()
    except socket.timeout as e:
        sink.record_fail(f"中断流在超时内没发出首帧：{e!r}", hard=True)
    except (OSError, http.client.HTTPException) as e:
        sink.record_fail(f"中断流连接失败：{e!r}", hard=True)

    time.sleep(0.3)  # 给服务端处理断开留一点时间
    chat_once(f"{RUN_ID}-int-b", sink)


def lane_worker(kind, lane, sink, rounds, deadline):
    sid = f"{RUN_ID}-{kind}-{lane}"
    sent = 0
    while True:
        if deadline is not None:
            if time.monotonic() >= deadline:
                break
        elif sent >= rounds:
            break
        sent += 1
        if kind == "s":
            stream_once(sid, sink)
        else:
            chat_once(sid, sink)


def progress_printer(sinks, start, stop):
    while not stop.wait(30):
        elapsed = int(time.monotonic() - start)
        parts = []
        for name, sink in sinks:
            total, ok, rl, hard, fail_count = sink.snapshot()[:5]
            parts.append(f"{name} ok={ok} 429={rl} fail={fail_count} req={total}")
        print(f"[{elapsed}s] " + "  ".join(parts), flush=True)


def scenario_verdict(sink):
    total, ok, rl, hard, fail_count = sink.snapshot()[:5]
    if total == 0:
        return None, "未配置并发（SKIP）"
    if fail_count:
        return False, f"{fail_count} 条失败"
    if ok == 0:
        return False, f"全部 {rl} 次都是 429，没有验到契约"
    return True, ""


def report(sinks):
    scenarios = [
        ("nonstream", "非流式并发（会话隔离 / 字段 / 无 5xx）", sinks["n"]),
        ("sse", "SSE 并发（meta→delta→done / 会话隔离）", sinks["s"]),
        ("readers", "只读并发（health / zones / suggestions）", sinks["r"]),
        ("interrupt", "客户端中断后恢复（断开后再问一次）", sinks["i"]),
    ]
    passed = failed = 0
    print("\n===== loadtest report =====")
    for key, label, sink in scenarios:
        total, ok, rl, hard, fail_count, failures, lat = sink.snapshot()
        verdict, note = scenario_verdict(sink)
        if verdict is None:
            print(f"{key:10s} SKIP  {note}")
            continue
        p50 = percentile(lat, 0.5)
        p95 = percentile(lat, 0.95)
        timing = f"P50 {p50:.0f}ms P95 {p95:.0f}ms" if p50 is not None else "P50 - P95 -"
        state = "PASS" if verdict else "FAIL"
        if verdict:
            passed += 1
        else:
            failed += 1
        suffix = f"  {note}" if note else ""
        print(f"{key:10s} {state}  req {total} ok {ok} 429 {rl} fail {fail_count}  {timing}{suffix}")
        for detail in failures[:5]:
            print(f"    - {detail}")

    hard_total = sum(sinks[k].hard for k in sinks)
    totals = [sum(sinks[k].total for k in sinks), sum(sinks[k].ok for k in sinks),
              sum(sinks[k].rl for k in sinks), sum(sinks[k].fail_count for k in sinks)]
    if hard_total == 0:
        passed += 1
        print(f"harderrors PASS  （无 5xx / 连接错误）")
    else:
        failed += 1
        print(f"harderrors FAIL  （{hard_total} 次 5xx / 连接错误）")
    print(f"合计 req {totals[0]} ok {totals[1]} 429 {totals[2]} fail {totals[3]}")
    print(f"通过 {passed} 项，失败 {failed} 项")
    return failed


def build_parser():
    p = argparse.ArgumentParser(
        description="并发/压测：非流式 + SSE + 只读 + 中断恢复；429 单列，5xx/连接错误判失败",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter)
    p.add_argument("--base", default="http://127.0.0.1:8787", help="目标地址")
    p.add_argument("--n", type=int, default=8, help="非流式问答并发路数")
    p.add_argument("--streams", type=int, default=4, help="SSE 并发路数")
    p.add_argument("--readers", type=int, default=4, help="只读并发路数")
    p.add_argument("--rounds", type=int, default=1, help="每路轮数；给 --duration 时忽略")
    p.add_argument("--duration", type=float, default=None,
                   help="持续压测秒数（长跑，如 7200 = 2 小时）")
    p.add_argument("--timeout", type=float, default=60.0, help="单请求超时秒数")
    p.add_argument("--token", default=os.environ.get("ADMIN_TOKEN", ""),
                   help="管理只读接口口令（用于 /api/stats；默认取环境变量 ADMIN_TOKEN）")
    return p


def main():
    global SCHEME, HOST, PORT, PREFIX, TIMEOUT, RUN_ID
    args = build_parser().parse_args()
    if args.n + args.streams + args.readers <= 0:
        build_parser().error("--n / --streams / --readers 不能全为 0，否则没有可压的场景")

    base = args.base.rstrip("/")
    u = urllib.parse.urlsplit(base)
    SCHEME = u.scheme or "http"
    HOST = u.hostname or "127.0.0.1"
    PORT = u.port or (443 if SCHEME == "https" else 80)
    PREFIX = u.path.rstrip("/")
    TIMEOUT = args.timeout
    RUN_ID = f"lt{int(time.time() * 1000) % 10_000_000}"
    rounds = max(1, args.rounds)
    token = (args.token or "").strip()

    print(f"loadtest target {base}  n={args.n} streams={args.streams} readers={args.readers} "
          f"rounds={rounds} duration={args.duration or '-'} timeout={args.timeout:g}s")
    if token:
        print("admin token 已提供：/api/stats 纳入只读并发")
    print("429 属预期限流，单列计数不算失败；5xx / 连接错误判失败")

    sink_n, sink_s, sink_r, sink_i = Sink(), Sink(), Sink(), Sink()
    start = time.monotonic()
    deadline = start + args.duration if args.duration else None
    stop = threading.Event()
    progress_stop = threading.Event()

    reader_threads = []
    for lane in range(args.readers):
        t = threading.Thread(target=reader_lane, args=(lane, stop, sink_r, token), daemon=True)
        t.start()
        reader_threads.append(t)
    if args.duration:
        threading.Thread(target=progress_printer,
                         args=([("nonstream", sink_n), ("sse", sink_s), ("readers", sink_r)],
                               start, progress_stop), daemon=True).start()

    # 场景 4 先跑：既验「硬断开后恢复」，也顺带当预热——实例真能问答，后面的并发数才可信
    interrupt_check(sink_i)

    lanes = []
    for lane in range(args.n):
        lanes.append(threading.Thread(target=lane_worker,
                                      args=("n", lane, sink_n, rounds, deadline), daemon=True))
    for lane in range(args.streams):
        lanes.append(threading.Thread(target=lane_worker,
                                      args=("s", lane, sink_s, rounds, deadline), daemon=True))
    for t in lanes:
        t.start()
    for t in lanes:
        t.join()

    stop.set()
    for t in reader_threads:
        t.join()
    progress_stop.set()

    elapsed = time.monotonic() - start
    print(f"\n共耗时 {elapsed:.1f}s")
    failed = report({"n": sink_n, "s": sink_s, "r": sink_r, "i": sink_i})
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
