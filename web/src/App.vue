<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useChat } from './composables/useChat';
import { useSpeech } from './composables/useSpeech';
import { useDictation } from './composables/useDictation';
import { formatAnswer, type Block } from './format';
import { bindZoneBridge, dispatchZoneChange, writeZoneToUrl, type ZoneSource } from './zoneLink';
import SourcePanel from './components/SourcePanel.vue';
import AdminPanel from './components/AdminPanel.vue';
import AvatarPortrait from './components/AvatarPortrait.vue';
import StageDiagram from './components/StageDiagram.vue';

/** 展厅闲置自动回到欢迎态：下一位参观者不该看到上一个人的对话 */
const IDLE_RESET_MS = 180_000;

const chat = useChat();
const speech = useSpeech({
  // 播报被浏览器拦下（not-allowed）时进「最近的技术问题」：展厅大屏不提示，运营视图能看到原因
  onError: (reason) =>
    chat.logError('（语音播报）', `浏览器拦下了自动播报（${reason}）：页面需要一次真实点击/触摸`),
});
const draft = ref('');
/**
 * 语音提问：识别到文字就直接提问——展厅里没人愿意再说一遍还去点发送。
 * 识别失败不往大屏上抛（技术信息一律只进运营视图），但会被记下来。
 */
const dictation = useDictation({
  onText: (text) => {
    draft.value = text;
    submit();
  },
  onError: (reason) => chat.logError('（语音提问）', reason),
});
/** 展厅大屏上不放运营入口：加 ?admin=1 打开（运营视图里的统计接口本来就要口令） */
const showAdmin = ref(typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('admin'));
const showSources = ref(false);
const scrollArea = ref<HTMLElement | null>(null);
const composer = ref<HTMLTextAreaElement | null>(null);
let idleTimer: number | undefined;

/**
 * 展区变化的唯一入口：下拉、window.znwdSetZone、znwd:zone 事件都从这里走。
 * - 同值 no-op：不重复拉推荐问题，也截断事件回声；
 * - 变更经 chat.setZone 落 localStorage，再用 replaceState 同步 URL（保留 admin 等参数）；
 * - source='api' 的变更向 window 广播 znwd:zone；外部事件本身就是广播，不再回发（防回环）。
 */
function applyZone(id: string | null, source: ZoneSource = 'api'): void {
  if (id === chat.zone.value) return;
  void chat.setZone(id);
  writeZoneToUrl(id);
  if (source === 'api') dispatchZoneChange(id);
}

// 展览桥：挂载即可被外部调用；卸载时必须解绑，避免反复挂载（测试/热更新）互相污染
const unbindZoneBridge = bindZoneBridge(applyZone);

function bumpActivity(): void {
  if (idleTimer) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    // streaming/resetting 期间落空时必须重新武装：否则计时器被消耗后再无下一个，
    // 挂死的流超时报错后对话就永远留在公共大屏上，直到有人再碰屏（违背本常量的设计初衷）。
    // 重新武装走的是 setTimeout 而非直接递归调用，无深递归风险。
    if (chat.messages.value.length && !chat.streaming.value && !chat.resetting.value) void chat.startOver();
    bumpActivity();
  }, IDLE_RESET_MS);
}

/** 只解一次锁，之后自己摘掉监听 */
function unlockSpeechOnce(): void {
  speech.unlock();
  window.removeEventListener('pointerdown', unlockSpeechOnce);
  window.removeEventListener('touchstart', unlockSpeechOnce);
  window.removeEventListener('keydown', unlockSpeechOnce);
}

onMounted(() => {
  // 服务端语音是否可用由 /api/health 说了算：可用则播报走服务端 TTS，否则当场用浏览器内置
  void chat.bootstrap().then(() => {
    const health = chat.health.value;
    if (health) speech.setServerReady(Boolean(health.speechReady));
  });
  composer.value?.focus();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, bumpActivity, { passive: true });
  }
  // 第一次真实手势顺手解锁语音（空 utterance 暖机 + 预热中文音色）：之后即使播报由脚本触发，
  // 也不会被浏览器的自动播放策略拒掉。展厅的常态本来就有手势，这一步只是把配额提前备好。
  window.addEventListener('pointerdown', unlockSpeechOnce, { passive: true });
  window.addEventListener('touchstart', unlockSpeechOnce, { passive: true });
  window.addEventListener('keydown', unlockSpeechOnce);
  bumpActivity();
});

