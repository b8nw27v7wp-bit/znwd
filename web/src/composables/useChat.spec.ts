import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      '/api/chat/stream': () => sse('event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"好","latencyMs":1}\n\n'),
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
});
