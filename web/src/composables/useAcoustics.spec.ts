// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accumulate, emptyCounters, pendingDeltas, useAcoustics, ACOUSTICS_INTERVAL_MS } from './useAcoustics';
import type { AcousticsEvent } from './useAcoustics';

/**
 * 后端那份白名单的源文件：S15 的一致性断言直接读它，不维护第二份副本。
 *
 * <p>用 cwd 而不是 `import.meta.url`——jsdom 环境里那是 http URL，转不成路径；
 * vitest 的工作目录就是 `web/`（`npm run test` 与 CI 都从那里起）。
 */
const SPEECH_PARSER = resolve(
  process.cwd(),
  '../server/src/main/java/com/znwd/hostess/audio/SpeechParser.java',
);

/**
 * 声学遥测的累计与上报。
 *
 * 这一层守的是**口径**：计数涨了要对得上现场发生了什么事。最容易记错的两条单独钉住——
 * `end` 的三种原因都算一次语句、`segmentFailure` 也算一次分段调用（「调用 − 失败 = 成功」
 * 必须恒成立，否则运营面板上那两个数怎么都对不上）。
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('事件 → 计数', () => {
  function counted(events: AcousticsEvent[]): Record<string, number> {
    const counters = emptyCounters();
    for (const event of events) accumulate(counters, event);
    return counters;
  }

  it('语句数按结束原因分解，超时结束是余数', () => {
    const counters = counted([
      { kind: 'end', mode: 'auto' },
      { kind: 'end', mode: 'auto' },
      { kind: 'end', mode: 'manual' },
      { kind: 'end', mode: 'max' },
    ]);
    expect(counters.utterances).toBe(4);
    expect(counters.autoEnds).toBe(2);
    expect(counters.manualEnds).toBe(1);
    // 超时没有独立计数：utterances - autoEnds - manualEnds 就是它，面板按同一套口径算
    expect(counters.utterances - counters.autoEnds - counters.manualEnds).toBe(1);
  });

  it('分段失败也算一次调用（调用 − 失败 = 成功）', () => {
    const counters = counted([
      { kind: 'segment', latencyMs: 800, audioMs: 2_000 },
      { kind: 'segmentFailure', audioMs: 2_000 },
    ]);
    expect(counters.segmentCalls).toBe(2);
    expect(counters.segmentFailures).toBe(1);
    expect(counters.segmentCalls - counters.segmentFailures).toBe(1);
  });

  it('分段延迟只累加成功的那些（超时那种十几秒会把均值带偏）', () => {
    const counters = counted([
      { kind: 'segment', latencyMs: 600, audioMs: 2_000 },
      { kind: 'segment', latencyMs: 1400, audioMs: 2_000 },
      { kind: 'segmentFailure', audioMs: 2_000 },
    ]);
    expect(counters.partialLatencyCount).toBe(2);
    expect(counters.partialLatencySumMs).toBe(2000);
    expect(counters.partialLatencySumMs / counters.partialLatencyCount).toBe(1000);
  });

  it('底噪存和与次数，均值留给服务端算', () => {
    const counters = counted([
      { kind: 'noise', rms: 0.01 },
      { kind: 'noise', rms: 0.02 },
    ]);
    expect(counters.noiseSamples).toBe(2);
    expect(counters.noiseFloorSum).toBeCloseTo(0.03, 6);
  });

  it('放弃与误触发各自成列', () => {
    const counters = counted([
      { kind: 'suppressedAbandon' },
      { kind: 'falseTrigger' },
      { kind: 'falseTrigger' },
      { kind: 'noSpeech' },
      { kind: 'segmentDropped' },
    ]);
    expect(counters.suppressedAbandons).toBe(1);
    expect(counters.falseTriggers).toBe(2);
    expect(counters.noSpeechAborts).toBe(1);
    expect(counters.segmentDropped).toBe(1);
  });

  it('只发非零项：空批不该白占一次配额', () => {
    const counters = counted([{ kind: 'end', mode: 'auto' }]);
    expect(pendingDeltas(counters)).toEqual({ utterances: 1, autoEnds: 1 });
    expect(pendingDeltas(emptyCounters())).toEqual({});
  });

  it('终稿：三段延迟、音频秒数与服务端耗时各归各的键（§5 S4/S8）', () => {
    const counters = counted([
      { kind: 'final', endDelayMs: 1_000, latencyMs: 1_800, audioMs: 2_000, serverMs: 500 },
      { kind: 'final', endDelayMs: 1_200, latencyMs: 2_000, audioMs: 3_000, serverMs: 700 },
    ]);
    expect(counters.finalCalls).toBe(2);
    expect(counters.finalEndDelaySumMs).toBe(2_200);
    expect(counters.finalLatencySumMs).toBe(3_800);
    expect(counters.finalServerSumMs).toBe(1_200);
    expect(counters.finalAudioMs).toBe(5_000);
  });

  it('分段失败的音频照算：ASR 按音频秒计费，打出去的那一段就计费（§5 S8）', () => {
    const counters = counted([
      { kind: 'segment', latencyMs: 800, audioMs: 2_000 },
      { kind: 'segmentFailure', audioMs: 2_000 },
    ]);
    expect(counters.segmentAudioMs).toBe(4_000);
    expect(counters.partialLatencyCount, '延迟仍只累加成功的那些').toBe(1);
  });

  it('自适应阈值自己成列：与底噪并排才看得出「采了有没有用」（§5 S1）', () => {
    const counters = counted([
      { kind: 'threshold', rms: 0.02 },
      { kind: 'threshold', rms: 0.05 },
      { kind: 'noise', rms: 0.015 },
    ]);
    expect(counters.thresholdSamples).toBe(2);
    expect(counters.thresholdSum).toBeCloseTo(0.07, 6);
    // 两者不是同一批样本：阈值的样本数随底噪估计的更新次数走，别把两个数混着用
    expect(counters.noiseSamples).toBe(1);
  });

  it('回声按两道门限分列，插话与判错各成一列（P3a）', () => {
    const counters = counted([
      { kind: 'echo', rms: 0.01, over: false, farOver: false },
      { kind: 'echo', rms: 0.03, over: true, farOver: false },
      { kind: 'echo', rms: 0.2, over: true, farOver: true },
      { kind: 'bargeIn' },
      { kind: 'bargeInRejected' },
    ]);
    expect(counters.echoSamples).toBe(3);
    expect(counters.echoFloorSum).toBeCloseTo(0.24, 6);
    expect(counters.echoOverCount).toBe(2);
    expect(counters.echoFarOverCount).toBe(1);
    expect(counters.bargeIns).toBe(1);
    // 判错是 falseTriggers 的子集（它同时也是一次空识别），不是另一类事件
    expect(counters.bargeInRejected).toBe(1);
  });

  it('回答链路的两段延迟分开计（§4 P2 修订 1）', () => {
    const counters = counted([
      { kind: 'firstSentence', ms: 700 },
      { kind: 'firstSentence', ms: 900 },
      { kind: 'firstAudio', ms: 400 },
    ]);
    expect(counters.firstSentenceCount).toBe(2);
    expect(counters.firstSentenceSumMs).toBe(1_600);
    expect(counters.firstAudioCount).toBe(1);
    expect(counters.firstAudioSumMs).toBe(400);
  });
});

/**
 * §5 S15：**前端产出的键集合必须 ⊆ 后端白名单**。
 *
 * <p>两份清单是手写的——`emptyCounters()` 在这里，`SpeechParser.METRIC_KEYS` 在服务端。
 * 加了一条事件却忘了加键，表现是**静默丢数据**：接口 400／字段被拒，没有报错、没有日志，
 * 运营面板上那一行永远是 0，只有人蹲到现场比对才发现。所以直接拿后端的源文件对一遍。
 */
