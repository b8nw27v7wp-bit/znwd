import { getCurrentInstance, onUnmounted, ref } from 'vue';
import { recognizeSpeech } from '../api';

/**
 * 语音提问：点一下开麦进入聆听，VAD 检出人声后停顿 VAD_SILENCE_MS（当前 1 秒）自动结束并识别；
 * 识别前再点一下 = 立即手动结束（原有兜底路径）。
 *
 * 采集与编码全在前端做，理由有三个：
 * 1) **接口只收 wav/mp3**：MediaRecorder 在 Chrome 默认吐 webm/opus，直接被 ASR 拒；
 *    自己用 AudioContext 采 PCM 再拼 WAV 头，格式完全可控，还省一个转码依赖。
 * 2) **体积**：48kHz 原始 PCM 一秒就近 100KB，20 秒录音会顶到上传上限；降到 16kHz 后
 *    一秒 32KB，两秒都不到 64KB——展厅的短问答这个码率足够识别。
 * 3) **可控**：掐头去尾、时长上限、静音判定都在本地，不必把整段录音先传上去再让服务端挑。
 *
 * 采集节点用已废弃的 ScriptProcessorNode 而不是 AudioWorklet：后者要求单独一个模块文件
 * 并走 addModule 异步加载，为一次录音引入这套构建配置不划算；前者的替代品至今没有全量落地。
 */

/** 送给识别接口的目标采样率：16kHz 单声道 16bit ≈ 32KB/s */
export const TARGET_SAMPLE_RATE = 16_000;
/** 单段录音上限：超过自动结束（2MB 上传上限下，这个长度只有三分之一余量） */
export const MAX_RECORD_MS = 20_000;
/** 短于这个长度的录音按「误触」处理，不浪费一次识别调用 */
const MIN_RECORD_MS = 400;

/** 判定「有人说话」的 RMS 下限：人声经开降噪后通常 0.03~0.15，导出供展厅现场调参 */
export const VAD_SPEECH_RMS = 0.02;
/** 判定「有动静」（非纯静音）的下限：低于它的一律当无声，用于无语音超时 */
export const VAD_SILENCE_RMS = 0.01;
/**
 * 说完到收尾的静音时长。按**时长**而不是块数累计——4096 帧块的时长取决于设备实际采样率
 * （浏览器常锁 44.1/48kHz，此时一块只有 ~85ms），按块数算会在快采样率设备上把
 * 「停顿 1 秒」变成 340ms，句中换气就截断。导出供展厅现场调参。
 */
export const VAD_SILENCE_MS = 1_000;
/** 开麦后一直没动静的放弃时长：没人说话就收回麦克风，而不是一直挂着 */
export const VAD_NO_SPEECH_MS = 6_000;

export type VadState = {
  /** 已听到过 ≥VAD_SPEECH_RMS 的人声：自动收尾的前置条件 */
  speechSeen: boolean;
  /** 已听到过 ≥VAD_SILENCE_RMS 的动静（粘滞）：无语音超时只在「全程无声」时才开火 */
  audible: boolean;
  /** 距上一次人声（≥VAD_SPEECH_RMS）累计的非人声时长（毫秒） */
  silentMs: number;
};

/** 初始 VAD 状态；invalidate/start 都要回到它，漏一处按钮文案就会和真实状态脱钩 */
export function initialVad(): VadState {
  return { speechSeen: false, audible: false, silentMs: 0 };
}

/** 单个 PCM 块的均方根。全零返回 0；空块不参与判定（除零保护） */
export function chunkRms(chunk: Float32Array): number {
  if (!chunk.length) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
}

/**
 * VAD 状态推进（纯函数，便于单测）。chunkMs = 本块时长，由调用方按真实采样率算。
 *
 * - RMS ≥ 说话阈值：置 speechSeen/audible 并清零静音时长（一句话重新开始算）；
 * - 其余（含两阈值之间的滞回带）：按 chunkMs 累计静音——**带内也算静音**：
 *   停在带内的环境音若只「保持状态」，静音时长会被冻结、永远凑不满收尾条件，
 *   录音只能挂到 20s 上限；带内只防误触发说话（speechSeen 仍要求 ≥说话阈值），
 *   不再兼做「静音豁免」。audible 单独记录，保证轻声说话者不被无语音超时误杀。
 */
export function vadStep(state: VadState, rms: number, chunkMs: number): VadState {
  if (rms >= VAD_SPEECH_RMS) return { speechSeen: true, audible: true, silentMs: 0 };
  return {
    speechSeen: state.speechSeen,
    audible: state.audible || rms >= VAD_SILENCE_RMS,
    silentMs: state.silentMs + Math.max(0, chunkMs),
  };
}

