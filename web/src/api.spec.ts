import { describe, expect, it, vi, afterEach } from 'vitest';
import { STREAM_TIMEOUT_MS, SYNTH_TIMEOUT_MS, sendFeedback, streamChat, synthesizeSpeech, type ChatDone, type ChatMeta } from './api';

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
