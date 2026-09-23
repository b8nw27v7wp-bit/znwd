#!/usr/bin/env python3
"""问答内容验收（需要真实服务 + 真实大模型在跑，因此**不进 CI**）。

与另外两套的分工：
  tools/smoke.py       契约层——接口通不通、字段在不在（CI 里跑）
  tools/security.py    边界层——越权、限流、坏输入（CI 里跑）
  tools/acceptance.py  内容层——**答得对不对**：该答的答了没有、该拒的拒了没有、
                       答案里有没有资料外的自由发挥（需要真模型，CI 跑不了）

为什么要有这一层：契约测试全绿而回答是错的，是这类项目最容易出现也最难发现的状态。
2026-09-23 补语料那一轮的改动（同义词、FAQ 小节、新语料）在契约层完全看不出来。

用法（先起服务，`.env` 配好真模型）：
    python tools/acceptance.py                 # 默认 http://127.0.0.1:8787
    BASE=http://127.0.0.1:9900 python tools/acceptance.py
退出码 0 = 全部通过，1 = 有断言失败。

用例写法：
    {"id": "...", "q": "问题", "expect": "answer"|"refuse",
     "must": [[可选说法1, 可选说法2], ...],   # 每个内层列表是「任一命中即可」的一组
     "never": ["不该出现的字眼"],             # 资料外的自由发挥（如「建议联系销售」）
     "session": "同一个 id 的多轮追问共用一个 session"}
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("BASE", "http://127.0.0.1:8787").rstrip("/")
TAGS = os.environ.get("TAGS", "")   # 逗号分隔：只跑这些 tag，便于单跑一组

passed = 0
failed = []
warned = []

PUNCT = re.compile(r"[\s\u3000，。、；：？！“”‘’（）《》【】·…—\-—~`\"'()\[\]{}<>/\\|,.;:!?*#]+")


def norm(s):
    return PUNCT.sub("", (s or "")).lower()


def chat(question, session_id):
    payload = json.dumps({"message": question, "sessionId": session_id}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + "/api/chat", data=payload,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read().decode("utf-8"))


def check(name, ok, detail=""):
    global passed
    if ok:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed.append(name)
        print(f"  FAIL  {name}  {detail}")


def note(name, detail):
    warned.append(f"{name}（{detail}）")
    print(f"  WARN  {name}  {detail}")


# ── 用例表 ───────────────────────────────────────────────────────────────────
CASES = [
    # A 组：2026-09-23 修掉的误拦 / 漏放 / 泛问法
    {"id": "A01-误拦-有客户了吗", "tag": "fix", "q": "有客户了吗", "expect": "answer",
     "must": [["客户"], ["0"]], "never": ["不在我的讲解范围"]},
    {"id": "A02-误拦-融资了吗", "tag": "fix", "q": "融资了吗", "expect": "answer",
     "must": [["融资"]], "never": ["不在我的讲解范围"]},
    {"id": "A03-漏放-扫地机器人", "tag": "fix", "q": "扫地机器人多少钱？", "expect": "answer",
     "must": [["资料中没有", "资料里没有", "未提供", "没有"], ["光伏"]],
     "never": ["建议联系", "联系销售", "咨询销售", "拨打", "官网"]},
    {"id": "A04-漏放-送外卖", "tag": "fix", "q": "这个机器人能送外卖吗？", "expect": "answer",
     "must": [["不能", "不具备", "不是"]], "never": ["不在我的讲解范围"]},
    {"id": "A05-泛问法-社会效益", "tag": "fix", "q": "项目有什么社会效益", "expect": "answer",
     "must": [["绿色能源", "可持续发展", "社会效益", "环保"]]},
    {"id": "A06-泛问法-对社会好处", "tag": "fix", "q": "对社会有什么好处", "expect": "answer",
     "must": [["绿色", "可持续", "社会", "环保"]]},
    {"id": "A07-泛问法-社会价值", "tag": "fix", "q": "有什么社会价值", "expect": "answer",
     "must": [["社会", "价值"]]},
    {"id": "A08-泛问法-环境效益", "tag": "fix", "q": "环境效益怎样", "expect": "answer",
     "must": [["环境", "低碳", "减排", "绿色"]]},
    {"id": "A09-泛问法-意义", "tag": "fix", "q": "项目意义是什么", "expect": "answer",
     "must": [["意义", "价值", "作用", "推广", "发展"]]},
    {"id": "A10-泛问法-环保贡献", "tag": "fix", "q": "对环保有什么贡献", "expect": "answer",
     "must": [["环保", "绿色", "低碳", "减排", "可持续"]]},

    # B 组：2026-09-23 新补进语料的原文段落
    {"id": "B01-新语料-运维痛点", "tag": "corpus", "q": "传统运维有什么问题", "expect": "answer",
     "must": [["人工巡检", "效率低", "精度差"], ["清洁", "污染", "纸质记录", "数据丢失", "成本"]]},
    {"id": "B02-新语料-巡检痛点", "tag": "corpus", "q": "人工巡检有什么问题", "expect": "answer",
     "must": [["效率低", "精度差", "成本高"]]},
    {"id": "B03-新语料-技术创新", "tag": "corpus", "q": "技术创新之处有哪些", "expect": "answer",
     "must": [["多模态"], ["数字孪生", "模块化"]]},
    {"id": "B04-新语料-数据来源", "tag": "corpus", "q": "数据来源是什么", "expect": "answer",
     "must": [["无人机"], ["热红外", "热成像", "多光谱"]]},
    {"id": "B05-新语料-设备寿命", "tag": "corpus", "q": "对设备寿命有什么好处", "expect": "answer",
     "must": [["寿命", "可靠性", "故障率"]]},

    # C 组：原文口径抽查（数字/参数，答错或答不出都算失败）
    {"id": "C01-口径-整机重量", "tag": "fact", "q": "清洁机器人有多重？", "expect": "answer",
     "must": [["23"]]},
    {"id": "C02-口径-防护等级", "tag": "fact", "q": "机器人外壳防护等级是多少", "expect": "answer",
     "must": [["ip67"]]},
    {"id": "C03-口径-图像规模", "tag": "fact", "q": "数据集有多少张图", "expect": "answer",
     "must": [["12万", "12万余"]]},
    {"id": "C04-口径-专利数", "tag": "fact", "q": "团队有多少专利", "expect": "answer",
     "must": [["3"], ["zl202410517695", "202410517695", "专利号"]]},
    {"id": "C05-口径-团队人数", "tag": "fact", "q": "团队有多少人", "expect": "answer",
     "must": [["4"]]},
    {"id": "C06-口径-热斑识别", "tag": "fact", "q": "能识别热斑吗", "expect": "answer",
     "must": [["热斑"], ["隐裂", "毫米"]]},
    {"id": "C07-口径-两套效率口径", "tag": "fact", "q": "清洗能提升多少发电效率", "expect": "answer",
     "must": [["2%", "2%-5%"], ["20%", "3%-20%", "8%"]]},
    {"id": "C08-口径-依托单位", "tag": "fact", "q": "依托单位是谁", "expect": "answer",
     "must": [["研究院", "东方理工"]]},
    {"id": "C09-口径-客户数量", "tag": "fact", "q": "项目目前有客户和收入吗", "expect": "answer",
     "must": [["0"], ["80", "60", "收入"]]},
    {"id": "C10-口径-清洁方式", "tag": "fact", "q": "有几种工作模式", "expect": "answer",
     "must": [["远程遥控"], ["自主导航", "无人驾驶"]]},

    # D 组：域外必须拒答（闸门不许放行）
    {"id": "D01-域外-笑话", "tag": "gate", "q": "讲个笑话", "expect": "refuse"},
    {"id": "D02-域外-天气", "tag": "gate", "q": "今天上海天气怎么样？", "expect": "refuse"},
    {"id": "D03-域外-发票", "tag": "gate", "q": "能开发票吗？", "expect": "refuse"},
    {"id": "D04-域外-大模型", "tag": "gate", "q": "你用的什么大模型", "expect": "refuse"},
    {"id": "D05-域外-写诗", "tag": "gate", "q": "帮我写一首诗", "expect": "refuse"},
    {"id": "D06-域外-股票", "tag": "gate", "q": "股票行情怎么样", "expect": "refuse"},
    {"id": "D07-域外-会议室", "tag": "gate", "q": "会议室在哪里", "expect": "refuse"},

    # E 组：多轮追问（同一 session，验证指代消解与上下文）
    {"id": "E01-多轮-首问", "tag": "multi", "q": "清洁机器人有多重？", "expect": "answer",
     "must": [["23"]], "session": "acc-multi-1"},
    {"id": "E02-多轮-追问防护", "tag": "multi", "q": "那它的防护等级呢", "expect": "answer",
     "must": [["ip67"]], "session": "acc-multi-1"},
    {"id": "E03-多轮-追问履带", "tag": "multi", "q": "履带打滑吗", "expect": "answer",
     "must": [["打滑", "防滑"]], "session": "acc-multi-1"},
    {"id": "E04-多轮-首问2", "tag": "multi", "q": "光伏医生是做什么的？", "expect": "answer",
     "must": [["巡检", "运维"]], "session": "acc-multi-2"},
    {"id": "E05-多轮-追问2", "tag": "multi", "q": "它靠什么发现故障", "expect": "answer",
     "must": [["热红外", "图像", "算法", "无人机"]], "session": "acc-multi-2"},

    # F 组：容易被"自由发挥"的问法（资料里没有的内容不许编）
    {"id": "F01-不编-价格", "tag": "nofab", "q": "这套系统卖多少钱", "expect": "answer",
     "must": [["资料中没有", "资料里没有", "未提供", "没有", "收费"]],
     "never": ["建议联系", "联系销售", "拨打", "官网"]},
    # 三份原文里没有「保修/质保」字样 → 正确行为是拒答（而不是编一个年限）
    {"id": "F02-不编-保修", "tag": "nofab", "q": "保修几年", "expect": "refuse"},
    {"id": "F03-不编-竞品", "tag": "nofab", "q": "你们和隆基绿能是什么关系？", "expect": "refuse"},
]

# 只认服务端的 noHit 与**拒答专用文案**：
# 「资料中没有…」在正常回答里也会出现（例如「资料中没有家用扫地机器人的说明」），
# 拿它当拒答标志会把答对的用例判成失败（第一轮就踩了）。
REFUSE_MARKS = ["不在我的讲解范围", "资料中也没有相关内容", "没有相关内容，无法回答"]


def main():
    if not CASES:
        print("没有用例"); return 1
    tags = {t.strip() for t in TAGS.split(",") if t.strip()}
    selected = [c for c in CASES if not tags or c.get("tag") in tags]
    print(f"== 问答内容验收：{len(selected)} 条用例（{BASE}）\n")

    for case in selected:
        sid = case.get("session") or ("acc-" + case["id"].split("-")[0] + "-" + re.sub(r"\W+", "", case["id"])[:20])
        try:
            resp = chat(case["q"], sid)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            check(case["id"], False, f"请求失败：{type(e).__name__} {e}")
            continue

        answer = resp.get("answer") or ""
        na = norm(answer)
        no_hit = bool(resp.get("noHit"))
        refused = no_hit or any(norm(m) in na for m in REFUSE_MARKS)

        if case["expect"] == "refuse":
            check(case["id"], refused, f"该拒答却答了：{answer[:80]}")
            continue

        problems = []
        if refused:
            problems.append(f"该答却拒答（noHit={no_hit}）")
        for group in case.get("must", []):
            if not any(norm(alt) in na for alt in group):
                problems.append(f"缺少 {'/'.join(group)}")
        for bad in case.get("never", []):
            if norm(bad) in na:
                problems.append(f"出现不该有的『{bad}』")

        if problems:
            check(case["id"], False, "；".join(problems) + f" | 答：{answer[:90]}")
        else:
            check(case["id"], True)
        if resp.get("latencyMs") and resp["latencyMs"] > 15000:
            note(case["id"], f"延迟偏高 {resp['latencyMs']}ms")

    print(f"\n通过 {passed} 项，失败 {len(failed)} 项")
    for name in failed:
        print(f"  FAIL  {name}")
    if warned:
        print("（延迟提醒）")
        for w in warned:
            print(f"  {w}")
    print("\n判据：该答的要答对（且答案必须来自资料）、该拒的要拒、资料里没有的不许编。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
