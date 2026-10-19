<script setup lang="ts">
/**
 * 大屏右侧（2/3 留白区）的项目讲解图，三块：
 *   1) 一次问答的链路 —— 本项目真实实现（资料 → 检索 → 闸门 → 生成），数字取自仓库口径；
 *   2) RAG 的基本原理 —— 通用示意图（query → 嵌入模型 → 向量索引 → 上下文 → 大模型 → 答案）；
 *   3) 技术栈 + 实测数据。
 *
 * 为什么手写 SVG/HTML（不用图片、不用 AI 生成插图）：
 *  1) **纯线稿、无彩色**：这块屏是给参观者看的工程说明，不是广告位。层级靠线宽、字号、留白做，
 *     不靠颜色——彩色一多就有"设计过度"的味道；两图共用同一套形状语言（椭圆=输入输出、
 *     圆角框=模型、圆柱=存储、横条=索引）；
 *  2) 图上数字全部来自本仓库（语料片段数、阈值、评测分数、单测/冒烟项数），改资料或阈值时
 *     只改这里的常量，不会出现「图和代码对不上」；
 *  3) 零外部资源，展厅一体机断网也能显示。
 *
 * 数字口径：README「当前基线」、docs/architecture.md §3、docs/eval.md。
 */

const pipeline = [
  { step: '01', title: '资料库', lines: ['Markdown 展区资料', '分块建索引'], metric: '242 个片段' },
  { step: '02', title: '双路检索', lines: ['关键词打分 + 同义词扩展', '向量路 512 维（兜底）'], metric: 'RRF 融合' },
  { step: '03', title: '相关性闸门', lines: ['阈值 6.5（按真实', '访客问句重标）'], metric: '未命中不调模型', key: true },
  { step: '04', title: '生成回答', lines: ['小米 MiMo v2.5', 'OpenAI 兼容接口'], metric: '附来源可追溯' },
];

const stack = [
  { name: '前端', detail: 'Vue 3.5 · Vite 6 · TypeScript 5.7', note: '手写 CSS，不引 UI 框架' },
  { name: '后端', detail: 'Spring Boot 3.5.16 · Java 21', note: 'MyBatis 3.0.5 + REST / SSE' },
  { name: '检索', detail: '关键词打分 + 512 维向量', note: '同义词表 34 组，可在线热更新' },
  { name: '模型', detail: '小米 MiMo v2.5', note: 'OpenAI 兼容，可整体换模型' },
  { name: '存储', detail: 'MySQL 9.7', note: '最小权限账号；库不可用自动降级' },
  { name: '运行', detail: '单机内网 · 一体机离线可用', note: '无第三方 UI 依赖' },
];

const metrics = [
  { label: '语料', value: '242 片段' },
  { label: '检索 top1 / top3', value: '0.99 / 1.0' },
  { label: '闸门误拦', value: '0 / 161' },
  { label: '端到端（本机实测）', value: '约 4.4 s' },
  { label: '单测', value: '后端 242 · 前端 287' },
  { label: '接口冒烟', value: '100 项' },
];

/** 链路图坐标（viewBox 1080×258）：四个等宽节点 + 闸门向下分出的「未命中」支路 */
const BOX_W = 210;
const BOX_H = 126;
const BOX_Y = 20;
const BOX_X = [22, 296, 570, 844];
const BRANCH_Y = 196;

/** 原理图坐标（viewBox 720×300）：四条横条＝向量索引 */
const BARS_X = 290;
const BARS_Y = 94;
</script>

