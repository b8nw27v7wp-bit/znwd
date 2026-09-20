import { ref } from 'vue';

/**
 * 浏览器内置语音播报（Web Speech API，零依赖、离线可用）。
 *
 * 展厅场景的三条取舍：
 * 1) **只读回答、不读提问**，且在流式结束后整段读——边流边读会把半句切成碎音。
 * 2) **开关落 localStorage**（默认开）：展厅机器就是靠它讲解，重启后保持上次的选择。
 * 3) **长文按句切片排队**：Chrome 对超长 utterance 会中途静默，切成 ≤120 字的片段最稳；
 *    同时给一段定时 resume，把 Chrome 朗读约 15 秒后自动暂停的老毛病拉回来。
 */

/** 朗读开关的存储键 */
const ENABLED_KEY = 'znwd.speak';
/** 单条朗读上限：大屏前的人听不了长篇，超出部分直接不读 */
export const MAX_SPEAK_CHARS = 600;
/** 每个片段的字数上限（按句切开，见 splitForSpeech） */
export const SPEAK_CHUNK_CHARS = 120;
/** Chrome 长文朗读约 15s 后会静默暂停，这个间隔内 resume 一次 */
const RESUME_INTERVAL_MS = 5_000;

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

export function useSpeech() {
  const synth = engine();
  const supported = synth !== null;
  const enabled = ref(supported && readEnabled());
  const speaking = ref(false);
  let resumeTimer: number | undefined;

  function readEnabled(): boolean {
    try {
      // 默认开：展厅大屏就是靠它讲解；只有显式关过才不读
      return localStorage.getItem(ENABLED_KEY) !== '0';
    } catch {
      return true;
    }
  }

  function clearTimer(): void {
    if (resumeTimer !== undefined) {
      window.clearInterval(resumeTimer);
      resumeTimer = undefined;
    }
  }

  /** 停掉当前朗读（换问题、开新对话、闲置复位、组件卸载都要调） */
  function stop(): void {
    clearTimer();
    speaking.value = false;
    try {
      synth?.cancel();
    } catch {
      // 某些浏览器在无朗读时 cancel 会抛，忽略即可
    }
  }

  /** 读一段回答：同一时刻只读一条，长文自动切片排队 */
  function speak(text: string): void {
    if (!synth || !enabled.value) return;
    const clean = sanitizeForSpeech(text).slice(0, MAX_SPEAK_CHARS);
    if (!clean) return;
    stop();

    const parts = splitForSpeech(clean);
    if (!parts.length) return;
    const Ctor = (window as SpeechWindow).SpeechSynthesisUtterance!;
    const voice = warmVoice(synth);
    speaking.value = true;

    parts.forEach((part, index) => {
      const utter = new Ctor(part);
      utter.lang = 'zh-CN';
      utter.rate = 1.02;
      utter.pitch = 1;
      if (voice) utter.voice = voice;
      if (index === parts.length - 1) {
        // 以最后一段收尾为准：读完或读错都把状态放回 idle
        utter.onend = () => {
          speaking.value = false;
          clearTimer();
        };
        utter.onerror = () => {
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

  /** 切换朗读开关并持久化；关掉时立即闭嘴 */
  function toggle(): void {
    enabled.value = !enabled.value;
    try {
      localStorage.setItem(ENABLED_KEY, enabled.value ? '1' : '0');
    } catch {
      // 隐私模式下写不了 localStorage：本次会话仍然生效
    }
    if (!enabled.value) stop();
  }

  return { supported, enabled, speaking, speak, stop, toggle };
}

