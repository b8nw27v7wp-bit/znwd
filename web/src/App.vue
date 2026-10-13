<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useChat } from './composables/useChat';
import { useSpeech, lastSentenceEnd, sanitizeForSpeech } from './composables/useSpeech';
import { useDictation } from './composables/useDictation';
import { useAcoustics } from './composables/useAcoustics';
import { readStorage, writeStorage } from './storage';
import { formatAnswer, type Block } from './format';
import { bindZoneBridge, dispatchZoneChange, writeZoneToUrl, type ZoneSource } from './zoneLink';
import SourcePanel from './components/SourcePanel.vue';
import AdminPanel from './components/AdminPanel.vue';
import AvatarPortrait from './components/AvatarPortrait.vue';
import StageDiagram from './components/StageDiagram.vue';

/** 展厅闲置自动回到欢迎态：下一位参观者不该看到上一个人的对话 */
const IDLE_RESET_MS = 180_000;

/**
 * 常开聆听的存储键。**缺省为开**（键缺失或任何非 '0' 的值都算开）——与朗读键 `znwd.speak`
 * 同一套写法，两个开关互相独立。
 */
const LISTEN_KEY = 'znwd.listen';
/**
 * 插话打断（P3a-2）的存储键。**缺省为关**，与常开聆听相反。
 *
 * <p>理由在判据而不在能力：打断要判断「麦克风里这一下是人声还是自己的喇叭声」，而这个门限
 * 必须由现场的回声数据（P3a-1 的 `echo*` 那组计数）定。没拿到数据就打开判决，等于拿参观者
 * 试参数——判错一次就是把回答掐了、又没有新问题。常开聆听缺省开，是因为它的判据（VAD 常量）
 * 在 P1 已经现场跑过。
 */
const BARGEIN_KEY = 'znwd.bargein';

const chat = useChat();
/** 声学遥测：底噪与 VAD 判定只在前端看得见，靠它汇进 /api/stats（运营面板据此调现场阈值） */
const acoustics = useAcoustics();
const listenOn = ref(readStorage('local', LISTEN_KEY) !== '0');
const bargeInOn = ref(readStorage('local', BARGEIN_KEY) === '1');
/**
 * 三段延迟的中间时刻（§4 P2 修订 1）。
 *
 * <p>第一段（说完→终稿）由 `useDictation` 自己量——只有它知道「说完」是哪一刻；
 * 后两段跨了 chat 与 speech 两个 composable，只有 App 看得全，所以记在这里。
 */
let askedAt = 0;
let firstSentenceAt = 0;

const speech = useSpeech({
  // 播报被浏览器拦下（not-allowed）时进「最近的技术问题」：展厅大屏不提示，运营视图能看到原因
  onError: (reason) =>
    chat.logError('（语音播报）', `浏览器拦下了自动播报（${reason}）：页面需要一次真实点击/触摸`),
  // 第三段延迟（首句 → 首段音频）：`useSpeech` 每答只报一次，这里配上首句生成时刻换算
  onPlaybackStart: () => {
    if (!askedAt || !firstSentenceAt) return;
    const ms = performance.now() - firstSentenceAt;
    firstSentenceAt = 0; // 本答已经量过，别被同一次回答的后续片段再报一遍
    acoustics.record({ kind: 'firstAudio', ms });
  },
});
const draft = ref('');
/**
 * 输入框里这份草稿是不是「语音预览」。
 *
 * <p>只有它还是预览的时候才允许被 `onPartial(null)` 清掉：参观者手打进去的字
 * 不该因为一次误触发的环境噪声被抹掉（展厅里这两种输入会混在同一个框里）。
 */
const partialDraft = ref<string | null>(null);
/**
 * 语音提问：识别到文字就直接提问——展厅里没人愿意再说一遍还去点发送。
 * 识别失败不往大屏上抛（技术信息一律只进运营视图），但会被记下来。
 *
 * <p>常开聆听多一条预览通道：`onPartial` 是分段识别的拼接结果，随说话逐段变长；
 * 它**只是预览**，终稿永远走 `onText`（整段识别）并立刻提问，所以这里不做任何提交。
 */
