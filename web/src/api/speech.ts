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
 *
 * <p>**它必须长于服务端一次合成的总预算**（`AUDIO_TIMEOUT_MS`，缺省 15s，含全部重试）：
 * 那条同步调用不会因为浏览器 abort 而中断上游请求，客户端先放弃就只是让服务端白跑一趟，
 * 而且会把一次本可以成功的重试判成失败（`useSpeech` 会就此降级到浏览器合成）。
 */
export const SYNTH_TIMEOUT_MS = 20_000;
/**
 * 整段识别的等待上限：要等一次 20 秒录音的上传 + 上游出字 + 可能的服务端重试。
 *
 * <p>服务端一次识别的总预算是 `AUDIO_ASR_TIMEOUT_MS`（缺省 30s，含全部重试），比它短得多。
 */
export const RECOGNITION_TIMEOUT_MS = 90_000;
/**
 * 常开聆听下**分段识别**的等待上限。
 *
 * <p>整段识别给 90s 是因为要等一次 20 秒录音的上传 + 上游出字；分段只有 2 秒音频，
 * 沿用 90s 会让「同时在途至多 2 段」的闸门卡死十几秒（表现为文字迟迟不出、后面的段全被丢弃）。
 *
 * <p>它比服务端那 30s 预算**短**，是有意的：分段只是预览，参观者等不到就先不要它，
 * 让槽位立刻空出来给后面的段；服务端那侧的花费被它自己的预算封顶（不会再出现
 * 「客户端 15s 放弃、服务端重试到三分钟」）。
 */
export const SEGMENT_RECOGNITION_TIMEOUT_MS = 15_000;

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

/**
 * 语音转文本：16bit PCM 的 WAV 整体 POST（接口只收 wav/mp3，见后端 SpeechParser）。
 *
 * <p>timeoutMs 给常开聆听的分段识别留了口子（见 {@link SEGMENT_RECOGNITION_TIMEOUT_MS}）：
 * 整段录音与 2 秒切片对「等多久算失败」的答案不一样。
 */
export async function recognizeSpeech(
  wav: Blob,
  signal?: AbortSignal,
  timeoutMs = RECOGNITION_TIMEOUT_MS,
): Promise<RecognitionResult> {
  const timeout = requestTimeout(signal, timeoutMs);
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

/**
 * 声学遥测上报（`POST /api/speech/metrics`）：本地累加的**增量计数**批量送出。
 *
 * <p>三条与其它接口不同的取舍：
 * - **不带口令**：面板没打开时数据同样要落库，走 `adminRequest` 会把统计变成「只在有人看时才准」；
 * - **不重试、不抛**：写的是运营计数，丢一批只是少几个样本，而调用点（定时器/卸载）没有地方呈现错误；
 * - **keepalive**：卸载或切到后台时那一批必须发得出去，否则「关页面」这类现场动作永远缺最后一笔。
 */
export async function sendSpeechMetrics(deltas: Record<string, number>): Promise<void> {
  const res = await fetch(apiUrl('/api/speech/metrics'), {
    method: 'POST',
    headers: json,
    body: JSON.stringify(deltas),
    keepalive: true,
  });
  // 非 2xx 要**抛**：这个接口对未知键与越界值是整批 400，只看 fetch 是否 resolve 会把
  // 「这批数据被拒了」当成「上报成功」——表现是运营面板上那几行永远不动，且毫无线索。
  if (!res.ok) throw new Error(`speech metrics ${res.status}`);
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
