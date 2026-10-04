/**
 * 语音端点：TTS（/api/speech/synthesize）与 ASR（/api/speech/recognize）。
 *
 * 超时壳与错误翻译复用 http.ts：合成 20s（按句切片后正常 1~3s 回来）、识别 90s（整段上传）。
 */

import { apiUrl, awaitWithAbort, json, requestTimeout, safeError, streamAbortError } from './http';

/**
 * 单段合成的等待上限。
 *
 * <p>没有它的话，一次卡住的请求会让播报循环永久停在 await 上（speaking 一直为 true、
 * 页面上「停读」不消失）。按句切片后正常在 1~3 秒内回来，20 秒是给网络抖动留的余量。
 */
export const SYNTH_TIMEOUT_MS = 20_000;
export const RECOGNITION_TIMEOUT_MS = 90_000;

/**
 * 文本转语音：后端回 WAV 字节流，前端拿到就能塞进 Audio 播。
 *
 * <p>两种失败在语义上都不是「重试一下就好」：503（speech_unavailable）= 服务端没开语音，
 * 502（speech_failed）= 上游网关挂了。调用方（useSpeech）一律当场降级到浏览器内置播报。
 */
export async function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<Blob> {
  const timeout = requestTimeout(signal, SYNTH_TIMEOUT_MS);
  try {
    const res = await awaitWithAbort(
      fetch(apiUrl('/api/speech/synthesize'), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ text }),
        signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
    return await awaitWithAbort(res.blob(), timeout.signal);
  } finally {
    timeout.cleanup();
  }
}

export interface RecognitionResult {
  text: string;
  /** 音频时长（秒）：用来判断「说了话」还是「录到了一片静音」 */
  seconds: number;
  elapsedMs?: number;
}

/** 语音转文本：16bit PCM 的 WAV 整体 POST（接口只收 wav/mp3，见后端 SpeechParser） */
export async function recognizeSpeech(wav: Blob, signal?: AbortSignal): Promise<RecognitionResult> {
  const timeout = requestTimeout(signal, RECOGNITION_TIMEOUT_MS);
  try {
    const audio = await blobToDataUrl(wav, timeout.signal);
    const res = await awaitWithAbort(
      fetch(apiUrl('/api/speech/recognize'), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ audio }),
        signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
    return (await awaitWithAbort(res.json(), timeout.signal)) as RecognitionResult;
  } finally {
    timeout.cleanup();
  }
}

/** Blob → data URL：交给 FileReader（原生实现），不用 btoa 拼字符串，避免大录音上爆栈 */
function blobToDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(streamAbortError(signal));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      reader.abort();
      cleanup();
      reject(streamAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error('录音读取失败'));
    };
    reader.onabort = () => {
      cleanup();
      reject(streamAbortError(signal));
    };
    reader.readAsDataURL(blob);
  });
}
