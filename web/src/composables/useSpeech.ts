import { computed, getCurrentInstance, onUnmounted, ref } from 'vue';
import { synthesizeSpeech } from '../api';
import { readStorage, writeStorage } from '../storage';

/**
 * 语音播报：优先用服务端 TTS（MiMo，音色与语速集中在服务端配，key 不进前端），
 * 不可用或报错时当场退回浏览器内置播报。
 *
 * 展厅场景的取舍：
 * 1) **只读回答、不读提问**，且在流式结束后整段读——边流边读会把半句切成碎音。
 * 2) **开关落 localStorage**（默认开）：展厅机器就是靠它讲解，重启后保持上次的选择。
 * 3) **长文按句切片排队**：切点选在句末（≤120 字）。这既是绕开 Chrome 超长 utterance 静默的老办法，
 *    也是服务端 TTS 的请求单位——播第 N 句时已经在取第 N+1 句，首句延迟就只有一次合成的时间。
 * 4) **两级引擎，绝不哑掉**：服务端不通就降级到浏览器合成器（下面那套 resume 补丁治的正是
 *    浏览器合成的老毛病），运营在 ?admin=1 里能看到这一轮到底是谁发的声。
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

/** 超长单句：先按逗号顿号断，再对仍然超长的部分硬切 */
function hardSplit(sentence: string, chunk: number): string[] {
  const pieces: string[] = [];
  let buf = '';
  for (const part of sentence.split(/(?<=[，,、])/)) {
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
  const sentences = text
    .split(/(?<=[。！？；!?;])/)
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
  /** 本次会话里服务端语音失败过：之后的 health 结果不再把它翻回可用 */
  let probeFailed = false;
  /** 播报代号：stop()/新播报自增，进行中的取音频与播放循环据此自行收尾 */
  let generation = 0;
  let ttsController: AbortController | null = null;
  let audio: HTMLAudioElement | null = null;
  let playbackWatchdog: ReturnType<typeof setTimeout> | undefined;
  let gestureSeen = false;
  let serverWarmed = false;
  /** 当前播放的收尾回调：stop() 调它把挂着的 promise 放掉，否则循环永远等下去 */
  let finishPlay: (() => void) | null = null;

  function readEnabled(): boolean {
    return readStorage('local', ENABLED_KEY) !== '0';
  }

  function clearTimer(): void {
    if (resumeTimer !== undefined) {
      window.clearInterval(resumeTimer);
      resumeTimer = undefined;
    }
  }

  /** 停掉当前朗读（换问题、开新对话、闲置复位、组件卸载都要调） */
  function stop(): void {
    generation += 1;
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

  if (getCurrentInstance()) onUnmounted(stop);

  /**
   * 读一段回答：同一时刻只读一条，长文自动切片排队。
   *
   * <p>引擎选择只有一处：服务端标了可用就走服务端（音色统一），否则走浏览器内置。
   * 服务端在播放中途挂掉时由 {@link speakServer} 自己降级，这里不再重复判断。
   */
  function speak(text: string): void {
    if (!enabled.value) return;
    if (!serverReady.value && !synth) return;
    const clean = sanitizeForSpeech(text).slice(0, MAX_SPEAK_CHARS);
    if (!clean) return;

    const parts = splitForSpeech(clean);
    if (!parts.length) return;
    stop();
    speaking.value = true;
    lastError.value = ''; // 这一轮开始前先清掉上一轮的失败标记

    if (serverReady.value) {
      ttsController = new AbortController();
      void speakServer(parts, ttsController);
    } else speakBrowser(parts);
  }

  /**
   * 服务端播报：一句一段音频，播第 N 句时已经在取第 N+1 句。
   *
   * <p>预取是关键——串行「取一句播一句」会让每句之间都空等一次合成（30 字约 1 秒），
   * 听感上像结巴；这里在第 N 句开播前就把第 N+1 句的请求发出去。
   */
  async function speakServer(parts: string[], requestController: AbortController): Promise<void> {
    const mine = generation;
    let pending: Promise<Blob> | null = null;
    let unplayedIndex = 0;
    try {
      for (let i = 0; i < parts.length; i++) {
        unplayedIndex = i;
        const current = pending ?? prefetch(parts[i], requestController.signal);
        pending = i + 1 < parts.length ? prefetch(parts[i + 1], requestController.signal) : null;
        const blob = await current;
        if (mine !== generation) return;
        await playBlob(blob);
        if (mine !== generation) return;
        unplayedIndex = i + 1;
      }
    } catch (e) {
      if (mine !== generation) return;
      const reason = e instanceof Error ? e.message : 'server-speech-failed';
      requestController.abort();
      serverReady.value = false;
      probeFailed = true;
      lastError.value = reason;
      options.onError?.(reason);
      if (mine !== generation) return;
      const remaining = parts.slice(unplayedIndex);
      if (synth && remaining.length) speakBrowser(remaining);
      else speaking.value = false;
      return;
    } finally {
      if (ttsController === requestController) ttsController = null;
    }
    if (mine === generation) speaking.value = false;
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
        void Promise.resolve(element.play()).catch((e: unknown) => {
          done(new Error(`autoplay-blocked:${e instanceof Error ? e.message : ''}`));
        });
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

  /** 切换朗读开关并持久化；关掉时立即闭嘴 */
  function toggle(): void {
    enabled.value = !enabled.value;
    writeStorage('local', ENABLED_KEY, enabled.value ? '1' : '0');
    if (!enabled.value) stop();
  }

  /**
   * 同步服务端语音可用性（App 在 bootstrap 后用 /api/health 的 speechReady 调它）。
   *
   * <p>只在「从未探测过」或状态变化时改：运行中被判失败后又收到一次陈旧的 true 不该复辟——
   * 所以一旦本次会话失败过，就由 {@link speakServer} 的降级结果说了算。
   */
  function setServerReady(ready: boolean): void {
    const wasReady = serverReady.value;
    if (ready && !wasReady && probeFailed) return;
    if (!ready && wasReady) {
      stop();
      serverWarmed = false;
    }
    serverReady.value = ready;
    if (ready && !wasReady) warmServer();
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
    stop,
    toggle,
    unlock,
  };
}

