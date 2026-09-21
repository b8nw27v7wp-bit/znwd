#!/usr/bin/env python3
"""数据库层脱敏与最小权限核查（只用标准库 + 本机 mysql 客户端）。

与 tools/security.py 的分工：那一套只打 HTTP，不碰数据库；这一套专看**落库之后**的样子——
运维导出、备份、误配权限这些场景里，表格里存了什么才是真正会被扩散的东西。

    python tools/db-check.py                     # 用 server/.env 里的 DB_* 连本机库
    MYSQL_BIN="/d/MySQL/MySQL Server9.7/bin/mysql.exe" python tools/db-check.py
    DB_HOST=127.0.0.1 DB_USER=znwd DB_PASSWORD=… python tools/db-check.py   # 环境变量优先（CI 用）

没有 mysql 客户端、或库连不上时，用例标 SKIP（不是通过）。口令通过临时 option 文件传给客户端，
**不出现在命令行参数里**（Windows 上命令行对同机其他进程可见）。
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import urllib.request
import uuid

REPO = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = REPO / "server/.env"
BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")

CANDIDATE_CLIENTS = [
    os.environ.get("MYSQL_BIN", ""),
    r"D:/MySQL/MySQL Server9.7/bin/mysql.exe",
    r"C:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe",
    "/usr/bin/mysql",
    "/usr/local/bin/mysql",
]

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


def env_value(key, default=""):
    """取值顺序与后端一致：系统环境变量 > server/.env > 默认值。

    CI 里没有 server/.env，库信息全部来自 job 的环境变量；本地则读 .env。
    """
    if os.environ.get(key):
        return os.environ[key].strip()
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return default


def find_client():
    for cand in CANDIDATE_CLIENTS:
        if not cand:
            continue
        p = pathlib.Path(cand)
        if p.is_file():
            return str(p)
    found = shutil.which("mysql")
    return found


class Db:
    """通过临时 option 文件调用 mysql 客户端（口令不进命令行）。"""

    def __init__(self, client, host, port, user, password, database):
        self.client = client
        self.database = database
        self.opt = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / f"znwd_dbcheck_{os.getpid()}.cnf"
        self.opt.write_text(
            f"[client]\nhost={host}\nport={port}\nuser={user}\npassword={password}\ndatabase={database}\n"
            "default-character-set=utf8mb4\n",
            encoding="utf-8",
        )
        try:
            os.chmod(self.opt, 0o600)
        except OSError:
            pass

    def run(self, sql):
        proc = subprocess.run([self.client, f"--defaults-extra-file={self.opt}", "-B", "-N", "-e", sql],
                              capture_output=True)
        return proc.returncode, proc.stdout.decode("utf-8", "replace"), proc.stderr.decode("utf-8", "replace")

    def rows(self, sql):
        code, out, err = self.run(sql)
        if code != 0:
            raise RuntimeError(err.strip()[:200])
        return [line.split("\t") for line in out.strip().splitlines() if line.strip()]

    def close(self):
        self.opt.unlink(missing_ok=True)


def chat(message, session_id):
    payload = json.dumps({"message": message, "sessionId": session_id}).encode("utf-8")
    req = urllib.request.Request(BASE + "/api/chat", data=payload, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode("utf-8"))


print(f"库目标：{env_value('DB_USER', 'znwd')}@{env_value('DB_HOST', '127.0.0.1')}:"
      f"{env_value('DB_PORT', '3306')}/{env_value('DB_NAME', 'znwd')}")

client = find_client()
if not client:
    print("  找不到 mysql 客户端：设 MYSQL_BIN 指向它，或跳过本套（HTTP 层用例见 tools/security.py）")
    sys.exit(0)

db = Db(client,
        env_value("DB_HOST", "127.0.0.1"),
        env_value("DB_PORT", "3306"),
        env_value("DB_USER", "znwd"),
        env_value("DB_PASSWORD", ""),
        env_value("DB_NAME", "znwd"))
try:
    # ── 连接与表结构 ─────────────────────────────────────────────────────────
    print("\n== 库层：表与最小权限")
    try:
        tables = sorted(r[0] for r in db.rows("SHOW TABLES"))
    except RuntimeError as e:
        print(f"  连不上库或不满足权限（{e}）——本套跳过")
        sys.exit(0)

    expected = {"session", "session_message", "chat_log", "feedback", "uncovered_question"}
    check("D01 五张表齐全", expected <= set(tables), f"实有={tables}")

    grants = " ".join(db.rows("SHOW GRANTS FOR CURRENT_USER()")[0]) if db.rows("SHOW GRANTS FOR CURRENT_USER()") else ""
    check("D02 应用账号是最小权限（无 DROP/ALTER/GRANT）",
          not any(k in grants.upper() for k in (" DROP", " ALTER", " GRANT OPTION", "ALL PRIVILEGES")),
          f"grants={grants[:120]}")

    # ── 发一条带「20 字之后标记」的提问，看库里落下什么 ───────────────────────
    print("\n== 库层：脱敏（chat_log 只留 hash 形态）")
    tail_mark = "DBMARK4f2a"
    message = "开头二十个字之外的库层标记" + tail_mark + "结束"
    sid = "dbcheck-" + uuid.uuid4().hex[:8]
    try:
        chat(message, sid)
    except Exception as e:
        skip("D03 chat_log 的 message_preview 不含 20 字之后的原话", f"提问失败：{type(e).__name__}")

    row = None
    for _ in range(20):  # 落库可能有毫秒级延迟，poll 一小会儿
        rows = db.rows(f"SELECT message_preview, message_len FROM chat_log WHERE session_id='{sid}' "
                       f"ORDER BY id DESC LIMIT 1")
        if rows:
            row = rows[0]
            break
        time.sleep(0.25)
    if row is None:
        skip("D03 chat_log 的 message_preview 不含 20 字之后的原话", "未查到本次请求的 chat_log 行")
    else:
        preview, length = row[0], row[1]
        check("D03 chat_log 的 message_preview 不含 20 字之后的原话", tail_mark not in preview,
              "库里出现完整原话")
        check("D04 message_preview 是 hash 形态（hash#长度#前20字）",
              "#" in preview and preview.split("#")[-1] == message[:20], f"preview={preview[:60]}")
        check("D05 message_len 记原长（脱敏不等于丢统计）", str(length) == str(len(message)),
              f"库={length} 期望={len(message)}")

        answer_len = db.rows(f"SELECT CHAR_LENGTH(answer_preview) FROM chat_log WHERE session_id='{sid}' "
                             f"ORDER BY id DESC LIMIT 1")[0][0]
        check("D06 answer_preview 有截断（<=80 字）", int(answer_len) <= 80, f"长度={answer_len}")

    # ── 会话存储与未覆盖问题：这两处是"存原文"的设计，文档里要写明 ───────────
    print("\n== 库层：会话与未覆盖问题（按设计存原文，属已知取舍）")
    msgs = db.rows(f"SELECT COUNT(*) FROM session_message WHERE session_id='{sid}'")
    check("D07 会话消息落库（重启不丢上下文的前提）", msgs and int(msgs[0][0]) >= 2, f"条数={msgs}")

    no_hit_sid = "dbcheck-" + uuid.uuid4().hex[:8]
    no_hit_q = "今天午饭吃什么" + "DBNOHIT" + uuid.uuid4().hex[:4]
    try:
        chat(no_hit_q, no_hit_sid)
        rows = []
        for _ in range(20):
            rows = db.rows(f"SELECT question FROM uncovered_question WHERE session_id='{no_hit_sid}' LIMIT 1")
            if rows:
                break
            time.sleep(0.25)
        check("D08 闸门拦下的问题进 uncovered_question（运营补知识用，按设计存原文）",
              bool(rows) and rows[0][0] == no_hit_q, f"查到={rows}")
    except Exception as e:
        skip("D08 未覆盖问题落库", f"{type(e).__name__}")

    # 清理本次探测产生的行（库是展厅的，别留测试数据）
    try:
        db.run(f"DELETE FROM session_message WHERE session_id IN ('{sid}','{no_hit_sid}')")
        db.run(f"DELETE FROM session WHERE id IN ('{sid}','{no_hit_sid}')")
        db.run(f"DELETE FROM chat_log WHERE session_id IN ('{sid}','{no_hit_sid}')")
        db.run(f"DELETE FROM uncovered_question WHERE session_id='{no_hit_sid}'")
        print("\n（探测数据已清理：两个测试会话及其 chat_log/未覆盖问题行）")
    except RuntimeError as e:
        print(f"\n（清理失败，请手工删除 dbcheck-* 会话：{e}）")
finally:
    db.close()

print("\n== 汇总 ==")
print(f"通过 {passed} 项，失败 {len(failed)} 项，跳过 {len(skipped)} 项")
for name in failed:
    print(f"  FAIL  {name}")
for name in skipped:
    print(f"  SKIP  {name}")
sys.exit(1 if failed else 0)
