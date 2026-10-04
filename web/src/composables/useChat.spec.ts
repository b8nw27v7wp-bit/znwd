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
  // 令牌存 sessionStorage（不是 localStorage）：测试里也要有它，否则取不到 storage 会静默退化成仅内存
  vi.stubGlobal('sessionStorage', memoryStorage());
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

  // 名字要说准：这条是 fetch 当场抛错、**一个 delta 都没收到**，所以走兜底文案——
  // 「保留半句」是下面「真·中途断流」那条的事，别再张冠李戴。
  it('fetch 失败且零 delta：重问后仍失败，兜底文案 + 错误标注', async () => {
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

/**
 * 同值 setZone 必须直接 no-op。
 *
 * 下拉重复点同一项、znwd:zone 事件回声都会走到这里；不拦的话每一声回声都要重打一次
 * 推荐问题接口，回环场景下还会放大成请求风暴——这是 zoneLink 防回环的最后一道闸。
 */
describe('展区同值设置', () => {
  it('同值 setZone 不重复请求推荐问题（含清空）', async () => {
    const suggestionCalls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/suggestions')) {
          suggestionCalls.push(url);
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const chat = useChat();
    await chat.setZone('pv-clean');
    await chat.setZone('pv-clean');
    expect(suggestionCalls.filter((u) => u.includes('zone=pv-clean')), '同值只该请求一次').toHaveLength(1);

    await chat.setZone(null);
    await chat.setZone(null);
    expect(suggestionCalls.filter((u) => !u.includes('zone=')), '清空同值也只该请求一次').toHaveLength(1);
  });
});

/**
 * 会话归属令牌（服务端 2026-09-29 收紧）。
 *
 * 服务端对下发过令牌的会话：GET/DELETE 不带或不匹配一律 404。
 * 前端要是把令牌丢了，「换人清上下文」就会 404 失败——而现场看不出来（大屏照样清屏），
 * 上一轮的对话却还留在服务端。这条测试盯的就是这条链。
 */
describe('会话归属令牌', () => {
  it('done 帧下发的令牌存进内存与 sessionStorage，startOver 删会话时带回服务端', async () => {
    const deleteInits: RequestInit[] = [];
    stubFetch({
      '/api/sessions/': (init) => {
        deleteInits.push(init ?? {});
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      '/api/suggestions': () => new Response(JSON.stringify({ items: [] }), { status: 200 }),
      '/api/chat/stream': () => sse(
        'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"sources":[]}\n\n',
        'event:delta\ndata:{"text":"好"}\n\n',
        'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"好","latencyMs":1,"sessionToken":"tok-abc123"}\n\n',
      ),
    });

    const chat = useChat();
    expect(chat.sessionToken.value, '起手没有令牌').toBe('');

    await chat.ask('问一句');
    expect(chat.sessionToken.value, 'done 帧的令牌要收下来').toBe('tok-abc123');
    expect(sessionStorage.getItem('znwd.sessionToken')).toBe('tok-abc123');

    await chat.startOver();
    const headers = (deleteInits[0]?.headers ?? {}) as Record<string, string>;
    expect(headers['x-session-token'], '删会话必须带上令牌，否则服务端 404、上下文没清掉').toBe('tok-abc123');
    expect(chat.sessionToken.value, '旧令牌只对旧会话有效，换会话后必须丢掉').toBe('');
    expect(sessionStorage.getItem('znwd.sessionToken')).toBeNull();
  });
});

/**
 * P1-4：零 delta 的失败自动重问一次。
 *
 * 连接僵死/inactivity 这类故障「重开一条流多半就好」，而展厅访客不会主动点重试。
 * 三道防双发闸：已有 delta（content 非空）、已重问过、总超时（再等 180s 没有意义）。
 * 重试仍失败才把错误亮给用户；第一次的失败不记技术问题（只有终态才记）。
 */
describe('零 delta 自动重问', () => {
  const META = 'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[]}\n\n';
  const OK_STREAM = () =>
    sse(
      META,
      'event:delta\ndata:{"text":"不停机。"}\n\n',
      'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"不停机。","latencyMs":42}\n\n',
    );

  it('零 delta 的失败自动重问一次，第二次成功才上屏', async () => {
    let calls = 0;
    stubFetch({
      '/api/chat/stream': () => {
        calls += 1;
        if (calls === 1) throw new Error('网络中断');
        return OK_STREAM();
      },
    });
    const chat = useChat();
    await chat.ask('问一句');
    expect(calls, '首发失败要自动重问一次').toBe(2);
    expect(chat.messages.value[1]?.content).toBe('不停机。');
    expect(chat.messages.value[1]?.error).toBeUndefined();
    expect(chat.errors.value, '第一次失败不算终态，不该记技术问题').toHaveLength(0);
    expect(chat.streaming.value).toBe(false);
  });

  it('已收到 delta 后失败不重问（保留半句，直接标注错误）', async () => {
    let calls = 0;
    stubFetch({
      '/api/chat/stream': () => {
        calls += 1;
        return sse(META, 'event:delta\ndata:{"text":"半句"}\n\n'); // done 前 EOF
      },
    });
    const chat = useChat();
    await chat.ask('问一句');
    expect(calls, '已有 delta 再重问会把半句答成两遍').toBe(1);
    const answer = chat.messages.value[1];
    expect(answer?.content).toBe('半句');
    expect(answer?.error).toBe('SSE 流在 done 前结束');
    expect(answer?.pending).toBe(false);
    expect(chat.streaming.value).toBe(false);
  });

  /**
   * 真·中途断流：和上面那条「done 前 EOF」不同，这里是流**已经吐出字**之后
   * read 直接 reject（连接被掐断）——半句必须留在屏上、错误要标注、
   * 按重试三道闸（已有 delta）一次都不能重问。
   */
  it('真·中途断流：已吐两个 delta 后连接中断，保留半句且不自动重问', async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const cancel = vi.fn().mockResolvedValue(undefined);
    let step = 0;
    stubFetch({
      '/api/chat/stream': () => {
        calls += 1;
        // 桩一个假 Response：第一次 read 吐 meta+两个 delta，第二次 read 直接失败
        return {
          ok: true,
          body: {
            getReader: () => ({
              read: () => {
                step += 1;
                if (step === 1) {
                  return Promise.resolve({
                    done: false,
                    value: encoder.encode(
                      META +
                        'event:delta\ndata:{"text":"不需要"}\n\n' +
                        'event:delta\ndata:{"text":"停"}\n\n',
                    ),
                  });
                }
                return Promise.reject(new Error('network connection lost'));
              },
              cancel,
            }),
          },
        } as unknown as Response;
      },
    });

    const chat = useChat();
    await chat.ask('问一句');

    expect(calls, '已有 delta 再重问会把半句答成两遍').toBe(1);
    const answer = chat.messages.value[1];
    expect(answer?.content, '断流前收到的两个 delta 要留在屏上').toBe('不需要停');
    expect(answer?.error).toBe('network connection lost');
    expect(answer?.pending).toBe(false);
    expect(chat.error.value).toBe('network connection lost');
    expect(chat.errors.value, '终态失败要记一条技术问题').toHaveLength(1);
    expect(chat.streaming.value).toBe(false);
    expect(cancel, '失败路径必须取消 reader').toHaveBeenCalledTimes(1);
  });

  it('重问仍失败才把错误亮给用户，且只记一条技术问题', async () => {
    let calls = 0;
    stubFetch({
      '/api/chat/stream': () => {
        calls += 1;
        throw new Error('网络中断');
      },
    });
    const chat = useChat();
    await chat.ask('问一句');
    expect(calls, '至多重问一次').toBe(2);
    const answer = chat.messages.value[1];
    expect(answer?.content).toBe('这条问题暂时没能回答，请再试一次。');
    expect(answer?.error).toBe('网络中断');
    expect(chat.error.value).toBe('网络中断');
    expect(chat.errors.value, '两次失败只记一条（不翻倍刷运营视图）').toHaveLength(1);
  });

  it('总超时（180s）不重问：心跳压着活性、到上限才失败，只发一次请求', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const encoder = new TextEncoder();
    stubFetch({
      '/api/chat/stream': () => {
        calls += 1;
        // 挂死但每 15s 心跳：活性计时永不触发，只有 180s 总上限能结束它
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(':ping\n\n'));
              const beat = () => {
                try {
                  controller.enqueue(encoder.encode(':ping\n\n'));
                } catch {
                  return;
                }
                setTimeout(beat, 15_000);
              };
              setTimeout(beat, 15_000);
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
    });
    const chat = useChat();
    const asking = chat.ask('问一句');
    // 排干微任务：让首只 read 起跑（消费已入队的 :ping、刷新活性），心跳循环挂上假钟
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(180_000);
    await vi.advanceTimersByTimeAsync(0);
    await asking;
    expect(calls, '总超时重问只会把失败再拖 180s').toBe(1);
    expect(chat.messages.value[1]?.error).toBe('流式回答超时');
    expect(chat.errors.value).toHaveLength(1);
    expect(chat.streaming.value).toBe(false);
    vi.useRealTimers();
  });
});
