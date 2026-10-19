import { computed, getCurrentInstance, onUnmounted, ref } from 'vue';
import { synthesizeSpeech } from '../api';
import { readStorage, writeStorage } from '../storage';

/**
 * 语音播报：优先用服务端 TTS（MiMo，音色与语速集中在服务端配，key 不进前端），
 * 不可用或报错时当场退回浏览器内置播报。
 *
 * 展厅场景的取舍：
 * 1) **只读回答、不读提问**，且**边流式边读**：回答攒够一个完整句子就合成开播（beginAnswer/
 *    feedAnswer/endAnswer 增量接口），不再等整段流结束——首句开口能提前 2~3 秒。
 *    没有句末标点的半句绝不出声，避免把半句切成碎音。
 * 2) **开关落 localStorage**（默认开）：展厅机器就是靠它讲解，重启后保持上次的选择。
 * 3) **长文按句切片排队**：切点选在句末（≤120 字）。这既是绕开 Chrome 超长 utterance 静默的老办法，
 *    也是服务端 TTS 的请求单位——播第 N 句时已经在取第 N+1 句，首句延迟就只有一次合成的时间。
 * 4) **两级引擎，绝不哑掉**：服务端不通就降级到浏览器合成器（下面那套 resume 补丁治的正是
 *    浏览器合成的老毛病），运营在 ?admin=1 里能看到这一轮到底是谁发的声。
 *    浏览器引擎是降级路径，保持一次性放播（endAnswer 时整缓冲读出），流式提前开口只做在服务端引擎上。
 */

/** 朗读开关的存储键 */
const ENABLED_KEY = 'znwd.speak';
/** 单条朗读上限：大屏前的人听不了长篇，超出部分直接不读 */
export const MAX_SPEAK_CHARS = 600;
/** 每个片段的字数上限（按句切开，见 splitForSpeech） */
export const SPEAK_CHUNK_CHARS = 120;
/** Chrome 长文朗读约 15s 后会静默暂停，这个间隔内 resume 一次 */
const RESUME_INTERVAL_MS = 5_000;
export const PLAYBACK_WATCHDOG_MS = 30_000;
/**
 * 服务端播报被判失败后，多久之内不接受「又可用」。
 *
 * <p>比 App 的重探周期（`SPEECH_RECHECK_MS`，60 秒）短，所以恢复不会被自己的冷却期挡住。
 */
export const SERVER_RETRY_COOLDOWN_MS = 30_000;
/**
 * 46 字节的空 WAV（只有头、没有采样）。
 *
 * <p>{@code <audio>} 与浏览器合成器一样受自动播放策略约束：借第一次真实手势放一段无声的它，
 * 后面由脚本触发的播报才不会被拒。展厅的常态本来就有手势，这一步只是把配额提前备好。
 */
const SILENT_WAV =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';

/** 这一轮播报是谁发的声（运营视图用；none = 两个引擎都不可用） */
export type SpeechEngine = 'server' | 'browser' | 'none';

