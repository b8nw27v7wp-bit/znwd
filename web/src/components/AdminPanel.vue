<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  fetchAdminStats,
  fetchFeedbackStats,
  fetchUncovered,
  type AdminStats,
  type FeedbackStats,
  type UncoveredItem,
} from '../api';
import { readStorage, removeStorage, writeStorage } from '../storage';
import KnowledgePanel from './KnowledgePanel.vue';
import DiagnosticsPanel from './DiagnosticsPanel.vue';

/**
 * 运营视图：统计、未覆盖问题（要补的资料）、负反馈，以及知识库管理与检索诊断（子面板）。
 * 口令只存 sessionStorage，不进 URL、不进日志；管理接口没配 ADMIN_TOKEN 时后端直接放行（开发态）。
 * 所有管理请求都经 api/admin.ts 的 adminRequest 统一带 authorization 头。
 */
const TOKEN_KEY = 'znwd.adminToken';

const token = ref(readStorage('session', TOKEN_KEY) ?? '');
/** 提交后的口令：子面板拿它发请求，避免输入框每敲一个字就打一轮接口 */
const committedToken = ref(token.value);
const stats = ref<AdminStats | null>(null);
const uncovered = ref<UncoveredItem[]>([]);
const feedback = ref<FeedbackStats | null>(null);
const error = ref('');
let loadGeneration = 0;

async function load(): Promise<void> {
  const generation = ++loadGeneration;
  const requestToken = token.value;
  error.value = '';
  if (requestToken) writeStorage('session', TOKEN_KEY, requestToken);
  else removeStorage('session', TOKEN_KEY);
  committedToken.value = requestToken;
  try {
    const [s, u, f] = await Promise.all([
      fetchAdminStats(requestToken),
      fetchUncovered(requestToken),
      fetchFeedbackStats(requestToken),
    ]);
    if (generation !== loadGeneration) return;
    stats.value = s;
    uncovered.value = u.items;
    feedback.value = f;
  } catch (e) {
    if (generation === loadGeneration) {
      stats.value = null;
      uncovered.value = [];
      feedback.value = null;
      error.value = e instanceof Error ? e.message : '加载失败';
    }
  }
}

function tokens(): string {
  const t = stats.value?.tokens;
  if (!t) return '-';
  return `入 ${t.prompt ?? 0} / 出 ${t.completion ?? 0} / 计费 ${t.total ?? 0}`;
}

function when(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

onMounted(load);
</script>

<template>
  <section class="admin">
    <h2>运营统计</h2>
    <input v-model="token" type="password" placeholder="ADMIN_TOKEN（未配置可留空）" @keyup.enter="load" />
    <button class="linkish" @click="load">加载 / 刷新</button>
    <p v-if="error" class="snippet" style="color: var(--warn)">{{ error }}</p>

    <table v-if="stats">
      <tbody>
        <tr><td>问答总数</td><td>{{ stats.chatTotal }}</td></tr>
        <tr><td>引用资料回答</td><td>{{ stats.ragHits }}</td></tr>
        <tr><td>资料未覆盖</td><td>{{ stats.noHit }}</td></tr>
        <tr><td>多轮改写</td><td>{{ stats.rewritten }}</td></tr>
        <tr><td>出错</td><td>{{ stats.errors }}</td></tr>
        <tr><td>活跃会话</td><td>{{ stats.activeSessions }}</td></tr>
        <tr><td>tokens</td><td>{{ tokens() }}</td></tr>
      </tbody>
    </table>

    <table v-if="feedback">
      <tbody>
        <tr><td>有帮助</td><td>{{ feedback.up ?? 0 }}</td></tr>
        <tr><td>没帮助</td><td>{{ feedback.down ?? 0 }}</td></tr>
      </tbody>
    </table>

    <template v-if="uncovered.length">
      <div class="title" style="margin-top: 14px">待补资料的问题</div>
      <div v-for="item in uncovered" :key="item.question + item.at" class="meta">
        {{ item.question }} · {{ when(item.at) }}
      </div>
    </template>

    <KnowledgePanel :token="committedToken" />
    <DiagnosticsPanel :token="committedToken" />
  </section>
</template>
