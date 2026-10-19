import { computed, getCurrentInstance, onUnmounted, ref } from 'vue';
import { recognizeSpeech } from '../api';
import { chunkRms, concat, encodeWav, enhanceForUpload, TARGET_SAMPLE_RATE } from './audioPcm';
import { useSegmentStream, type SegmentMetric } from './useSegmentStream';

/**
 * 语音提问。两种模式共用同一套采集与 VAD，差别只在「麦克风什么时候开着」：
 *
 * - **点按模式**（旧行为，一字未改）：点一下开麦 → VAD 检出人声后停顿 VAD_SILENCE_MS 自动结束 →
 *   识别 → 收麦。麦克风只在录音期间开着。
 * - **常开聆听**（`arm()` 后进入）：麦克风与 AudioContext 常驻，说话即开始一句、
 *   停顿即收尾；说话过程中每 SEGMENT_MS 切一段送识别，文字边出边显示（`onPartial`），
 *   终稿仍然走整段识别（`onText`）。
 *
 * 采集与编码全在前端做，理由见 `audioPcm.ts`；分段识别管线本身在 `useSegmentStream`，
 * 这里只负责「谁在听、什么时候算一句话说完了」。
 *
 * 采集节点用已废弃的 ScriptProcessorNode 而不是 AudioWorklet：后者要求单独一个模块文件
 * 并走 addModule 异步加载，为一次录音引入这套构建配置不划算；前者的替代品至今没有全量落地。
 *
 * **两条路不要混**：判决路径（VAD、插话、回声观察）吃的始终是麦克风原始 PCM，而上传路径
 * （终稿与分段切片）在 `encodeWav` 之前过一遍 `enhanceForUpload`（高通 + 增益归一化）——
 * 增强一旦回灌进判据，就会重现「轻声参观者被压没、面板上还看不出」的静默故障（见 audioPcm）。
 */

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
/** 开麦后一直没动静的放弃时长：没人说话就收回麦克风，而不是一直挂着（**只在点按模式生效**） */
export const VAD_NO_SPEECH_MS = 6_000;

// ---- 底噪自适应（§5 S1）----

/**
 * 底噪估计的滑动 EMA 速率（按块，16kHz/4096 帧下约 4 块/秒）。
 *
 * <p>**慢升快降**：偶发的一声关门很快被忘掉，持续存在的环境底噪才会把估计抬上去。
 * 时间常数 ≈ 50 块（约 13s）与 10 块（约 2.5s）——展厅里说话与静默交替出现，
 * 上升慢一点，句间那一秒的安静就不会把估计打回零点。导出供展厅现场调参。
 */
export const NOISE_EMA_RISE = 0.02;
export const NOISE_EMA_FALL = 0.1;

/**
 * 自适应说话阈值 = `max(常量地板, 底噪估计 × 这个系数)`，再封顶到 {@link VAD_ADAPT_MAX_RMS}。
 *
 * <p>为什么要 `max(常量, …)` 而不是直接换成自适应：常量是**安静展厅的正确答案**，
 * 而在安静环境里 EMA 一直贴着 0，自适应不该把阈值压到常量以下（那会开始误触发）。
 *
 * <p>**系数与上限必须一起看，而且宁可「吵」也不能「聋」。** EMA 在稳态底噪下收敛到**底噪本身**，
 * 于是阈值最终落在 `系数 × 底噪` 上：系数取 3 时，底噪 0.02 的展厅阈值就是 0.06、
 * 0.027 以上直接顶到上限 0.08——而人声（含轻声）就在 0.03~0.15 这一档，结果是**参观者说什么都
 * 起不了句**（表现成「麦克风没反应」，且底噪上报样本同时掉到 0，运营看不出阈值已经顶死）。
 * 现在取 1.5 与 0.04（= 常量地板的 2 倍，即正常说话的**下限**）：底噪 0.02 时阈值 0.03，
 * 底噪再高也就停在 0.04，参观者正常说话一定进得来。
 *
 * <p>代价是「底噪高于上限」的极端展厅会持续误触发（`falseTriggers` 在面板上一直涨）——
 * 这是**有意的取舍**：误触发看得见、参观者照样能问；聋是静默的，而且会被当成机器坏了。
 * 真到了那一步该做的是换机位/加吸音，而不是把阈值抬到听不见人。
 * 导出供展厅现场调参（P1 出口物「参数定稿」就是定这几个数）。
 */
export const VAD_ADAPT_FACTOR = 1.5;
export const VAD_ADAPT_MAX_RMS = 0.04;

/**
 * 疑似漏断的判定窗口（§5 S3）：自动收尾后这个时长内又起了一句，才可能算一次漏断。
 *
 * <p>**它只是三个条件里的一个**：光看时间会把「主动插话」和「噪声误触发」都记成漏断
 * （前者与静音阈值无关，后者的上一句根本没有文字），两个都会把漏断率抬到失真。
 * 完整判据见 {@link useDictation} 里的 `autoEndPending`。
 */
export const TRUNCATION_WINDOW_MS = 1_500;

// ---- 插话打断（P3a）----

/**
 * 判为插话需要**持续**超过这个时长的越限声音。
 *
 * <p>单个块的一记爆音（关门、话筒被碰）与真人说话的区别不在峰值而在持续：
 * 说话会连着好几个块都越限，爆音只有一个。导出供展厅现场调参。
 *
 * <p>**只看时长是不够的**：块长按设备在 85ms~256ms 之间（浏览器常锁 16k/44.1k/48kHz，
 * 而 ScriptProcessor 固定 4096 帧），256ms 的设备上一块就越过 120ms——判据直接退化成峰值检测，
 * 一记爆音就能把回答掐掉。所以另加 {@link BARGEIN_MIN_BLOCKS} 一起卡。
 */
