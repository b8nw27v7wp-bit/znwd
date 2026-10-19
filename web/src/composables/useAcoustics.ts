import { getCurrentInstance, onUnmounted } from 'vue';
import { sendSpeechMetrics } from '../api';
import type { DictationMetric } from './useDictation';

/**
 * 声学遥测：把**只在前端看得见**的量（底噪 RMS、VAD 判定、分段延迟、播报期间的回声）累成
 * 增量计数，定期批量 POST `/api/speech/metrics`，最终汇进 `/api/stats` 的 `speech` 段。
 *
 * 为什么需要这一层：运营面板的数据源是 `/api/stats`，而底噪与误触只发生在浏览器里。
 * 不上报的话，「这一套阈值在展厅现场到底合不合适」就只能靠人蹲在现场听——第 3 档要求
 * 拿现场声学实测报告过闸，没有这条通道就交不出报告。
 *
 * 三条取舍：
 * 1. **批量送增量**：一次讲话可能产生几十条事件，逐条上报会把配额打满；本地累加、按批送，
 *    后端只管相加（口径统一在服务端，前端不自己算均值）。
 * 2. **丢了就丢了**：发送失败不重试也不补发——攒着不放会无限涨内存，而这是体检数据不是账目；
 *    下一批带上新的增量继续。
 * 3. **不走 adminRequest**：这个接口没有口令（面板没打开时数据同样要落库），用 apiUrl 直连；
 *    keepalive 保证切页/卸载时那一批也发得出去。
 *
 * 精度上的刻意选择：**只有「和」与「次数」，没有客户端自己算的均值**。均值留给服务端
 * （`Analytics#speechStats`）——现场调阈值时运营面板与接口直连两个入口读到的数必须一致，
 * 口径只留一份。峰值同理不留：分位数不是加法能算出来的，要它就得换上报协议（§5 S2）。
 */

/** 上报周期：15 秒一批。名义 4 次/分钟，配额的默认值（30）留了节流恢复后集中补报的余量 */
export const ACOUSTICS_INTERVAL_MS = 15_000;

/**
 * 回答链路起止的埋点（§4 P2 修订 1 的第二、三段）。
 *
 * <p>它不属于 `useDictation`：这两段分别发生在 `useChat`（首句生成）与 `useSpeech`（首段开口）里，
 * 而把它们串起来的是 App——问一句、听回答、等开口这条链只有它看得全。
 */
export type AnswerMetric =
  | { kind: 'firstSentence'; ms: number } // 提问发出 → 首句生成
  | { kind: 'firstAudio'; ms: number }; // 首句生成 → 首段音频开始播

export type AcousticsEvent = DictationMetric | AnswerMetric;

/** 增量计数累加器：键与后端 `/api/speech/metrics` 的白名单一一对应 */
export type AcousticsCounters = Record<string, number>;

/**
 * 单项数值的上限，**与后端 `SpeechParser.METRIC_MAX_VALUE` 必须同一个数**（有测试读那份源码对齐）。
 *
 * <p>后端对越界的值不是「忽略这一项」而是**整批 400**——内存计数器没有回退路径，一条坏数据进去，
 * 重启前运营面板读到的都是错的。那条判据是对的，代价是「一个越界值带走整批几十个键」，
 * 所以客户端出口这里先夹一道：越界的夹到上限、非有限值直接不发。
 */
export const METRIC_MAX_VALUE = 1e6;

export function emptyCounters(): AcousticsCounters {
  return {
    utterances: 0,
    autoEnds: 0,
    manualEnds: 0,
    noSpeechAborts: 0,
    falseTriggers: 0,
    suspectedTruncations: 0,
    suppressedAbandons: 0,
    segmentCalls: 0,
    segmentFailures: 0,
    segmentDropped: 0,
    segmentAudioMs: 0,
    partialLatencySumMs: 0,
    partialLatencyCount: 0,
    noiseFloorSum: 0,
    noiseSamples: 0,
    thresholdSum: 0,
    thresholdSamples: 0,
    finalCalls: 0,
    finalEndDelaySumMs: 0,
    finalLatencySumMs: 0,
    finalServerSumMs: 0,
    finalAudioMs: 0,
    echoSamples: 0,
    echoFloorSum: 0,
    echoOverCount: 0,
    echoFarOverCount: 0,
    bargeIns: 0,
    bargeInRejected: 0,
    firstSentenceSumMs: 0,
    firstSentenceCount: 0,
    firstAudioSumMs: 0,
    firstAudioCount: 0,
  };
}

/**
 * 把一条事件记进累加器（纯函数，便于单测）。
 *
 * <p>四条容易记错、单独说明：
 * - `end` 无论哪种结束原因都算一次 `utterances`，`autoEnds`/`manualEnds` 是它的分解，
 *   超时（`max`）是剩下的差——与后端「问答总数 = rag + llm_only + errors」同一套口径；
 * - `segmentFailure` **也计一次 `segmentCalls`**：它确实打出去了，只是没成功。
 *   这样「调用 − 失败 = 成功」在任何时刻都成立，面板不必再解释这两个数怎么对；
 * - `segmentFailure` / `final` 的音频时长照算：ASR 按音频秒计费，失败的那一段也计费；
 * - `bargeInRejected` 是 `falseTriggers` 的**子集**（插话判错也算一次空识别），
 *   不是另一类，面板上要按「插话 N 次，其中判错 M 次」读。
 */
