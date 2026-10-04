import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  STREAM_INACTIVITY_MS,
  STREAM_TIMEOUT_MS,
  SYNTH_TIMEOUT_MS,
  sendFeedback,
  streamChat,
  synthesizeSpeech,
  type ChatDone,
  type ChatMeta,
} from './api';

/** 把若干 SSE 帧拼成 fetch 的流式响应 */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function frame(event: string, data: unknown): string {
  return `event:${event}\ndata:${JSON.stringify(data)}\n\n`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SSE 解析', () => {
  it('按 meta → delta → done 顺序分发，并拼接逐字输出', async () => {
    const meta: ChatMeta = {
      mode: 'rag',
      provider: 'mock',
      retrieval: 'keyword',
      noHit: false,
      cached: false,
      sources: [{ title: '叶片检测', snippet: '片段', score: 0.02, sourcePath: 'a.md' }],
    };
    const done: ChatDone = { ...meta, answer: '不需要停机。', latencyMs: 12 };

    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        frame('meta', meta),
        frame('delta', { text: '不需要' }),
        frame('delta', { text: '停机。' }),
        frame('done', done),
      ]),
    ));

    const seen: string[] = [];
    let answer = '';
    let metaSources = 0;
    await streamChat('叶片检测要停机吗？', 's1', {
      onMeta: (m) => {
        seen.push('meta');
        metaSources = m.sources.length;
      },
      onDelta: (t) => {
        seen.push('delta');
        answer += t;
      },
      onDone: (d) => {
        seen.push('done');
        expect(d.latencyMs).toBe(12);
      },
    });

    expect(seen).toEqual(['meta', 'delta', 'delta', 'done']);
    expect(answer).toBe('不需要停机。');
    expect(metaSources).toBe(1);
  });

  it('帧被 TCP 拆开也能正确重组（跨 chunk 的半帧）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        'event:meta\ndata:{"mode":"rag","prov',
        'ider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[]}\n\nevent:delta\ndata:{"text":"半',
        '句"}\n\nevent:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"半句","latencyMs":3}\n\n',
      ]),
    ));

    let answer = '';
    const events: string[] = [];
    await streamChat('问', null, {
      onMeta: () => events.push('meta'),
      onDelta: (t) => {
        events.push('delta');
        answer += t;
      },
      onDone: () => events.push('done'),
    });
    expect(events).toEqual(['meta', 'delta', 'done']);
    expect(answer).toBe('半句');
  });

  it('CRLF 帧边界跨 chunk 时不会把半帧提前分发', async () => {
    const meta: ChatMeta = {
      mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, sources: [],
    };
    const done: ChatDone = { ...meta, answer: '跨 chunk', latencyMs: 1 };
    const wire = [frame('meta', meta), frame('delta', { text: '跨' }), frame('done', done)]
      .join('')
      .replace(/\n/g, '\r\n');
    const firstBreak = wire.indexOf('\r\n') + 1;
    const secondBreak = wire.indexOf('\r\n', firstBreak) + 1;
    const thirdBreak = wire.indexOf('\r\n', secondBreak) + 1;
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        wire.slice(0, firstBreak),
        wire.slice(firstBreak, secondBreak),
        wire.slice(secondBreak, thirdBreak),
        wire.slice(thirdBreak),
      ]),
    ));

    const events: string[] = [];
    await streamChat('问', null, {
      onMeta: () => events.push('meta'),
      onDelta: () => events.push('delta'),
      onDone: () => events.push('done'),
    });

    expect(events).toEqual(['meta', 'delta', 'done']);
  });

  it('状态顺序错误时在调用回调前失败', async () => {
    const meta: ChatMeta = {
      mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, sources: [],
    };
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([frame('delta', { text: '不应回调' }), frame('meta', meta)]),
    ));

    const events: string[] = [];
    await expect(
      streamChat('问', null, {
        onMeta: () => events.push('meta'),
        onDelta: () => events.push('delta'),
        onDone: () => events.push('done'),
      }),
    ).rejects.toThrow('delta 帧顺序错误');
    expect(events).toEqual([]);
  });

  it('done 后的尾随非法帧使整个流失败', async () => {
    const meta: ChatMeta = {
      mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, sources: [],
    };
    const done: ChatDone = { ...meta, answer: '完成', latencyMs: 1 };
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        frame('meta', meta),
        frame('delta', { text: '完成' }),
        frame('done', done),
        'event:delta\ndata:{bad}\n\n',
      ]),
    ));

    await expect(
      streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
    ).rejects.toThrow('非法 SSE 帧');
  });

  it('心跳注释帧被忽略，不影响事件序列', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        ': ping\n\n',
        frame('meta', { mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, sources: [] }),
        frame('delta', { text: '字' }),
        ': ping\n\n',
        frame('done', { mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, cached: false, sources: [], answer: '字', latencyMs: 1 }),
      ]),
    ));
    const events: string[] = [];
    await streamChat('问', null, {
      onMeta: () => events.push('meta'),
      onDelta: () => events.push('delta'),
      onDone: () => events.push('done'),
    });
    expect(events).toEqual(['meta', 'delta', 'done']);
  });

  it('HTTP 非 2xx 时抛出后端错误文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ error: 'rate_limited', message: 'too many requests' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    ));
    await expect(
      streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
    ).rejects.toThrow('too many requests');
  });

  it('流在 done 前 EOF 时失败，并取消 reader', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValue({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    await expect(
      streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
    ).rejects.toThrow('done 前结束');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('非法 JSON 帧失败，且仍取消 reader', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const encoder = new TextEncoder();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: encoder.encode('event:delta\ndata:{bad\n\n') })
      .mockResolvedValue({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    await expect(
      streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
    ).rejects.toThrow('非法 SSE 帧');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('严格拒绝缺少契约字段的 meta、delta、done', async () => {
    const meta: ChatMeta = {
      mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, sources: [],
    };
    const cases: Array<[string, string]> = [
      [frame('meta', { mode: 'rag', provider: 'mock', noHit: false, sources: [] }), 'meta 帧'],
      [frame('delta', { text: 123 }), 'delta 帧'],
      [frame('done', { ...meta, answer: '答' }), 'latencyMs'],
    ];
    for (const [payload, message] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => sseResponse([payload])));
      await expect(
        streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
      ).rejects.toThrow(message);
    }
  });

  it('done 帧缺少有效 answer 时失败', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const encoder = new TextEncoder();
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: encoder.encode(frame('done', { answer: '  ' })) })
      .mockResolvedValue({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    await expect(
      streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
    ).rejects.toThrow('有效 answer');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('外部取消保留 AbortError', async () => {
    const read = vi.fn(() => new Promise<never>(() => {}));
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));
    const controller = new AbortController();
    const pending = streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('safeError 不会吞掉请求超时', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: () => new Promise<never>(() => {}),
    } as unknown as Response)));
    const pending = sendFeedback({ sessionId: null, rating: 'up' });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError', message: '请求超时' });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it('合成请求超时保留超时错误', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = synthesizeSpeech('测试');
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError', message: '请求超时' });
    await vi.advanceTimersByTimeAsync(SYNTH_TIMEOUT_MS);
    await assertion;
  });

  it('读取超时后中止请求并取消 reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    const pending = streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} });
    const assertion = expect(pending).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

/**
 * `event: error` 帧：parseFrame 见到它直接抛（带 payload 的 message 就用原文案），
 * 此前只有实现、没有用例——这里把两条分支钉住：有 message 用 message，缺了回落通用文案。
 */
describe('SSE error 事件帧', () => {
  it('中途 event: error 以 payload 的 message reject，已上屏的回调保留且 reader 照常取消', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const encoder = new TextEncoder();
    const meta: ChatMeta = {
      mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, cached: false, sources: [],
    };
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: encoder.encode(frame('meta', meta)) })
      .mockResolvedValueOnce({ done: false, value: encoder.encode(frame('delta', { text: '半句' })) })
      .mockResolvedValueOnce({ done: false, value: encoder.encode(frame('error', { message: '上游模型超时' })) })
      .mockResolvedValue({ done: true, value: undefined });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    const events: string[] = [];
    await expect(
      streamChat('问', null, {
        onMeta: () => events.push('meta'),
        onDelta: () => events.push('delta'),
        onDone: () => events.push('done'),
      }),
    ).rejects.toThrow('上游模型超时');

    expect(events, 'error 之前已分发的帧保留，done 永远不回调').toEqual(['meta', 'delta']);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('error 帧缺 message 字段时抛「服务内部错误」，不吐 undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([frame('error', {})])));
    await expect(
      streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
    ).rejects.toThrow('服务内部错误');
  });
});

