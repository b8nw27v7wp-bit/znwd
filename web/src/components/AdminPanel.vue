<script setup lang="ts">
import { onMounted, ref } from 'vue';

/**
 * 运营视图：统计、未覆盖问题（要补的资料）、负反馈。
 * 口令只存 sessionStorage，不进 URL、不进日志；管理接口没配 ADMIN_TOKEN 时后端直接放行（开发态）。
 */
const TOKEN_KEY = 'znwd.adminToken';

const token = ref(sessionStorage.getItem(TOKEN_KEY) ?? '');
const stats = ref<Record<string, unknown> | null>(null);
const uncovered = ref<Array<{ question: string; at: number }>>([]);
const feedback = ref<{ up?: number; down?: number; topDown?: Array<{ question: string; down: number }> } | null>(null);
const error = ref('');

function headers(): Record<string, string> {
  return token.value ? { authorization: `Bearer ${token.value}` } : {};
}

async function load(): Promise<void> {
  error.value = '';
  if (token.value) sessionStorage.setItem(TOKEN_KEY, token.value);
  else sessionStorage.removeItem(TOKEN_KEY);
  try {
    const [s, u, f] = await Promise.all([
      fetch('/api/stats', { headers: headers() }),
      fetch('/api/admin/uncovered', { headers: headers() }),
      fetch('/api/admin/feedback-stats', { headers: headers() }),
    ]);
    if (s.status === 401 || u.status === 401 || f.status === 401) {
      error.value = '口令不正确（401）';
      return;
    }
    stats.value = (await s.json()) as Record<string, unknown>;
    const uncoveredBody = (await u.json()) as { items?: Array<{ question: string; at: number }> };
    uncovered.value = uncoveredBody.items ?? [];
    feedback.value = (await f.json()) as { up?: number; down?: number };
  } catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败';
  }
}

function tokens(): string {
  const t = stats.value?.tokens as Record<string, number> | undefined;
  if (!t) return '-';
  return `入 ${t.prompt} / 出 ${t.completion} / 计费 ${t.total}`;
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
  </section>
</template>
