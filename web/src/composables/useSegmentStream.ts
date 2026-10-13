import { recognizeSpeech, SEGMENT_RECOGNITION_TIMEOUT_MS } from '../api';
import { concat, encodeWav, joinPartials, resample, TARGET_SAMPLE_RATE } from './audioPcm';

/**
 * 常开聆听的**分段识别管线**：把说话过程中的 PCM 按切片送 ASR，把回文本拼成预览。
 *
 * <p>从 `useDictation` 里整块抽出来的理由（§5 S14）：那边已经 790 行、43 个模块级绑定，
 * 两个模式（点按 / 常开）与分段管线纠缠在一起，而第 3 档的 P2/P3 还要继续往上加。
 * 抽出来之后这一层的职责只有一条：**「什么时候切一段、要不要发、发了怎么作废」**。
 * 采集、VAD、整段识别仍留在 `useDictation`——它们才是「谁在听」的判决方。
 *
 * <p>三条边界（越界就不该改在这里）：
 * - 它**不碰麦克风、不碰 VAD**：每块只收「PCM + 这一块算不算人声」两个入参；
 * - 它**不决定句子何时结束**：切片只活在调用方划定的「一句」里，`rotate()` 一叫就整批作废；
 * - 它**不提交任何东西**：预览只是给人看的，终稿永远走整段识别。
 */

/**
 * 常开聆听下送去分段识别的切片长度。
 *
 * <p>2 秒 16kHz/单声道/16bit = 64KB，远小于 `/api/speech/*` 的 2MB 体积闸门；
 * 再短会让切片落在词中间（识别质量跳水），再长则「边说话边出字」的体感就没了。
 */
export const SEGMENT_MS = 2_000;

/**
 * **首段**的门槛，比后续段长。
 *
 * <p>短句是这里最大的浪费来源（§5 S5）：`SEGMENT_MS` 是从**起句**开始算的，而静音尾巴也算在里面
 * ——一句 1.5 秒的话，到 t≈2.05s 就攒满 2 秒发出去了（含 0.55 秒静音），而 VAD 在 t≈2.5s 就收尾。
 * 于是预览与终稿几乎同时落地：白花一次 ASR 调用，输入框还闪一下。
 * 把首段门槛抬到 2.8s，1.5 秒的短句就整段走终稿，一次调用都不多花。
 */
export const SEGMENT_FIRST_MS = 2_800;

/**
 * 一片里**真正在说话的音频**占比的下限：不够就先不发。
 *
 * <p>首段门槛管的是「短句」，这条管的是「一片里大半是停顿」——磕磕巴巴、说一句停一下的人，
 * 切下来的那一片送去识别只能换回几个字，而它要等的那句终稿马上就到。达不到就先不发，
 * 把样本留着与下一片合并（`nextAt` 往后顺延一片，见 {@link useSegmentStream}）。
 *
 * <p>**分子是「越过当前说话阈值」的音频，不是「有动静」**：`VAD_SILENCE_RMS`（0.01）在真实展厅里
 * 几乎每块都过（空调底噪就在 0.012 一档），按它算占比恒等于 1，这条过滤等于没写。用 VAD 那个
 * 自适应阈值问的才是同一件事：这一片里有多少是**它在当人声听**的音频。
 *
 * <p>**分母是这一片的全部音频**（占比而不是时长）：块长按设备在 85ms~256ms 之间浮动，
 * 而 VAD 的收尾条件是「连静 1 秒」——磕巴的人一片里的语音量正比于块长（256ms 块约 0.27，
 * 85ms 块约 0.09），固定的毫秒门槛会把两种设备判成两种口径，占比才能把它们摆到同一把尺上。
 * 取 0.4：正常说话在 0.5~0.7，两类设备的磕巴者都在 0.3 以下，中间留得开。导出供现场调参。
 */
export const SEGMENT_MIN_SPEECH_RATIO = 0.4;

/**
 * 同时在途的分段识别请求上限。
 *
 * <p>超了**直接丢这一段**而不是排队：识别是给参观者看的预览，攒着不放只会让文字越落越远，
 * 还会把 ASR 配额吃光（丢了多少由 `segmentDropped` 计数上报）。
 */
export const MAX_SEGMENT_INFLIGHT = 2;

/**
 * 分段管线的遥测事件：调用、失败、丢弃。键与后端白名单一一对应。
 *
 * <p>`audioMs` 是这一段的**音频时长**（§5 S8）：ASR 多按音频秒计费，只报次数算不出成本。
 * 失败也带着它——那一段确实打出去了，只是没成功。
 */
export type SegmentMetric =
  | { kind: 'segment'; latencyMs: number; audioMs: number }
  | { kind: 'segmentFailure'; audioMs: number }
  | { kind: 'segmentDropped' };

