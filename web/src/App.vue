<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useChat } from './composables/useChat';
import { useSpeech } from './composables/useSpeech';
import SourcePanel from './components/SourcePanel.vue';
import AdminPanel from './components/AdminPanel.vue';
import AvatarPortrait from './components/AvatarPortrait.vue';

/** 展厅闲置自动回到欢迎态：下一位参观者不该看到上一个人的对话 */
const IDLE_RESET_MS = 180_000;

const chat = useChat();
const speech = useSpeech();
const draft = ref('');
const showAdmin = ref(false);
const showSources = ref(false);
const scrollArea = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
let idleTimer: number | undefined;

function bumpActivity(): void {
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    if (chat.messages.value.length && !chat.streaming.value) void chat.startOver();
  }, IDLE_RESET_MS);
}

onMounted(() => {
  void chat.bootstrap();
  composer.value?.focus();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, bumpActivity, { passive: true });
  }
  bumpActivity();
});

onUnmounted(() => {
  if (idleTimer) window.clearTimeout(idleTimer);
  speech.stop();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.removeEventListener(type, bumpActivity);
  }
});

// 流式回答期间自动跟到底部：大屏前的人不用自己滚
watch(
  () => chat.messages.value.map((m) => m.content.length).join(':'),
  async () => {
    await nextTick();
    const el = scrollArea.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

// 换了问题就把上一条的来源收起来，省得挂着一份对不上的资料
watch(
  () => chat.messages.value.length,
  () => {
    showSources.value = false;
    // 回到欢迎态（新对话 / 闲置复位）时上一位参观者的回答不该还在念
    if (!chat.messages.value.length) speech.stop();
  },
);

// 语音播报：新问题一来先闭嘴，流式结束后整段读（失败/取消的那条不读）
watch(
  () => chat.streaming.value,
  (now, before) => {
    if (now) {
      speech.stop();
      return;
    }
    if (!before) return;
    const last = chat.messages.value[chat.messages.value.length - 1];
    if (!last || last.role !== 'assistant' || last.error) return;
    speech.speak(last.content);
  },
);

const zoneOptions = computed(() =>
  chat.zones.value.map((z) => ({ id: z.id, label: z.title || z.id })),
);

const placeholder = computed(() =>
  chat.streaming.value ? '正在回答…' : '输入问题，例如“叶片检测要停机吗？”',
);

/** 等第一个字时是"思考"（侧头），出字后是"说话"（动口型），语音播报中也算说话，其余空闲 */
const avatarState = computed<'idle' | 'speaking' | 'thinking'>(() => {
  if (chat.streaming.value) {
    const last = chat.messages.value[chat.messages.value.length - 1];
    return last && last.content.length === 0 ? 'thinking' : 'speaking';
  }
  return speech.speaking.value ? 'speaking' : 'idle';
});

function submit(): void {
  const text = draft.value;
  if (!text.trim()) return;
  draft.value = '';
  void chat.ask(text);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}

function assistantSourceLabel(mode?: string, provider?: string): string {
  if (mode === 'llm_only') return `通用模型回答（${provider ?? '-'}，未引用资料）`;
  return `基于知识库（${provider ?? '-'}）`;
}
</script>

<template>
  <div class="stage">
    <!-- 左 1/3：上半虚拟形象、下半问答 -->
    <section class="panel">
      <!-- 虚拟形象：立绘优先（AvatarPortrait），加载失败自动退回 SVG 版（AvatarFigure） -->
      <div class="avatar-slot" data-avatar-slot>
        <AvatarPortrait :state="avatarState" />
      </div>

      <div class="console">
        <header class="head">
          <div>
            <h1>展厅虚拟讲解员</h1>
            <span class="sub">光伏清洁 · 风场检测 · 服务与合作</span>
          </div>
          <div class="head-actions">
            <span v-if="chat.health.value">
              {{ chat.health.value.knowledgeChunks }} 条资料
            </span>
            <button
              v-if="speech.supported"
              class="linkish speak-toggle"
              :class="{ off: !speech.enabled.value }"
              :aria-pressed="speech.enabled.value"
              :title="speech.enabled.value ? '回答会自动朗读，点击关闭' : '点击开启自动朗读'"
              @click="speech.toggle()"
            >
              朗读：{{ speech.enabled.value ? '开' : '关' }}
            </button>
            <button
              v-if="speech.speaking.value"
              class="linkish"
              title="停止朗读（不影响朗读开关）"
              @click="speech.stop()"
            >
              停读
            </button>
            <button class="linkish" @click="chat.startOver()">新对话</button>
            <button class="linkish" @click="showAdmin = true">运营视图</button>
          </div>
        </header>

        <div class="zone-row">
          <label class="zone-label" for="zone-select">展区</label>
          <select
            id="zone-select"
            class="zone-select"
            :value="chat.zone.value ?? ''"
            @change="chat.setZone(($event.target as HTMLSelectElement).value || null)"
          >
            <option value="">全部展区</option>
            <option v-for="z in zoneOptions" :key="z.id" :value="z.id">{{ z.label }}</option>
          </select>
        </div>

        <main ref="scrollArea" class="main">
          <p v-if="chat.health.value && !chat.health.value.storageAvailable" class="banner">
            数据库未连接：本次问答不会留存（会话/统计/反馈重启即丢）。运营侧请按 server/db/init.sql 初始化 MySQL。
          </p>

          <div v-if="!chat.messages.value.length" class="empty">
            可以直接问，也可以点下面的问题开始：
          </div>

          <div
            v-for="message in chat.messages.value"
            :key="message.id"
            class="msg"
            :class="message.role"
          >
            <template v-if="message.role === 'user'">
              <div class="bubble">{{ message.content }}</div>
            </template>
            <template v-else>
              <div class="speaker">{{ assistantSourceLabel(message.meta?.mode, message.meta?.provider) }}</div>
              <div class="answer" aria-live="polite">
                {{ message.content }}<span v-if="message.pending" class="caret"></span>
              </div>
              <div class="msg-foot">
                <span v-if="message.meta?.cached">缓存命中</span>
                <span v-if="message.meta?.noHit" class="nohit">资料中未覆盖，已按“直说没有”回答</span>
                <span v-if="message.meta?.rewrite?.rewritten">已按上下文补全提问</span>
                <span v-if="message.latencyMs">{{ message.latencyMs }} ms</span>
                <button
                  :class="{ on: chat.feedback.value[message.id] === 'up' }"
                  :disabled="message.pending"
                  @click="chat.rate(message, 'up')"
                >
                  有帮助
                </button>
                <button
                  :class="{ on: chat.feedback.value[message.id] === 'down' }"
                  :disabled="message.pending"
                  @click="chat.rate(message, 'down')"
                >
                  没帮助
                </button>
              </div>
            </template>
          </div>

          <div v-if="chat.error.value" class="banner">{{ chat.error.value }}</div>

          <div v-if="!chat.streaming.value && chat.sources.value.length" class="sources-block">
            <button class="src-toggle" @click="showSources = !showSources">
              {{ showSources ? '收起来源' : `查看来源（${chat.sources.value.length}）` }}
            </button>
            <SourcePanel v-if="showSources" :sources="chat.sources.value" />
          </div>

          <div v-if="!chat.messages.value.length && chat.suggestions.value.length" class="chips">
            <button
              v-for="question in chat.suggestions.value"
              :key="question"
              class="chip"
              @click="chat.ask(question)"
            >
              {{ question }}
            </button>
          </div>
        </main>

        <footer class="compose">
          <div class="composer">
            <textarea
              ref="composer"
              v-model="draft"
              :placeholder="placeholder"
              aria-label="输入你的问题"
              rows="1"
              :disabled="chat.streaming.value"
              @keydown="onKeydown"
            ></textarea>
            <button v-if="chat.streaming.value" class="send ghost" @click="chat.cancel()">停</button>
            <button v-else class="send" :disabled="!draft.trim()" @click="submit()">↑</button>
          </div>
          <div class="hint">
            回车发送 · Shift+回车换行 · 回答严格依据展厅资料，资料没有的会直说没有 · 闲置 3 分钟自动回到欢迎语<template
              v-if="speech.supported && speech.enabled.value"
            > · 回答会自动朗读</template>
          </div>
        </footer>
      </div>
    </section>

    <!-- 右 2/3：暂时留白，留给后续展项内容 -->
    <div class="stage-rest" aria-hidden="true"></div>

    <div v-if="showAdmin" class="drawer">
      <div class="drawer-head">
        <span>运营视图</span>
        <button class="linkish" @click="showAdmin = false">关闭</button>
      </div>
      <AdminPanel />
    </div>
  </div>
</template>
