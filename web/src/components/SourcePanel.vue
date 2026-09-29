<script setup lang="ts">
import { ref } from 'vue';
import type { Source } from '../api';
import { highlightSegments, type HighlightSegment } from '../highlight';

const props = defineProps<{ sources: Source[] }>();

/** 每条来源独立展开（按 v-for 下标记；换一批来源时天然重置） */
const open = ref<Record<number, boolean>>({});

function toggle(index: number): void {
  open.value[index] = !open.value[index];
}

function segments(source: Source): HighlightSegment[] {
  return highlightSegments(source.chunkText, source.matchTerm, source.matchOffset);
}

function score(source: Source): string {
  const parts: string[] = [];
  if (typeof source.score === 'number') parts.push(`融合 ${source.score.toFixed(2)}`);
  if (typeof source.vectorScore === 'number' && source.vectorScore > 0) {
    parts.push(`语义 ${source.vectorScore.toFixed(2)}`);
  }
  if (typeof source.keywordScore === 'number' && source.keywordScore > 0) {
    parts.push(`关键词 ${source.keywordScore.toFixed(1)}`);
  }
  return parts.join(' · ');
}
</script>

<template>
  <p v-if="!props.sources.length" class="snippet">回答引用到的资料会显示在这里。</p>
  <div v-for="(source, index) in props.sources" :key="`${source.sourcePath}#${index}`" class="card">
    <!-- 整行标题即按钮：大屏触屏点按区域要够大（min-height 见 styles.css .src-head） -->
    <button
      v-if="source.chunkText"
      type="button"
      class="src-head"
      :aria-expanded="open[index] === true"
      @click="toggle(index)"
    >
      <span class="title">{{ source.title }}</span>
      <span class="src-hint">{{ open[index] ? '收起' : '查看全文' }}</span>
    </button>
    <div v-else class="title">{{ source.title }}</div>
    <div class="snippet">{{ source.snippet }}</div>
    <div class="meta">
      {{ source.zoneTitle || source.zone || '未分展区' }} · {{ score(source) }}
    </div>
    <!-- 展开完整命中分块：matchOffset 处高亮 matchTerm；定位不了就整段原文（切分逻辑见 highlight.ts） -->
    <div v-if="source.chunkText && open[index]" class="src-full"><template v-for="(seg, si) in segments(source)" :key="si"><mark v-if="seg.hit">{{ seg.text }}</mark><span v-else>{{ seg.text }}</span></template></div>
  </div>
</template>