const dictation = useDictation({
  onText: (text) => {
    draft.value = text;
    partialDraft.value = null;
    submit();
  },
  onPartial: (text) => {
    if (text === null) {
      if (partialDraft.value !== null && draft.value === partialDraft.value) draft.value = '';
      partialDraft.value = null;
      return;
    }
    draft.value = text;
    partialDraft.value = text;
  },
  onError: (reason) => chat.logError('（语音提问）', reason),
  onMetrics: (event) => acoustics.record(event),
  /**
   * 判出插话（P3a-2）：让 AI 当场让口。
   *
   * <p>`useDictation` 那边已经做完「解除抑制 + 把判成人声的那几块接成新的一句」，
   * 这里只剩两件它够不到的事：
   * - **停播**：`speech.stop()` 清队列 + `pause()` + `cancel()`，本来就是毫秒级的；
   * - **停掉还在生成的那一条**：只停播是不够的——回答还在往下流，新的句子会立刻排队重新出声，
   *   变成「打断之后 AI 接着说」。回答要不要留半条由 `chat.cancel()` 定，与页面上的「停」
   *   按钮同一条路径，参观者看到的是「AI 让口，我接着说」。
   */
  onBargeIn: () => {
    speech.stop();
    if (chat.streaming.value) chat.cancel();
  },
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

/** 后端语音是否可用（/api/health 的 speechReady）：常开聆听自动开麦的前置条件之一 */
const speechReady = ref(false);
const bootstrapped = ref(false);
/** 已经出现过真实手势：开麦要等到这时才做（权限弹窗与「用户激活」都靠它） */
let gestureSeen = false;

/**
 * 常开聆听自动开麦。
 *
 * <p>三道门都得过：已经完成 bootstrap、后端真的报语音可用、常开关没被运营关掉。
 * 少了 speechReady 这道，`AUDIO_PROVIDER=none` 的实例会在每次说话时刷一条 503
 * ——大屏上没人看得见，但运营视图会被这类噪音淹掉。
 *
 * <p>幂等且**允许重试**：权限被拒时留着手势监听，参观者下一次点屏幕会再试一次
 * （`arm()` 内部已经挡住「已经开着又开一次」）。
 */
function armDictation(): void {
  if (!gestureSeen || !bootstrapped.value || !speechReady.value || !listenOn.value) return;
  void dictation.arm();
}

/** 第一次真实手势：解锁语音（空 utterance 暖机 + 预热中文音色）并顺手开麦 */
function onFirstGesture(): void {
  gestureSeen = true;
  // 之后即使播报由脚本触发，也不会被浏览器的自动播放策略拒掉；unlock() 内部只暖机一次
  speech.unlock();
  armDictation();
  // 「后端明确没有语音」（AUDIO_PROVIDER=none）时也不再留着监听：它要等的是一个不会来的状态
  if (dictation.armed.value || !listenOn.value || (bootstrapped.value && !speechReady.value)) {
    detachGestureWake();
  }
}

/** 监听只在「还没到目的」时留着：armed 成功，或已经不必再 arm（常开关着） */
function detachGestureWake(): void {
  window.removeEventListener('pointerdown', onFirstGesture);
  window.removeEventListener('touchstart', onFirstGesture);
  window.removeEventListener('keydown', onFirstGesture);
}

onMounted(() => {
  // 服务端语音是否可用由 /api/health 说了算：可用则播报走服务端 TTS，否则当场用浏览器内置
  void chat.bootstrap().then(() => {
    const health = chat.health.value;
    bootstrapped.value = true;
    if (health) {
      speechReady.value = Boolean(health.speechReady);
      speech.setServerReady(speechReady.value);
    }
    // 手势可能先到（页面已经被人点过）、bootstrap 后到：这时补一次开麦
    armDictation();
  });
  composer.value?.focus();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, bumpActivity, { passive: true });
  }
  // 第一次真实手势解锁语音并开麦：arm 成功前监听不摘，权限被拒时下个手势还会再试
  window.addEventListener('pointerdown', onFirstGesture, { passive: true });
  window.addEventListener('touchstart', onFirstGesture, { passive: true });
  window.addEventListener('keydown', onFirstGesture);
  bumpActivity();
});