export const BARGEIN_HOLD_MS = 120;
/**
 * 判为插话至少需要的**连续越限块数**。
 *
 * <p>与 {@link BARGEIN_HOLD_MS} 取严（两个都得满足）：在 85ms 块的快采样率设备上，
 * 2 块 = 170ms 仍然只是「一小声」；在 256ms 块的设备上，2 块 = 512ms，真人插话（「等一下」）
 * 本来就比这长，而关门/碰话筒只占一块。这样两种设备上的实际判据强度才对得上。
 */
export const BARGEIN_MIN_BLOCKS = 2;
/**
 * 插话门限相对当前说话阈值的倍数。
 *
 * <p>播报期间麦克风里本来就有自己的喇叭声（AEC 之后还剩多少，由 P3a-1 的 `echo*` 计数回答）。
 * 门限抬到两倍是「先按保守值落地、等现场数据再定」的默认——判据本身必须由现场数据定，
 * 所以这个开关默认**关**（运营在 ?admin=1 里打开后才判决，见 App 的 bargeInOn）。
 *
 * <p>它跟 {@link VAD_ADAPT_MAX_RMS} 联动：阈值上限 0.04 → 插话门限最高 0.08，
 * 还在「贴着话筒正常说话」的量级里，不会因为展厅吵就让打断失效。
 */
export const BARGEIN_FACTOR = 2;
/** 越限块最多回灌多少毫秒：只用来接住插话开头被削掉的那半个字，不该攒成一段长录音 */
export const BARGEIN_PREROLL_MS = 400;

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

/**
 * VAD 状态推进（纯函数，便于单测）。chunkMs = 本块时长，由调用方按真实采样率算。
 *
 * - RMS ≥ 说话阈值：置 speechSeen/audible 并清零静音时长（一句话重新开始算）；
 * - 其余（含两阈值之间的滞回带）：按 chunkMs 累计静音——**带内也算静音**：
 *   停在带内的环境音若只「保持状态」，静音时长会被冻结、永远凑不满收尾条件，
 *   录音只能挂到 20s 上限；带内只防误触发说话（speechSeen 仍要求 ≥说话阈值），
 *   不再兼做「静音豁免」。audible 单独记录，保证轻声说话者不被无语音超时误杀。
 *
 * <p>`speechRms` 默认是常量地板，由调用方传入自适应后的值（§5 S1）——
 * 缺省值保证老调用点与老测试的口径一字不变。
 */
export function vadStep(
  state: VadState,
  rms: number,
  chunkMs: number,
  speechRms: number = VAD_SPEECH_RMS,
): VadState {
  if (rms >= speechRms) return { speechSeen: true, audible: true, silentMs: 0 };
  return {
    speechSeen: state.speechSeen,
    audible: state.audible || rms >= VAD_SILENCE_RMS,
    silentMs: state.silentMs + Math.max(0, chunkMs),
  };
}

/**
 * 一句语音的结束原因：停顿自动收尾 / 点按手动结束 / 撞上 MAX_RECORD_MS。
 *
 * <p>它只用于遥测：运营看「自动 / 手动 / 超时结束」的构成就知道现场的停顿阈值合不合适
 * （自动占绝大多数才是对的；超时结束多说明阈值太长或环境太吵）。
 */
export type DictationEndMode = 'auto' | 'manual' | 'max';

/**
 * 声学遥测事件：**只在前端看得见**的量。累计与上报见 `useAcoustics`。
 *
 * <p>事件与后端计数键一一对应（`end` 含三种结束原因，`segment` 与 `segmentFailure`
 * 各算一次调用），这样「计数涨了」和「现场发生了什么」能直接对上，不必再对一遍口径。
 *
 * <p>第 3 档 P2 起多出来的几组：
 * - `threshold`：**当前生效的**说话阈值（自适应之后的值，§5 S1）。没有它，运营只能看到底噪，
 *   看不到「底噪有没有真的参与判决」，那正是 S1 要修的那条；
 * - `final`：整段识别的三段延迟（说完→收尾判决→终稿文本）与音频时长（§5 S4/S8）；
 * - `truncationSuspected`：自动收尾后马上又起了一句，疑似被静音阈值截断（§5 S3）；
 * - `echo` / `bargeIn` / `bargeInRejected`：播报期间的回声采样与插话判决（P3a）。
 */
export type DictationMetric =
  | { kind: 'noise'; rms: number }
  | { kind: 'threshold'; rms: number }
  | { kind: 'end'; mode: DictationEndMode }
  | { kind: 'noSpeech' }
  | { kind: 'falseTrigger' }
  | { kind: 'truncationSuspected' }
  | { kind: 'suppressedAbandon' }
  | SegmentMetric
  | { kind: 'final'; endDelayMs: number; latencyMs: number; audioMs: number; serverMs: number }
  | { kind: 'echo'; rms: number; over: boolean; farOver: boolean }
  | { kind: 'bargeIn' }
  | { kind: 'bargeInRejected' };