<template>
  <div class="diagram">
    <section class="block">
      <header>
        <h2>一次问答的链路</h2>
        <p class="lead">提问 → 检索 → 闸门 → 生成，全程可在内网离线运行</p>
      </header>

      <svg
        class="flow"
        viewBox="0 0 1080 258"
        role="img"
        aria-label="问答链路：资料库、双路检索、相关性闸门、生成回答；未命中时固定拒答"
      >
        <defs>
          <marker id="arrow-light" viewBox="0 0 8 8" refX="7" refY="4"
                  markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0.6 L7 4 L0 7.4 z" fill="#c7c7cc" />
          </marker>
        </defs>

        <!-- 四个节点：白底细边框；闸门用更深的边框标出「关键一步」，不靠颜色 -->
        <g v-for="(node, i) in pipeline" :key="node.title">
          <rect :x="BOX_X[i]" :y="BOX_Y" :width="BOX_W" :height="BOX_H" rx="12"
                fill="#ffffff" :stroke="node.key ? '#1d1d1f' : '#e5e5ea'" stroke-width="1" />
          <text class="t-step" :x="BOX_X[i] + 20" :y="BOX_Y + 26">{{ node.step }}</text>
          <text class="t-title" :x="BOX_X[i] + 20" :y="BOX_Y + 54">{{ node.title }}</text>
          <text v-for="(line, li) in node.lines" :key="line" class="t-line"
                :x="BOX_X[i] + 20" :y="BOX_Y + 80 + li * 21">{{ line }}</text>
          <text class="t-metric" :x="BOX_X[i] + 20" :y="BOX_Y + 119">{{ node.metric }}</text>
        </g>

        <!-- 主链箭头（标签居中留在间隙里，避免贴框） -->
        <g stroke="#c7c7cc" stroke-width="1.2" fill="none">
          <line v-for="(x, i) in BOX_X.slice(0, -1)" :key="x"
                :x1="x + BOX_W + 4" :y1="BOX_Y + BOX_H / 2"
                :x2="BOX_X[i + 1] - 6" :y2="BOX_Y + BOX_H / 2"
                marker-end="url(#arrow-light)" />
          <line :x1="BOX_X[2] + BOX_W / 2" :y1="BOX_Y + BOX_H + 2"
                :x2="BOX_X[2] + BOX_W / 2" :y2="BRANCH_Y - 4" marker-end="url(#arrow-light)" />
        </g>
        <text class="t-path" text-anchor="middle"
              :x="(BOX_X[2] + BOX_W + BOX_X[3]) / 2" :y="BOX_Y + BOX_H / 2 - 10">命中</text>
        <text class="t-line" :x="BOX_X[2] + BOX_W / 2 + 12" :y="BRANCH_Y - 12">未命中</text>

        <!-- 未命中支路：闸门在生成之前拦下，不调模型 -->
        <rect :x="BOX_X[2] - 46" :y="BRANCH_Y" width="316" height="56" rx="12"
              fill="#ffffff" stroke="#e5e5ea" stroke-width="1" />
        <text class="t-sub" :x="BOX_X[2] - 26" :y="BRANCH_Y + 24">固定拒答（0 token）</text>
        <text class="t-line" :x="BOX_X[2] - 26" :y="BRANCH_Y + 45">不让模型硬答，同时记入未覆盖清单</text>
      </svg>
    </section>

    <div class="duo">
      <section class="block">
        <header>
          <h2>RAG 的基本原理</h2>
          <p class="lead">问句也直接进模型，检索出的资料作为上下文一起送过去</p>
        </header>

        <svg
          class="flow"
          viewBox="0 0 720 300"
          role="img"
          aria-label="通用 RAG 原理：查询经嵌入模型进入向量索引，从数据库取出上下文；查询与上下文一起交给大模型生成答案"
        >
          <defs>
            <marker id="arrow-dark" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0.6 L7 4 L0 7.4 z" fill="#1d1d1f" />
            </marker>
          </defs>

          <!-- 数据库（圆柱）与向量存储索引：线稿，无填充 -->
          <g fill="none" stroke="#1d1d1f" stroke-width="1.2">
            <path d="M290 18 A 58 10 0 0 1 406 18 L406 56 A 58 10 0 0 1 290 56 Z" />
            <ellipse cx="348" cy="18" rx="58" ry="10" />
            <rect v-for="n in 4" :key="n" :x="BARS_X" :y="BARS_Y + (n - 1) * 14" width="116" height="8" rx="4" />
            <rect x="146" y="88" width="110" height="60" rx="10" />
            <rect x="428" y="176" width="144" height="58" rx="10" />
            <ellipse cx="66" cy="118" rx="46" ry="26" />
            <ellipse cx="500" cy="118" rx="50" ry="26" />
            <ellipse cx="660" cy="205" rx="40" ry="24" />
          </g>

          <text class="t-sub" x="348" y="46" text-anchor="middle">数据库</text>
          <text class="t-line" x="348" y="164" text-anchor="middle">向量存储 · 索引</text>
          <text class="t-sub" x="201" y="124" text-anchor="middle">嵌入模型</text>
          <text class="t-sub" x="500" y="211" text-anchor="middle">大模型</text>
          <text class="t-en" x="66" y="124" text-anchor="middle">query</text>
          <text class="t-sub" x="500" y="124" text-anchor="middle">上下文</text>
          <text class="t-sub" x="660" y="211" text-anchor="middle">答案</text>

          <!-- 箭头：检索链 + 问句直达大模型 -->
          <g stroke="#1d1d1f" stroke-width="1.2" fill="none">
            <line x1="112" y1="118" x2="142" y2="118" marker-end="url(#arrow-dark)" />
            <line x1="256" y1="118" x2="286" y2="118" marker-end="url(#arrow-dark)" />
            <line x1="348" y1="92" x2="348" y2="60" marker-end="url(#arrow-dark)" />
            <path d="M406 34 C 452 34 454 74 448 106" marker-end="url(#arrow-dark)" />
            <line x1="500" y1="144" x2="500" y2="172" marker-end="url(#arrow-dark)" />
            <line x1="572" y1="205" x2="616" y2="205" marker-end="url(#arrow-dark)" />
            <path d="M66 144 C 66 232 220 246 340 246 L 400 246 C 424 246 428 234 428 212"
                  marker-end="url(#arrow-dark)" />
          </g>
        </svg>
      </section>

      <section class="block">
        <header>
          <h2>用到的技术栈</h2>
          <p class="lead">一台普通一体机就能跑</p>
        </header>

        <ul class="stack">
          <li v-for="item in stack" :key="item.name">
            <span class="stack-head">
              <span class="stack-name">{{ item.name }}</span>
              <span class="stack-detail">{{ item.detail }}</span>
            </span>
            <span class="stack-note">{{ item.note }}</span>
          </li>
        </ul>
      </section>
    </div>

    <dl class="metrics">
      <div v-for="item in metrics" :key="item.label">
        <dt>{{ item.label }}</dt>
        <dd>{{ item.value }}</dd>
      </div>
    </dl>
  </div>