export type SegmentStreamOptions = {
  /** 分段管线是否在跑（仅常开聆听）：关掉时 `feed` 不累积任何东西 */
  enabled: () => boolean;
  /** 采集侧的真实采样率（浏览器常锁 44.1/48kHz）：切片门槛按它折算，编码前再重采样到 16k */
  sampleRate: () => number;
  /**
   * 采集侧的操作代号（`useDictation` 的 operationGeneration）。
   *
   * <p>抑制、取消、卸载都会让它变——**只要它变了，在途请求的返回值就一律作废**，
   * 否则回答播报期间会有一条两秒前的文字窜进输入框。
   */
  generation: () => number;
  /** 预览文本（null = 这份预览作废，调用方该清掉它） */
  onPartial?: (text: string | null) => void;
  onMetrics?: (event: SegmentMetric) => void;
};

export function useSegmentStream(options: SegmentStreamOptions) {
  /** 当前语句号：换号即作废在途分段的返回值（迟到的 partial 不该改输入框） */
  let utteranceId = 0;
  /** 本句已成功识别的分段文本，按序拼成预览 */
  let parts: string[] = [];
  let chunks: Float32Array[] = [];
  let samples = 0;
  /** 本片里「越过说话阈值」的样本数，{@link SEGMENT_MIN_SPEECH_RATIO} 这条判据用它 */
  let speechSamples = 0;
  /** 下一次切片的样本数门槛：首段是 SEGMENT_FIRST_MS，之后每片是 SEGMENT_MS */
  let nextAt = 0;
  let inflight = 0;
  const controllers = new Set<AbortController>();

  function sliceSamples(): number {
    return Math.round((SEGMENT_MS / 1000) * options.sampleRate());
  }

  function clearSlice(): void {
    chunks = [];
    samples = 0;
    speechSamples = 0;
  }

  /** 把在途的分段识别请求全部取消（抑制、取消、卸载时用；它们的文字已经没有去处了） */
  function abort(): void {
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {
        // 已经 abort 过：忽略
      }
    }
  }

  /**
   * 换一句话：作废在途返回、清空预览与缓冲。
   *
   * <p>顺带把「同时在途至多 2 段」的槽位立刻放出来——不 abort 的话，上一句的请求还占着名额，
   * 下一句的第一个切片会被误判为超限而丢弃。
   */
  function rotate(): void {
    utteranceId += 1;
    parts = [];
    clearSlice();
    abort();
    nextAt = Math.round((SEGMENT_FIRST_MS / 1000) * options.sampleRate());
  }

  /** 当前语句号（调用方在别处记时间戳/做判决时可能要对上它） */
  function statement(): number {
    return utteranceId;
  }

  /**
   * 喂一块 PCM。`speech` 由调用方按 VAD 的口径判定（这一块**越过了当前的说话阈值**）。
   *
   * <p>攒够门槛就切一片出去；语音不够就**不发也不丢**，把门槛往后顺延一片——
   * 那多半是切点落进了停顿里，等这句话收尾走终稿比现在硬发一段更省也更准。
   */
  function feed(chunk: Float32Array, speech: boolean): void {
    if (!options.enabled()) return;
    if (!nextAt) nextAt = Math.round((SEGMENT_FIRST_MS / 1000) * options.sampleRate());
    chunks.push(chunk);
    samples += chunk.length;
    if (speech) speechSamples += chunk.length;
    if (samples < nextAt) return;
    const rate = options.sampleRate();
    if (speechSamples < samples * SEGMENT_MIN_SPEECH_RATIO) {
      nextAt = samples + sliceSamples();
      return;
    }
    const pcm = concat(chunks);
    clearSlice();
    nextAt = sliceSamples();
    void send(pcm, (pcm.length / rate) * 1000, utteranceId);
  }

  /**
   * 送一段去识别，成功就把文本拼进预览。
   *
   * <p>过期判定用「generation + 语句号」两道：抑制、取消、换句都会换号，
   * 迟到的返回值一律丢弃。
   */
  async function send(pcm: Float32Array, audioMs: number, owner: number): Promise<void> {
    if (inflight >= MAX_SEGMENT_INFLIGHT) {
      options.onMetrics?.({ kind: 'segmentDropped' });
      return;
    }
    const generation = options.generation();
    const rate = options.sampleRate();
    const controller = new AbortController();
    controllers.add(controller);
    inflight += 1;
    const sentAt = performance.now();
    try {
      const wav = encodeWav(resample(pcm, rate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
      const result = await recognizeSpeech(wav, controller.signal, SEGMENT_RECOGNITION_TIMEOUT_MS);
      if (stale(generation, owner)) return;
      options.onMetrics?.({ kind: 'segment', latencyMs: performance.now() - sentAt, audioMs });
      const text = result.text.trim();
      if (!text) return;
      parts.push(text);
      options.onPartial?.(joinPartials(parts));
    } catch {
      if (stale(generation, owner)) return;
      // 分段失败**静默**：终稿还在后面，为一段预览去刷「没有听清」只会吓到参观者。
      // 失败率照样上报，运营在面板上看得到（429/超时/网络都算这里）。
      options.onMetrics?.({ kind: 'segmentFailure', audioMs });
    } finally {
      inflight -= 1;
      controllers.delete(controller);
    }
  }

  /** 这一批返回值还算不算数：代号变了（抑制/取消/卸载）或已经换句，就整批丢掉 */
  function stale(generation: number, owner: number): boolean {
    return generation !== options.generation() || owner !== utteranceId;
  }

  return { feed, rotate, abort, statement };
}