export type DictationOptions = {
  /** 识别成功回文本（调用方决定是填进输入框还是直接提问） */
  onText?: (text: string) => void;
  /** 失败原因（麦克风被拒、识别失败）：运营视图用来解释「为什么按了没反应」 */
  onError?: (reason: string) => void;
  /**
   * 常开聆听的**预览**文本（分段识别的拼接结果）；null = 这段预览作废，调用方该清掉它。
   *
   * <p>预览永远不是终稿：`onText` 的整段识别结果才是，调用方要保证终稿覆盖预览。
   */
  onPartial?: (text: string | null) => void;
  /** 声学遥测事件（底噪、结束原因、分段成败）：接 `useAcoustics().record` */
  onMetrics?: (event: DictationMetric) => void;
  /**
   * 判出「参观者在插话」（P3a-2，仅在 `setBargeIn(true)` 之后）。
   *
   * <p>调用方在这里**停掉播报**：检测在采集侧、停播在播报侧，`useDictation` 够不到
   * `useSpeech`。本组件自己已经做过的事：解除抑制、把判成人声的那几块回灌成新的一句——
   * 所以回调回来时参观者说的那半句已经在录了。
   */
  onBargeIn?: () => void;
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

type InputBufferLike = { inputBuffer: { getChannelData: (channel: number) => Float32Array } };

/** 终稿的三段计时（§5 S4）与它归属的那一句（§5 S3 要对号入座） */
type FinalTiming = {
  statement: number;
  endedAt: number;
  voiceAt: number;
  audioMs: number;
  fromBargeIn: boolean;
  /**
   * 这一句是**聆听态**起的（结束后麦克风留着）还是点按起的。
   *
   * <p>带着走而不是在终稿落地时读 `alwaysOn`：终稿是排队回来的，中途运营可能已经拨过模式开关，
   * 那时读到的开关值与这一句的来源已经不是一回事了（归类会错，提示也会给错人）。
   */
  staysArmed: boolean;
};

export function useDictation(options: DictationOptions = {}) {
  const supported = dictationSupported();
  /** 正在录一句（capturing）：常开聆听下只有说话期间为 true */
  const recording = ref(false);
  const pending = ref(false);
  /** 正在识别（整段、终稿）：这期间按钮应该禁用，避免两次提问打架 */
  const busy = ref(false);
  /** 已录时长（毫秒）：按钮上显示，让说话的人知道还在录；常开聆听的聆听态下冻结为 0 */
  const elapsedMs = ref(0);
  /** 本轮是否已检出人声：区分「聆听中」与「说完了」两种文案，也参与无语音超时判定 */
  const speechDetected = ref(false);
  /** 最近一次失败原因（空串 = 没失败过） */
  const error = ref('');
  /**
   * 麦克风与采集链路是否已建立。
   *
   * <p>点按模式下只在录音期间为 true；常开聆听下它是**常态**——配合 `recording === false`
   * 就是「聆听中，可以直接说话」，按钮文案据此切换。
   */
  const armed = ref(false);
  /** 常开聆听是否开启（App 由存储键同步进来）；关闭时会顺手放开麦克风 */
  const alwaysOn = ref(false);
  /** 插话判决是否开启（P3a-2，App 由存储键同步）：**默认关**，先只量回声不判决（P3a-1） */
  const bargeIn = ref(false);

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

  /** 分段识别管线（切片、在途闸门、预览拼接、过期作废），常开聆听下才有东西喂给它 */
  const segments = useSegmentStream({
    enabled: () => alwaysOn.value,
    sampleRate: () => contextRate,
    generation: () => operationGeneration,
    onPartial: options.onPartial,
    onMetrics: (event: SegmentMetric) => metric(event),
  });

  /**
   * 底噪的滑动 EMA（§5 S1）。起手为 0（阈值等于常量地板），先按听来的数慢慢长上去。
   */
  let noiseEma = 0;
  /** 语句序号：每起一句加一，用来把「等待终稿的那句话」与别处的事件对上号 */
  let statementSeq = 0;
  /** 当前这一句的序号（endStatement 要带着它走完整段识别那条异步链） */
  let currentStatement = 0;
  /**
   * §5 S3 的待判定：这一句是**自动收尾**的，而它到底是「一句话被静音阈值截成两句」，
   * 还是「参观者说完就走」，两个条件都到齐了才判得准：
   *
   * <p>① 它的终稿回来了、而且**有文字**——回空的那次是环境噪声误触发（`falseTriggers` 那一类），
   * 上一句根本没有话可言，记成漏断会把嘈杂展厅的漏断率顶到接近 100%；
   * ② 1.5 秒（{@link TRUNCATION_WINDOW_MS}）内又起了一句，且那一句**不是插话**
   * ——插话是参观者主动打断，与静音阈值长短无关。
   *
   * <p>两个条件谁先到不一定（重启往往比终稿先到，但 ASR 快、参观者起句晚时反过来），
   * 所以两边都调 `settleTruncation()`，齐了才落账。
   */
  let autoEndPending: { statement: number; autoEndAt: number; restarted: boolean; hadText: boolean | null } | null = null;
  /** 最后一次「听到人声」的时刻：说完→终稿那一段延迟就从它开始算（§5 S4） */
  let lastVoiceAt = 0;
  /** 播报期间被判成「可能有人在说话」的块（P3a），判决通过后它们就是新一句的开头 */
  let bargeInRun: Array<{ chunk: Float32Array; rms: number }> = [];
  let bargeInRunMs = 0;
  /** 这一句是从插话开始的：整段识别回空时它另记一笔「判错了」 */
  let statementFromBargeIn = false;

  /** 整段识别的串行链：常开聆听下上一句的终稿还没回来时，下一句等它落地再发 */
  let finalChain: Promise<void> = Promise.resolve();
  /** 在途（含排队）的整段识别条数：`busy` 由它决定，不能按「单次调用结束」清 */
  let finalsInFlight = 0;
  /** 抑制中（播报/流式回答期间）：麦克风保持开着，但语句与分段全部冻结（P3a 之后回声照采） */
  let suppressed = false;
  /**
   * 这一句是怎么开始的：聆听态起句（常开）= 结束后保持麦克风；点按起句 = 结束后收麦。
   *
   * <p>必须记在**语句**上而不是读当下的 `alwaysOn`：运营把常开开关打开着、但自动 arm 被门禁
   * 挡住（`speechReady=false`）时，参观者手点一次麦克风走的是点按路径——若按开关判断，
   * 这一句结束就不收麦了，页面会在这台**没有语音服务**的机器上悄悄进入常开聆听，
   * 之后每一阵环境噪声都打一次 ASR 拿 503。
   */
  let statementStaysArmed = false;
  /**
   * 上一次已经报过的开麦失败原因，**只在自动 arm 那条路上去重**。
   *
   * <p>常开聆听在 arm 成功前**每次手势都会重试**（权限弹窗要靠用户激活），被拒的机器上
   * 就是每次点屏幕都失败一次——包括路过的人无意碰一下屏幕。同一条错反复往运营视图里灌，
   * 会把真正的故障挤出去（`chat.errors` 上限 20 条），所以同一个原因只报一次。
   *
   * <p>**点按路径不去重**（{@link start} 每次进来先清空它）：那一路每一次都是参观者主动点的，
   * 而失败原因现在同时驱动着输入区下方那句行动指引——去重会让第二次之后的点击**彻底静默**，
   * 正是「点了没反应、机器坏了」那个观感。清空的两处：成功开麦后（下次再失败照样报）、
   * 以及每次新的点按尝试。
   */
  let reportedMicError = '';

  function metric(event: DictationMetric): void {
    options.onMetrics?.(event);
  }

  function stopTracks(value: MediaStream | null): void {
    try {
      value?.getTracks().forEach((track) => track.stop());
    } catch {
      return;
    }
  }

  /** 放开麦克风与 AudioContext（点按模式的收尾、常开模式的 ops 关闭/卸载） */
  function releaseMic(): void {
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
    armed.value = false;
    const currentContext = context;
    context = null;
    try {
      const closing = currentContext?.close();
      if (closing) void Promise.resolve(closing).catch(() => {});
    } catch {
      // 已经关过：忽略
    }
  }

  /** 作废当前语句（在途分段的返回值据此整批丢弃）与它的分段缓冲 */
  function rotateUtterance(): void {
    segments.rotate();
    clearBargeInRun();
  }

  function clearBargeInRun(): void {
    bargeInRun = [];
    bargeInRunMs = 0;
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
    // 整个会话被重置（取消/关闭常开/卸载）：S3 的待判定也不能留，免得跟下一轮的句子对错号
    autoEndPending = null;
    rotateUtterance();
    recognitionController?.abort();
    recognitionController = null;
    releaseMic();
    // 半截预览不该留在输入框里：调用方按「草稿还是这份预览」决定要不要清空
    options.onPartial?.(null);
  }

  /**
   * 打开麦克风并接好采集链路（两个模式的公共前半段）。
   *
   * @return 是否成功；失败时已经报过 onError，调用方不必再报
   */
  async function openMic(generation: number): Promise<boolean> {
    pending.value = true;
    let acquired: MediaStream | null = null;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({
        // 展厅是开放空间：回声消除与降噪开着，比追求原始音质重要
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (disposed || generation !== operationGeneration) {
        stopTracks(acquired);
        return false;
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
      processor.onaudioprocess = (event) => onChunk(event as unknown as InputBufferLike);
      source.connect(processor);
      // 某些实现里不接 destination 就不会触发 onaudioprocess；输出为静音，不会真的放出来
      processor.connect(ctx.destination);
      armed.value = true;
      reportedMicError = ''; // 这次开起来了：之后若再失败，那条原因要重新报
      startTicker(generation);
      return true;
    } catch (e) {
      if (disposed || generation !== operationGeneration) {
        stopTracks(acquired);
        return false;
      }
      releaseMic();
      const reason = e instanceof Error ? e.message : '麦克风不可用';
      error.value = reason;
      if (reason !== reportedMicError) {
        reportedMicError = reason;
        options.onError?.(reason);
      }
      return false;
    } finally {
      if (generation === operationGeneration) pending.value = false;
    }
  }

  /**
   * 时长与上限的定时器：**只在整个麦克风开着的时候跑**（常开聆听下它跨语句常驻）。
   *
   * <p>无语音超时只在点按模式生效：常开聆听没有「录音开始」这个概念，「等了 6 秒没人说话」
   * 对应的动作是继续聆听，而不是把麦克风收回去。
   */
  function startTicker(generation: number): void {
    ticker = window.setInterval(() => {
      if (disposed || generation !== operationGeneration) {
        releaseMic();
        return;
      }
      if (!recording.value) {
        elapsedMs.value = 0; // 聆听态没有「已录多久」
        return;
      }
      elapsedMs.value = performance.now() - startedAt;
      // 无语音超时先判：tick 被节流合并到 20s 之后时，纯静音也该走「没有听到声音」
      // 这条免识别路径，而不是掉进 MAX 分支白跑一次识别。
      // 用 audible 而不是 speechDetected：轻声（带内）说话者不置 speechSeen 但 audible，
      // 不该在 6 秒被掐掉；全程真正无声才收回麦克风。
      if (!alwaysOn.value && !vad.audible && elapsedMs.value >= VAD_NO_SPEECH_MS) {
        metric({ kind: 'noSpeech' });
        error.value = '没有听到声音';
        options.onError?.(error.value);
        invalidate();
        return;
      }
      if (elapsedMs.value >= MAX_RECORD_MS) {
        void endStatement('max');
      }
    }, 100);
  }

  /**
   * 当前生效的说话阈值（§5 S1）：常量地板与「底噪估计 × 系数」取大，再封顶。
   *
   * <p>安静展厅里 `noiseEma` 贴着 0，阈值就是常量——与 P1 行为完全一致；
   * 展厅底噪一上来（空调、人声底噪、隔壁展位），阈值跟着抬，误触发随之减少。
   */
  function speechRms(): number {
    return Math.min(VAD_ADAPT_MAX_RMS, Math.max(VAD_SPEECH_RMS, noiseEma * VAD_ADAPT_FACTOR));
  }

  /**
   * 底噪估计：只在**「不是在说话」的块**上推进——常开聆听的聆听态、以及说话过程中的停顿与尾巴。
   *
   * <p>两处刻意的取舍：
   * - **慢升快降**（见 NOISE_EMA_RISE/FALL）：估计只会被持续存在的底噪抬上去，偶发噪声很快被忘掉；
   * - **上报口径不同**：`noise` 事件仍只收 `rms < VAD_SPEECH_RMS` 的块（与服务端那份报告口径
   *   一字不差，历史数据可比），而这里的估计要在**底噪高于常量**时也能长上去，所以收得更宽——
   *   否则正是最需要自适应的那种展厅里，估计永远停在 0。为此多报一条 `threshold`，
   *   让运营能看出「阈值到底自适应到了哪儿」。
   *
   * <p>已知边界（留给现场报告复核）：底噪一旦高于常量地板，VAD 会把底噪当成人声、进入语句态，
   * 这时采样只能靠语句之间的空隙推进，收敛会比安静环境慢。
   */
  function trackNoise(rms: number): void {
    if (!armed.value || suppressed) return;
    if (recording.value && rms >= speechRms()) return;
    noiseEma += (rms - noiseEma) * (rms < noiseEma ? NOISE_EMA_FALL : NOISE_EMA_RISE);
    metric({ kind: 'threshold', rms: speechRms() });
  }

  /** 底噪**上报**采样：只记「不像人声」的块，且只在麦克风开着、没被抑制的时候 */
  function sampleNoise(rms: number): void {
    if (!armed.value || suppressed || rms >= VAD_SPEECH_RMS) return;
    metric({ kind: 'noise', rms });
  }

  /**
   * VAD 推进一步，并把「已检出人声」同步给按钮文案；阈值取当前自适应值。
   *
   * @return 这一块**越过当前阈值**没有——分段管线要拿它算「这一片里有多少真在说话的音频」
   *   （{@link SEGMENT_MIN_SPEECH_MS}），刻意复用同一次判决，不另立一套「算不算语音」的口径
   */
  function advanceVad(rms: number, chunkMs: number): boolean {
    const threshold = speechRms();
    const isSpeech = rms >= threshold;
    vad = vadStep(vad, rms, chunkMs, threshold);
    if (isSpeech) lastVoiceAt = performance.now();
    if (!speechDetected.value && vad.speechSeen) speechDetected.value = true;
    return isSpeech;
  }

  /**
   * 采集回调：整个组件的「状态机」都在这里。
   *
   * - 抑制中：麦克风照开、**底噪与分段照旧冻结**（播报音量会伪造 speechSeen 并污染底噪），
   *   只把这一块喂给回声观察（P3a）——它是「自己的喇叭在麦克风里有多响」唯一的来源；
   * - capturing：累积 PCM + 分段 + 推 VAD，攒满静音就自动收尾；
   * - 否则（常开聆听的聆听态）：只推 VAD 与底噪，**不累积 PCM**——检出人声才从这一块开始算一句。
   */
  function onChunk(event: InputBufferLike): void {
    if (disposed) return;
    const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
    const rms = chunkRms(chunk);
    const chunkMs = (chunk.length / contextRate) * 1000;
    if (suppressed) {
      watchEcho(chunk, rms, chunkMs);
      return;
    }
    trackNoise(rms);
    sampleNoise(rms);

    if (recording.value) {
      chunks.push(chunk);
      segments.feed(chunk, advanceVad(rms, chunkMs));
      // 说完自动收尾：手动点按（stop）与这条路径汇合于同一 endStatement，不会打架
      if (vad.speechSeen && vad.silentMs >= VAD_SILENCE_MS) void endStatement('auto');
      return;
    }
    if (!alwaysOn.value) return; // 点按模式下麦克风只在录音期间开着，走不到这里；不满足时保持沉默

    advanceVad(rms, chunkMs);
    if (!vad.speechSeen) return;
    beginStatement(true);
    // 上面的 beginStatement 把 VAD 归零了，这一块要重新喂一遍：
    // 否则「说完一句立刻停」时 speechSeen 为 false，这一句只能挂到 MAX_RECORD_MS 才收尾
    feedStatementChunk(chunk, rms, chunkMs);
  }

  /** 把一块 PCM 记进当前这一句（PCM + VAD + 分段预览），起句的第一块与插话回灌都走它 */
  function feedStatementChunk(chunk: Float32Array, rms: number, chunkMs: number): void {
    chunks.push(chunk);
    segments.feed(chunk, advanceVad(rms, chunkMs));
  }

  /**
   * 播报期间的回声观察与插话判决（P3a）。
   *
   * <p>**P3a-1（只测不判）**：把每一块的 RMS 报上去（越过说话阈值 / 越过插话门限各记一类）。
   * 这组数今天是**采不到**的——旧实现一律冻结，而它正是「自己的喇叭声在麦克风里到底多响、
   * AEC 之后还剩多少」的唯一来源；P3a-2 的门限要按它定。
   *
   * <p>**P3a-2（真打断）**：`setBargeIn(true)` 之后，越限声音**持续**超过 BARGEIN_HOLD_MS
   * 才判为插话。判据是「持续」而不是「峰值」，理由见 {@link BARGEIN_HOLD_MS}。
   */
  function watchEcho(chunk: Float32Array, rms: number, chunkMs: number): void {
    const threshold = speechRms();
    metric({ kind: 'echo', rms, over: rms >= threshold, farOver: rms >= threshold * BARGEIN_FACTOR });
    if (!bargeIn.value || !alwaysOn.value) return;
    if (rms < threshold * BARGEIN_FACTOR) {
      clearBargeInRun();
      return;
    }
    bargeInRun.push({ chunk, rms });
    bargeInRunMs += chunkMs;
    // 只留够接住半个字的回灌，攒长了等于把播报的尾巴也当成新提问。
    // 下限是 BARGEIN_MIN_BLOCKS 而不是 1：256ms 块的设备上两块就 512ms > BARGEIN_PREROLL_MS，
    // 按 1 块裁的话这段缓冲永远凑不齐判决所需的块数，插话**永远判不出来**
    while (bargeInRunMs > BARGEIN_PREROLL_MS && bargeInRun.length > BARGEIN_MIN_BLOCKS) {
      bargeInRunMs -= (bargeInRun[0].chunk.length / contextRate) * 1000;
      bargeInRun.shift();
    }
    // 时长与块数取严（理由见 BARGEIN_MIN_BLOCKS）：块长按设备在 85ms~256ms 之间浮动，
    // 只看时长会让 256ms 块的设备上一记爆音就直接过线
    if (bargeInRunMs < BARGEIN_HOLD_MS || bargeInRun.length < BARGEIN_MIN_BLOCKS) return;
    triggerBargeIn();
  }

  /**
   * 判出插话：停手、把已经判成人声的那几块接成新的一句，再请调用方闭嘴。
   *
   * <p>三件事的顺序有讲究：
   * 1. **先自己解除抑制**——App 那边的 `setSuppressed(false)` 要等 Vue 的 watcher 跑完，
   *    等它就意味着新一句的头几个块会被当成「还在抑制」丢掉；
   * 2. **回灌的块要走一遍 VAD**——它们是这句话的开头，只塞进 PCM 不让 VAD 看见的话，
   *    参观者说了半句就停下时，这一句只能挂到 20 秒上限才收尾；
   * 3. **最后才回调**——回调里 App 会 `speech.stop()`（毫秒级），此时这一句已经在录了。
   */
  function triggerBargeIn(): void {
    const run = bargeInRun;
    clearBargeInRun();
    if (!suppressed || disposed) return;
    suppressed = false;
    metric({ kind: 'bargeIn' });
    beginStatement(true, true);
    for (const block of run) {
      feedStatementChunk(block.chunk, block.rms, (block.chunk.length / contextRate) * 1000);
    }
    options.onBargeIn?.();
  }

  /**
   * 开始一句：清空 PCM 与分段缓冲、换语句号、VAD 归零。
   *
   * @param staysArmed 这一句结束后麦克风是否保持开着（聆听态起句为 true，点按起句为 false）
   * @param fromBargeIn 这一句是不是插话起的（插话与「被静音阈值截断」无关，S3 要排除它）
   */
  function beginStatement(staysArmed: boolean, fromBargeIn = false): void {
    statementStaysArmed = staysArmed;
    statementFromBargeIn = fromBargeIn;
    currentStatement = ++statementSeq;
    rotateUtterance();
    chunks = [];
    vad = initialVad();
    speechDetected.value = false;
    recording.value = true;
    startedAt = performance.now();
    lastVoiceAt = startedAt;
    elapsedMs.value = 0;
    // §5 S3 的第 ② 个条件：自动收尾后 1.5 秒内又起了一句（且不是插话）。
    // 第 ① 个条件是「上一句的终稿确实识出了文字」，它由终稿那条异步链补上，见 settleTruncation
    const pending = autoEndPending;
    if (staysArmed && !fromBargeIn && pending && startedAt - pending.autoEndAt <= TRUNCATION_WINDOW_MS) {
      pending.restarted = true;
      settleTruncation();
    }
  }

  /**
   * §5 S3 的落账点：两个条件齐了就判，**谁先到都算**。
   *
   * <p>判完就把待判定清掉——留着一份过期的会让下一次的窗口对错号。没齐就继续等：
   * 参观者说完就走（不重启）的那次会一直留着，直到被下一次自动收尾覆盖，永远不会误记。
   */
  function settleTruncation(): void {
    const pending = autoEndPending;
    if (!pending) return;
    if (pending.hadText === false) {
      autoEndPending = null; // 上一句的终稿是空的：那多半是噪声误触发，不是被截断的话
      return;
    }
    if (pending.hadText === true && pending.restarted) {
      autoEndPending = null;
      metric({ kind: 'truncationSuspected' });
    }
  }

  /**
   * 结束当前一句并走整段识别（两种模式共用的终稿路径）。
   *
   * <p>常开聆听下不释放麦克风、也不等识别结果——聆听立刻继续，下一句能马上开始；
   * 但终稿是**串行**的，上一句还在飞时这一句先等它落地（在途只有一条，等一次即可）。
   */
  async function endStatement(mode: DictationEndMode): Promise<void> {
    if (!recording.value) return;
    const generation = operationGeneration;
    const endedAt = performance.now();
    const duration = endedAt - startedAt;
    const rate = contextRate;
    // 「这一句结束后麦克风要不要留着」看的是**起句的方式**，不是当下的开关（理由见 statementStaysArmed）
    const always = statementStaysArmed;
    const timing: FinalTiming = {
      statement: currentStatement,
      endedAt,
      voiceAt: lastVoiceAt || startedAt,
      audioMs: 0,
      fromBargeIn: statementFromBargeIn,
      staysArmed: always,
    };
    recording.value = false;
    elapsedMs.value = 0;
    speechDetected.value = false;
    if (!always) releaseMic(); // 点按模式：录音一结束就收麦（旧行为不变）
    const pcm = concat(chunks);
    timing.audioMs = (pcm.length / rate) * 1000;
    chunks = [];
    vad = initialVad();
    // 换语句号 + 掐掉在途分段：它们的文字属于**已经结束**的这句，终稿才是唯一有权威的结果。
    // 顺带把「同时在途至多 2 段」的槽位立刻放出来，下一句的第一个切片不至于被误判为超限而丢弃。
    rotateUtterance();

    if (duration < MIN_RECORD_MS || !pcm.length) {
      // 常开聆听下「太短」就是没人认真说话（VAD 起手至少要攒满一个块 + 1 秒静音），
      // 静默丢弃即可；点按模式保持原有的两条提示
      if (always) return;
      error.value = duration < MIN_RECORD_MS ? '录音太短' : '没有采到声音';
      options.onError?.(error.value);
      return;
    }

    metric({ kind: 'end', mode });
    if (mode === 'auto') {
      // S3 的待判定：这一句自己收的尾，等「它的终稿有没有文字」与「1.5 秒内有没有再起一句」齐了再算。
      // 放在「太短丢弃」之后是有意的——那条路径不发识别、不会有终稿回来，挂个永远等不到的条件没意义
      autoEndPending = { statement: currentStatement, autoEndAt: endedAt, restarted: false, hadText: null };
    }
    // busy 按「在途条数」计：终稿是排队的，先落地的那一句不能把还在飞的后一句一起清掉
    busy.value = true;
    finalsInFlight += 1;
    const run = finalChain.then(() => recognizeFinal(pcm, rate, generation, timing));
    finalChain = run.catch(() => {});
    try {
      await run;
    } finally {
      finalsInFlight -= 1;
      if (!disposed && generation === operationGeneration) busy.value = finalsInFlight > 0;
    }
  }

  /**
   * 整段识别：终稿。成功走 onText（调用方据此自动提问），失败走 onError。
   *
   * <p>`pcm` 是这一句的**原始** PCM（采集速率）；语音增强只在这里做一次
   * （{@link enhanceForUpload}），所以「谁说被当成说话了」与「送上去的音频有多响」
   * 是两个互不影响的决定。
   */
  async function recognizeFinal(
    pcm: Float32Array,
    rate: number,
    generation: number,
    timing: FinalTiming,
  ): Promise<void> {
    // 排队期间可能已经被取消（关常开、重新开始、卸载）：这道判断必须在**发请求之前**，
    // 否则会给一段已经没有去处的录音白付一次 ASR 调用，结果回来也只会被丢弃
    if (disposed || generation !== operationGeneration) return;
    const requestController = new AbortController();
    recognitionController = requestController;
    try {
      const wav = encodeWav(enhanceForUpload(pcm, rate), TARGET_SAMPLE_RATE);
      const result = await recognizeSpeech(wav, requestController.signal);
      // 终稿延迟只在这一处上报（§5 S4/S8）：说完了多久才等到文本 / 这段录音有多少音频秒。
      // 失败的调用不报（超时那种 90 秒会把均值带偏，与分段延迟同一套口径）。
      if (generation === operationGeneration) reportFinal(timing, result.elapsedMs);
      if (disposed || generation !== operationGeneration || requestController.signal.aborted) return;
      const text = result.text.trim();
      settleFinalOutcome(timing.statement, Boolean(text));
      if (!text) {
        handleEmptyFinal(timing.fromBargeIn, timing.staysArmed);
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
    }
  }

  /**
   * 终稿回来了：把「是否识出文字」补进 S3 的待判定里（§5 S3 的第 ① 个条件）。
   *
   * <p>对不上号就什么都不做——`autoEndPending` 里挂的是**某一句**的待判定，
   * 终稿是排队回来的，中间可能已经换过句子。
   */
  function settleFinalOutcome(statement: number, hadText: boolean): void {
    const pending = autoEndPending;
    if (!pending || pending.statement !== statement) return;
    pending.hadText = hadText;
    settleTruncation();
  }

  /**
   * 终稿三段延迟的埋点（§5 S4 + §4 P2 修订 1）。
   *
   * <p>原文只有一个「说完→首音 ≤1.5s」，把三段糊在一起，超标了也不知道该优化谁。这里拆开：
   * `endDelayMs` = 说完 → VAD 判出收尾（今天约等于 VAD_SILENCE_MS），
   * `latencyMs − endDelayMs` = 收尾 → 终稿文本（一次往返 + 前端编码上传），
   * `serverMs` 是服务端自己量的一次识别耗时——两者之差就是浏览器这一侧的开销。
   */
  function reportFinal(timing: FinalTiming, serverMs?: number): void {
    const at = performance.now();
    const endDelayMs = Math.max(0, timing.endedAt - timing.voiceAt);
    metric({
      kind: 'final',
      endDelayMs,
      latencyMs: Math.max(endDelayMs, at - timing.voiceAt),
      audioMs: timing.audioMs,
      serverMs: serverMs ?? 0,
    });
  }

  /**
   * 整段识别回来是空的：聆听态下几乎都是环境噪声被 VAD 当成了说话。
   *
   * <p>这条路径**不能报错**：展厅里没人说话的时候最多，一句「没有听清」会在大屏上反复刷。
   * 计数进遥测（`falseTriggers`），预览清掉，等下一句。点按起的那一句是明确的用户操作，保留原有提示。
   *
   * <p>判据取**这一句的来源**（`staysArmed`）而不是当下的模式开关：运营在点按录音中拨到全双工、
   * 这一句的终稿随后才回来时，读开关会把一次点按误判成聆听态的一句话——参观者听不到任何解释，
   * 遥测里也多一条假的 `falseTrigger`。这是审核提过的 `handleEmptyFinal` 归类边界，已按来源收口。
   *
   * <p>从插话起的那一句另记一笔 `bargeInRejected`：打断判错的代价是「把回答掐了、又没有新问题」，
   * 这一条才是决定 P3a-2 的门限敢不敢开在低位的那个数（总数仍计在 `falseTriggers` 里）。
   */
  function handleEmptyFinal(fromBargeIn: boolean, staysArmed: boolean): void {
    if (staysArmed) {
      metric({ kind: 'falseTrigger' });
      if (fromBargeIn) metric({ kind: 'bargeInRejected' });
      options.onPartial?.(null);
      return;
    }
    error.value = '没有听清，请再说一次';
    options.onError?.(error.value);
  }

  /** 开始录音（点按模式）；麦克风被拒/不支持的机器上只报错不抛，按钮不会卡在「录音中」 */
  async function start(): Promise<void> {
    if (!supported || disposed || recording.value || pending.value || busy.value || armed.value) return;
    error.value = '';
    // 每一次点按都是参观者的主动行为（不像常开聆听那样每个手势自动重试一次），所以这一次失败
    // 一定要报出去：报了才会出现输入区下方那句行动指引，也才谈得上「再点一下就再连一次」。
    // 去重留给自动 arm 那条路，理由见 reportedMicError。
    reportedMicError = '';
    const generation = ++operationGeneration;
    if (!(await openMic(generation))) return;
    if (disposed || generation !== operationGeneration) return;
    // 窄窗：点麦之后、getUserMedia 落地之前参观者手打一句提交了（或回答开始播报），此刻已进抑制。
    // 照旧进语句的话这一句会空录到 VAD_NO_SPEECH_MS，白报一次「没有听到声音」；
    // 而 setSuppressed 是在这次 start 之后才调的，收不到它，所以在这里自己收麦。
    if (suppressed) {
      releaseMic();
      return;
    }
    // 点按起句：结束后收麦。**即使常开开关是开着的**——那台机器可能正是因为 speechReady=false
    // 才没被自动 arm，这一句之后继续挂着麦克风只会让每一次环境噪声都打一次 503
    beginStatement(false);
  }

  /**
   * 打开麦克风并停在聆听态（常开聆听）。
   *
   * <p>与 `start()` 的区别是**不进语句**：不开录音、不累积 PCM，只等 VAD 检出人声。
   * 幂等，可以在每次手势里放心调——权限被拒时下一个手势会再试一次。
   */
  async function arm(): Promise<void> {
    if (!supported || disposed || !alwaysOn.value || armed.value || pending.value || recording.value) return;
    error.value = '';
    const generation = ++operationGeneration;
    if (!(await openMic(generation))) return;
    if (disposed || generation !== operationGeneration) return;
    vad = initialVad();
    speechDetected.value = false;
    elapsedMs.value = 0;
  }

  /** 结束录音并识别；识别结果通过 options.onText 回给调用方。常开聆听下 = 立即结束当前这句 */
  async function stop(): Promise<void> {
    if (!recording.value) {
      if (pending.value) invalidate();
      return;
    }
    await endStatement('manual');
  }

  /** 丢弃这段录音（录音中点「取消」），并放开麦克风 */
  function cancel(): void {
    if (!recording.value && !pending.value && !busy.value && !armed.value) return;
    invalidate();
  }

  /**
   * 常开聆听开关（App 由存储键同步）。
   *
   * <p>关掉时放弃当前语句并放开麦克风，回到点按模式；放弃**不报错**——这是运营按的开关，
   * 不是参观者做错了什么。
   */
  function setAlwaysOn(value: boolean): void {
    if (alwaysOn.value === value) return;
    alwaysOn.value = value;
    if (value) return;
    invalidate();
  }

  /**
   * 插话判决开关（P3a-2，App 由存储键同步，缺省关）。
   *
   * <p>关着的时候只量不判（P3a-1）：回声照采、计数照报，但一句话都不会被打断。
   * 判据要等现场回声数据（`echo*` 那组计数），不能拍脑袋开。
   */
  function setBargeIn(value: boolean): void {
    if (bargeIn.value === value) return;
    bargeIn.value = value;
    clearBargeInRun(); // 免得切换那一刻手里的越限块直接触发一次判决
  }

  /**
   * 抑制（回答播报与流式回答期间）：麦克风**保持开着**，但语句、VAD、底噪、分段全部冻结。
   *
   * <p>为什么不干脆收麦：收麦再开要走一次 getUserMedia，展厅里那是可见的权限抖动与几百毫秒空窗。
   * 为什么必须冻结：喇叭与麦克风在同一台机器上，讲解声会伪造 `speechSeen`，也会把底噪采样
   * 拉高——那样调出来的阈值在真实安静环境里全是错的。
   *
   * <p>正在说的这一句直接**放弃**（丢 PCM、换语句号、清预览、计 `suppressedAbandons`）：
   * 半句被回声音染过的录音送去识别只会得到垃圾文本，还不如等参观者说完再说一遍。
   *
   * <p>与 P1 的差别只有一处：抑制期间**仍会采回声**（`watchEcho`），因为「自己的喇叭在麦克风里
   * 有多响」只能在这一刻量；它写进的是独立的 `echo*` 计数，不会污染底噪（§5 S1 的口径）。
   */
  function setSuppressed(value: boolean): void {
    if (suppressed === value) return;
    suppressed = value;
    if (!value) {
      clearBargeInRun();
      return;
    }
    // 在途分段一律作废：它们的文字属于被打断的那句，落地只会在回答期间改写输入框
    rotateUtterance();
    if (!recording.value) return;
    recording.value = false;
    elapsedMs.value = 0;
    speechDetected.value = false;
    chunks = [];
    vad = initialVad();
    metric({ kind: 'suppressedAbandon' });
    options.onPartial?.(null);
    // 被放弃的这一句如果是**点按起句**（staysArmed=false），必须连麦一起收：
    // 抑制只清 recording/chunks/vad，`armed` 会一直留 true，而 `start()` 开头就有 armed 早退——
    // 之后每次点 mic 都直接返回，表现为「按钮永久无响应 + 麦克风常开」。
    // 判据与 `endStatement` 的 `if (!always) releaseMic()` 同源：全双工句恒 staysArmed=true，
    // 这里收麦会破坏「抑制不收麦」的设计（那是防权限抖动与空窗的），所以按**语句**判而不是按开关判。
    // 不必 bump operationGeneration：被放弃的点按句没有在途识别——终稿只在 endStatement 之后才发。
    if (!statementStaysArmed) releaseMic();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    invalidate();
  }

  if (getCurrentInstance()) onUnmounted(dispose);

  /** 常开聆听且空闲：按钮文案与形象状态都拿它判断（`recording` 时不算，那时在录一句） */
  const listening = computed(() => armed.value && !recording.value);

  return {
    supported,
    recording,
    pending,
    busy,
    elapsedMs,
    speechDetected,
    error,
    armed,
    listening,
    bargeIn,
    start,
    arm,
    stop,
    cancel,
    dispose,
    setAlwaysOn,
    setBargeIn,
    setSuppressed,
  };
}
