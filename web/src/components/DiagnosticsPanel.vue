<script setup lang="ts">
import { ref, watch } from 'vue';
import { runDiagnostics, type DiagnosticsInfo } from '../api';

/**
 * 检索诊断：输入一个真实问题，看这次会被闸门怎么判——
 * 判定（拦下/通过）、两路分数、阈值与还差多少，以及人话结论。
 * 最近几次诊断按新→旧留在面板上，方便对照着补语料/同义词。
 */
const props = defineProps<{ token: string }>();

const MAX_RESULTS = 5;

const q = ref('');
const running = ref(false);
const error = ref('');
const results = ref<DiagnosticsInfo[]>([]);

const REASON_LABELS: Record<string, string> = {
  keyword_hit: '关键词命中',
  vector_hit: '向量兜底命中',
  no_candidates: '无候选',
  below_threshold: '低于阈值',
};

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '诊断失败';
}

function fmt(value: number | null): string {
  return value === null ? '-' : value.toFixed(2);
}

function modeLabel(mode: string | null): string {
  if (mode === 'keyword') return '关键词';
  if (mode === 'hybrid') return '混合（关键词 + 语义）';
  return mode ?? '-';
}

function reasonLabel(reason: string | null): string {
  if (!reason) return '-';
  return REASON_LABELS[reason] ?? reason;
}

function distanceLabel(distance: number | null): string {
  if (distance === null) return '-';
  if (distance > 0) return `还差 ${distance.toFixed(2)} 分`;
  return `已超出 ${(-distance).toFixed(2)} 分`;
}

async function run(): Promise<void> {
  const query = q.value.trim();
  if (!query || running.value) return;
  running.value = true;
  error.value = '';
  try {
    const info = await runDiagnostics(props.token, query);
    results.value = [info, ...results.value].slice(0, MAX_RESULTS);
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    running.value = false;
  }
}

function clear(): void {
  results.value = [];
}

// 换口令后旧结果作废：它们是在另一套凭据下跑出来的
watch(() => props.token, () => {
  results.value = [];
  error.value = '';
});
</script>

<template>
  <div class="diag">
    <h2>检索诊断</h2>
    <div class="row-inline">
      <input
        v-model="q"
        type="text"
        aria-label="要诊断的问题"
        placeholder="输入问题看闸门判定，例如：有客户了吗"
        @keydown.enter.prevent="run()"
      />
      <button class="linkish" :disabled="running || !q.trim()" @click="run()">
        {{ running ? '诊断中…' : '诊断' }}
      </button>
    </div>
    <p v-if="error" class="kb-msg bad">{{ error }}</p>

    <div v-if="results.length" class="kb-actions">
      <span class="meta">最近 {{ results.length }} 次诊断（最多保留 {{ MAX_RESULTS }} 次）</span>
      <button class="linkish" @click="clear()">清空</button>
    </div>

    <div v-for="(result, index) in results" :key="`${result.query}#${index}`" class="diag-item">
      <div class="title">
        {{ result.query }} · <span :class="result.gated ? 'bad' : 'ok'">{{ result.gated ? '拦下' : '通过' }}</span>
      </div>
      <div v-if="result.verdict" class="meta">{{ result.verdict }}</div>
      <table>
        <tbody>
          <tr><td>检索模式</td><td>{{ modeLabel(result.mode) }}</td></tr>
          <tr><td>原因</td><td>{{ reasonLabel(result.reason) }}</td></tr>
          <tr><td>关键词闸门分</td><td>{{ fmt(result.keywordGateScore) }}</td></tr>
          <tr><td>最高关键词分</td><td>{{ fmt(result.keywordBestScore) }}</td></tr>
          <tr><td>最高余弦</td><td>{{ fmt(result.vectorBestCosine) }}</td></tr>
          <tr>
            <td>阈值（关键词 / 向量）</td>
            <td>{{ fmt(result.thresholds.minKeywordScore) }} / {{ fmt(result.thresholds.minVectorScore) }}</td>
          </tr>
          <tr><td>距离闸门</td><td>{{ distanceLabel(result.distanceToGate) }}</td></tr>
          <tr><td>候选数</td><td>{{ result.candidates ?? '-' }}</td></tr>
        </tbody>
      </table>
      <template v-if="result.hits.length">
        <div class="title" style="margin-top: 8px">命中（{{ result.hits.length }}）</div>
        <div v-for="(hit, hitIndex) in result.hits" :key="hitIndex" class="meta">
          {{ hit.title || hit.sourcePath || '未命名' }} · {{ hit.zoneTitle || hit.zone || '未分展区' }} ·
          关键词 {{ fmt(hit.keywordScore) }} · 融合 {{ fmt(hit.fuseScore) }}
        </div>
      </template>
    </div>
  </div>
</template>