export type DictationOptions = {
  /** 识别成功回文本（调用方决定是填进输入框还是直接提问） */
  onText?: (text: string) => void;
  /** 失败原因（麦克风被拒、识别失败）：运营视图用来解释「为什么按了没反应」 */
  onError?: (reason: string) => void;
};

type AudioWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/** 取 AudioContext 构造函数：老 Safari 只有 webkit 前缀那个（TS 的 lib.dom 只声明了全局名） */
function audioContextCtor(): typeof AudioContext | undefined {
  if (typeof AudioContext !== 'undefined') return AudioContext;
  return (window as AudioWindow).webkitAudioContext;
}

/** 支持才可用；不支持的设备上按钮直接不出现，而不是点了没反应 */
export function dictationSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return Boolean(navigator.mediaDevices?.getUserMedia) && Boolean(audioContextCtor());
}

/**
 * 线性插值重采样。语音识别不需要更讲究的抗混叠滤波，而重采样滤波器的实现与调参成本
 * 远高于它带来的识别收益；纯函数，便于单测。
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !input.length) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Float32 PCM → 16bit 单声道 WAV。头部按标准 RIFF 手写，避免为一个容器引依赖。 */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 块长度
  view.setUint16(20, 1, true); // 1 = PCM
  view.setUint16(22, 1, true); // 单声道
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // 字节率
  view.setUint16(32, 2, true); // 块对齐
  view.setUint16(34, 16, true); // 位深
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    // 负半轴满量程到 -32768：用 0x8000 而不是 0x7fff，否则最小负值会轻微削顶
    view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function concat(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function useDictation(options: DictationOptions = {}) {
  const supported = dictationSupported();
  const recording = ref(false);
  const pending = ref(false);
  /** 正在识别（录音已结束、等接口返回）：这期间按钮应该禁用，避免两次提问打架 */
  const busy = ref(false);
  /** 已录时长（毫秒）：按钮上显示，让说话的人知道还在录 */
  const elapsedMs = ref(0);
  /** 本轮是否已检出人声：区分「聆听中」与「说完了」两种文案，也参与无语音超时判定 */
  const speechDetected = ref(false);
  /** 最近一次失败原因（空串 = 没失败过） */
  const error = ref('');

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
  let vad: VadState = initialVad();
  let contextRate = TARGET_SAMPLE_RATE;
  let startedAt = 0;
  let ticker: number | undefined;
  let operationGeneration = 0;
  let recognitionController: AbortController | null = null;
  let disposed = false;

  function stopTracks(value: MediaStream | null): void {
    try {
      value?.getTracks().forEach((track) => track.stop());
    } catch {
      return;
    }
  }

  function release(): void {
    if (ticker !== undefined) {
      window.clearInterval(ticker);
      ticker = undefined;
    }
    try {
      processor?.disconnect();
      source?.disconnect();
    } catch {
      // 已经断开过：忽略
    }
    processor = null;
    source = null;
    stopTracks(stream);
    stream = null;
    const currentContext = context;
    context = null;
    try {
      const closing = currentContext?.close();
      if (closing) void Promise.resolve(closing).catch(() => {});
    } catch {
      // 已经关过：忽略
    }
  }

  function invalidate(): void {
    operationGeneration += 1;
    pending.value = false;
    recording.value = false;
    busy.value = false;
    elapsedMs.value = 0;
    speechDetected.value = false;
    chunks = [];
    vad = initialVad();
    recognitionController?.abort();
    recognitionController = null;
    release();
  }

  /** 开始录音；麦克风被拒/不支持的机器上只报错不抛，按钮不会卡在「录音中」 */
  async function start(): Promise<void> {
    if (!supported || disposed || recording.value || pending.value || busy.value) return;
    error.value = '';
    const generation = ++operationGeneration;
    pending.value = true;
    let acquired: MediaStream | null = null;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({
        // 展厅是开放空间：回声消除与降噪开着，比追求原始音质重要
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (disposed || generation !== operationGeneration) {
        stopTracks(acquired);
        return;
      }
      stream = acquired;
      const Ctor = audioContextCtor();
      if (!Ctor) throw new Error('浏览器不支持录音');
      const ctx = new Ctor({ sampleRate: TARGET_SAMPLE_RATE });
      context = ctx;
      // 浏览器未必照办 16kHz（很多设备锁在 44.1/48kHz），拿回真实值，编码前统一重采样
      contextRate = ctx.sampleRate;
      source = ctx.createMediaStreamSource(acquired);
      processor = ctx.createScriptProcessor(4096, 1, 1);
      chunks = [];
      vad = initialVad();
      processor.onaudioprocess = (event) => {
        if (disposed || generation !== operationGeneration || !recording.value) return;
        const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
        chunks.push(chunk);
        // 按块的真实时长累计（contextRate 是设备实际采样率，不保证 16k）
        const chunkMs = (chunk.length / contextRate) * 1000;
        vad = vadStep(vad, chunkRms(chunk), chunkMs);
        if (!speechDetected.value && vad.speechSeen) speechDetected.value = true;
        // 说完自动收尾：手动点按（stop/cancel）与这条路径汇合于同一 stop()，不会打架
        if (vad.speechSeen && vad.silentMs >= VAD_SILENCE_MS) void stop();
      };
      source.connect(processor);
      // 某些实现里不接 destination 就不会触发 onaudioprocess；输出为静音，不会真的放出来
      processor.connect(ctx.destination);
    } catch (e) {
      if (disposed || generation !== operationGeneration) {
        stopTracks(acquired);
        return;
      }
      release();
      const reason = e instanceof Error ? e.message : '麦克风不可用';
      error.value = reason;
      options.onError?.(reason);
      return;
    } finally {
      if (generation === operationGeneration) pending.value = false;
    }

    if (disposed || generation !== operationGeneration) {
      stopTracks(acquired);
      return;
    }
    recording.value = true;
    speechDetected.value = false;
    startedAt = performance.now();
    elapsedMs.value = 0;
    ticker = window.setInterval(() => {
      if (disposed || generation !== operationGeneration) {
        release();
        return;
      }
      elapsedMs.value = performance.now() - startedAt;
      // 无语音超时先判：tick 被节流合并到 20s 之后时，纯静音也该走「没有听到声音」
      // 这条免识别路径，而不是掉进 MAX 分支白跑一次识别。
      // 用 audible 而不是 speechDetected：轻声（带内）说话者不置 speechSeen 但 audible，
      // 不该在 6 秒被掐掉；全程真正无声才收回麦克风。
      if (!vad.audible && elapsedMs.value >= VAD_NO_SPEECH_MS) {
        error.value = '没有听到声音';
        options.onError?.(error.value);
        invalidate();
        return;
      }
      if (elapsedMs.value >= MAX_RECORD_MS) {
        void stop();
      }
    }, 100);
  }

  /** 结束录音并识别；识别结果通过 options.onText 回给调用方 */
  async function stop(): Promise<void> {
    if (!recording.value) {
      if (pending.value) invalidate();
      return;
    }
    const generation = operationGeneration;
    const duration = performance.now() - startedAt;
    const rate = contextRate;
    recording.value = false;
    release();
    elapsedMs.value = 0;

    if (duration < MIN_RECORD_MS) {
      error.value = '录音太短';
      options.onError?.(error.value);
      return;
    }
    const pcm = concat(chunks);
    chunks = [];
    if (!pcm.length) {
      error.value = '没有采到声音';
      options.onError?.(error.value);
      return;
    }

    const requestController = new AbortController();
    recognitionController = requestController;
    busy.value = true;
    try {
      const wav = encodeWav(resample(pcm, rate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
      const result = await recognizeSpeech(wav, requestController.signal);
      if (disposed || generation !== operationGeneration || requestController.signal.aborted) return;
      const text = result.text.trim();
      if (!text) {
        error.value = '没有听清，请再说一次';
        options.onError?.(error.value);
        return;
      }
      error.value = '';
      options.onText?.(text);
    } catch (e) {
      if (disposed || generation !== operationGeneration || requestController.signal.aborted) return;
      error.value = e instanceof Error ? e.message : '识别失败';
      options.onError?.(error.value);
    } finally {
      if (recognitionController === requestController) recognitionController = null;
      if (!disposed && generation === operationGeneration) {
        busy.value = false;
        elapsedMs.value = 0;
      }
    }
  }

  /** 丢弃这段录音（录音中点「取消」） */
  function cancel(): void {
    if (!recording.value && !pending.value && !busy.value) return;
    invalidate();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    invalidate();
  }

  if (getCurrentInstance()) onUnmounted(dispose);

  return { supported, recording, pending, busy, elapsedMs, speechDetected, error, start, stop, cancel, dispose };
}
