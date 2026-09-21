<script setup lang="ts">
import type { Source } from '../api';

const props = defineProps<{ sources: Source[] }>();

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
    <div class="title">{{ source.title }}</div>
    <div class="snippet">{{ source.snippet }}</div>
    <div class="meta">
      {{ source.zoneTitle || source.zone || '未分展区' }} · {{ score(source) }}
    </div>
  </div>
</template>