/**
 * 把回答洗成「能念出来的话」：Markdown 记号、链接、URL 都不该被逐字念出来。
 * 纯函数，便于单测。
 */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整段不读
    .replace(/`([^`]*)`/g, '$1') // 行内代码只留内容
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接只读文字
    .replace(/https?:\/\/\S+/g, ' ') // 裸链接
    .replace(/^\s{0,3}#{1,6}\s*/gm, '') // 标题记号
    .replace(/^\s{0,3}[-*+]\s+/gm, '') // 列表记号
    .replace(/[*_~>|]/g, '') // 强调/引用/表格线
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** 句末标点集（切分口径只此一份：splitForSpeech 按它切句、lastSentenceEnd 按它找最后一句） */
const SENTENCE_ENDS = '。！？；!?;';

/**
 * 在一组分隔符**之后**切开，分隔符留在前一段的末尾（= `split(/(?<=[marks])/)` 的效果）。
 *
 * <p>为什么不用那个写法：**反向引用断言**（lookbehind）虽然是 ES2018 语法，但浏览器支持得很晚
 * ——Safari/WebKit 到 16.4（2023-03）才有，而构建目标 `es2020` 不会降级它、esbuild 也降不了。
 * 老内核上的失败方式不是「这一句不读」，而是**正则字面量解析失败 → 整个模块解析失败 → 白屏**，
 * 正是展厅最不能出的一种故障（`tools/offline-check.py` 的 O08 会扫产物把这条钉死）。
 */
function splitAfter(text: string, marks: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (marks.includes(text[i])) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** 超长单句：先按逗号顿号断，再对仍然超长的部分硬切 */
function hardSplit(sentence: string, chunk: number): string[] {
  const pieces: string[] = [];
  let buf = '';
  for (const part of splitAfter(sentence, '，,、')) {
    if (part.length > chunk) {
      if (buf.trim()) pieces.push(buf.trim());
      buf = '';
      for (let i = 0; i < part.length; i += chunk) pieces.push(part.slice(i, i + chunk).trim());
      continue;
    }
    if ((buf + part).length > chunk) {
      if (buf.trim()) pieces.push(buf.trim());
      buf = '';
    }
    buf += part;
  }
  if (buf.trim()) pieces.push(buf.trim());
  return pieces.filter(Boolean);
}

/** 按句末标点切段并合并到不超过 chunk 字，保证每段都是一句完整的话 */
export function splitForSpeech(text: string, chunk = SPEAK_CHUNK_CHARS): string[] {
  const sentences = splitAfter(text, SENTENCE_ENDS)
    .map((s) => s.trim())
    .filter(Boolean);

  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = '';
  };

  for (const sentence of sentences) {
    if (sentence.length > chunk) {
      flush();
      out.push(...hardSplit(sentence, chunk));
      continue;
    }
    if ((buf + sentence).length > chunk) flush();
    buf += sentence;
  }
  flush();
  return out;
}

/**
 * 最后一个句末标点的下标，没有则返回 -1。
 *
 * <p>流式朗读用它判断「这句话说完了没有」：只有取到完整句（含标点）才允许合成开播，
 * 半句绝不出声。纯函数，便于单测。
 */
export function lastSentenceEnd(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (SENTENCE_ENDS.includes(text[i])) return i;
  }
  return -1;
}

type SpeechWindow = Window & {
  speechSynthesis?: SpeechSynthesis;
  SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
};

/** 支持才返回合成器；Node/测试环境或老浏览器返回 null */
function engine(): SpeechSynthesis | null {
  if (typeof window === 'undefined') return null;
  const w = window as SpeechWindow;
  return w.speechSynthesis && w.SpeechSynthesisUtterance ? w.speechSynthesis : null;
}

/** 优先中文音色；拿不到就让浏览器按 lang 自己挑（绝大多数情况也能挑对） */
function pickVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  let voices: SpeechSynthesisVoice[] = [];
  try {
    voices = synth.getVoices?.() ?? [];
  } catch {
    return null;
  }
  const zh = voices.filter((v) => (v.lang ?? '').toLowerCase().startsWith('zh'));
  if (!zh.length) return null;
  return zh.find((v) => /zh[-_]cn/i.test(v.lang)) ?? zh[0];
}

/**
 * 音色缓存与预热。
 *
 * 浏览器的 voices 列表是异步装好的：首次朗读时 `getVoices()` 常常还是空数组，
 * 于是第一条回答会落到默认音色（可能是英文音色念中文）。重写前的 React 版就是靠
 * `voiceschanged` 预热解决这件事，这里保留同样做法。缓存按合成器实例挂 WeakMap，
 * 测试里换假实现不会串味。
 */
const voiceCache = new WeakMap<SpeechSynthesis, SpeechSynthesisVoice>();
const voiceHooked = new WeakSet<SpeechSynthesis>();

function warmVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  const found = pickVoice(synth);
  if (found) voiceCache.set(synth, found);
  if (!voiceHooked.has(synth)) {
    voiceHooked.add(synth);
    try {
      synth.addEventListener?.('voiceschanged', () => {
        const late = pickVoice(synth);
        if (late) voiceCache.set(synth, late);
      });
    } catch {
      // 某些实现没有 addEventListener：忽略即可，朗读时再挑一次
    }
  }
  return voiceCache.get(synth) ?? found;
}

export type SpeechOptions = {
  /**
   * 播报失败回调（**只报真失败**：not-allowed 这类被浏览器策略拒掉的情况）。
   * interrupted / canceled 是「我们自己停读」的正常语义（换问题、点停读、开新对话），不在这里报。
   */
  onError?: (reason: string) => void;
  /**
   * **本答的第一段音频真的响起来了**（每个回答至多一次）。
   *
   * <p>它存在的唯一理由是延迟埋点（§4 P2 修订 1 的第三段「首句 → 首段音频」）：
   * 「合成回来了」与「参观者听见了」是两件事，只有播放器真的起播才算开口。
   * 服务端引擎在 `play()` 落地时回调，浏览器内置引擎在第一句 `onstart` 时回调——
   * 两条路径都算，否则降级部署上这一段延迟永远是空的。
   */
  onPlaybackStart?: () => void;
};

export function useSpeech(options: SpeechOptions = {}) {
  const synth = engine();
  const supported = synth !== null;
  /**
   * 开关初值只看用户上次的选择，**不绑 supported**。
   *
   * <p>绑上去会踩这个坑：某些一体机内核/隐私模式下没有 speechSynthesis，但服务端 TTS 完全可用，
   * 而 `enabled=false` 会让 {@link speak} 在第一行就返回——声音没了、日志里也没有任何错误，
   * 表现成「配了语音却一声不响」（诊断时实测：fetch 根本没发出去）。真正的可用性由
   * {@link available} 表达，speak 内部另有引擎判断兜底。
   */
  const enabled = ref(readEnabled());
  const speaking = ref(false);
  /** 最近一次播报失败的原因（空串 = 没失败过）；运营视图拿它做「被浏览器拦下了」的标记 */
  const lastError = ref('');
  /**
   * 服务端语音是否可用：App 用 `/api/health` 的 speechReady 置位；任何一次失败都会置回 false
   * 并当场降级。展厅运行中后端被人重启/断网是常态，不能等下一次刷新页面才退化。
   */
  const serverReady = ref(false);
  /** 任一引擎可用（服务端 TTS 或浏览器内置合成）：运营视图据此显示朗读开关 */
  const available = computed(() => serverReady.value || supported);
  /** 这一轮实际用的是哪套引擎（运营视图显示，排查「声音不对」时第一眼要看它） */
  const engineKind = computed<SpeechEngine>(() =>
    serverReady.value ? 'server' : supported ? 'browser' : 'none',
  );
  let resumeTimer: number | undefined;
  /**
   * 上一次判定「服务端 TTS 不可用」的时刻（0 = 没失败过）。
   *
   * <p>失败后**不立刻接受一次「又可用」**——那多半是页面早期拿到的陈旧 health；但也不能一票否决到底，
   * 所以它是一条**冷却期**而不是布尔闩：降级是「当场」，恢复是「过了冷却期再说」。冷却期由
   * App 的低频重探（`SPEECH_RECHECK_MS`）配合——没有那条重探的话（health 只在挂载时取一次），
   * 一次上游抖动就会把这台机器的播报永久换成浏览器合成，直到有人手刷页面。
   */
  let failedAt = 0;

  /**
   * 记「服务端 TTS 不可用」这一次状态迁移：降级当场生效、记录冷却起点、复位暖机闩。
   *
   * <p>**唯一的登记入口**——`setServerReady(false)`（health 说不可用）与 `runQueue` 的失败降级
   * 都调它，避免两处各写一半（早先 runQueue 只写了 `serverReady`/`failedAt`，漏了 `serverWarmed`，
   * 于是 V3 恢复路径里的 `warmServer()` 因闩还是 true 而空转：恢复后的首次服务端播报仍可能被
   * 自动播放策略挡下）。**它只登记，不停播**：停播是 `setServerReady(false)` 额外做的事，
   * 而 runQueue 正在异常路径上，停播会 `generation++` 打断它自己的浏览器回退。
   */
  function markServerUnavailable(): void {
    serverReady.value = false;
    failedAt = Date.now();
    serverWarmed = false;
  }

  /** 播报代号：stop()/新播报自增，进行中的取音频与播放循环据此自行收尾 */
  let generation = 0;
  let ttsController: AbortController | null = null;
  let audio: HTMLAudioElement | null = null;
  let playbackWatchdog: ReturnType<typeof setTimeout> | undefined;
  let gestureSeen = false;
  let serverWarmed = false;
  /** 当前播放的收尾回调：stop() 调它把挂着的 promise 放掉，否则循环永远等下去 */
  let finishPlay: (() => void) | null = null;

  // ---- 每答状态（beginAnswer 复位；stop() 置 answerActive=false 让残余 feed 全部失效）----
  /** 本答进行中：feed/end 只在此期间生效，停读/换问题后由 stop() 关掉 */
  let answerActive = false;
  /** 已提取进播报的字符游标：feedAnswer 只取 fullText 里游标之后的新内容 */
  let consumed = 0;
  /** 本答已排队的字符数，受 MAX_SPEAK_CHARS 总预算约束 */
  let spokenChars = 0;
  /** 本答引擎（首次入队时定）：server = 流式预取循环；browser = 缓冲到 endAnswer 一次性读 */
  let answerEngine: 'server' | 'browser' | null = null;
  /** 服务端引擎的待播队列（文本已按句切好） */
  let queue: string[] = [];
  /** 队头两条的取音频槽位：fetch0 对应 queue[0]，fetch1 对应 queue[1]（预取与播放并行的关键） */
  let fetch0: Promise<Blob> | null = null;
  let fetch1: Promise<Blob> | null = null;
  /** 正在播放的那一条文本：失败降级时它还没出队，要一并交给浏览器引擎补读 */
  let inFlight: string | null = null;
  /** 浏览器引擎缓冲 / 服务端降级后的待补读内容，endAnswer（或降级撞上已收尾）时一次性读出 */
  let pendingBrowserParts: string[] = [];
  /** 循环在「队列空且未关闭」时挂在这里，feed/end/stop 唤醒 */
  let queueWaiter: (() => void) | null = null;
  /** 本答的首段音频是否已经报过（每答只报一次，降级路径重播不该让计数翻倍） */
  let firstAudioReported = false;

  /** 首段音频起播：每个回答只往上报一次，供 App 算「首句 → 首音」那一段延迟 */
  function notifyPlaybackStart(): void {
    if (firstAudioReported) return;
    firstAudioReported = true;
    options.onPlaybackStart?.();
  }

  function readEnabled(): boolean {
    return readStorage('local', ENABLED_KEY) !== '0';
  }

  function clearTimer(): void {
    if (resumeTimer !== undefined) {
      window.clearInterval(resumeTimer);
      resumeTimer = undefined;
    }
  }

  /**
   * 停掉当前播放，**但不关本答的 feed 通道**（朗读开关关闭与 stop() 共用）。
   *
   * <p>槽位与 inFlight 绑着即将被 abort 的请求，必须一并清理：否则朗读开关拨回后，
   * 新循环会复用这些已死的 Promise，第一句就进降级路径；inFlight 里没播完的那条
   * 退回队头，恢复后从它继续读。
   */
  function haltPlayback(): void {
    generation += 1;
    wakeQueue(); // 唤醒挂在空队列上的循环，让它在 generation 校验处退场
    if (inFlight) queue.unshift(inFlight);
    inFlight = null;
    fetch0 = null;
    fetch1 = null;
    clearTimer();
    if (playbackWatchdog !== undefined) {
      clearTimeout(playbackWatchdog);
      playbackWatchdog = undefined;
    }
    ttsController?.abort();
    ttsController = null;
    speaking.value = false;
    if (audio) {
      const playing = audio;
      audio = null;
      try {
        playing.pause();
      } catch {
        // 不同实现下未开始播放时 pause 的行为不一致，忽略即可
      }
    }
    const finish = finishPlay;
    finishPlay = null;
    finish?.();
    try {
      synth?.cancel();
    } catch {
      // 某些浏览器在无朗读时 cancel 会抛，忽略即可
    }
  }

  /** 停掉当前朗读并关闭本答 feed 通道（换问题、开新对话、闲置复位、停读、组件卸载都要调） */
  function stop(): void {
    haltPlayback();
    // 关掉本答的 feed 通道：停读之后残余的 feedAnswer/endAnswer 全部 no-op
    answerActive = false;
  }

  if (getCurrentInstance()) onUnmounted(stop);

  /**
   * 整段读（一次性接口）：洗一遍、整段入队、随即收尾。
   *
   * <p>三道入口守卫（enabled、引擎可用、文本非空）都在 beginAnswer 的 stop() **之前**，
   * 保证「空文本/未启用不打断当前播报」的既有语义；引擎判断直接复用 resolveEngine()，
   * 不再维护第二份可用性规则。正文只在这里 sanitize 一次——不再经 feed 的游标提取，
   * 免得同一段文本跑两遍清洗正则。
   */
  function speak(text: string): void {
    if (!enabled.value || !resolveEngine()) return;
    const clean = sanitizeForSpeech(text).slice(0, MAX_SPEAK_CHARS);
    if (!clean) return;
    const parts = splitForSpeech(clean);
    if (!parts.length) return;
    beginAnswer();
    enqueue(parts);
    endAnswer(''); // 正文已整段入队，这里只负责关队列（没有尾巴可取）
  }

  /**
   * 流式朗读的第一步：停掉上一条播报并复位本答状态。
   *
   * <p>顺序有讲究——stop() 会置 answerActive=false，必须先 stop 再重新打开，
   * 否则本答的 feed 从一开始就全是 no-op。
   */
  function beginAnswer(): void {
    stop();
    answerActive = true;
    consumed = 0;
    spokenChars = 0;
    answerEngine = null;
    queue = [];
    fetch0 = null;
    fetch1 = null;
    inFlight = null;
    pendingBrowserParts = [];
    firstAudioReported = false;
  }

  /**
   * 流式朗读的第二步：每次回答变长都把**完整句子**送进来（fullText 是当前全文，不是增量）。
   *
   * <p>游标只推进到「最后一个句末标点」，没有完整句就什么都不做——半句绝不出声。
   */
  function feedAnswer(fullText: string): void {
    if (!answerActive || !enabled.value) return;
    const parts = takeCompleted(fullText, false);
    if (parts) enqueue(parts);
  }

  /**
   * 流式朗读的收尾：冲刷没有标点的尾巴（这段不要求句末标点），关闭队列并放播浏览器缓冲。
   *
   * <p>失败/取消的回答不会走到这里——调用方（App 的 watch）对 error 回答改调 stop()，
   * 保持「错误回答不读」的既有语义。
   */
  function endAnswer(finalText: string): void {
    if (!answerActive) return;
    const parts = takeCompleted(finalText, true);
    answerActive = false;
    if (parts) enqueue(parts);
    wakeQueue(); // 循环排空后自行退场；没有循环（浏览器引擎/未入队）时是 no-op
    flushBrowser();
  }

  /**
   * 从 fullText 游标处提取可读片段：flush=false 只取到最后一个句末标点，flush=true 取全部。
   *
   * <p>sanitize 与 600 字总预算都在这里落地；预算耗尽时把游标一次性推到末尾，
   * 后续 feed 不再重复做无用的切分。
   */
  function takeCompleted(fullText: string, flush: boolean): string[] | null {
    if (spokenChars >= MAX_SPEAK_CHARS) {
      consumed = fullText.length;
      return null;
    }
    const pending = fullText.slice(Math.min(consumed, fullText.length));
    if (!pending) return null;
    let take: string;
    if (flush) {
      take = pending;
      consumed = fullText.length;
    } else {
      const end = lastSentenceEnd(pending);
      if (end < 0) return null;
      take = pending.slice(0, end + 1);
      consumed += end + 1;
    }
    const clean = sanitizeForSpeech(take).slice(0, MAX_SPEAK_CHARS - spokenChars);
    if (!clean) return null;
    spokenChars += clean.length;
    const parts = splitForSpeech(clean);
    return parts.length ? parts : null;
  }

  /** 本答引擎只定一次：服务端可用就走服务端（音色统一），否则浏览器内置，都没有则整答不读 */
  function resolveEngine(): 'server' | 'browser' | null {
    if (serverReady.value) return 'server';
    if (synth) return 'browser';
    return null;
  }

  function enqueue(parts: string[]): void {
    // 朗读开关的总闸：feed/speak 各自拦过一次，endAnswer 的收尾提取也在这里兜住——
    // 少了这道，开关关闭时 feed 全部落空、endAnswer 却会把游标停在 0 的全文送进来
    if (!enabled.value) return;
    if (!answerEngine) {
      const picked = resolveEngine();
      if (!picked) return;
      answerEngine = picked;
      lastError.value = ''; // 这一轮开始前先清掉上一轮的失败标记
      if (picked === 'server') speaking.value = true;
    }
    if (answerEngine === 'server') {
      queue.push(...parts);
      if (ttsController) {
        ensurePrefetch(ttsController.signal);
        wakeQueue();
      } else {
        ttsController = new AbortController();
        void runQueue(ttsController);
      }
    } else {
      pendingBrowserParts.push(...parts);
    }
  }

  /** 浏览器缓冲放播（endAnswer / 降级撞上已收尾时）：一次性读出，onend 语义与旧版一致 */
  function flushBrowser(): void {
    if (!pendingBrowserParts.length) return;
    const parts = pendingBrowserParts;
    pendingBrowserParts = [];
    if (!enabled.value || !synth) return;
    speaking.value = true;
    speakBrowser(parts);
  }

  function wakeQueue(): void {
    const waiter = queueWaiter;
    queueWaiter = null;
    waiter?.();
  }

  function waitQueue(): Promise<void> {
    return new Promise<void>((resolve) => {
      queueWaiter = resolve;
    });
  }

  /**
   * 补齐队头两条的取音频槽位：fetch0 ← queue[0]，fetch1 ← queue[1]。
   *
   * <p>两个调用点缺一不可——循环每轮开头调它，feedAnswer 入队后也调它：
   * 播放第 N 句期间（循环被 playBlob 卡住）到达的第 N+1 句，靠 feed 这一侧触发预取，
   * 才能让「取下一句」与「播这一句」真正并行（旧版 parts 是静态数组，循环里一次排完，
   * 没有这个问题；动态队列必须两边都催）。幂等：槽位非空不动。
   */
  function ensurePrefetch(signal: AbortSignal): void {
    if (!fetch0 && queue.length >= 1) fetch0 = prefetch(queue[0], signal);
    if (!fetch1 && queue.length >= 2) fetch1 = prefetch(queue[1], signal);
  }

  /**
   * 服务端播报循环：动态队列版的「播第 N 句时已在取第 N+1 句」。
   *
   * <p>与旧版 speakServer 的差异只在数据源——从静态 parts 数组换成 queue，
   * 空队列且本答仍开着（answerActive）时挂在 waitQueue 上等 feed/end/stop 唤醒；
   * generation/预取/降级语义原样继承。
   */
  async function runQueue(requestController: AbortController): Promise<void> {
    const mine = generation;
    try {
      for (;;) {
        if (mine !== generation) return;
        ensurePrefetch(requestController.signal);
        if (!fetch0) {
          if (!answerActive) break;
          await waitQueue();
          continue;
        }
        const current = fetch0;
        fetch0 = null;
        inFlight = queue.shift() ?? null;
        fetch0 = fetch1; // 槽位旋转：原 queue[1] 现在是队头
        fetch1 = null;
        const blob = await current;
        if (mine !== generation) return;
        await playBlob(blob);
        if (mine !== generation) return;
        inFlight = null;
      }
      if (mine === generation) speaking.value = false;
    } catch (e) {
      if (mine !== generation) return;
      const reason = e instanceof Error ? e.message : 'server-speech-failed';
      requestController.abort();
      markServerUnavailable();
      lastError.value = reason;
      options.onError?.(reason);
      if (mine !== generation) return;
      // 未播的尾巴（含当前失败的这条）转入浏览器缓冲：答还没结束就等 endAnswer 一起补读，
      // 已收尾（失败发生在收尾段）就当场读——与旧版「降级立刻播剩余」的终点一致
      if (inFlight) pendingBrowserParts.push(inFlight);
      pendingBrowserParts.push(...queue);
      inFlight = null;
      queue = [];
      fetch0 = null;
      fetch1 = null;
      answerEngine = 'browser';
      speaking.value = false;
      if (!answerActive) flushBrowser();
    } finally {
      if (ttsController === requestController) ttsController = null;
    }
  }

  function prefetch(part: string, signal: AbortSignal): Promise<Blob> {
    const request = synthesizeSpeech(part, signal);
    request.catch(() => {});
    return request;
  }

  function playBlob(blob: Blob): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let url: string | undefined;
      let element: HTMLAudioElement;
      try {
        url = URL.createObjectURL(blob);
        element = new Audio(url);
      } catch (error) {
        if (url) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            return reject(error);
          }
        }
        reject(error);
        return;
      }
      audio = element;
      let settled = false;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (playbackWatchdog === watchdog) {
          clearTimeout(watchdog);
          playbackWatchdog = undefined;
        }
        if (finishPlay === finish) finishPlay = null;
        if (error) {
          try {
            element.pause();
          } catch {}
        }
        try {
          URL.revokeObjectURL(url!);
        } catch {}
        if (audio === element) audio = null;
        if (error) reject(error);
        else resolve();
      };
      // finish/watchdog 的声明直接落在赋值处（prefer-const）：done 只会在这两处初始化之后
      // 才被调用（onended/onerror/play().catch 全是异步回调，中间没有同步调用点），
      // 不存在 TDZ 读取，行为与原来「先 let 后赋」一致。
      const finish = () => done();
      finishPlay = finish;
      element.onended = () => done();
      element.onerror = () => done(new Error('audio-play-failed'));
      const watchdog = setTimeout(() => {
        if (element.ended) done();
        else done(new Error('audio-play-timeout'));
      }, PLAYBACK_WATCHDOG_MS);
      playbackWatchdog = watchdog;
      try {
        // play() 落地才算「开口」：合成回来与参观者听见了是两件事（见 onPlaybackStart）
        void Promise.resolve(element.play()).then(
          () => {
            if (audio === element) notifyPlaybackStart();
          },
          (e: unknown) => {
            done(new Error(`autoplay-blocked:${e instanceof Error ? e.message : ''}`));
          },
        );
      } catch (e) {
        done(new Error(`autoplay-blocked:${e instanceof Error ? e.message : ''}`));
      }
    });
  }

  /** 浏览器内置播报（兜底路径），保留原有的切片 + resume 补丁 */
  function speakBrowser(parts: string[]): void {
    if (!synth) {
      speaking.value = false;
      return;
    }
    const Ctor = (window as SpeechWindow).SpeechSynthesisUtterance!;
    const voice = warmVoice(synth);
    const mine = generation;

    parts.forEach((part, index) => {
      const utter = new Ctor(part);
      utter.lang = 'zh-CN';
      utter.rate = 1.02;
      utter.pitch = 1;
      if (voice) utter.voice = voice;
      // 降级路径也要报「开口」：否则没有服务端 TTS 的部署上，第三段延迟永远是空的
      if (index === 0) utter.onstart = () => notifyPlaybackStart();
      if (index === parts.length - 1) {
        // 以最后一段收尾为准：读完或读错都把状态放回 idle
        utter.onend = () => {
          if (mine !== generation) return;
          speaking.value = false;
          clearTimer();
        };
        utter.onerror = (event) => {
          if (mine !== generation) return;
          // not-allowed = 浏览器自动播放策略拒了（要求先有一次用户激活）；interrupted / canceled
          // 是我们主动停读的正常语义，报出来只会让运营视图被噪声淹掉。
          const reason = String((event as SpeechSynthesisErrorEvent | undefined)?.error ?? 'error');
          if (reason !== 'interrupted' && reason !== 'canceled') {
            lastError.value = reason;
            options.onError?.(reason);
            console.warn('[speech] 播报失败：', reason);
          }
          speaking.value = false;
          clearTimer();
        };
      }
      synth.speak(utter);
    });

    resumeTimer = window.setInterval(() => {
      if (synth.speaking) synth.resume();
      else clearTimer();
    }, RESUME_INTERVAL_MS);
  }

  /**
   * 首次真实手势时暖机：把「用户激活」配额与音色列表提前拿到。
   *
   * <p>两套引擎都要暖：服务端音频走 {@code <audio>}，同样受自动播放策略约束。
   * 展厅的交互本来就有手势（参观者点问题），这里只是提前备好——后续即便播报由脚本触发
   * （运营演示、自动化检查）也不会被拒。
   */
  function warmServer(): void {
    if (!gestureSeen || !serverReady.value || serverWarmed) return;
    serverWarmed = true;
    try {
      const element = new Audio(SILENT_WAV);
      void Promise.resolve(element.play()).catch(() => {});
    } catch {
      return;
    }
  }

  function unlock(): void {
    if (gestureSeen) return;
    gestureSeen = true;
    warmServer();
    if (!synth) return;
    try {
      warmVoice(synth);
      const Ctor = (window as SpeechWindow).SpeechSynthesisUtterance!;
      const utter = new Ctor('');
      utter.volume = 0; // 只为解锁，不出声
      synth.speak(utter);
    } catch {
      // 某些实现会拒绝空 utterance：忽略即可，正常朗读时还会再试
    }
  }

  /**
   * 切换朗读开关并持久化；关掉时立即闭嘴。
   *
   * <p>关闭走 haltPlayback 而不是 stop()：只停播放、**不关本答 feed 通道**——
   * 拨回来之后流还在继续时，feed/end 恢复工作，回答余下的部分照旧会读
   * （旧版 speak-at-end 按当时的 enabled 决定，同样是「拨回就照读」）。
   */
  function toggle(): void {
    enabled.value = !enabled.value;
    writeStorage('local', ENABLED_KEY, enabled.value ? '1' : '0');
    if (!enabled.value) haltPlayback();
  }

  /**
   * 同步服务端语音可用性（App 用 `/api/health` 的 `speechReady` 调它：挂载时一次，之后按
   * `SPEECH_RECHECK_MS` 低频重探）。
   *
   * <p>**降级当场生效，恢复要过冷却期**：运行中被判失败后，`SERVER_RETRY_COOLDOWN_MS` 之内的
   * 「又可用」一律不认（那多半是一次陈旧的 health），过了冷却期的那次新探测说了算——
   * 恢复路径正是靠这一条才存在的（见 {@link failedAt}）。
   *
   * <p>`ready=false` 与 `runQueue` 的失败降级共用 {@link markServerUnavailable} 登记状态
   * （不同只在：这里额外停播）。
   */
  function setServerReady(ready: boolean): void {
    const wasReady = serverReady.value;
    if (ready) {
      if (!wasReady) {
        // 冷却期内的「又可用」不认（多半是陈旧的 health）；过了冷却期就复位并暖机
        if (failedAt && Date.now() - failedAt < SERVER_RETRY_COOLDOWN_MS) return;
        failedAt = 0;
      }
      serverReady.value = true;
      if (!wasReady) warmServer();
      return;
    }
    // ready=false：统一走降级登记。停播是这里额外做的事（runQueue 的失败降级在异常路径上，
    // 不能停播——那会打断它自己的浏览器回退），状态簿记则共用 markServerUnavailable。
    if (wasReady) stop();
    markServerUnavailable();
  }

  return {
    supported,
    available,
    enabled,
    speaking,
    lastError,
    serverReady,
    engineKind,
    setServerReady,
    speak,
    beginAnswer,
    feedAnswer,
    endAnswer,
    stop,
    toggle,
    unlock,
  };
}

