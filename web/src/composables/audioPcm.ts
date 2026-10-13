/**
 * 采集与编码用的 PCM 原语：采样率、均方根、重采样、WAV 打包、分段预览的拼接。
 *
 * <p>为什么单独成文件而不是留在 `useDictation` 里：分段管线（`useSegmentStream`）要复用它们，
 * 而 `useDictation` 又要用分段管线——放在同一文件里就成了一条运行时循环依赖。
 * 这里只有纯函数与常量，谁都可以单向引用它。
 *
 * <p>采集与编码全在前端做，理由有三个：
 * 1) **接口只收 wav/mp3**：MediaRecorder 在 Chrome 默认吐 webm/opus，直接被 ASR 拒；
 *    自己用 AudioContext 采 PCM 再拼 WAV 头，格式完全可控，还省一个转码依赖。
 * 2) **体积**：48kHz 原始 PCM 一秒就近 100KB，20 秒录音会顶到上传上限；降到 16kHz 后
 *    一秒 32KB，两秒都不到 64KB——展厅的短问答这个码率足够识别。
 * 3) **可控**：掐头去尾、时长上限、静音判定都在本地，不必把整段录音先传上去再让服务端挑。
 */

/** 送给识别接口的目标采样率：16kHz 单声道 16bit ≈ 32KB/s */
export const TARGET_SAMPLE_RATE = 16_000;

/** 单个 PCM 块的均方根。全零返回 0；空块不参与判定（除零保护） */
export function chunkRms(chunk: Float32Array): number {
  if (!chunk.length) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
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

/** 按顺序把若干块 PCM 接成一段（切片与终稿都要用；纯函数） */
export function concat(chunks: Float32Array[]): Float32Array {
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

/** 拉丁字母/数字：与中文相邻时要不要补空格就看它 */
const LATIN_CHAR = /[0-9A-Za-z]/;

/**
 * 拼接分段识别的预览文本（纯函数，便于单测）。
 *
 * <p>**只在需要的地方补一个空格**：两段中文之间加空格会把「叶片有 裂纹」这种读起来发涩的文本
 * 摆到参观者面前，而两段拉丁文本不加空格会直接连成一个词（`machine` + `Please` → `machinePlease`）。
 * 判据是「边界两侧只要有一侧是拉丁字母/数字就补空格」，纯中文边界与带标点的边界都不动。
 */
export function joinPartials(parts: string[]): string {
  let out = '';
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (out && needsSpace(out[out.length - 1], part[0])) out += ' ';
    out += part;
  }
  return out;
}

/** 边界补空格判据：两侧都非空白，且至少一侧是拉丁字母/数字 */
function needsSpace(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  if (/\s/.test(prev) || /\s/.test(next)) return false;
  return LATIN_CHAR.test(prev) || LATIN_CHAR.test(next);
}