export function accumulate(counters: AcousticsCounters, event: AcousticsEvent): void {
  switch (event.kind) {
    case 'noise':
      counters.noiseFloorSum += event.rms;
      counters.noiseSamples += 1;
      return;
    case 'threshold':
      counters.thresholdSum += event.rms;
      counters.thresholdSamples += 1;
      return;
    case 'end':
      counters.utterances += 1;
      if (event.mode === 'auto') counters.autoEnds += 1;
      else if (event.mode === 'manual') counters.manualEnds += 1;
      return;
    case 'noSpeech':
      counters.noSpeechAborts += 1;
      return;
    case 'falseTrigger':
      counters.falseTriggers += 1;
      return;
    case 'truncationSuspected':
      counters.suspectedTruncations += 1;
      return;
    case 'segment':
      counters.segmentCalls += 1;
      counters.segmentAudioMs += event.audioMs;
      counters.partialLatencySumMs += event.latencyMs;
      counters.partialLatencyCount += 1;
      return;
    case 'segmentFailure':
      counters.segmentCalls += 1;
      counters.segmentFailures += 1;
      counters.segmentAudioMs += event.audioMs;
      return;
    case 'segmentDropped':
      counters.segmentDropped += 1;
      return;
    case 'suppressedAbandon':
      counters.suppressedAbandons += 1;
      return;
    case 'final':
      counters.finalCalls += 1;
      counters.finalEndDelaySumMs += event.endDelayMs;
      counters.finalLatencySumMs += event.latencyMs;
      counters.finalServerSumMs += event.serverMs;
      counters.finalAudioMs += event.audioMs;
      return;
    case 'echo':
      counters.echoSamples += 1;
      counters.echoFloorSum += event.rms;
      if (event.over) counters.echoOverCount += 1;
      if (event.farOver) counters.echoFarOverCount += 1;
      return;
    case 'bargeIn':
      counters.bargeIns += 1;
      return;
    case 'bargeInRejected':
      counters.bargeInRejected += 1;
      return;
    case 'firstSentence':
      counters.firstSentenceCount += 1;
      counters.firstSentenceSumMs += event.ms;
      return;
    case 'firstAudio':
      counters.firstAudioCount += 1;
      counters.firstAudioSumMs += event.ms;
      return;
    default:
      return;
  }
}

/**
 * 只取非零项：全零的键不发，免得每一批都白占几十个字段的带宽与配额。
 *
 * <p>出口再夹一道值域（{@link METRIC_MAX_VALUE}）：后端对越界的值是**整批 400**，
 * 一个离谱的样本（比如机器休眠几小时醒来后 `performance.now()` 的跳变算出来的毫秒数）
 * 会把这 15 秒里攒的几十个键一起带走，而且一声不响。夹到上限至少保住同批的其它样本
 * ——反正后端 `Analytics#recordSpeech` 也是按同一个上限夹的。
 */
export function pendingDeltas(counters: AcousticsCounters): AcousticsCounters {
  const out: AcousticsCounters = {};
  for (const [key, value] of Object.entries(counters)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    out[key] = Math.min(value, METRIC_MAX_VALUE);
  }
  return out;
}

export function useAcoustics() {
  let counters = emptyCounters();
  let timer: number | undefined;

  function record(event: AcousticsEvent): void {
    accumulate(counters, event);
  }

  /** 把这一批送出去并把累加器清零；没有攒到任何东西时直接返回（空批只白占一次配额） */
  function flush(): void {
    const deltas = pendingDeltas(counters);
    if (!Object.keys(deltas).length) return;
    counters = emptyCounters();
    void sendSpeechMetrics(deltas).catch((error: unknown) => {
      // 上报是尽力而为：接口没起来、配额正好用尽、页面正在卸载都会失败，
      // 而这些都不影响参观者此刻能不能提问，所以既不重试也不往上抛。
      // 但**要留下痕迹**：被 400 掉（键漂移或值越界）的表现是「运营面板上那几行永远是 0」，
      // 一声不响的话只有人蹲到现场比对才发现——控制台至少给研究者留一条线索。
      console.warn('[acoustics] 这批声学遥测没能上报（下一批带新的增量继续）：', error);
    });
  }

  /** 切到后台时补发一次：展厅的一体机常被直接关掉标签页，卸载事件未必来得及 */
  function onVisibilityChange(): void {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') flush();
  }

  if (typeof window !== 'undefined') {
    timer = window.setInterval(flush, ACOUSTICS_INTERVAL_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }

  function dispose(): void {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    flush();
  }

  if (getCurrentInstance()) onUnmounted(dispose);

  return { record, flush, dispose };
}