/**
 * P1-4：断流活性检测。
 *
 * 后端每 15s 发一次 `:ping` 注释心跳；对端僵死（不关流、不吐字）时，旧实现要干等 180s
 * 总上限才报错。现在：收到任何字节刷新活性计时器，45s（3× 心跳）无数据即提前失败；
 * 总时长 180s 上限保留，语义由错误文案区分（「连接中断」vs「流式回答超时」）。
 */
describe('SSE 断流活性检测', () => {
  const meta: ChatMeta = { mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, cached: false, sources: [] };

  it('心跳持续刷新活性：跨过 45s 阈值但每 30s 有 :ping 的流照常走完', async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const done: ChatDone = { ...meta, answer: '字', latencyMs: 1 };
    // 脚本化读：t=0 meta → 每 30s 一个 :ping → t=120 delta+done → EOF
    const script: Array<{ delay: number; chunk: string }> = [
      { delay: 0, chunk: frame('meta', meta) },
      { delay: 30_000, chunk: ':ping\n\n' },
      { delay: 30_000, chunk: ':ping\n\n' },
      { delay: 30_000, chunk: ':ping\n\n' },
      { delay: 30_000, chunk: frame('delta', { text: '字' }) + frame('done', done) },
      { delay: 0, chunk: '' }, // EOF
    ];
    let step = 0;
    const read = vi.fn(() =>
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        const next = script[step++];
        setTimeout(() => {
          if (!next || next.chunk === '') resolve({ done: true, value: undefined });
          else resolve({ done: false, value: encoder.encode(next.chunk) });
        }, next?.delay ?? 0);
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel: vi.fn().mockResolvedValue(undefined) }) },
    } as unknown as Response)));

    const events: string[] = [];
    const pending = streamChat('问', null, {
      onMeta: () => events.push('meta'),
      onDelta: () => events.push('delta'),
      onDone: () => events.push('done'),
    });
    // fetch→read 链全是微任务：先排干，第一只 read 定时器才会挂到假钟上
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0); // meta 落地并刷新活性
    await vi.advanceTimersByTimeAsync(130_000); // 跨 45s 阈值，但心跳间隔 30s 始终压着
    await pending;
    expect(events).toEqual(['meta', 'delta', 'done']);
  });

  it('连接僵死：45 秒收不到任何字节就快速失败（远早于 180s），并取消 reader', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn(() => new Promise<never>(() => {}));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    const pending = streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} });
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      message: expect.stringContaining('连接中断'),
    });
    // 只推进 45s（总上限的 1/4）：断言能在这里完成，本身就证明没干等 180s
    await vi.advanceTimersByTimeAsync(STREAM_INACTIVITY_MS);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('总超时语义不回归：期间心跳不断，到 180s 仍以「流式回答超时」失败', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const encoder = new TextEncoder();
    // 每 30s 一个心跳：活性不断被刷新，只有 180s 总上限能结束这条流
    const read = vi.fn(() =>
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
        setTimeout(() => resolve({ done: false, value: encoder.encode(':ping\n\n') }), 30_000);
      }),
    );
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: { getReader: () => ({ read, cancel }) },
    } as unknown as Response)));

    const pending = streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} });
    // 排干微任务：让第一只 read（30s 后吐心跳）先挂上假钟，否则活性计时会在总超时前先开火
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    // 文案精确匹配「流式回答超时」：若被活性计时提前杀掉，错误会是「连接中断」，这里就会红
    const assertion = expect(pending).rejects.toThrow('流式回答超时');
    await vi.advanceTimersByTimeAsync(STREAM_TIMEOUT_MS);
    await assertion;
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

