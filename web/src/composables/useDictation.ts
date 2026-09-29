import { getCurrentInstance, onUnmounted, ref } from 'vue';
import { recognizeSpeech } from '../api';

/**
 * 语音提问：按住/点一下说话，松开/再点即识别成文字。
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
  /** 最近一次失败原因（空串 = 没失败过） */
  const error = ref('');

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let chunks: Float32Array[] = [];
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
    chunks = [];
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
      processor.onaudioprocess = (event) => {
        if (disposed || generation !== operationGeneration || !recording.value) return;
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
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
    startedAt = performance.now();
    elapsedMs.value = 0;
    ticker = window.setInterval(() => {
      if (disposed || generation !== operationGeneration) {
        release();
        return;
      }
      elapsedMs.value = performance.now() - startedAt;
      if (elapsedMs.value >= MAX_RECORD_MS) void stop();
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

  return { supported, recording, pending, busy, elapsedMs, error, start, stop, cancel, dispose };
}