</template>

<style scoped>
.diagram {
  height: 100%;
  overflow: hidden auto;
  padding: 34px 64px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.block header h2 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

.block .lead {
  margin: 5px 0 0;
  font-size: 13.5px;
  color: var(--text-dim);
}

.flow {
  display: block;
  width: 100%;
  height: auto;
  margin-top: 16px;
}

/* 左边原理图、右边技术栈：原理图要够宽才看得清，所以给它 1.6 份 */
.duo {
  display: grid;
  grid-template-columns: minmax(0, 1.62fr) minmax(0, 1fr);
  gap: 40px;
  align-items: start;
}

/* SVG 里的字统一从 CSS 走，方便和页面字号一起调 */
.flow text {
  font-family: var(--font);
}
.t-step {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  fill: var(--text-faint);
}
.t-title {
  font-size: 16.5px;
  font-weight: 600;
  fill: var(--text);
}
.t-sub {
  font-size: 13.5px;
  font-weight: 600;
  fill: var(--text);
}
.t-en {
  font-size: 13.5px;
  fill: var(--text);
}
.t-line {
  font-size: 12.5px;
  fill: var(--text-dim);
}
.t-metric {
  font-size: 12.5px;
  fill: var(--text-dim);
}
.t-path {
  font-size: 13px;
  font-weight: 600;
  fill: var(--text);
}

.stack {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.stack li {
  display: grid;
  gap: 2px;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
}

.stack-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.stack-name {
  flex: 0 0 34px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-faint);
}

.stack-detail {
  font-size: 14px;
  font-weight: 600;
}

.stack-note {
  padding-left: 44px;
  font-size: 12.5px;
  color: var(--text-dim);
}

.metrics {
  margin: auto 0 0;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}

.metrics dt {
  font-size: 12.5px;
  color: var(--text-faint);
}

.metrics dd {
  margin: 3px 0 0;
  font-size: 15px;
  font-weight: 600;
}

/* 窄屏（展厅一体机若为竖屏）：原理图与技术栈改上下排，实测数据换行 */
@media (max-width: 1280px) {
  .diagram {
    padding: 26px 24px;
  }
  .duo {
    grid-template-columns: 100%;
    gap: 22px;
  }
  .metrics {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