onUnmounted(() => {
  if (idleTimer) window.clearTimeout(idleTimer);
  unbindZoneBridge();
  chat.cancel();
  speech.stop();
  // 录音中途被卸载（切页面/热更新）也要把麦克风与 AudioContext 放掉：
  // track 不停的话浏览器会一直显示「正在使用麦克风」
  dictation.cancel();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.removeEventListener(type, bumpActivity);
  }
  window.removeEventListener('pointerdown', unlockSpeechOnce);
  window.removeEventListener('touchstart', unlockSpeechOnce);
  window.removeEventListener('keydown', unlockSpeechOnce);
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

/** 落库状态只给运营看：展厅大屏上不提示（技术问题一律走聊天窗口） */
const storageLabel = computed(() => {
  const health = chat.health.value;
  if (!health) return '未知（后端未响应）';
  return health.storageAvailable ? 'MySQL 已连接' : '未连接（会话/统计/反馈重启即丢）';
});

/** 回答按块渲染（粗体/列表/分段）：模型爱用 Markdown，直接当纯文本渲染会让 ** 和 * 上大屏 */
const renderedAnswers = computed<Record<string, Block[]>>(() => {
  const out: Record<string, Block[]> = {};
  for (const message of chat.messages.value) {
    if (message.role === 'assistant') out[message.id] = formatAnswer(message.content);
  }
  return out;
});

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

const zoneOpen = ref(false);

/** 触发按钮上的当前值：没选就是"全部展区" */
const zoneLabel = computed(
  () => zoneOptions.value.find((z) => z.id === chat.zone.value)?.label ?? '全部展区',
);

function pickZone(id: string | null): void {
  zoneOpen.value = false;
  applyZone(id);
}

const placeholder = computed(() =>
  chat.streaming.value || chat.resetting.value ? '正在回答…' : '输入问题，例如“叶片检测要停机吗？”',
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
  if (!text.trim() || chat.streaming.value || chat.resetting.value) return;
  draft.value = '';
  void chat.ask(text);
}

/**
 * 麦克风按钮：按一下开始录，再按一下结束并识别。
 *
 * <p>开始前先停掉播报——展厅里喇叭和麦克风在同一台机器上，讲解声会被录进去变成提问的一部分。
 */
function toggleDictation(): void {
  if (dictation.pending.value) {
    dictation.cancel();
  } else if (dictation.recording.value) {
    void dictation.stop();
  } else {
    speech.stop();
    void dictation.start();
  }
}

/** 运营视图里的播报来源：排查「声音不对/没声音」时第一眼要看它 */
const speechEngineLabel = computed(() => {
  switch (speech.engineKind.value) {
    case 'server':
      return '服务端 TTS（MiMo）';
    case 'browser':
      return '浏览器内置合成';
    default:
      return '不可用';
  }
});

/**
 * 回车提交。
 *
 * 必须跳过输入法组字状态：中文输入法里「回车」也用来确认候选词，
 * 不判断的话，参观者选词的那一下就会把半截拼音/候选文本当成问题发出去（展厅全中文场景，必踩）。
 * `keyCode === 229` 是旧浏览器在组字中的标记，一起挡掉。
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
}

/** 技术问题列表里的时间戳（本机时区，运营对日志用） */
function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
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
            <!-- 页面上只留"正在朗读"时的停读；朗读开关与会话重置收进运营视图的本机设置 -->
            <button
              v-if="speech.speaking.value"
              class="linkish"
              title="停止朗读"
              @click="speech.stop()"
            >
              停读
            </button>
          </div>
        </header>

        <div class="zone-row">
          <span id="zone-label" class="zone-label">展区</span>
          <!-- 自绘下拉：原生 <select> 的展开列表由系统绘制，样式做不了 -->
          <div class="zone-select" :class="{ open: zoneOpen }" @keydown.esc="zoneOpen = false">
            <button
              type="button"
              class="zone-trigger"
              aria-haspopup="listbox"
              :aria-expanded="zoneOpen"
              aria-labelledby="zone-label"
              @click="zoneOpen = !zoneOpen"
            >
              <span class="zone-value">{{ zoneLabel }}</span>
              <svg class="zone-caret" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
                <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"
                      stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <div v-if="zoneOpen" class="zone-backdrop" @click="zoneOpen = false"></div>
            <ul v-if="zoneOpen" class="zone-menu" role="listbox" aria-labelledby="zone-label">
              <li class="zone-all">
                <button
                  type="button"
                  role="option"
                  class="zone-option"
                  :class="{ on: chat.zone.value === null }"
                  :aria-selected="chat.zone.value === null"
                  @click="pickZone(null)"
                >
                  全部展区
                </button>
              </li>
              <li v-if="!zoneOptions.length" class="zone-empty">展区列表未加载</li>
              <li v-for="z in zoneOptions" :key="z.id">
                <button
                  type="button"
                  role="option"
                  class="zone-option"
                  :class="{ on: chat.zone.value === z.id }"
                  :aria-selected="chat.zone.value === z.id"
                  @click="pickZone(z.id)"
                >
                  {{ z.label }}
                </button>
              </li>
            </ul>
          </div>
        </div>

        <main ref="scrollArea" class="main">
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
                <p
                  v-for="(block, bi) in renderedAnswers[message.id] ?? []"
                  :key="bi"
                  :class="block.kind === 'li' ? 'line li' : 'line'"
                >
                  <span v-if="block.marker" class="marker">{{ block.marker }}</span>
                  <template v-for="(seg, si) in block.segments" :key="si">
                    <strong v-if="seg.bold">{{ seg.text }}</strong>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                  <span
                    v-if="message.pending && bi === (renderedAnswers[message.id]?.length ?? 0) - 1"
                    class="caret"
                  ></span>
                </p>
                <span v-if="message.pending && !(renderedAnswers[message.id]?.length)" class="caret"></span>
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
              :disabled="chat.streaming.value || chat.resetting.value"
              @keydown="onKeydown"
            ></textarea>
            <button v-if="chat.streaming.value" class="send ghost" @click="chat.cancel()">停</button>
            <button v-else class="send" aria-label="发送" :disabled="chat.resetting.value || !draft.trim()" @click="submit()">↑</button>
            <!-- 语音提问：按一下开始、再按一下结束并识别；不支持的机器上整颗按钮不出现 -->
            <button
              v-if="dictation.supported"
              type="button"
              class="mic"
              :class="{ on: dictation.recording.value }"
              :disabled="dictation.busy.value || dictation.pending.value || chat.streaming.value"
              :aria-pressed="dictation.recording.value"
              :aria-label="dictation.recording.value ? '结束录音并识别' : '语音提问'"
              :title="dictation.recording.value ? '点一下结束' : '点一下开始说话'"
              @click="toggleDictation()"
            >
              <span v-if="dictation.recording.value" class="mic-time">
                {{ (dictation.elapsedMs.value / 1000).toFixed(1) }}s
              </span>
              <span v-else-if="dictation.busy.value" class="mic-time">…</span>
              <svg v-else width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 1.6a2.1 2.1 0 0 1 2.1 2.1v4.2a2.1 2.1 0 0 1-4.2 0V3.7A2.1 2.1 0 0 1 8 1.6Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                />
                <path
                  d="M3.7 7.7a4.3 4.3 0 0 0 8.6 0M8 12v2.3"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
        </footer>
      </div>
    </section>

    <!-- 右 2/3：项目讲解图（一次问答的链路 + 技术栈与实测数据） -->
    <div class="stage-rest">
      <StageDiagram />
    </div>

    <div v-if="showAdmin" class="drawer">
      <div class="drawer-head">
        <span>运营视图</span>
        <button class="linkish" @click="showAdmin = false">关闭</button>
      </div>

      <section class="local-set">
        <h2>本机设置</h2>
        <div class="row">
          <span>回答朗读</span>
          <button
            v-if="speech.available.value"
            class="linkish"
            :aria-pressed="speech.enabled.value"
            @click="speech.toggle()"
          >
            {{ speech.enabled.value ? '开' : '关' }}
          </button>
          <span v-else class="muted">本机与后端都没有可用的语音</span>
        </div>
        <!-- 开关藏在 ?admin=1 抽屉里，大屏上看不出状态；被浏览器拦下时在这行标出来 -->
        <p class="muted" :style="speech.lastError.value ? { color: 'var(--warn)' } : undefined">
          {{
            speech.lastError.value
              ? `上次播报被浏览器拦下（${speech.lastError.value}）：页面需要一次真实点击/触摸`
              : '本机设置；浏览器可能拦截自动播报'
          }}
        </p>
        <div class="row">
          <span>播报来源</span>
          <span class="muted">{{ speechEngineLabel }}</span>
        </div>
        <div class="row">
          <span>数据留存</span>
          <span class="muted">{{ storageLabel }}</span>
        </div>
        <div class="row">
          <span>当前会话</span>
          <button class="linkish" @click="chat.startOver()">重新开始</button>
        </div>
      </section>

      <section v-if="chat.errors.value.length" class="tech-log">
        <h2>最近的技术问题（{{ chat.errors.value.length }}）</h2>
        <div v-for="item in chat.errors.value" :key="item.at" class="tech-item">
          <div class="q">{{ item.question }}</div>
          <div class="m">{{ item.message }} · {{ timeLabel(item.at) }}</div>
        </div>
        <button class="linkish" @click="chat.clearErrors()">清空</button>
      </section>

      <AdminPanel />
    </div>
  </div>
</template>