/**
 * sources 的命中定位三件套（chunkText/matchTerm/matchOffset）是后端后加的增量字段：
 * 老服务端整体不给（缺省降级），matchTerm 可能整个 key 缺省（jackson non_null），
 * 类型出错时只丢字段、不能废掉整条消息——下面按这三条各钉一个回归。
 */
describe('sources 命中定位字段（chunkText / matchTerm / matchOffset）', () => {
  const baseSource = {
    title: '清洁作业流程',
    snippet: '片段',
    score: 0.4,
    sourcePath: '01_光伏清洁机器人/清洁作业流程.md',
  };

  async function streamWithSource(source: unknown): Promise<ChatDone> {
    const meta = { mode: 'rag', provider: 'mock', retrieval: 'keyword', noHit: false, sources: [source] };
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([frame('meta', meta), frame('done', { ...meta, answer: '答', latencyMs: 3 })]),
    ));
    let done!: ChatDone;
    await streamChat('问', null, {
      onMeta: () => {},
      onDelta: () => {},
      onDone: (value) => {
        done = value;
      },
    });
    return done;
  }

  it('新字段原样透传给来源面板', async () => {
    const done = await streamWithSource({
      ...baseSource,
      chunkText: '巡检时发现叶片有裂纹',
      matchTerm: '叶片',
      matchOffset: 5,
    });
    const source = done.sources[0]!;
    expect(source.chunkText).toBe('巡检时发现叶片有裂纹');
    expect(source.matchTerm).toBe('叶片');
    expect(source.matchOffset).toBe(5);
  });

  it('老服务端不带这三个字段也照常解析（缺省降级）', async () => {
    const done = await streamWithSource(baseSource);
    const source = done.sources[0]!;
    expect(source.chunkText).toBeUndefined();
    expect(source.matchTerm).toBeUndefined();
    expect(source.matchOffset).toBeUndefined();
    expect(source.title).toBe('清洁作业流程');
  });

  it('matchTerm 整个 key 缺省且 matchOffset=-1：只留原文，不报错', async () => {
    const done = await streamWithSource({ ...baseSource, chunkText: '整段原文', matchOffset: -1 });
    const source = done.sources[0]!;
    expect(source.chunkText).toBe('整段原文');
    expect('matchTerm' in source).toBe(false);
    expect(source.matchOffset).toBe(-1);
  });

  it('类型不对的字段被丢弃，不废掉整条消息', async () => {
    const done = await streamWithSource({
      ...baseSource,
      chunkText: 123,
      matchTerm: null,
      matchOffset: 'x',
    });
    const source = done.sources[0]!;
    expect('chunkText' in source).toBe(false);
    expect('matchTerm' in source).toBe(false);
    expect('matchOffset' in source).toBe(false);
    expect(source.title).toBe('清洁作业流程');
  });

  it('老契约字段依旧严格：score 类型不对照样失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        frame('meta', {
          mode: 'rag',
          provider: 'mock',
          retrieval: 'keyword',
          noHit: false,
          sources: [{ ...baseSource, score: 'x' }],
        }),
      ]),
    ));
    await expect(
      streamChat('问', null, { onMeta: () => {}, onDelta: () => {}, onDone: () => {} }),
    ).rejects.toThrow('sources.score 无效');
  });
});