describe('遥测键与后端白名单一致', () => {
  it('前端每一个计数键都在 SpeechParser.METRIC_KEYS 里', () => {
    const source = readFileSync(SPEECH_PARSER, 'utf8');
    const start = source.indexOf('METRIC_KEYS = Set.of(');
    expect(start, '白名单的声明没找到：解析口径要跟着改').toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf(');', start));
    const allowed = new Set([...block.matchAll(/"(\w+)"/g)].map((match) => match[1]));

    const missing = Object.keys(emptyCounters()).filter((key) => !allowed.has(key));
    expect(missing, '这些键前端会发、后端会拒（静默丢数据）').toEqual([]);
  });
});

describe('上报', () => {
  function stubFetch(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('定时冲刷：只发增量，发完清零（同一条不重复上报）', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch();
    const acoustics = useAcoustics();

    acoustics.record({ kind: 'end', mode: 'auto' });
    acoustics.record({ kind: 'segment', latencyMs: 500, audioMs: 2_000 });
    await vi.advanceTimersByTimeAsync(ACOUSTICS_INTERVAL_MS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/speech/metrics');
    expect(init.method).toBe('POST');
    expect(init.keepalive, '切页/卸载时那一批也要发得出去').toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({
      utterances: 1,
      autoEnds: 1,
      segmentCalls: 1,
      segmentAudioMs: 2_000,
      partialLatencySumMs: 500,
      partialLatencyCount: 1,
    });

    // 什么都没有的第二批不发
    await vi.advanceTimersByTimeAsync(ACOUSTICS_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 新的增量单独成批（不把上一批再送一遍）
    acoustics.record({ kind: 'falseTrigger' });
    await vi.advanceTimersByTimeAsync(ACOUSTICS_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({
      falseTriggers: 1,
    });
    acoustics.dispose();
  });

  it('接口失败不抛也不重试（调用点在定时器与卸载里，没人接得住异常）', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      throw new Error('网络断了');
    });
    vi.stubGlobal('fetch', fetchMock);
    const acoustics = useAcoustics();

    acoustics.record({ kind: 'end', mode: 'manual' });
    await vi.advanceTimersByTimeAsync(ACOUSTICS_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(ACOUSTICS_INTERVAL_MS);

    // 失败的那批不补发（攒着不放会无限涨内存），下一批只带新的增量
    expect(fetchMock).toHaveBeenCalledTimes(1);
    acoustics.record({ kind: 'end', mode: 'manual' });
    await vi.advanceTimersByTimeAsync(ACOUSTICS_INTERVAL_MS);
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({
      utterances: 1,
      manualEnds: 1,
    });
    acoustics.dispose();
  });

  it('卸载时冲刷最后一批并停掉定时器', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch();
    const acoustics = useAcoustics();

    acoustics.record({ kind: 'suppressedAbandon' });
    acoustics.dispose();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({
      suppressedAbandons: 1,
    });

    await vi.advanceTimersByTimeAsync(ACOUSTICS_INTERVAL_MS * 3);
    expect(fetchMock, '卸载后不该再有上报').toHaveBeenCalledTimes(1);
  });
});
