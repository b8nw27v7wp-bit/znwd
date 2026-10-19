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
 * 4) **判决与上传分流**：VAD 与插话判决一律吃**原始** PCM，只有送 ASR 的那一份经过语音增强
 *    （{@link enhanceForUpload}：高通 + 增益归一化）。增强一旦回灌进判决路径，就会重新制造
 *    「轻声参观者被压没、面板上还看不出阈值出过问题」那个静默故障——两条路各有各的口径。
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

// ---- 送 ASR 前的语音增强（只走上传路径）----
//
// 这一节里没有一个函数参与「谁在听」的判决：它们只回答「送上去的那份音频长什么样」。
// 现阶段做的是两件**不改变语义**的事——压掉 100Hz 以下的房间噪声，把语音段电平拉齐到
// 识别习惯的档位。滤波与增益都不发明信息，所以不会像降噪那样把轻声说话者从判据里抹掉；
// 真要上模型级降噪（RNNoise 一类），也必须接在这里，而不是接在 VAD 之前。

/**
 * 高通的截止频率。
 *
 * <p>100Hz 以下几乎没有语音能量，而空调风噪、桌面震动、电源哼声恰好都在这一段——
 * 它们对识别是纯噪声，却会同时抬高底噪估计与绝对 RMS（展厅现场把 `VAD_SPEECH_RMS`
 * 往上调，有一半就是在跟这段能量较劲）。压掉它，是人声增强里唯一稳赚不赔的一步。
 */
export const ENHANCE_HIGHPASS_HZ = 100;

/** 二阶高通的 Q：1/√2 是 Butterworth（通带最平，没有峰起） */
const BUTTERWORTH_Q = Math.SQRT1_2;

/**
 * 二阶高通（RBJ Cookbook 的双线性变换）。纯函数，长度不变。
 *
 * <p>用双二阶而不是一阶 RC：一阶只有 -6dB/oct，同样 100Hz 截止时 50Hz 电源哼声才压 6dB；
 * 双二阶在 50Hz 上大约压 16dB，而 300Hz 以上的人声几乎不动。
 *
 * <p>参数非法（采样率为 0、截止频率不在 (0, 奈奎斯特) 内）时**原样返回同一个数组**：
 * 这一层是「锦上添花」，任何情况下都不该让一次录音因为它变成一个异常。
 */
export function highPass(
  input: Float32Array,
  sampleRate: number,
  cutoffHz = ENHANCE_HIGHPASS_HZ,
): Float32Array {
  if (!input.length || sampleRate <= 0 || cutoffHz <= 0 || cutoffHz >= sampleRate / 2) return input;
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q);
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** 增益归一化的帧长：20ms 够短到跟得上一句话里的强弱起伏，又长到帧内 RMS 稳定 */
export const ENHANCE_FRAME_MS = 20;

/**
 * 算「语音段」电平时用的帧级 RMS 下限。
 *
 * <p>与 `useDictation` 的 `VAD_SPEECH_RMS` 同量级，但**刻意各管各的**：这个常量只决定
 * 「哪些帧参与电平统计」，改它不会改变谁被当成说话；反过来现场调 VAD 阈值也不该顺手改变
 * 上传音频的音量。两个数绑在一起的话，现场每调一次灵敏度，送上去的音频电平就跟着变一次。
 */
export const ENHANCE_SPEECH_RMS = 0.02;

/**
 * 语音段的目标电平（约 -20dBFS）：识别对电平敏感，同一个展厅里轻声与正常说话不该差一个数量级。
 *
 * <p>它和 {@link ENHANCE_SPEECH_RMS} 一起决定了增益的天然上限：参与统计的帧至少是说话阈值的
 * 电平，所以增益最多 `目标 ÷ 语音帧地板` = 5 倍（14dB）。再往上没有意义——那种电平的音频
 * 本来就是判据眼中的「没人在说话」。
 */
export const ENHANCE_TARGET_RMS = 0.1;

/** 缩放后的峰值上限：给 int16 量化留余量。增益贴着它走，而不是先放大再削顶 */
export const ENHANCE_PEAK_CEILING = 0.99;

/**
 * 这份音频该乘多少倍：**只抬不削**，返回 1 到「目标电平 ÷ 语音帧地板」之间的值（当前 ≤5）。
 *
 * <p>判据是「语音段的 RMS 离目标电平差多少」，而不是整段的 RMS：整段里含着停顿与底噪，
 * 一段「说三秒停两秒」的录音按整段算会算出偏小的增益，越安静的人越吃亏——那是反的。
 *
 * <p>三条边界都是**有意保守**的：
 * - 已经够响（增益 ≤ 1）就原样不动，不做衰减——衰减会把正常说话的人压到不该有的电平上，
 *   而识别对「偏响」的容忍度远高于「偏轻」；
 * - 整段没有一帧够得上语音（全是底噪、或者压根是静音）时返回 1：这类录音不该被
 *   「增强」成一片响亮的噪声，它的归宿是前端那条「空识别」路径；
 * - 增益还被峰值余量压一次（`ENHANCE_PEAK_CEILING / 峰值`），宁可不拉满也不削顶。
 */
export function speechGain(input: Float32Array, sampleRate: number): number {
  if (!input.length || sampleRate <= 0) return 1;
  const frame = Math.max(1, Math.round((ENHANCE_FRAME_MS / 1000) * sampleRate));
  let speechSquares = 0;
  let speechSamples = 0;
  let peak = 0;
  for (let start = 0; start < input.length; start += frame) {
    const end = Math.min(start + frame, input.length);
    let squares = 0;
    for (let i = start; i < end; i++) {
      const value = input[i];
      squares += value * value;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
    }
    const count = end - start;
    if (Math.sqrt(squares / count) >= ENHANCE_SPEECH_RMS) {
      speechSquares += squares;
      speechSamples += count;
    }
  }
  if (!speechSamples || peak <= 0) return 1;
  const speechRms = Math.sqrt(speechSquares / speechSamples);
  const gain = ENHANCE_TARGET_RMS / speechRms;
  if (gain <= 1) return 1;
  const roomToFullScale = ENHANCE_PEAK_CEILING / peak;
  const limited = Math.min(gain, roomToFullScale);
  return limited < 1 ? 1 : limited;
}

/** 按增益缩放一份新数组（纯函数）。增益 ≤ 1 或非正值时原样返回，不复制、也不衰减 */
export function applyGain(input: Float32Array, gain: number): Float32Array {
  if (!(gain > 1)) return input;
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] * gain;
  return out;
}

/**
 * **上传路径**的统一入口：一段采集速率的原始 PCM → 高通 → 重采样到 16k → 增益归一化。
 *
 * <p>终稿与分段切片都从这里出，理由是一条：两条路上送出去的音频必须是**同一种东西**，
 * 否则「同样的声音，预览识别得出来、终稿识别不出来」这种问题永远说不清是数据的锅还是模型的锅。
 *
 * <p>调用点只有两处（`useDictation.recognizeFinal`、`useSegmentStream.send`），都在
 * `encodeWav` 之前；采集侧那个 `ScriptProcessor` 回调一个字段都不改——热路径上只多了一层
 * 纯函数调用，VAD 与回声观察看到的仍是麦克风原始数据。
 */
export function enhanceForUpload(pcm: Float32Array, captureRate: number): Float32Array {
  const filtered = highPass(pcm, captureRate);
  const out = resample(filtered, captureRate, TARGET_SAMPLE_RATE);
  return applyGain(out, speechGain(out, TARGET_SAMPLE_RATE));
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
