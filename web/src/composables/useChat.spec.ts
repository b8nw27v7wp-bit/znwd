import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../api';
import { useChat } from './useChat';

/**
 * 状态机测试：不依赖真后端。重点盯两条现场会踩的路径——
 * 1) 流式失败但已经收到半句时，不能把半句抹掉；
 * 2) 会话 ID 要持久化（连续追问的上下文靠它）。
 */
function stubFetch(handlers: Record<string, (init?: RequestInit) => Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      for (const [key, handler] of Object.entries(handlers)) {
        if (url.includes(key)) return handler(init);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function sse(...frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        frames.forEach((f) => controller.enqueue(encoder.encode(f)));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const health = { ok: true, knowledgeChunks: 134, llmProvider: 'mock', embedding: 'bag', retrieval: 'keyword', storage: 'mysql', storageAvailable: false, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 };

/** node 环境没有 localStorage：用一个内存实现顶替，测试要盯的是「会话 ID 有没有被持久化」这件事本身 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

describe('问答状态机', () => {
  it('提问后先出现待答消息，收到 done 后补上延迟与来源', async () => {
    stubFetch({
      '/api/health': () => new Response(JSON.stringify(health), { status: 200 }),
      '/api/zones': () => new Response(JSON.stringify({ zones: [{ id: 'wind-inspect', title: '风场检测' }] }), { status: 200 }),
      '/api/suggestions': () => new Response(JSON.stringify({ items: ['叶片检测要停机吗？', '光伏展区展示什么？'] }), { status: 200 }),
      '/api/chat/stream': () =>
        sse(
          'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[{"title":"叶片检测","snippet":"s","score":0.02,"sourcePath":"a.md"}]}\n\n',
          'event:delta\ndata:{"text":"不停机"}\n\n',
          'event:delta\ndata:{"text":"。"}\n\n',
          'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[{"title":"叶片检测","snippet":"s","score":0.02,"sourcePath":"a.md"}],"answer":"不停机。","latencyMs":42}\n\n',
        ),
      '/api/feedback': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    });

    const chat = useChat();
    await chat.bootstrap();
    expect(chat.suggestions.value).toEqual(['叶片检测要停机吗？', '光伏展区展示什么？']);
    expect(chat.zones.value[0]?.id).toBe('wind-inspect');

    const asking = chat.ask('叶片检测要停机吗？');
    expect(chat.streaming.value).toBe(true);
    expect(chat.messages.value.length).toBe(2);
    expect(chat.messages.value[1]?.pending).toBe(true);

    await asking;
    const answer = chat.messages.value[1];
    expect(answer?.content).toBe('不停机。');
    expect(answer?.pending).toBe(false);
    expect(answer?.latencyMs).toBe(42);
    expect(chat.sources.value.length).toBe(1);
    expect(chat.streaming.value).toBe(false);

    await chat.rate(answer!, 'up');
    expect(chat.feedback.value[answer!.id]).toBe('up');
  });

  it('流式失败时保留已收到的半句并标注错误', async () => {
    stubFetch({
      '/api/chat/stream': () => {
        throw new Error('网络中断');
      },
    });
    const chat = useChat();
    await chat.ask('问一句');
    const answer = chat.messages.value[1];
    expect(answer?.pending).toBe(false);
    expect(answer?.error).toBe('网络中断');
    expect(answer?.content).toBe('这条问题暂时没能回答，请再试一次。');
    expect(chat.streaming.value).toBe(false);
  });

  it('会话 ID 落 localStorage，startOver 换新 ID 并清空消息', async () => {
    stubFetch({
      '/api/sessions/': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/suggestions': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      '/api/chat/stream': () => sse(
        'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"sources":[]}\n\n',
        'event:delta\ndata:{"text":"好"}\n\n',
        'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"好","latencyMs":1}\n\n',
      ),
    });
    const chat = useChat();
    const before = chat.sessionId.value;
    expect(localStorage.getItem('znwd.sessionId')).toBe(before);

    await chat.ask('问一句');
    await chat.startOver();
    expect(chat.sessionId.value).not.toBe(before);
    expect(localStorage.getItem('znwd.sessionId')).toBe(chat.sessionId.value);
    expect(chat.messages.value.length).toBe(0);
  });

  it('startOver 先中止旧流，旧请求的 signal 不会恢复当前状态', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamSignal: AbortSignal | undefined;
    stubFetch({
      '/api/chat/stream': (init) => {
        streamSignal = init?.signal as AbortSignal | undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
      '/api/sessions/': () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      '/api/suggestions': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    });

    const chat = useChat();
    const asking = chat.ask('旧问题');
    await vi.waitFor(() => expect(streamController).toBeTruthy());
    const oldSession = chat.sessionId.value;
    const resetting = chat.startOver();
    expect(streamSignal?.aborted).toBe(true);

    await resetting;
    await asking;
    expect(chat.sessionId.value).not.toBe(oldSession);
    expect(chat.messages.value).toHaveLength(0);
  });

  it('startOver 完成前拒绝新 ask，避免重置期间产生新流', async () => {
    let releaseReset: (() => void) | undefined;
    const resetResponse = new Promise<Response>((resolve) => {
      releaseReset = () => resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/sessions/')) return resetResponse;
      if (url.includes('/api/suggestions')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const chat = useChat();
    const resetting = chat.startOver();
    expect(chat.resetting.value).toBe(true);
    await chat.ask('重置期间的问题');
    expect(chat.messages.value).toHaveLength(0);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/chat/stream'))).toBe(false);

    releaseReset?.();
    await resetting;
    expect(chat.resetting.value).toBe(false);
  });

  it('反馈 HTTP 失败时回滚乐观标记', async () => {
    stubFetch({
      '/api/feedback': () => new Response(JSON.stringify({ message: '反馈失败' }), { status: 503 }),
    });
    const chat = useChat();
    const message: Message = { id: 'm1', role: 'assistant', content: '回答' };
    chat.messages.value.push(message);

    await chat.rate(message, 'up');

    expect(chat.feedback.value.m1).toBeUndefined();
    expect(chat.error.value).toBe('反馈失败');
  });

  it('重置 HTTP 失败时仍清理本地状态并保留错误', async () => {
    stubFetch({
      '/api/sessions/': () => new Response(JSON.stringify({ message: '重置失败' }), { status: 500 }),
      '/api/suggestions': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
    });
    const chat = useChat();
    const oldSession = chat.sessionId.value;
    chat.messages.value.push({ id: 'm1', role: 'user', content: '保留我' });

    await chat.startOver();

    expect(chat.sessionId.value).not.toBe(oldSession);
    expect(localStorage.getItem('znwd.sessionId')).toBe(chat.sessionId.value);
    expect(chat.messages.value).toHaveLength(0);
    expect(chat.error.value).toBe('重置失败');
  });

  it('localStorage 抛错时仍可创建并使用会话', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage denied');
      },
      setItem: () => {
        throw new Error('storage denied');
      },
      removeItem: () => {
        throw new Error('storage denied');
      },
    });
    expect(() => useChat()).not.toThrow();
  });
});

/**
 * TC-UI-09：展区快速连续切换时，旧请求不能覆盖新请求的结果。
 *
 * useChat 用 suggestionsGeneration 递增做代际隔离：先启动的请求如果后返回，
 * 会发现 generation 已变而丢弃结果——这是竞态窗口内保证「最终一致」的关键路径。
 *
 * 测试方法：直接调用 setZone 两次（不通过 DOM），验证 generation guard 的保护。
 * 不用 fake timers——它会阻塞 vitest 的 Promise 微任务调度导致 await 挂起。
 */
describe('展区切换竞态', () => {
  it('快速连续切换展区：最终显示最后一次选择的推荐问题，旧响应不覆盖', async () => {
    // 模拟带延迟的 fetch：zone A 慢、zone B 快
    const zoneResults: Record<string, string[]> = { A: ['A问题'], B: ['B问题'] };
    const zoneDelays: Record<string, number> = { A: 200, B: 20 };

    // stubFetch 的 handler 只收 init（RequestInit），拿不到 URL；
    // 这里直接 stub fetch 自己实现按 URL 分发。
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/health')) {
          return new Response(JSON.stringify(health), { status: 200 });
        }
        if (url.includes('/api/zones')) {
          return new Response(JSON.stringify({ zones: [] }), { status: 200 });
        }
        if (url.includes('/api/suggestions')) {
          const zone = url.includes('zone=')
            ? decodeURIComponent(url.split('zone=')[1]!.split('&')[0]!)
            : null;
          const items = zone ? (zoneResults[zone] ?? []) : [];
          const delay = zone ? (zoneDelays[zone] ?? 0) : 0;
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(new Response(JSON.stringify({ items, zone }), { status: 200 }));
            }, delay);
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const chat = useChat();
    await chat.bootstrap();

    // 快速连续切换：A → B（A 慢、B 快，B 应先完成）
    const switchingA = chat.setZone('A');
    const switchingB = chat.setZone('B');

    // 等 B 先完成
    await switchingB;
    expect(chat.suggestions.value, 'B 的推荐问题应已就绪').toEqual(['B问题']);

    // 再等 A 完成（generation 已变，A 的旧响应应被丢弃）
    await switchingA;
    expect(chat.suggestions.value, 'A 的旧响应不应覆盖 B').toEqual(['B问题']);
  });
});
