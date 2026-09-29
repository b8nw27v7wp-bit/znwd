<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  fetchKnowledgeList,
  fetchSynonyms,
  reloadKnowledge,
  saveSynonyms,
  type KnowledgeListInfo,
  type SynonymsInfo,
} from '../api';

/**
 * 知识库管理：文档清单、一键重载、同义词表热更新。
 *
 * <p>口令由运营视图（AdminPanel）的输入框统一持有，这里只拿提交后的 token 发请求；
 * token 一变（重新加载）就整段重拉，401/网络失败全部落成可见文案。
 */
const props = defineProps<{ token: string }>();

const loading = ref(false);
const error = ref('');
const docs = ref<KnowledgeListInfo | null>(null);
const synonyms = ref<SynonymsInfo | null>(null);

/** 同义词编辑框：TSV 原文，保存时按行 PUT 回去 */
const synText = ref('');
const synPersist = ref(true);
const saving = ref(false);
const saveFailed = ref(false);
const saveMessage = ref('');

const reloading = ref(false);
const reloadFailed = ref(false);
const reloadMessage = ref('');

let loadGeneration = 0;

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '加载失败';
}

async function loadAll(): Promise<void> {
  const generation = ++loadGeneration;
  error.value = '';
  loading.value = true;
  try {
    const [listResult, synResult] = await Promise.allSettled([
      fetchKnowledgeList(props.token),
      fetchSynonyms(props.token),
    ]);
    if (generation !== loadGeneration) return;
    if (listResult.status === 'fulfilled') {
      docs.value = listResult.value;
    } else {
      docs.value = null;
      error.value = messageOf(listResult.reason);
    }
    if (synResult.status === 'fulfilled') {
      synonyms.value = synResult.value;
      synText.value = synResult.value.tsv;
    } else {
      synonyms.value = null;
      if (!error.value) error.value = messageOf(synResult.reason);
    }
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}

async function doReload(): Promise<void> {
  if (reloading.value) return;
  reloading.value = true;
  reloadFailed.value = false;
  reloadMessage.value = '';
  try {
    const result = await reloadKnowledge(props.token);
    const chunks = result.knowledgeChunks ?? '-';
    const generation = result.generation ?? '-';
    reloadMessage.value = `重载完成：${chunks} 块 · 第 ${generation} 代索引`;
    await loadAll();
  } catch (reason) {
    reloadFailed.value = true;
    reloadMessage.value = `重载失败：${messageOf(reason)}`;
  } finally {
    reloading.value = false;
  }
}

async function doSave(): Promise<void> {
  if (saving.value) return;
  const lines = synText.value.split('\n');
  saving.value = true;
  saveFailed.value = false;
  saveMessage.value = '';
  try {
    const result = await saveSynonyms(props.token, lines, synPersist.value);
    const count = result.count ?? lines.filter((line) => line.trim()).length;
    if (!synPersist.value) {
      saveMessage.value = `已保存（${count} 组，仅内存生效）：重启后失效`;
    } else if (!result.persistedTo) {
      saveMessage.value = `已保存（${count} 组）：写入文件失败，仅内存生效，重启会丢`;
    } else {
      saveMessage.value = `已保存（${count} 组）：${result.persistedTo}`;
    }
    // 回读规范化后的表：让计数与编辑框跟服务端一致；回读失败不影响「已保存」这个结论
    try {
      const fresh = await fetchSynonyms(props.token);
      synonyms.value = fresh;
      synText.value = fresh.tsv;
    } catch {
      /* 上面已给出保存结果，回读失败不覆盖 */
    }
  } catch (reason) {
    saveFailed.value = true;
    saveMessage.value = `保存失败：${messageOf(reason)}`;
  } finally {
    saving.value = false;
  }
}

watch(() => props.token, () => void loadAll(), { immediate: true });
</script>

<template>
  <div class="kb">
    <h2>知识库文档</h2>
    <div class="kb-actions">
      <button class="linkish" :disabled="reloading" @click="doReload()">
        {{ reloading ? '重载中…' : '重载知识库' }}
      </button>
      <button class="linkish" :disabled="loading" @click="loadAll()">刷新</button>
    </div>
    <p v-if="reloadMessage" class="kb-msg" :class="reloadFailed ? 'bad' : 'ok'">{{ reloadMessage }}</p>
    <p v-if="error" class="kb-msg bad">知识库加载失败：{{ error }}</p>

    <template v-if="docs">
      <div class="meta">
        共 {{ docs.fileCount ?? docs.docs.length }} 份文档 · {{ docs.chunkCount ?? '-' }} 块
        <template v-if="docs.knowledgeDir"> · {{ docs.knowledgeDir }}</template>
      </div>
      <table v-if="docs.docs.length">
        <tbody>
          <tr v-for="doc in docs.docs" :key="doc.path">
            <td>
              {{ doc.path }}
              <div v-if="doc.title" class="meta">{{ doc.title }}</div>
            </td>
            <td>{{ doc.zoneTitle || doc.zone || '未分展区' }}</td>
            <td>{{ doc.chunks > 0 ? `已索引 ${doc.chunks} 块` : '无分块' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="meta">知识库里还没有文档。</div>
    </template>

    <div class="title" style="margin-top: 16px">同义词表</div>
    <div v-if="synonyms" class="meta">
      共 {{ synonyms.count }} 组 · 来源：{{ synonyms.source === 'builtin' ? '内置' : synonyms.source || '-' }}
      <template v-if="synonyms.file"> · {{ synonyms.file }}</template>
    </div>
    <textarea
      v-model="synText"
      rows="6"
      spellcheck="false"
      aria-label="同义词表（每行：主词 TAB 备选词，逗号分隔）"
      placeholder="每行：主词 TAB 备选词（逗号分隔）"
    ></textarea>
    <div class="kb-actions">
      <label class="check"><input v-model="synPersist" type="checkbox" /> 持久化到文件</label>
      <button class="linkish" :disabled="saving || !synonyms" @click="doSave()">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </div>
    <p v-if="saveMessage" class="kb-msg" :class="saveFailed ? 'bad' : 'ok'">{{ saveMessage }}</p>
  </div>
</template>