onUnmounted(() => {
  if (idleTimer) window.clearTimeout(idleTimer);
  unbindZoneBridge();
  chat.cancel();
  speech.stop();
  // 卸载（切页面/热更新）必须放掉麦克风与 AudioContext：常开聆听下它们一直开着，
  // track 不停的话浏览器会一直显示「正在使用麦克风」。dispose 会顺手清掉在途识别与预览。
  dictation.dispose();
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.removeEventListener(type, bumpActivity);
  }
  window.removeEventListener('pointerdown', onFirstGesture);
  window.removeEventListener('touchstart', onFirstGesture);
  window.removeEventListener('keydown', onFirstGesture);
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
    if (chat.messages.value.length) return;
    // 回到欢迎态（新对话 / 闲置复位）时上一位参观者的回答不该还在念
    speech.stop();
    // 半截语音预览也不能留给下一位参观者；**手打的草稿照留**——参观者可能只是走开一下，
    // 手里正在打的字被清掉比留一行旧文本更让人困惑（partialDraft 为 null 时这里什么都不做）
    if (partialDraft.value !== null) {
      draft.value = '';
      partialDraft.value = null;
    }
  },
);

/**
 * 常开聆听开关：同步给 composable，并且**开的那一刻就试着开麦**
 * （运营在 ?admin=1 里拨回来时不该还要再点一次屏幕）。
 *
 * <p>刻意**不在这里写存储**：页面每次加载都往 localStorage 里塞一个键，是替还没做过决定的
 * 参观者做决定。存储只在运营真的拨了开关那一下写（见 toggleListen）。
 */
watch(
  listenOn,
  (on) => {
    dictation.setAlwaysOn(on);
    if (on) armDictation();
  },
  { immediate: true },
);

/** arm 成功就把手势监听摘掉；被拒时留着，下个手势再试（权限弹窗要求用户激活） */
watch(
  () => dictation.armed.value,
  (armed) => {
    if (armed) detachGestureWake();
  },
);

/**
 * 播报与流式回答期间**抑制**麦克风输入（第 2 档：抑制而不是打断）。
 *
 * <p>喇叭和麦克风在同一台机器上，讲解声进麦克风会被 VAD 当成有人说话。
 * 抑制期间麦克风保持开着（避免权限抖动），但语句、VAD、分段全部冻结——否则
 * 底噪样本会被自己的喇叭声污染，现场调出来的阈值全是错的。
 *
 * <p>P3a 之后这一段多了个观察者：抑制期间仍然**采回声**（写进独立的 `echo*` 计数），
 * 因为「自己的喇叭在麦克风里有多响」只能在这一刻量；插话判决（如果开着）也读同一份数据。
 * 它不是重新开始听——越限但要持续一段时间才判人声，见 useDictation 的 watchEcho。
 */
watch(
  [() => chat.streaming.value, () => speech.speaking.value],
  ([streaming, speaking]) => dictation.setSuppressed(streaming || speaking),
);

/** 插话判决开关（存储只在这一处写，与常开聆听同一套写法） */
watch(bargeInOn, (on) => dictation.setBargeIn(on), { immediate: true });

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

// 语音播报：开流先闭嘴上一条并准备本答，回答攒够一句就播，流式结束冲刷尾巴；
// 失败/取消的那条不读——改调 stop()，已经响起来的部分也一并闭嘴
watch(
  () => chat.streaming.value,
  (now, before) => {
    if (now) {
      speech.beginAnswer();
      return;
    }
    if (!before) return;
    const last = chat.messages.value[chat.messages.value.length - 1];
    if (!last || last.role !== 'assistant' || last.error) speech.stop();
    else speech.endAnswer(last.content);
  },
);

