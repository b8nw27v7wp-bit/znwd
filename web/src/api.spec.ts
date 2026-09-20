import { describe, expect, it, vi, afterEach } from 'vitest';
import { streamChat, type ChatDone, type ChatMeta } from './api';

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
  vi.restoreAllMocks();
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

  it('心跳注释帧被忽略，不影响事件序列', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        ': ping\n\n',
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
    expect(events).toEqual(['delta', 'done']);
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
});