// 流式期间回答在长：把当前全文喂给播报（内部按游标只取新完成的句子，半句不出声）
watch(
  () => {
    if (!chat.streaming.value) return '';
    const last = chat.messages.value[chat.messages.value.length - 1];
    return last && last.role === 'assistant' ? last.content : '';
  },
  (content) => {
    if (!content) return;
    speech.feedAnswer(content);
    // 第二段延迟（§4 P2 修订 1）：提问发出（语音终稿或打字提交）→ 首句生成。
    // 判据刻意与 useSpeech 决定「要不要开口」的那一处完全一致（先洗 Markdown，再找句末标点）：
    // 否则会出现「有完整句子了但不出声」的时刻，两段延迟对不上账
    if (!askedAt || firstSentenceAt) return;
    if (lastSentenceEnd(sanitizeForSpeech(content)) < 0) return;
    firstSentenceAt = performance.now();
    acoustics.record({ kind: 'firstSentence', ms: firstSentenceAt - askedAt });
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

/**
 * 等第一个字时是"思考"（侧头），出字后是"说话"（动口型），语音播报中也算说话；
 * 麦克风开着且没人说话时是"聆听"（常开聆听的常态），其余空闲。
 */
const avatarState = computed<'idle' | 'speaking' | 'thinking' | 'listening'>(() => {
  if (chat.streaming.value) {
    const last = chat.messages.value[chat.messages.value.length - 1];
    return last && last.content.length === 0 ? 'thinking' : 'speaking';
  }
  if (speech.speaking.value) return 'speaking';
  return dictation.listening.value ? 'listening' : 'idle';
});

/**
 * 提问的唯一入口：点 ↑、语音终稿、推荐问题都从这里走。
 *
 * <p>除了交给 `chat.ask`，它还打一个「提问发出」的时刻——四段延迟（§4 P2 修订 1）的后两段
 * 都从这个点起算。四散在各处的 `chat.ask` 调用点会让这套埋点漏掉一半样本。
 *
 * <p>**不区分语音还是打字**：后两段量的是「问题落地 → 模型出首句 → 听见首音」这段**回答链路**，
 * 与问题是怎么进来的无关（语音独有的那一段「说完→终稿」由 `useDictation` 自己量）。
 */
function askQuestion(text: string): void {
  askedAt = performance.now();
  firstSentenceAt = 0;
  void chat.ask(text);
}

function submit(): void {
  const text = draft.value;
  if (!text.trim() || chat.streaming.value || chat.resetting.value) return;
  draft.value = '';
  askQuestion(text);
}

/**
 * 麦克风按钮。
 *
 * <p>点按模式（旧行为）：按一下进入聆听（说完停顿 VAD_SILENCE_MS 自动结束并识别，当前 1 秒），
 * 识别前再按一下立即结束。开始前先停掉播报——展厅里喇叭和麦克风在同一台机器上，
 * 讲解声会被录进去变成提问的一部分。
 *
 * <p>常开聆听下麦克风本来就开着，所以按钮只剩一个作用：**立即结束当前这句话**（不等停顿）。
 * 没人说话时点它什么都不做——真正的开关在运营视图里（`?admin=1` 的本机设置），
 * 大屏前的人不该有办法把讲解员的耳朵关掉。
 */
function toggleDictation(): void {
  if (listenOn.value && dictation.armed.value) {
    if (dictation.recording.value) void dictation.stop();
    return;
  }
  if (dictation.pending.value) {
    dictation.cancel();
  } else if (dictation.recording.value) {
    void dictation.stop();
  } else {
    speech.stop();
    void dictation.start();
  }
}

/**
 * 播报 / 流式回答期间麦克风被抑制（与 setSuppressed 的判据同一份）。
 *
 * <p>按钮文案要说出来：参观者在这段时间说话，**插话判决关着时是没有反应**的，
 * 不讲清楚就会被当成机器坏了；开着时反过来——那时候说话是有用的，文案得说「直接说」。
 */
const micSuppressed = computed(() => chat.streaming.value || speech.speaking.value);

/** 正在录一句时按是否已检出人声区分文案；常开聆听空闲时是「聆听中」 */
const micLabel = computed(() => {
  if (dictation.listening.value) {
    if (!micSuppressed.value) return '聆听中，直接说话即可';
    return bargeInOn.value ? '正在回答，想插话直接说' : '正在回答，暂时不听（说完会恢复）';
  }
  if (!dictation.recording.value) return '语音提问';
  return dictation.speechDetected.value ? '结束录音并识别' : '聆听中，说完停顿一下自动结束';
});

const micTitle = computed(() => {
  if (dictation.listening.value) {
    if (!micSuppressed.value) return '常开聆听中：直接说话就会提问';
    return bargeInOn.value
      ? '回答期间麦克风仍然在听：直接开口就会打断它（门限高于平时，避免被自己的喇叭声打断）'
      : '回答播放期间麦克风被抑制，避免自己的喇叭声被当成提问；播放结束自动恢复';
  }
  if (!dictation.recording.value) return '点一下开始说话';
  return dictation.speechDetected.value ? '点一下结束' : '也可点一下立即结束';
});

/**
 * 运营视图里的常开聆听开关：落存储，并由上面的 watcher 同步给 composable。
 *
 * <p>`gestureSeen` 在这里补一次：拨开关本身就是一次真实手势，接下来不需要再点屏幕才能开麦。
 */
function toggleListen(): void {
  listenOn.value = !listenOn.value;
  writeStorage('local', LISTEN_KEY, listenOn.value ? '1' : '0');
  gestureSeen = true;
  armDictation();
}

/**
 * 运营视图里的插话打断开关（P3a-2）。
 *
 * <p>它**只改判决**，不改采集：关着的时候回声照采（P3a-1），运营面板上那组 `echo*` 照样在涨。
 * 打开之后才真的会打断——门限是按当前说话阈值的两倍算的（见 useDictation 的 BARGEIN_FACTOR），
 * 拿到现场回声数据后该调的就是它。
 */
function toggleBargeIn(): void {
  bargeInOn.value = !bargeInOn.value;
  writeStorage('local', BARGEIN_KEY, bargeInOn.value ? '1' : '0');
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
            <h1>晴晴</h1>
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
              @click="askQuestion(question)"
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
            <!-- 语音提问：点一下进入聆听，说完停顿（VAD_SILENCE_MS，当前 1 秒）自动识别；识别前再点一下立即结束。
                 常开聆听下麦克风本来就开着，这颗按钮变成「立即结束这一句」（没人说话时点它无动作）。
                 不支持的机器上整颗按钮不出现。 -->
            <button
              v-if="dictation.supported"
              type="button"
              class="mic"
              :class="{ on: dictation.recording.value || dictation.listening.value }"
              :disabled="dictation.busy.value || dictation.pending.value || chat.streaming.value"
              :aria-pressed="dictation.recording.value || dictation.listening.value"
              :aria-label="micLabel"
              :title="micTitle"
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
        <!-- 常开聆听：存储键缺省 = 开（展厅的常态），关掉就退回点按模式。
             开关只在这里：大屏前的人不该有办法把讲解员的耳朵关掉。 -->
        <div v-if="dictation.supported" class="row">
          <span>常开聆听</span>
          <button
            class="linkish"
            :aria-pressed="listenOn"
            @click="toggleListen()"
          >
            {{ listenOn ? '开' : '关' }}
          </button>
        </div>
        <p v-if="dictation.supported" class="muted">
          {{
            listenOn
              ? '麦克风常开：说话即提问。关掉可退回「点一下说话」。'
              : '已关闭：需要点麦克风按钮才会开始听'
          }}
        </p>
        <!-- 插话打断（P3a-2）：**缺省关**。判据（门限抬多少、持续多久）必须由现场回声数据定，
             关着的时候回声照采（P3a-1），运营统计里那组 echo* 计数就是这份数据。 -->
        <div v-if="dictation.supported" class="row">
          <span>插话打断</span>
          <button class="linkish" :aria-pressed="bargeInOn" @click="toggleBargeIn()">
            {{ bargeInOn ? '开' : '关' }}
          </button>
        </div>
        <p v-if="dictation.supported" class="muted">
          {{
            bargeInOn
              ? '回答期间直接开口就会打断它，你接下来说的那句成为新问题。'
              : '关：回答期间麦克风只采回声、不判决（运营统计里的回声行照样在涨）'
          }}
        </p>
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
