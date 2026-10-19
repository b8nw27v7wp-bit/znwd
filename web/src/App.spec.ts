// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { SEGMENT_FIRST_MS } from './composables/useSegmentStream';
import App from './App.vue';
import AvatarPortrait from './components/AvatarPortrait.vue';

/**
 * 展厅页面（App.vue）的接线测试：用真组件 + 假合成器，验证四条现场行为——
 * 1) 页面上不放运营入口（四个入口与底部小字都不显示），运营视图只能靠 `?admin=1` 打开；
 *    技术问题（落库状态、回答失败）一律走聊天窗口或运营视图，页面上不弹横幅；
 * 2) 回答流式结束后整段自动朗读，且读的是洗过的正文；
 * 3) 关掉朗读开关后不再朗读，且选择落 localStorage（重启保持）；
 * 4) 重新开始 / 朗读中点「停读」都能立刻停止。
 *
 * 为什么要有这一层：composable 单测只覆盖了「怎么读」，读不读、什么时候读是 App.vue 里的
 * 两个 watcher 决定的，只能挂载真组件才验得到。
 */

class FakeUtterance {
  text: string;
  lang = '';
  rate = 1;
  pitch = 1;
  voice: unknown = null;
  volume = 1;
  onend: (() => void) | null = null;
  onerror: ((ev?: { error?: string }) => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

/** reject=true 时模拟浏览器的自动播放策略：speak 立刻回 not-allowed（自动播放拦截机理，见 CHANGELOG 2026-09-22 条目） */
function installSpeech(options: { reject?: boolean } = {}) {
  const spoken: string[] = [];
  const utterances: FakeUtterance[] = [];
  const synth = {
    speaking: false,
    speak(u: FakeUtterance) {
      utterances.push(u);
      spoken.push(u.text);
      synth.speaking = true;
      if (options.reject) u.onerror?.({ error: 'not-allowed' });
    },
    cancel() {
      synth.speaking = false;
    },
    resume() {},
    getVoices: () => [{ lang: 'zh-CN', name: 'Tingting' }],
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true });
  return { spoken, synth, utterances };
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

const ANSWER = '**叶片检测**不需要停机，按巡检规程 https://example.com/a 执行即可。';

function stubFetch(storageAvailable = true, streamFails = false, answer = ANSWER, sources: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({ ok: true, knowledgeChunks: 134, llmProvider: 'mock', embedding: 'bag', retrieval: { mode: 'keyword', keywordChunks: 134 }, storage: 'mysql', storageAvailable, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 }),
          { status: 200 },
        );
      }
      if (url.includes('/api/zones')) {
        return new Response(
          JSON.stringify({ zones: [{ id: 'wind-inspect', title: '风场检测' }, { id: 'pv-clean', title: '光伏清洁' }] }),
          { status: 200 },
        );
      }
      if (url.includes('/api/suggestions')) return new Response(JSON.stringify({ items: ['叶片检测要停机吗？'] }), { status: 200 });
      if (url.includes('/api/chat/stream')) {
        if (streamFails) throw new Error('网络中断');
        const src = JSON.stringify(sources);
        return sse(
          `event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":${src}}\n\n`,
          `event:delta\ndata:{"text":${JSON.stringify(answer)}}\n\n`,
          `event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":${src},"answer":${JSON.stringify(answer)},"latencyMs":42}\n\n`,
        );
      }
      if (url.includes('/api/feedback')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes('/api/sessions/')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function askAndWait(wrapper: ReturnType<typeof mount>) {
  await wrapper.find('textarea').setValue('叶片检测要停机吗？');
  await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain('不需要停机');
  });
  await flushPromises();
}

/** 运营视图只能靠 URL 参数打开（页面上不再放按钮） */
function mountWithAdmin() {
  window.history.replaceState({}, '', '/?admin=1');
  return mount(App);
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, '', '/');
  // 展览桥是全局副作用：上个用例万一没卸载干净，这里兜底清掉，避免跨用例污染
  delete (window as unknown as { znwdSetZone?: unknown }).znwdSetZone;
  vi.unstubAllGlobals();
  stubFetch();
});

type FakeAudioEl = {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  play: () => Promise<void>;
  pause: () => void;
};

/**
 * health 报「服务端语音可用」+ 合成接口回 WAV 的环境。
 *
 * 与 stubFetch 的差别只在于 health 带 speechReady、并多一个 /api/speech/synthesize：
 * 用来验接线——探到的可用性有没有真的改变播报路径，运营视图有没有如实写出来源。
 */
function stubServerSpeech(audios: FakeAudioEl[], calls: string[], speechReady: () => boolean = () => true): void {
  class FakeURL extends (globalThis.URL as unknown as typeof URL) {
    static createObjectURL(): string {
      return 'blob:fake/1';
    }
    static revokeObjectURL(): void {}
  }
  vi.stubGlobal('URL', FakeURL);
  vi.stubGlobal(
    'Audio',
    class {
      src: string;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(src: string) {
        this.src = src;
        audios.push(this as unknown as FakeAudioEl);
      }
      play(): Promise<void> {
        return Promise.resolve();
      }
      pause(): void {}
    },
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/api/health')) {
        const ready = speechReady();
        return new Response(
          JSON.stringify({ ok: true, knowledgeChunks: 134, llmProvider: 'openai_compat', speech: ready ? 'mimo' : 'none', speechReady: ready, embedding: 'bag', retrieval: { mode: 'keyword', keywordChunks: 134 }, storage: 'mysql', storageAvailable: true, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 }),
          { status: 200 },
        );
      }
      if (url.includes('/api/zones')) return new Response(JSON.stringify({ zones: [] }), { status: 200 });
      if (url.includes('/api/suggestions')) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      if (url.includes('/api/chat/stream')) {
        return sse(
          'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[]}\n\n',
          `event:delta\ndata:{"text":${JSON.stringify(ANSWER)}}\n\n`,
          `event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":${JSON.stringify(ANSWER)},"latencyMs":42}\n\n`,
        );
      }
      if (url.includes('/api/speech/synthesize')) {
        // 刻意用普通对象而不是 `new Response(new Blob(...))`：CI（Node 22）+ jsdom 下，
        // undici 的 Response 构造器拿到 jsdom 的 Blob 会让 `res.blob()` 永远不返回——
        // 表现是「合成请求发出去了，但一个 Audio 都没建，日志里也没有任何降级原因」。
        // 本机 Node 26 不会暴露这个差异（所以本地一直是绿的）。useSpeech.spec 用的一直是
        // 这个写法，跨 Node 版本都稳；改这里请保持同样的形态。
        return {
          ok: true,
          status: 200,
          blob: async () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

describe('展厅页面：服务端语音接线', () => {
  /** performance.now 探针的复位钩子：延迟埋点要把时钟拨到指定的时刻 */
  let restoreNow: (() => void) | undefined;
  afterEach(() => {
    restoreNow?.();
    restoreNow = undefined;
  });

  it('health 报语音可用时播报走服务端，运营视图如实写出来源', async () => {
    const audios: FakeAudioEl[] = [];
    const calls: string[] = [];
    stubServerSpeech(audios, calls);

    const wrapper = mountWithAdmin();
    await flushPromises();
    await askAndWait(wrapper);

    // 两条断言都要等：`fetch` 打完到 `new Audio(...)` 之间还隔着 `await res.blob()`，
    // 只等「请求发出去了」会在慢机器上抓到 audios 还是空的那一帧（CI 上实测就是这么红的）。
    await vi.waitFor(() => {
      expect(calls.some((url) => url.includes('/api/speech/synthesize')), '合成请求要打到服务端').toBe(true);
      expect(audios.length, '服务端播报要用 Audio 播').toBeGreaterThan(0);
    });
    await vi.waitFor(() => {
      expect(wrapper.find('.local-set').text(), '运营视图要写明这一轮是谁发的声').toContain('服务端 TTS');
    });

    wrapper.unmount();
  });

  /**
   * 三段延迟的后两段（§4 P2 修订 1）：终稿→首句生成、首句→首段音频。
   *
   * <p>它们跨了 chat 与 speech 两个 composable，只有 App 看得全，所以打点在提问入口
   * 与两个 watcher 里——正是那种「改一处接线就悄悄不再上报」的地方，值得一条回归。
   *
   * <p>这里的合成响应**故意卡住**（而不是复用 stubServerSpeech）：不卡的话「首句生成」与
   * 「首段音频」落在同一个微任务批次里，两段延迟会在同一个时刻结算，这一段埋点写错了也看不出来。
   */
  it('终稿→首句→首音的延迟在 App 里打点并进遥测', async () => {
    let releaseSynth: (() => void) | undefined;
    const synthGate = new Promise<void>((resolve) => {
      releaseSynth = resolve;
    });
    class FakeURL extends (globalThis.URL as unknown as typeof URL) {
      static createObjectURL(): string {
        return 'blob:fake/1';
      }
      static revokeObjectURL(): void {}
    }
    vi.stubGlobal('URL', FakeURL);
    vi.stubGlobal(
      'Audio',
      class {
        src: string;
        ended = false;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(src: string) {
          this.src = src;
        }
        play(): Promise<void> {
          return Promise.resolve();
        }
        pause(): void {}
      },
    );
    stubFetchWith((url) => {
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({ ok: true, knowledgeChunks: 1, llmProvider: 'mock', speech: 'mimo', speechReady: true, embedding: 'bag', retrieval: { mode: 'keyword', keywordChunks: 1 }, storage: 'mysql', storageAvailable: true, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 }),
          { status: 200 },
        );
      }
      if (url.includes('/api/chat/stream')) {
        // 收尾帧放到下一个宏任务：`sse()` 一次把三帧全塞进去时，streaming 会在同一个微任务
        // 批次里翻回 false，App 那两个 watcher 根本看不到「流开始了」（beginAnswer/endAnswer
        // 全被跳过，合成请求也就发不出去）。真实后端本来就是一帧一帧来的，这里照着它来。
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(
                'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[]}\n\n',
              ));
              controller.enqueue(encoder.encode(`event:delta\ndata:{"text":${JSON.stringify(ANSWER)}}\n\n`));
              setTimeout(() => {
                controller.enqueue(encoder.encode(
                  `event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":${JSON.stringify(ANSWER)},"latencyMs":42}\n\n`,
                ));
                controller.close();
              }, 0);
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (url.includes('/api/speech/synthesize')) {
        // 形态与 stubServerSpeech 一致（普通对象而不是 new Response(new Blob(...))，理由见那里）
        return synthGate.then(() => ({
          ok: true,
          status: 200,
          blob: async () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: 'audio/wav' }),
        })) as unknown as Response;
      }
      return undefined;
    });
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();

    const wrapper = mountWithAdmin();
    // 等 bootstrap 把 health 的 speechReady 灌进 useSpeech：没灌进去时 resolveEngine() 是 null，
    // 整条播报链根本不启动（也就没有首音这一段）
    await vi.waitFor(() => {
      expect(wrapper.find('.local-set').text()).toContain('服务端 TTS');
    });

    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    now.mockReturnValue(1_100); // 提问发出
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    now.mockReturnValue(1_700); // 首句生成：流里的句末标点到达
    await flushPromises();
    now.mockReturnValue(2_100); // 首段音频起播：合成回来 → play() 落地
    releaseSynth?.();
    await flushPromises();

    wrapper.unmount(); // 卸载会冲刷最后一批遥测，不必去推 15 秒的定时器
    const body = metricsBody();
    expect(body?.firstSentenceCount, '终稿 → 首句生成').toBe(1);
    expect(body?.firstSentenceSumMs).toBe(600);
    expect(body?.firstAudioCount, '首句 → 首段音频').toBe(1);
    expect(body?.firstAudioSumMs).toBe(400);
  });

  /**
   * 服务端播报降级之后**要能自己恢复**。
   *
   * <p>降级是当场生效的（上游抖一下就立刻退回浏览器合成，这是对的），但 health 平时只在挂载时
   * 取一次——没有这条低频重探，一次抖动就会把整台机器的音色永久换掉，直到有人手刷页面，
   * 而运营只能靠翻 ?admin=1 才知道「这一台的播报来源变了」。
   */
  it('上游恢复后按周期重探 health，把播报切回服务端 TTS', async () => {
    vi.useFakeTimers();
    let ready = false;
    const audios: FakeAudioEl[] = [];
    const calls: string[] = [];
    stubServerSpeech(audios, calls, () => ready);

    const wrapper = mountWithAdmin();
    await flushPromises();
    expect(wrapper.find('.local-set').text(), '上游没起来：当场退回浏览器合成').not.toContain('服务端 TTS');
    expect(calls.filter((url) => url.includes('/api/health')).length).toBe(1);

    ready = true;
    await vi.advanceTimersByTimeAsync(60_000); // 一个重探周期
    await flushPromises();

    expect(calls.filter((url) => url.includes('/api/health')).length, '重探就是再取一次 health').toBe(2);
    expect(wrapper.find('.local-set').text(), '恢复不该等人手刷页面').toContain('服务端 TTS');

    vi.useRealTimers();
    wrapper.unmount();
  });
});

describe('展厅页面：界面入口与语音播报接线', () => {
  it('页面上不显示四个入口与底部小字，运营视图用 ?admin=1 打开', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    const text = wrapper.text();
    for (const gone of ['134 条资料', '朗读：', '新对话', '运营视图', '回车发送']) {
      expect(text).not.toContain(gone);
    }
    expect(wrapper.find('.drawer').exists()).toBe(false);
    wrapper.unmount();

    const admin = mountWithAdmin();
    await flushPromises();
    expect(admin.find('.drawer').exists()).toBe(true);
    expect(admin.find('.local-set').text()).toContain('回答朗读');
    expect(admin.find('.local-set').text()).toContain('重新开始');
    admin.unmount();
  });

  it('数据库未连接时页面上不提示，状态只出现在运营视图里', async () => {
    installSpeech();
    stubFetch(false);
    const wrapper = mount(App);
    await flushPromises();

    const text = wrapper.text();
    expect(text).not.toContain('数据库未连接');
    expect(text).not.toContain('init.sql');
    expect(wrapper.find('.banner').exists()).toBe(false);
    wrapper.unmount();

    const admin = mountWithAdmin();
    await flushPromises();
    expect(admin.find('.local-set').text()).toContain('未连接');
    admin.unmount();
  });

  it('回答失败时大屏只给友好提示，技术原因收在运营视图里', async () => {
    installSpeech();
    stubFetch(true, true);

    const wrapper = mountWithAdmin();
    await flushPromises();
    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find('.msg.assistant .answer').text()).toContain('这条问题暂时没能回答');
    });
    await flushPromises();

    // 对话区只有一句人话：技术原因、错误横幅都不该出现在大屏上
    expect(wrapper.find('.msg.assistant').text()).not.toContain('网络中断');
    expect(wrapper.find('.msg-error').exists()).toBe(false);
    expect(wrapper.find('.banner').exists()).toBe(false);
    expect(wrapper.find('.main').text()).not.toContain('技术问题');

    // 运营视图里能看到这条故障（问题原文 + 原因 + 时间）
    const log = wrapper.find('.tech-log');
    expect(log.exists()).toBe(true);
    expect(log.text()).toContain('叶片检测要停机吗？');
    expect(log.text()).toContain('网络中断');

    // 清空后列表消失
    await log.find('button').trigger('click');
    expect(wrapper.find('.tech-log').exists()).toBe(false);

    wrapper.unmount();
  });

  it('展区下拉：展开、选中标记、选择后收起并带展区重取推荐问题', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    const trigger = wrapper.find('.zone-trigger');
    expect(trigger.text()).toBe('全部展区');
    expect(wrapper.find('.zone-menu').exists()).toBe(false);

    await trigger.trigger('click');
    const options = wrapper.findAll('.zone-option');
    expect(options.map((o) => o.text())).toEqual(['全部展区', '风场检测', '光伏清洁']);
    expect(options[0]!.classes()).toContain('on'); // 默认选中"全部展区"

    await options[1]!.trigger('click');
    expect(wrapper.find('.zone-menu').exists()).toBe(false);
    expect(wrapper.find('.zone-trigger').text()).toBe('风场检测');

    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/api/suggestions?zone=wind-inspect'))).toBe(true);

    // 再展开：选中项跟着走，Esc 与点空白都能关
    await wrapper.find('.zone-trigger').trigger('click');
    expect(wrapper.findAll('.zone-option')[1]!.classes()).toContain('on');
    await wrapper.find('.zone-trigger').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.zone-menu').exists()).toBe(false);

    await wrapper.find('.zone-trigger').trigger('click');
    await wrapper.find('.zone-backdrop').trigger('click');
    expect(wrapper.find('.zone-menu').exists()).toBe(false);

    wrapper.unmount();
  });

  it('回答流式结束后自动朗读洗过的正文', async () => {
    const { spoken } = installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    await askAndWait(wrapper);

    const read = spoken.join('');
    expect(read).toContain('叶片检测不需要停机'); // 洗掉了 ** 与 URL
    expect(read).not.toContain('**');
    expect(read).not.toContain('http');

    wrapper.unmount();
  });

  it('回答失败（流中断）时一个字都不读：增量喂入在错误路径要被 stop 收口', async () => {
    const { spoken } = installSpeech();
    stubFetch(true, true); // streamFails：两次尝试都断，走 catch 的错误文案
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('这条问题暂时没能回答'));
    await flushPromises();

    expect(spoken).toEqual([]);
    wrapper.unmount();
  });

  it('关掉朗读开关后不再朗读，且选择落 localStorage', async () => {
    const { spoken } = installSpeech();
    const wrapper = mountWithAdmin();
    await flushPromises();

    const toggle = wrapper.find('.local-set .row button');
    expect(toggle.text()).toBe('开');
    await toggle.trigger('click');
    expect(wrapper.find('.local-set .row button').text()).toBe('关');
    expect(localStorage.getItem('znwd.speak')).toBe('0');

    const before = spoken.length;
    await askAndWait(wrapper);
    expect(spoken.length).toBe(before); // 关掉后一个字都不读

    wrapper.unmount();
  });

  it('重新开始会停掉正在读的回答并清空消息', async () => {
    const { spoken, synth } = installSpeech();
    const cancelSpy = vi.spyOn(synth, 'cancel');
    const wrapper = mountWithAdmin();
    await flushPromises();
    await askAndWait(wrapper);
    expect(spoken.length).toBeGreaterThan(0);

    const restart = wrapper.findAll('.local-set .row button').find((b) => b.text() === '重新开始');
    await restart!.trigger('click');
    await flushPromises();

    expect(cancelSpy).toHaveBeenCalled();
    expect(wrapper.findAll('.msg').length).toBe(0);

    wrapper.unmount();
  });

  it('朗读中显示「停读」，点了立刻停且不影响开关', async () => {
    const { synth } = installSpeech();
    const cancelSpy = vi.spyOn(synth, 'cancel');
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.findAll('button').some((b) => b.text() === '停读')).toBe(false);

    await askAndWait(wrapper);
    const stop = wrapper.findAll('button').find((b) => b.text() === '停读');
    expect(stop).toBeTruthy();

    await stop!.trigger('click');
    expect(cancelSpy).toHaveBeenCalled();
    expect(wrapper.findAll('button').some((b) => b.text() === '停读')).toBe(false);
    expect(localStorage.getItem('znwd.speak')).not.toBe('0'); // 停读不等于静音

    wrapper.unmount();
  });
});

/**
 * 注入面：模型的回答、知识片段的正文最终都会渲染到展厅大屏上。
 * 后端只回 JSON、排版函数只产出结构，这一层要验的是**浏览器里真的没有元素被造出来**——
 * 也就是 Vue 的文本插值确实把尖括号当文字了（而不是靠"我们没用 v-html"这句话）。
 */
describe('展厅页面：回答与片段里的 HTML 不上屏', () => {
  const XSS = '<img src=x onerror=alert(1)><script>alert(document.cookie)</script>';

  it('回答里的标签当文字渲染，不生成 img/script 元素', async () => {
    installSpeech();
    stubFetch(true, false, `检测结果 ${XSS} 如下`);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find('.msg.assistant .answer').text()).toContain('检测结果');
    });

    // 注意断言要精确：页面上本来就有一个合法的形象图 <img src="/avatar-guide.png">，
    // 所以查的是「载荷里的那个元素」而不是整页有没有 img（这条自己踩过一次）。
    expect(wrapper.find('.msg.assistant').element.querySelector('img, script, iframe')).toBeNull();
    expect(wrapper.element.querySelector('[onerror]')).toBeNull();
    expect(wrapper.element.querySelector('img[src="x"]')).toBeNull();
    // 原文照旧可读（当文字显示），并被转义成实体
    expect(wrapper.find('.msg.assistant .answer').text()).toContain(XSS);
    expect(wrapper.find('.msg.assistant .answer').html()).toContain('&lt;img');
    wrapper.unmount();
  });

  it('粗体记号里夹的标签也逃不出去', async () => {
    installSpeech();
    stubFetch(true, false, '**<b>加粗</b>** 与 <iframe src=//evil.example></iframe>');
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find('.msg.assistant .answer').text()).toContain('加粗');
    });

    expect(wrapper.find('.msg.assistant').element.querySelector('b, iframe')).toBeNull();
    expect(wrapper.element.querySelector('[src*="evil.example"]')).toBeNull();
    expect(wrapper.find('.msg.assistant .answer').html()).toContain('&lt;b');
    wrapper.unmount();
  });

  it('来源面板的片段同样是文字，不是节点', async () => {
    installSpeech();
    stubFetch(true, false, '回答正文', [
      { title: '恶意标题', snippet: `片段 ${XSS}`, score: 0.01, sourcePath: 'x.md', zone: null, zoneTitle: null, vectorScore: 0, keywordScore: 9.9 },
    ]);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find('.src-toggle').exists()).toBe(true);
    });
    await wrapper.find('.src-toggle').trigger('click');
    await flushPromises();

    expect(wrapper.find('.sources-block').exists()).toBe(true);
    expect(wrapper.find('.sources-block').element.querySelector('img, script, iframe')).toBeNull();
    expect(wrapper.find('.sources-block').element.querySelector('[onerror]')).toBeNull();
    expect(wrapper.find('.sources-block .snippet').text()).toContain(XSS);
    wrapper.unmount();
  });
});


/**
 * 对话主流程接线：除了「提问 → 出答案」之外的那几条路径——反馈上报、追问复用会话、
 * 点推荐问题、空输入与 Shift+Enter。这些以前全靠人工点，出问题只会表现为「点了没反应」。
 */
function fetchCalls(): Array<[string, RequestInit | undefined]> {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } }).mock.calls;
}

/**
 * 最后一批声学遥测的请求体。
 *
 * <p>遥测是攒批送的（15 秒一批），但**卸载时会冲刷一次**——所以在用例里 `unmount()`
 * 之后再读，就不必去推时钟。
 */
function metricsBody(): Record<string, number> | null {
  const call = fetchCalls().find((c) => String(c[0]).includes('/api/speech/metrics'));
  return call ? (JSON.parse(String(call[1]!.body)) as Record<string, number>) : null;
}

describe('展厅页面：对话主流程接线', () => {
  it('点「有帮助」把反馈连同上一轮问题一起上报', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();
    await askAndWait(wrapper);

    const up = wrapper.findAll('.msg-foot button').find((b) => b.text() === '有帮助')!;
    await up.trigger('click');
    await flushPromises();

    const call = fetchCalls().find((c) => String(c[0]).includes('/api/feedback'));
    expect(call).toBeTruthy();
    const body = JSON.parse(String(call![1]!.body));
    expect(body.rating).toBe('up');
    expect(body.question).toBe('叶片检测要停机吗？');
    expect(body.sessionId).toBeTruthy();
    expect(wrapper.find('.msg-foot button.on').text()).toBe('有帮助');
    wrapper.unmount();
  });

  it('连续追问复用同一个会话，上下文不丢', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();
    await askAndWait(wrapper);

    await wrapper.find('textarea').setValue('那要多久？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await vi.waitFor(() => {
      expect(fetchCalls().filter((c) => String(c[0]).includes('/api/chat/stream')).length).toBe(2);
    });

    const ids = fetchCalls()
      .filter((c) => String(c[0]).includes('/api/chat/stream'))
      .map((c) => JSON.parse(String(c[1]!.body)).sessionId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBe(localStorage.getItem('znwd.sessionId'));
    wrapper.unmount();
  });

  it('点推荐问题直接提问', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    const chip = wrapper.find('.chip');
    expect(chip.text()).toBe('叶片检测要停机吗？');
    await chip.trigger('click');
    await flushPromises();
    await vi.waitFor(() => {
      expect(wrapper.find('.msg.assistant .answer').text()).toContain('不需要停机');
    });

    expect(wrapper.find('.msg.user .bubble').text()).toBe('叶片检测要停机吗？');
    wrapper.unmount();
  });

  it('空白输入不发请求，Shift+Enter 也不发', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    const box = wrapper.find('textarea');
    await box.setValue('   ');
    await box.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(fetchCalls().some((c) => String(c[0]).includes('/api/chat'))).toBe(false);
    expect(wrapper.findAll('.msg').length).toBe(0);

    await box.setValue('叶片检测要停机吗？');
    await box.trigger('keydown', { key: 'Enter', shiftKey: true });
    await flushPromises();
    expect(fetchCalls().some((c) => String(c[0]).includes('/api/chat'))).toBe(false);
    wrapper.unmount();
  });
});

/**
 * 语音的两条现场行为（自动播放拦截的 P0/P1，见 CHANGELOG 2026-09-22 条目）：
 * 1) 被浏览器策略拦下时必须进「最近的技术问题」——大屏上不提示，但运营要能查到「为什么没声音」；
 * 2) 第一次真实手势要把语音解锁（空 utterance 暖机），且只解一次。
 */
describe('展厅页面：语音失败可见与手势解锁', () => {
  it('播报被浏览器拦下时进技术问题列表，大屏上不显示', async () => {
    installSpeech({ reject: true });
    const wrapper = mountWithAdmin();
    await flushPromises();
    await askAndWait(wrapper);

    const log = wrapper.find('.tech-log');
    expect(log.exists()).toBe(true);
    expect(log.text()).toContain('浏览器拦下了自动播报');
    expect(log.text()).toContain('not-allowed');
    // 参观者不该在大屏上看到技术信息
    expect(wrapper.find('.main').text()).not.toContain('浏览器拦下了');
    wrapper.unmount();
  });

  it('第一次真实手势解锁语音（静音空 utterance），且只解一次', async () => {
    const engine = installSpeech();
    const wrapper = mount(App);
    await flushPromises();
    expect(engine.utterances.length).toBe(0);

    window.dispatchEvent(new Event('pointerdown'));
    expect(engine.utterances.length, '首次手势应当暖机一次').toBe(1);
    expect(engine.utterances[0]!.text).toBe('');
    expect(engine.utterances[0]!.volume, '暖机不能真的出声').toBe(0);
    expect(wrapper.find('.local-set').exists()).toBe(false);

    window.dispatchEvent(new Event('pointerdown'));
    expect(engine.utterances.length, '解锁只做一次').toBe(1);
    wrapper.unmount();
  });
});

/** 默认的 fetch 桩：health / zones / suggestions 正常，chat/stream 返回正常流 */
function defaultFetchHandler(url: string): Response {
  if (url.includes('/api/health')) {
    return new Response(
      JSON.stringify({ ok: true, knowledgeChunks: 134, llmProvider: 'mock', embedding: 'bag', retrieval: { mode: 'keyword', keywordChunks: 134 }, storage: 'mysql', storageAvailable: true, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 }),
      { status: 200 },
    );
  }
  if (url.includes('/api/zones')) return new Response(JSON.stringify({ zones: [{ id: 'wind-inspect', title: '风场检测' }, { id: 'pv-clean', title: '光伏清洁' }] }), { status: 200 });
  if (url.includes('/api/suggestions')) return new Response(JSON.stringify({ items: ['叶片检测要停机吗？'] }), { status: 200 });
  if (url.includes('/api/chat/stream')) {
    return sse(
      'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[]}\n\n',
      'event:delta\ndata:{"text":"正常回答"}\n\n',
      'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"正常回答","latencyMs":10}\n\n',
    );
  }
  if (url.includes('/api/feedback')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
  if (url.includes('/api/sessions/')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
  throw new Error(`unexpected fetch: ${url}`);
}

/** 可覆盖部分端点的 fetch 桩：handler 返回 undefined 时走 defaultFetchHandler */
function stubFetchWith(handler: (url: string) => Response | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return handler(url) ?? defaultFetchHandler(url);
    }),
  );
}

/**
 * 缺口用例补全（TC-SSE-11 / TC-UI-11 / TC-UI-14）
 *
 * 这三条都是展厅现场的降级路径：后端挂了、回答卡了、没人碰了，
 * 页面都不能白屏或出未捕获异常——展厅是无人值守的，现场出错只能事后发现。
 */
describe('缺口用例补全', () => {
  it('TC-SSE-11：流式回答超时后运营视图可见友好错误，大屏不白屏', async () => {
    vi.useFakeTimers();
    installSpeech();
    // 流永远不结束（不 close、不 enqueue）→ 只有前端自己的 180s 超时能结束它
    const hangController = new AbortController();
    stubFetchWith((url) => {
      if (url.includes('/api/chat/stream')) {
        return new Response(
          new ReadableStream({
            start(controller) {
              const onAbort = () => { try { controller.close(); } catch {} };
              hangController.signal.addEventListener('abort', onAbort, { once: true });
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return defaultFetchHandler(url);
    });
    const wrapper = mountWithAdmin();
    await flushPromises();

    await wrapper.find('textarea').setValue('超时测试问题');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();

    // 推进 180s → 前端超时中止 → 错误写入 chat.errors
    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();

    // 运营视图里能看到这条超时故障（友好错误文案）
    const log = wrapper.find('.tech-log');
    expect(log.exists()).toBe(true);
    expect(log.text()).toContain('超时');

    // 大屏不白屏、不崩溃（textarea 仍存在）
    expect(wrapper.find('textarea').exists()).toBe(true);

    vi.useRealTimers();
    wrapper.unmount();
  });

  it('TC-UI-11：后端 health 不可达时页面仍能打开，存储状态文案为「未知（后端未响应）」', async () => {
    installSpeech();
    stubFetchWith((url) => {
      if (url.includes('/api/health')) throw new Error('fetch failed');
      return defaultFetchHandler(url);
    });
    const wrapper = mount(App);
    await flushPromises();

    // 页面正常渲染，不白屏
    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(wrapper.text()).toContain('晴晴');

    // 打开运营视图，存储状态为「未知（后端未响应）」
    const admin = mountWithAdmin();
    await flushPromises();
    expect(admin.find('.local-set').text()).toContain('未知（后端未响应）');
    admin.unmount();
    wrapper.unmount();
  });

  it('TC-UI-14：闲置180秒触发自动复位，期间有操作则计时器重置', async () => {
    vi.useFakeTimers();
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();
    // 真发一问（假定时器下桩 fetch 是同步 resolve 的，这里不能等 vi.waitFor——它自己也要定时器）
    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();

    const sessionBefore = localStorage.getItem('znwd.sessionId');
    expect(wrapper.findAll('.msg').length, '先要有一轮对话才谈得上复位').toBeGreaterThan(0);

    // 期间有操作（展厅里有人碰屏幕）→ 计时器重置：从这次手势起算 179 秒不该复位
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(179_000);
    await flushPromises();
    expect(wrapper.findAll('.msg').length, '手势后未到 180s 不该复位').toBeGreaterThan(0);
    expect(localStorage.getItem('znwd.sessionId'), '未到点不该换会话').toBe(sessionBefore);

    // 越过 180s（手势后 179s + 2s）→ 自动复位：清屏、换会话、回欢迎态
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0); // 让 startOver 里的 DELETE / 推荐问题两个异步链走完
    await flushPromises();
    expect(wrapper.findAll('.msg').length, '闲置超时后应清屏').toBe(0);
    expect(localStorage.getItem('znwd.sessionId'), '复位应换新会话').not.toBe(sessionBefore);
    expect(wrapper.text()).toContain('可以直接问');

    vi.useRealTimers();
    wrapper.unmount();
  });

  /**
   * P0-3：闲置计时器落空后必须重新武装。
   *
   * 场景：挂死流让 idle 回调在 streaming 期间触发（条件为假、本轮落空），随后流以总超时收场——
   * 旧实现到此再无任何计时器，上一位访客的对话会永远留在公共大屏上，直到有人碰屏。
   * 桩刻意持续发 `:ping`：活性计时（45s）不会提前杀流，能精确构造「idle 在 streaming 中落空」。
   */
  it('TC-UI-14b：流挂起时闲置回调落空，流结束后下一轮计时器仍会自动复位', async () => {
    vi.useFakeTimers();
    installSpeech();
    const encoder = new TextEncoder();
    const hangController = new AbortController();
    stubFetchWith((url) => {
      if (url.includes('/api/chat/stream')) {
        // 挂死但每 15s 心跳：inactivity 永不触发，只有 180s 总超时能结束这条流；
        // idle 计时器与总超时都挂在 180s，idle 先挂载先调度 → 先触发（此时 streaming 仍为 true）
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              let stopped = false;
              controller.enqueue(encoder.encode(':ping\n\n'));
              const beat = () => {
                if (stopped) return;
                try {
                  controller.enqueue(encoder.encode(':ping\n\n'));
                } catch {
                  return;
                }
                setTimeout(beat, 15_000);
              };
              setTimeout(beat, 15_000);
              hangController.signal.addEventListener(
                'abort',
                () => {
                  stopped = true;
                  try {
                    controller.close();
                  } catch {
                    /* 流已结束 */
                  }
                },
                { once: true },
              );
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return defaultFetchHandler(url);
    });
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.find('textarea').setValue('挂死测试问题');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const sessionBefore = localStorage.getItem('znwd.sessionId');

    // 第一轮 180s：idle 回调在 streaming 中触发（落空）→ 紧接着挂死流总超时收场
    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();
    expect(wrapper.findAll('.msg').length, 'idle 回调在 streaming 期间落空，对话应还在').toBeGreaterThan(0);
    expect(localStorage.getItem('znwd.sessionId'), '落空时不该换会话').toBe(sessionBefore);

    // 流已由总超时结束（兜底：显式中止桩，等价于「流结束」）
    hangController.abort();
    await flushPromises();

    // 第二轮 180s：重新武装的计时器到点 → 无人碰屏也自动复位（旧实现此处是红的）
    await vi.advanceTimersByTimeAsync(180_000);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(0); // 让 startOver 里的 DELETE / 推荐问题两个异步链走完
    await flushPromises();
    expect(wrapper.findAll('.msg').length, '流结束后闲置一轮必须自动复位').toBe(0);
    expect(localStorage.getItem('znwd.sessionId'), '复位要换新会话').not.toBe(sessionBefore);

    vi.useRealTimers();
    wrapper.unmount();
  });

  /**
   * 输入法组字：中文场景必踩。
   * 回车在中文输入法里也用来「确认候选词」，不判断组字状态就会把半截文本当问题发出去。
   */
  it('输入法组字状态下按回车不提交，组字结束后的回车才提交', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();
    const textarea = wrapper.find('textarea');
    await textarea.setValue('叶片检测要停机吗');

    await textarea.trigger('keydown', { key: 'Enter', isComposing: true });
    await flushPromises();
    expect(wrapper.findAll('.msg').length, '组字中的回车不该发出去').toBe(0);
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value, '草稿要留着').toBe('叶片检测要停机吗');

    await textarea.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.findAll('.msg').length, '组字结束后的回车应正常提交').toBeGreaterThan(0);
    expect(wrapper.text()).toContain('不需要停机');

    wrapper.unmount();
  });
});

/**
 * 语音模式的**接线**：开麦时机、预览进草稿、模式开关持久化、复位清理。
 *
 * 缺省点按（半双工）；建立在旧缺省全双工上的用例一律先落 `znwd.voiceMode='full'`。
 *
 * 这一层只能挂真组件才验得到——「谁决定什么时候开麦」「哪份草稿允许被预览覆盖」都写在 App.vue 里，
 * useDictation 只管采集与状态机。麦克风与 AudioContext 照第一组用例的路子桩掉（jsdom 没有它们），
 * 再直接往 ScriptProcessor 里喂 PCM 驱动整个链路。
 */
describe('展厅页面：语音模式接线', () => {
  type Feedable = {
    onaudioprocess:
      | ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void)
      | null;
  };

  /** 假的麦克风 + AudioContext + ScriptProcessor：与 useDictation.spec 同一套桩 */
  function installDictationBrowser() {
    const processor: Feedable & { connect: () => void; disconnect: () => void } = {
      onaudioprocess: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const source = { connect: vi.fn(), disconnect: vi.fn() };
    const getUserMedia = vi.fn(
      async () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
    );
    class FakeAudioContext {
      sampleRate = 16000;
      destination = {};
      createMediaStreamSource = vi.fn(() => source);
      createScriptProcessor = vi.fn(() => processor);
      close = vi.fn(async () => {});
    }
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    vi.stubGlobal('AudioContext', FakeAudioContext);
    // node 侧没有 FileReader（Blob → data URL 那步用得到），补一个最小实现
    class FakeFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      private aborted = false;
      readAsDataURL(blob: Blob): void {
        void blob.arrayBuffer().then(
          (buffer) => {
            if (this.aborted) return;
            this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onload?.();
          },
          () => {
            if (!this.aborted) this.onerror?.();
          },
        );
      }
      abort(): void {
        this.aborted = true;
        this.onabort?.();
      }
    }
    vi.stubGlobal('FileReader', FakeFileReader);
    // jsdom 的 HTMLMediaElement.play() 是「未实现」，语音解锁那条暖机会刷一屏警告；
    // 这里只要它别出声，桩掉即可
    class SilentAudio {
      src: string;
      ended = false;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(src: string) {
        this.src = src;
      }
      play(): Promise<void> {
        return Promise.resolve();
      }
      pause(): void {}
    }
    vi.stubGlobal('Audio', SilentAudio);
    return { processor, getUserMedia };
  }

  /** health 响应；speechReady 决定 App 会不会自动开麦 */
  function healthResponse(speechReady: boolean): Response {
    return new Response(
      JSON.stringify({ ok: true, knowledgeChunks: 1, llmProvider: 'mock', speech: speechReady ? 'mimo' : 'none', speechReady, embedding: 'bag', retrieval: { mode: 'keyword', keywordChunks: 1 }, storage: 'mysql', storageAvailable: true, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 }),
      { status: 200 },
    );
  }

  /**
   * health 报「服务端语音可用」的环境，识别接口按调用次序依次回给定文本
   * （第一段通常是分段预览、第二段才是终稿——一眼能看出预览与终稿是两条路）。
   */
  function stubListeningFetch(texts: string[]): void {
    let calls = 0;
    stubFetchWith((url) => {
      if (url.includes('/api/health')) return healthResponse(true);
      if (url.includes('/api/speech/recognize')) {
        const text = texts[Math.min(calls, texts.length - 1)] ?? '';
        calls += 1;
        return new Response(JSON.stringify({ text, seconds: 2 }), { status: 200 });
      }
      if (url.includes('/api/speech/metrics')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return undefined;
    });
  }

  /** 说话块：检出人声并累积分段（4096 帧 @16k = 256ms） */
  function feedSpeech(processor: Feedable): void {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.1) } });
  }

  /** 静音块：累计收尾用的静音时长（4 块 = 1024ms ≥ VAD_SILENCE_MS） */
  function feedSilence(processor: Feedable): void {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(4096) } });
  }

  /**
   * 小块（1024 帧 @16k = 64ms）。
   *
   * <p>插话判据按**持续时长**算（BARGEIN_HOLD_MS），256ms 的大块一次就够长了，
   * 测不出「一记爆音不该算插话」那一半。
   */
  function feedSmall(processor: Feedable, fill: number): void {
    processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1024).fill(fill) } });
  }

  /**
   * 「一直在生成、不结束」的回答流（第一条断流零 delta 会触发一次自动重问，让重问正常收尾）。
   *
   * @return 用例结束时 abort() 让流收尾，别把挂死的流留给后面的用例
   */
  function stubHangingAnswer(): AbortController {
    const hang = new AbortController();
    let streamCalls = 0;
    stubFetchWith((url) => {
      if (url.includes('/api/health')) return healthResponse(true);
      if (url.includes('/api/chat/stream')) {
        streamCalls += 1;
        if (streamCalls > 1) {
          return sse(
            'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"好了","latencyMs":1}\n\n',
          );
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              hang.signal.addEventListener('abort', () => {
                try {
                  controller.close();
                } catch {
                  /* 流已结束 */
                }
              }, { once: true });
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (url.includes('/api/speech/metrics')) return new Response('{"ok":true}', { status: 200 });
      return undefined;
    });
    return hang;
  }

  /**
   * 攒够**首段**门槛（SEGMENT_FIRST_MS）需要的说话块数：11 块 × 256ms ≈ 2.8 秒。
   *
   * <p>首段比后续段长是 §5 S5 的修法——门槛从起句开始算、静音尾巴也算在里面，
   * 1.5 秒的短句到 2 秒就白发一段，而那正是 VAD 马上要收尾的时刻。
   */
  const SEGMENT_CHUNKS = Math.ceil((SEGMENT_FIRST_MS / 1000) * 16_000 / 4096);

  let restoreNow: (() => void) | undefined;
  /** 用例中途失败时 wrapper 不会走到 unmount，挂着的组件会劫持后面用例的 window 事件——兜底卸掉 */
  let mounted: { unmount: () => void } | null = null;
  function track<T extends { unmount: () => void }>(wrapper: T): T {
    mounted = wrapper;
    return wrapper;
  }

  afterEach(() => {
    // 假定时器要在卸载**之前**还回去（卸载会挂计时器），而且失败路径也得还——
    // 有一条用例用假定时器，中途红掉时它自己的收尾不会执行，后面的时钟用例就全乱了
    vi.useRealTimers();
    mounted?.unmount();
    mounted = null;
    restoreNow?.();
    restoreNow = undefined;
    delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  });

  /** 麦克风相关的用例都关掉朗读：合成器一开口就会把走查带偏（也会真的去打合成接口） */
  function muteSpeech(): void {
    localStorage.setItem('znwd.speak', '0');
  }

  it('未落键默认点按：手势后不开麦，两键均不落，录音中形象是聆听', async () => {
    muteSpeech();
    const { getUserMedia } = installDictationBrowser();
    stubListeningFetch(['叶片有裂纹']);

    const wrapper = track(mount(App));
    await flushPromises();
    expect(localStorage.getItem('znwd.voiceMode'), '缺省不落键').toBeNull();
    expect(localStorage.getItem('znwd.listen'), '缺省不落键').toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    expect(getUserMedia, '缺省点按：手势不该自动开麦').not.toHaveBeenCalled();
    expect(wrapper.find('.mic').attributes('aria-label')).toBe('语音提问');
    expect(wrapper.find('.mic').classes()).not.toContain('on');

    // 点一下才开麦；录音中形象该是「聆听」，不是 idle（avatarState 的新分支）
    await wrapper.find('.mic').trigger('click');
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    expect(wrapper.findComponent(AvatarPortrait).props('state')).toBe('listening');
    expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中');
    wrapper.unmount();
  });

  it('旧键 znwd.listen=0 回退到点按：不开麦，回到「点一下说话」', async () => {
    muteSpeech();
    localStorage.setItem('znwd.listen', '0');
    const { getUserMedia } = installDictationBrowser();
    stubListeningFetch(['叶片有裂纹']);

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    expect(getUserMedia, '缺省点按不自动开麦（旧键 listen=0 也是点按）').not.toHaveBeenCalled();
    expect(wrapper.find('.mic').attributes('aria-label')).toBe('语音提问');
    expect(wrapper.find('.mic').classes()).not.toContain('on');
    wrapper.unmount();
  });

  it('旧键 znwd.listen=1 回退到全双工：手势后自动开麦', async () => {
    muteSpeech();
    localStorage.setItem('znwd.listen', '1');
    const { getUserMedia } = installDictationBrowser();
    stubListeningFetch(['叶片有裂纹']);

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    expect(getUserMedia, '显式拨过全双工的现场升级后行为不变').toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中');
    });
    wrapper.unmount();
  });

  it('新键 voiceMode 压过旧键 listen（双向）', async () => {
    muteSpeech();
    const { getUserMedia } = installDictationBrowser();
    stubListeningFetch(['叶片有裂纹']);

    // tap + listen=1 → 按新键走点按
    localStorage.setItem('znwd.listen', '1');
    localStorage.setItem('znwd.voiceMode', 'tap');
    let wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();
    expect(getUserMedia, '新键是唯一权威，旧键的全双工不该翻案').not.toHaveBeenCalled();
    expect(wrapper.find('.mic').attributes('aria-label')).toBe('语音提问');
    wrapper.unmount();

    // full + listen=0 → 按新键走全双工
    localStorage.setItem('znwd.listen', '0');
    localStorage.setItem('znwd.voiceMode', 'full');
    wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();
    expect(getUserMedia, '新键 full 压过旧键的点按').toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中');
    });
    wrapper.unmount();
  });

  it('health 报语音不可用时也不自动开麦（AUDIO_PROVIDER=none 的机器）', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    const { getUserMedia } = installDictationBrowser();
    stubFetchWith((url) => (url.includes('/api/health') ? healthResponse(false) : undefined));

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    // 自动开麦会变成每次说话都刷一条 503，运营视图全被这类噪音淹掉
    expect(getUserMedia).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('回答期间按钮说明「暂时不听」，回答结束自动恢复聆听', async () => {
    // 抑制期间说话是没有反应的：不把这件事写在按钮上，参观者只会觉得机器坏了
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    const { getUserMedia } = installDictationBrowser();
    const hang = new AbortController();
    let streamCalls = 0;
    stubFetchWith((url) => {
      if (url.includes('/api/health')) return healthResponse(true);
      if (url.includes('/api/chat/stream')) {
        streamCalls += 1;
        if (streamCalls > 1) {
          // 第二条：第一次断流零 delta 会触发一次自动重问（断流活性那套），这里让它正常收尾
          return sse(
            'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"好了","latencyMs":1}\n\n',
          );
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              hang.signal.addEventListener('abort', () => {
                try {
                  controller.close();
                } catch {
                  /* 流已结束 */
                }
              }, { once: true });
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (url.includes('/api/speech/metrics')) return new Response('{"ok":true}', { status: 200 });
      return undefined;
    });

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中'));

    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('.mic').attributes('aria-label')).toContain('暂时不听');

    hang.abort();
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中'));
  });

  it('插话打断（P3a）：判决开着时持续越限就当场让口，回答被掐掉', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    localStorage.setItem('znwd.bargein', '1');
    const { processor } = installDictationBrowser();
    const hang = stubHangingAnswer();

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中'));

    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    // 回答一开始生成就进抑制；判决开着时麦克风是真的在听，按钮文案得跟着改口
    expect(wrapper.find('.mic').attributes('aria-label')).toContain('想插话直接说');
    expect(wrapper.find('.send.ghost').exists(), '回答还在生成').toBe(true);

    feedSmall(processor, 0.2);
    feedSmall(processor, 0.2); // 两小块 = 128ms > BARGEIN_HOLD_MS

    await vi.waitFor(() =>
      expect(wrapper.find('.send.ghost').exists(), 'AI 让口：还在生成的那条回答也被掐掉').toBe(false));
    expect(wrapper.find('.mic').attributes('aria-label'), '这几块已经接成新的一句').toContain('结束录音并识别');

    hang.abort();
    wrapper.unmount();
  });

  it('插话打断缺省关：同样的越限声音只采回声，回答继续说', async () => {
    // 判据（门限抬多少、持续多久）必须由现场回声数据定，缺省拿参观者试参数是不行的
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    const { processor } = installDictationBrowser();
    const hang = stubHangingAnswer();

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中'));

    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(wrapper.find('.mic').attributes('aria-label')).toContain('暂时不听');

    for (let i = 0; i < 10; i++) feedSmall(processor, 0.2);
    await flushPromises();

    expect(wrapper.find('.send.ghost').exists(), '关着判决就不该打断').toBe(true);
    expect(wrapper.find('.mic').attributes('aria-label')).toContain('暂时不听');

    hang.abort();
    wrapper.unmount();
  });

  it('运营视图里的插话打断开关落存储（缺省不落键）', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 插话行只在全双工下可拨
    installDictationBrowser();
    stubListeningFetch(['叶片有裂纹']);

    const wrapper = track(mountWithAdmin());
    await flushPromises();

    expect(localStorage.getItem('znwd.bargein'), '缺省不落键：这是替没做过决定的人做决定').toBeNull();
    const toggle = wrapper.findAll('.local-set .row').find((row) => row.text().startsWith('插话打断'))!;
    expect(toggle.text()).toContain('关');

    await toggle.find('button').trigger('click');
    await flushPromises();
    expect(localStorage.getItem('znwd.bargein')).toBe('1');
    expect(toggle.text()).toContain('开');

    await toggle.find('button').trigger('click');
    await flushPromises();
    expect(localStorage.getItem('znwd.bargein')).toBe('0');
    wrapper.unmount();
  });

  it('分段预览进输入框，终稿覆盖预览并自动提问', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    const { processor } = installDictationBrowser();
    stubListeningFetch(['叶片有', '叶片有裂纹']);
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();

    const wrapper = track(mountWithAdmin());
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    for (let i = 0; i < SEGMENT_CHUNKS; i++) feedSpeech(processor);
    await vi.waitFor(() => {
      expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('叶片有');
    });

    now.mockReturnValue(3_000); // 越过 400ms 的有效门槛
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await vi.waitFor(() => {
      const call = fetchCalls().find((c) => String(c[0]).includes('/api/chat/stream'));
      expect(call, '终稿要自动提问').toBeTruthy();
      expect(JSON.parse(String(call![1]!.body)).message).toBe('叶片有裂纹');
    });
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value, '提交后输入框清空').toBe('');
    wrapper.unmount();
  });

  it('重新开始会清掉半截语音预览（闲置复位走的是同一条 watcher）', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    const { processor } = installDictationBrowser();
    stubListeningFetch(['叶片有']); // 只有分段预览，不会有终稿

    const wrapper = track(mountWithAdmin());
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    // 先有一轮对话：闲置复位/重新开始都只在「有对话可清」时才会触发那条 watcher
    await wrapper.find('textarea').setValue('叶片检测要停机吗？');
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => {
      expect(wrapper.find('.msg.assistant .answer').text()).toContain('正常回答');
    });
    await flushPromises();

    for (let i = 0; i < SEGMENT_CHUNKS; i++) feedSpeech(processor);
    await vi.waitFor(() => {
      expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('叶片有');
    });

    const restart = wrapper.findAll('.local-set .row button').find((b) => b.text() === '重新开始');
    await restart!.trigger('click');
    await flushPromises();

    expect(wrapper.findAll('.msg').length).toBe(0);
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value, '半截预览不该留给下一位参观者').toBe('');
    wrapper.unmount();
  });

  it('参观者手打的草稿不会被语音预览清掉', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    const { processor } = installDictationBrowser();
    // 整段识别回空（环境噪声被当成说话）：这条路径会调 onPartial(null) 清预览
    stubListeningFetch(['']);

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await flushPromises();

    // 手打一行，还没发出去
    await wrapper.find('textarea').setValue('我自己打的');
    // 环境噪声被当成说话 → 终稿为空 → onPartial(null)：这条路径不该把手工草稿抹掉
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    restoreNow = () => now.mockRestore();
    feedSpeech(processor);
    now.mockReturnValue(3_000);
    for (let i = 0; i < 4; i++) feedSilence(processor);
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('我自己打的');
    wrapper.unmount();
  });

  it('运营视图的「语音模式」开关落 localStorage 并可即时切换', async () => {
    muteSpeech();
    const { getUserMedia } = installDictationBrowser();
    stubListeningFetch([]);

    const wrapper = track(mountWithAdmin());
    await flushPromises();
    const row = wrapper.findAll('.local-set .row').find((r) => r.text().includes('语音模式'));
    expect(row, '运营视图要有这一行').toBeTruthy();
    expect(row!.find('button').text(), '缺省点按').toBe('点按');
    expect(localStorage.getItem('znwd.voiceMode'), '缺省不落键').toBeNull();
    expect(localStorage.getItem('znwd.listen'), '缺省不落键').toBeNull();

    await row!.find('button').trigger('click');
    expect(localStorage.getItem('znwd.voiceMode')).toBe('full');
    expect(localStorage.getItem('znwd.listen'), '镜像旧键，回滚 dist 后旧代码读到正确值').toBe('1');
    expect(row!.find('button').text()).toBe('全双工');

    // 拨到全双工这一下本身就是真实手势：不用再点屏幕就该开麦
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    await row!.find('button').trigger('click');
    expect(localStorage.getItem('znwd.voiceMode')).toBe('tap');
    expect(localStorage.getItem('znwd.listen')).toBe('0');
    expect(row!.find('button').text()).toBe('点按');
    wrapper.unmount();
  });

  it('点按模式下插话行置灰（存储值不清），切到全双工后可拨', async () => {
    muteSpeech();
    localStorage.setItem('znwd.bargein', '1'); // 置灰只禁用按钮，不该动存储值
    installDictationBrowser();
    stubListeningFetch([]);

    const wrapper = track(mountWithAdmin());
    await flushPromises();
    const row = wrapper.findAll('.local-set .row').find((r) => r.text().includes('插话打断'))!;
    const button = row.find('button');
    expect(button.attributes('disabled'), '点按模式下插话物理不触发').toBeDefined();
    expect(wrapper.text(), '文案要说清为什么拨不了').toContain('仅在全双工模式有效');
    expect(localStorage.getItem('znwd.bargein'), '置灰不清存储值').toBe('1');

    // 切到全双工后恢复可拨
    const modeRow = wrapper.findAll('.local-set .row').find((r) => r.text().includes('语音模式'))!;
    await modeRow.find('button').trigger('click');
    await flushPromises();
    expect(button.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('全双工录音中切回点按：当前句放弃、麦克风释放', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full');
    const { processor, getUserMedia } = installDictationBrowser();
    stubListeningFetch(['']);

    const wrapper = track(mountWithAdmin());
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    // 全双工下说话：进录音态（这句话还没说完）
    feedSpeech(processor);
    await vi.waitFor(() => expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中'));

    // 运营切回点按：setAlwaysOn(false) → invalidate → 放麦，不许留半句带进下一位参观者
    const row = wrapper.findAll('.local-set .row').find((r) => r.text().includes('语音模式'))!;
    await row.find('button').trigger('click');
    await flushPromises();

    expect(processor.disconnect, '切出全双工必须放麦').toHaveBeenCalled();
    expect(wrapper.find('.mic').attributes('aria-label'), '回到点按的待命文案').toBe('语音提问');
    expect(wrapper.find('.mic').classes()).not.toContain('on');
    wrapper.unmount();
  });

  it('点按录音中切到全双工：这一句走完后自动 arm（不聋）', async () => {
    muteSpeech();
    const { getUserMedia } = installDictationBrowser();
    stubListeningFetch(['']);

    const wrapper = track(mountWithAdmin());
    await flushPromises();

    // 缺省点按：点 mic 开始录一句
    await wrapper.find('.mic').trigger('click');
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    // 运营中途切全双工：arm() 被在途的 recording 挡回——这一句结束前不该重复开麦
    const row = wrapper.findAll('.local-set .row').find((r) => r.text().includes('语音模式'))!;
    await row.find('button').trigger('click');
    await flushPromises();
    expect(getUserMedia, '在途录音还没结束，arm 会被挡回').toHaveBeenCalledTimes(1);

    // 说完（识别完这一句）后必须补 arm，否则这次切换聋到刷新页面为止
    await wrapper.find('.mic').trigger('click'); // 立即结束这一句 → 识别（回空）→ 收麦
    await vi.waitFor(() => expect(getUserMedia, '这一句走完后要自动补 arm').toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(wrapper.find('.mic').attributes('aria-label')).toContain('聆听中');
    });
    wrapper.unmount();
  });

  it('卸载时放开麦克风（全双工下它一直开着）', async () => {
    muteSpeech();
    localStorage.setItem('znwd.voiceMode', 'full'); // 这组用例建立在「全双工开着」上
    const { processor, getUserMedia } = installDictationBrowser();
    stubListeningFetch([]);

    const wrapper = track(mount(App));
    await flushPromises();
    window.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    wrapper.unmount();
    // track 不停的话浏览器会一直显示「正在使用麦克风」
    expect(processor.disconnect).toHaveBeenCalled();
  });

  /**
   * 点按模式的现场可用性：端到端一轮、失败看得见、欢迎态入口。
   *
   * 与上一组同一套桩与清理（`track`/`restoreNow`/afterEach），所以嵌在它里面而不是另起一层，
   * 免得把 `installDictationBrowser` 那一整套重抄一遍。
   */
  describe('点按端到端 · 错误可见 · 入口按钮', () => {
    /**
     * 点按模式此前**没有任何 App 级端到端用例**（唯一的自动提问用例建在全双工上），
     * 而它现在是缺省——缺的正是「点一下 → 说话 → 停顿自动收尾 → 自动提问 → 收麦 → 还能再来一轮」这一条。
     */
    it('点按端到端首轮：VAD 收尾自动提问、收麦复位、二轮还能再录', async () => {
      muteSpeech();
      const { processor, getUserMedia } = installDictationBrowser();
      stubListeningFetch(['叶片有裂纹']);
      // 收尾判据按**录音时长**算（MIN_RECORD_MS），而喂块本身不花时间，得自己把时钟推过去
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();

      const wrapper = track(mount(App));
      await flushPromises();

      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

      for (let i = 0; i < 3; i++) feedSpeech(processor);
      now.mockReturnValue(3_000); // 越过 MIN_RECORD_MS
      for (let i = 0; i < 4; i++) feedSilence(processor); // 4 × 256ms > VAD_SILENCE_MS

      await vi.waitFor(() => {
        const call = fetchCalls().find((c) => String(c[0]).includes('/api/chat/stream'));
        expect(call, '整段识别回来要自动提问').toBeTruthy();
        expect(JSON.parse(String(call![1]!.body)).message).toBe('叶片有裂纹');
      });
      await vi.waitFor(() => {
        expect(wrapper.find('.msg.assistant .answer').text()).toContain('正常回答');
      });

      expect(processor.disconnect, '点按句一结束就收麦').toHaveBeenCalled();
      await vi.waitFor(() => expect(wrapper.find('.mic').attributes('aria-label')).toBe('语音提问'));
      expect(wrapper.find('.mic').classes()).not.toContain('on');

      // 二轮：点按模式必须能立刻再录一句（armed 若没收干净，这里会退化成无响应）
      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(getUserMedia, '二轮要重新开麦').toHaveBeenCalledTimes(2));
      expect(wrapper.find('.mic').classes()).toContain('on');
    });

    it('回答流式期间 mic 与输入框都禁用，「停」在场，流一结束就恢复', async () => {
      muteSpeech();
      installDictationBrowser();
      const hang = stubHangingAnswer();

      const wrapper = track(mount(App));
      await flushPromises();
      await wrapper.find('textarea').setValue('打字的问题');
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
      await flushPromises();

      expect(wrapper.find('.send.ghost').exists(), '「停」在场').toBe(true);
      expect(wrapper.find('.mic').attributes('disabled'), '回答期间不许再起一句').toBeDefined();
      expect(wrapper.find('textarea').attributes('disabled')).toBeDefined();

      hang.abort();
      await flushPromises();
      await vi.waitFor(() => expect(wrapper.find('.send.ghost').exists()).toBe(false));

      expect(wrapper.find('.mic').attributes('disabled')).toBeUndefined();
      expect(wrapper.find('textarea').attributes('disabled')).toBeUndefined();
    });

    it('识别在途（busy）时 mic 禁用，识别落地后恢复', async () => {
      muteSpeech();
      const { processor, getUserMedia } = installDictationBrowser();
      // 识别挂住不返回：busy 是「在途条数」算出来的，只能这样把它按在那一帧上
      let releaseRecognize: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseRecognize = resolve;
      });
      stubFetchWith((url) => {
        if (url.includes('/api/health')) return healthResponse(true);
        if (url.includes('/api/speech/recognize')) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              await gate;
              return { text: '叶片有裂纹', seconds: 2 };
            },
          } as unknown as Response;
        }
        if (url.includes('/api/speech/metrics')) return new Response('{"ok":true}', { status: 200 });
        return undefined;
      });
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();

      const wrapper = track(mount(App));
      await flushPromises();

      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      feedSpeech(processor);
      now.mockReturnValue(2_000);
      await wrapper.find('.mic').trigger('click'); // 立即结束这一句

      await vi.waitFor(() => expect(wrapper.find('.mic').attributes('disabled')).toBeDefined());

      releaseRecognize?.();
      await vi.waitFor(() => expect(wrapper.find('.mic').attributes('disabled')).toBeUndefined());
      await vi.waitFor(() => {
        const call = fetchCalls().find((c) => String(c[0]).includes('/api/chat/stream'));
        expect(call, '识别落地后照旧自动提问').toBeTruthy();
      });
    });

    it('欢迎态入口：可见、点击起录、走完一轮后消失', async () => {
      muteSpeech();
      const { processor, getUserMedia } = installDictationBrowser();
      stubListeningFetch(['叶片有裂纹']);
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();

      const wrapper = track(mount(App));
      await flushPromises();

      expect(wrapper.find('.voice-entry').exists(), '欢迎态要有显眼的入口').toBe(true);
      expect(wrapper.find('.voice-entry').text()).toBe('开始实时对话');

      await wrapper.find('.voice-entry').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      expect(wrapper.find('.voice-entry').text()).toContain('聆听中，请说话');
      expect(wrapper.find('.voice-entry').classes()).toContain('on');

      feedSpeech(processor);
      await vi.waitFor(() => expect(wrapper.find('.voice-entry').text()).toBe('说完了？点这里结束并识别'));

      now.mockReturnValue(3_000);
      for (let i = 0; i < 4; i++) feedSilence(processor);
      await vi.waitFor(() => expect(wrapper.find('.msg.user .bubble').text()).toBe('叶片有裂纹'));
      expect(wrapper.find('.voice-entry').exists(), '有过一轮对话就不再是欢迎态').toBe(false);
    });

    it('入口与 mic 的禁用口径逐字一致：录音中都可点，识别在途一起禁用', async () => {
      muteSpeech();
      const { processor, getUserMedia } = installDictationBrowser();
      let releaseRecognize: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseRecognize = resolve;
      });
      stubFetchWith((url) => {
        if (url.includes('/api/health')) return healthResponse(true);
        if (url.includes('/api/speech/recognize')) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              await gate;
              return { text: '叶片有裂纹', seconds: 2 };
            },
          } as unknown as Response;
        }
        if (url.includes('/api/speech/metrics')) return new Response('{"ok":true}', { status: 200 });
        return undefined;
      });
      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();

      const wrapper = track(mount(App));
      await flushPromises();

      await wrapper.find('.voice-entry').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      now.mockReturnValue(2_000);
      feedSpeech(processor);
      await vi.waitFor(() =>
        expect(wrapper.find('.mic').attributes('aria-label')).toBe('结束录音并识别'));

      expect(wrapper.find('.mic').attributes('disabled'), '录音中 mic 可点').toBeUndefined();
      expect(wrapper.find('.voice-entry').attributes('disabled')).toBeUndefined();

      await wrapper.find('.voice-entry').trigger('click'); // 入口点一下 = 结束本句
      await vi.waitFor(() => expect(wrapper.find('.mic').attributes('disabled')).toBeDefined());
      expect(wrapper.find('.voice-entry').attributes('disabled'), 'busy 期间两者一起禁用').toBeDefined();
      expect(wrapper.find('.voice-entry').text()).toBe('正在识别…');

      releaseRecognize?.();
      await vi.waitFor(() => expect(wrapper.find('.voice-entry').exists()).toBe(false));
    });

    it('全双工欢迎态没有入口（摆出来就是死按钮），mic 照常在场', async () => {
      muteSpeech();
      localStorage.setItem('znwd.voiceMode', 'full');
      const { getUserMedia } = installDictationBrowser();
      stubListeningFetch(['']);

      const wrapper = track(mount(App));
      await flushPromises();
      window.dispatchEvent(new Event('pointerdown'));
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

      // 全双工下麦克风本来就开着，toggleDictation 对空闲的点击直接 return
      expect(wrapper.find('.voice-entry').exists()).toBe(false);
      expect(wrapper.find('.mic').exists()).toBe(true);
    });

    it('点按后 6 秒没听到声音：输入区下方给行动指引，约 6 秒后自消失', async () => {
      vi.useFakeTimers();
      muteSpeech();
      const { getUserMedia } = installDictationBrowser();
      stubListeningFetch([]);
      // performance.now 不在 vitest 假定时器的默认集合里，而「6 秒没动静」正是按它算的，
      // 所以这里自己给一个可推的时钟（ticker 仍走假定时器）
      let clock = 1_000;
      const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
      restoreNow = () => now.mockRestore();

      const wrapper = track(mount(App));
      await flushPromises();
      await wrapper.find('.mic').trigger('click');
      await flushPromises();
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(wrapper.find('.voice-hint').exists()).toBe(false);

      clock = 7_000; // 越过 VAD_NO_SPEECH_MS
      await vi.advanceTimersByTimeAsync(100);
      await flushPromises();

      const hint = wrapper.find('.voice-hint');
      expect(hint.exists(), '参观者得知道刚才那下为什么没反应').toBe(true);
      expect(hint.text()).toBe('没有听到声音，请再说一次');
      expect(hint.attributes('role'), '读屏软件要念出来').toBe('status');
      expect(hint.attributes('aria-live')).toBe('polite');
      expect(wrapper.find('.compose .voice-hint').exists(), '提示在输入区里').toBe(true);
      expect(wrapper.find('.main .voice-hint').exists(), '绝不进消息列表').toBe(false);
      expect(wrapper.find('.mic').classes(), '按钮也要圈出来').toContain('warn');
      expect(wrapper.find('.mic').attributes('aria-label'), '录音已经收掉了').toBe('语音提问');

      // 6 秒后自清：上一轮的失败提示不该一直挂着
      await vi.advanceTimersByTimeAsync(6_000);
      await flushPromises();
      expect(wrapper.find('.voice-hint').exists()).toBe(false);
      expect(wrapper.find('.mic').classes()).not.toContain('warn');

      vi.useRealTimers();
    });

    it('识别回空：输入区下方给指引，技术原因仍在运营视图里', async () => {
      muteSpeech();
      const { processor, getUserMedia } = installDictationBrowser();
      stubListeningFetch(['']);

      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();

      const wrapper = track(mountWithAdmin());
      await flushPromises();

      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      feedSpeech(processor); // 有 PCM，否则走「没有采到声音」那条免识别路径
      now.mockReturnValue(2_000);
      await wrapper.find('.mic').trigger('click');

      await vi.waitFor(() => {
        expect(wrapper.find('.voice-hint').text()).toBe('没有听清，请再说一次');
      });
      expect(wrapper.find('.tech-log').text(), '技术日志照旧').toContain('没有听清');
      expect(wrapper.find('.main').text(), '技术信息不上大屏').not.toContain('没有听清');
      expect(wrapper.find('.compose .voice-hint').exists()).toBe(true);
    });

    it('麦克风被拒：给一句去细节的行动指引，浏览器原文只进技术日志', async () => {
      muteSpeech();
      const { getUserMedia } = installDictationBrowser();
      getUserMedia.mockRejectedValue(new Error('Permission denied'));
      stubListeningFetch([]);

      const wrapper = track(mountWithAdmin());
      await flushPromises();

      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => {
        expect(wrapper.find('.voice-hint').exists()).toBe(true);
      });

      const hint = wrapper.find('.voice-hint').text();
      expect(hint).toBe('麦克风打不开，请联系工作人员');
      expect(hint, '参观者不看错误码').not.toContain('Permission');
      expect(wrapper.find('.tech-log').text(), '运营要能查到原文').toContain('Permission denied');
    });

    it('麦克风被拒后每次再点都是重连 + 提示重现（不许第二次起静默）', async () => {
      // openMic 的 reportedMicError 去重是为常开聆听「每个手势自动重试」设的。点按路径上
      // 每一次点击都是参观者的主动行为，去重会让第二次之后毫无反馈——那正是「机器坏了」观感。
      muteSpeech();
      const { getUserMedia } = installDictationBrowser();
      getUserMedia.mockRejectedValue(new Error('Permission denied'));
      stubListeningFetch([]);

      const wrapper = track(mount(App));
      await flushPromises();

      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(wrapper.find('.voice-hint').exists()).toBe(true));
      expect(getUserMedia).toHaveBeenCalledTimes(1);

      // 第二、三次：既要真的再连一次，也要把提示重新贴出来
      for (const expected of [2, 3]) {
        await wrapper.find('.mic').trigger('click');
        await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(expected));
        await vi.waitFor(() =>
          expect(wrapper.find('.voice-hint').text()).toBe('麦克风打不开，请联系工作人员'));
      }

      // 欢迎态那颗大入口走的是同一个 toggleDictation，同样受益
      await wrapper.find('.voice-entry').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(4));
      await vi.waitFor(() =>
        expect(wrapper.find('.voice-hint').text()).toBe('麦克风打不开，请联系工作人员'));
    });

    it('卡死回归：录音中打字提交后点按必须能重新开录（抑制放弃要连麦一起收）', async () => {
      // 修复前：抑制只清 recording/chunks/vad，armed 留 true →
      // 之后每次点 mic 都被 start() 的 armed 早退吃掉，按钮永久无响应且麦克风常开
      muteSpeech();
      const { processor, getUserMedia } = installDictationBrowser();
      const hang = stubHangingAnswer();

      const wrapper = track(mount(App));
      await flushPromises();

      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      expect(wrapper.find('.mic').classes()).toContain('on');

      // 录音中打字提问：submit 起流 → 抑制 watcher → setSuppressed(true) 放弃这一句
      await wrapper.find('textarea').setValue('手打的问题');
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
      await flushPromises();
      expect(wrapper.find('.send.ghost').exists(), '回答已在生成').toBe(true);

      hang.abort();
      await flushPromises();
      // 零 delta 断流会触发一次自动重问，等它收尾后 streaming 才真的落下
      await vi.waitFor(() => expect(wrapper.find('.send.ghost').exists()).toBe(false));

      expect(wrapper.find('.mic').attributes('aria-label'), '不许错显全双工的聆听话术').toBe('语音提问');
      expect(wrapper.find('.mic').classes()).not.toContain('on');
      expect(processor.disconnect, '放弃点按句要连麦一起收').toHaveBeenCalled();

      // 修复前 armed 恒为 true：这一次点击会被 start() 早退吃掉（getUserMedia 停在 1）
      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(getUserMedia, '必须能重新开录').toHaveBeenCalledTimes(2));
      expect(wrapper.find('.mic').classes()).toContain('on');
    });

    it('草稿残留守卫：识别返回撞上流式回答时不写回输入框，改记技术日志', async () => {
      muteSpeech();
      const { processor, getUserMedia } = installDictationBrowser();
      // 识别挂住不返回：要的就是「识别在途时参观者已经手打一句发出去了」这一帧
      let releaseRecognize: (() => void) | undefined;
      const recognizeGate = new Promise<void>((resolve) => {
        releaseRecognize = resolve;
      });
      const hang = new AbortController();
      let streamCalls = 0;
      stubFetchWith((url) => {
        if (url.includes('/api/health')) return healthResponse(true);
        if (url.includes('/api/speech/recognize')) {
          return {
            ok: true,
            status: 200,
            json: async () => {
              await recognizeGate;
              return { text: '语音识别的文本', seconds: 2 };
            },
          } as unknown as Response;
        }
        if (url.includes('/api/chat/stream')) {
          streamCalls += 1;
          if (streamCalls > 1) {
            return sse(
              'event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":"好了","latencyMs":1}\n\n',
            );
          }
          return new Response(
            new ReadableStream({
              start(controller) {
                hang.signal.addEventListener('abort', () => {
                  try {
                    controller.close();
                  } catch {
                    /* 流已结束 */
                  }
                }, { once: true });
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        }
        if (url.includes('/api/speech/metrics')) return new Response('{"ok":true}', { status: 200 });
        return undefined;
      });

      const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
      restoreNow = () => now.mockRestore();

      const wrapper = track(mountWithAdmin());
      await flushPromises();

      // 点按录一句：先喂一块 PCM（否则走「没有采到声音」那条免识别路径），再点一下结束
      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
      feedSpeech(processor);
      now.mockReturnValue(2_000); // 越过 MIN_RECORD_MS
      await wrapper.find('.mic').trigger('click');
      await vi.waitFor(() => expect(wrapper.find('.mic').attributes('disabled')).toBeDefined());

      // 识别在途（mic 已禁用），参观者打字提交起流：submit() 把草稿清空了
      await wrapper.find('textarea').setValue('手打的');
      await wrapper.find('textarea').trigger('keydown', { key: 'Enter' });
      await flushPromises();
      expect(wrapper.find('.send.ghost').exists(), '回答已在生成').toBe(true);
      expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('');

      // 识别这时才回来：submit() 会被 streaming 挡回，文本不该卡在输入框里
      releaseRecognize?.();
      await vi.waitFor(() => expect(wrapper.find('.tech-log').text()).toContain('未自动提交'));
      expect(
        (wrapper.find('textarea').element as HTMLTextAreaElement).value,
        '留在输入框里就是一条发不出去的文本',
      ).toBe('');

      hang.abort();
      await flushPromises();
    });
  });
});

/**
 * 展览 zone 联动（旧 Node 版 P2 契约，Java/Vue 重写时漏掉的那层）：
 * URL `?zone=`、`window.znwdSetZone`、`znwd:zone` 事件。
 *
 * 挂在真组件上验完整链路：URL 读取 → 推荐问题、下拉写 URL（replaceState、保留 admin）、
 * 外部桥进出、防回环与卸载清理。jsdom 的 history.replaceState 可用，每个用例收尾都复位 URL。
 */
describe('展厅页面：展览 zone 联动', () => {
  function urlZone(): string | null {
    return new URLSearchParams(window.location.search).get('zone');
  }

  function zoneSetter(): ((id: string | null) => void) | undefined {
    return (window as Window & { znwdSetZone?: (id: string | null) => void }).znwdSetZone;
  }

  function suggestionCalls(): string[] {
    return fetchCalls()
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/api/suggestions'));
  }

  it('URL 带 ?zone= 时优先按该展区拉推荐问题，且 ?admin=1 行为不变', async () => {
    installSpeech();
    localStorage.setItem('znwd.zone', 'wind-inspect'); // URL 必须压过 localStorage
    window.history.replaceState({}, '', '/?zone=pv-doctor&admin=1');

    const wrapper = mount(App);
    await flushPromises();

    expect(suggestionCalls().some((u) => u.includes('zone=pv-doctor')), '要按 URL 的展区拉推荐').toBe(true);
    expect(suggestionCalls().some((u) => u.includes('zone=wind-inspect')), 'localStorage 的旧展区不该被请求').toBe(false);
    expect(wrapper.find('.drawer').exists(), '?admin=1 仍要打开运营视图').toBe(true);
    wrapper.unmount();
  });

  it('下拉选择后 URL 出现 zone 且保留 admin（replaceState，不 pushState）', async () => {
    installSpeech();
    window.history.replaceState({}, '', '/?admin=1');
    const events: unknown[] = [];
    const onZone = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('znwd:zone', onZone);
    const pushSpy = vi.spyOn(window.history, 'pushState');

    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('.zone-trigger').trigger('click');
    const pv = wrapper.findAll('.zone-option').find((o) => o.text() === '光伏清洁');
    await pv!.trigger('click');
    await flushPromises();

    expect(urlZone()).toBe('pv-clean');
    expect(new URLSearchParams(window.location.search).get('admin')).toBe('1');
    expect(pushSpy, '只允许 replaceState，不能污染后退历史').not.toHaveBeenCalled();
    expect(events, '下拉变化也要广播 znwd:zone').toEqual([{ zone: 'pv-clean' }]);
    expect(suggestionCalls().some((u) => u.includes('zone=pv-clean'))).toBe(true);

    pushSpy.mockRestore();
    window.removeEventListener('znwd:zone', onZone);
    wrapper.unmount();
  });

  it('清空展区后 URL 去掉 zone 参数（其余参数保留）', async () => {
    installSpeech();
    window.history.replaceState({}, '', '/?zone=pv-clean&admin=1');
    const wrapper = mount(App);
    await flushPromises();

    await wrapper.find('.zone-trigger').trigger('click');
    const all = wrapper.findAll('.zone-option').find((o) => o.text() === '全部展区');
    await all!.trigger('click');
    await flushPromises();

    expect(urlZone()).toBeNull();
    expect(new URLSearchParams(window.location.search).get('admin')).toBe('1');
    expect(suggestionCalls().some((u) => /\/api\/suggestions$/.test(u)), '清空后拉全馆推荐').toBe(true);
    wrapper.unmount();
  });

  it('window.znwdSetZone 切换展区、同步 URL 并派发 znwd:zone 事件', async () => {
    installSpeech();
    const events: unknown[] = [];
    const onZone = (e: Event) => events.push((e as CustomEvent).detail);
    window.addEventListener('znwd:zone', onZone);

    const wrapper = mount(App);
    await flushPromises();
    const setZone = zoneSetter();
    expect(typeof setZone, '挂载后要暴露 window.znwdSetZone').toBe('function');

    setZone!('pv-clean');
    await flushPromises();
    expect(wrapper.find('.zone-trigger').text()).toBe('光伏清洁');
    expect(urlZone()).toBe('pv-clean');
    expect(suggestionCalls().some((u) => u.includes('zone=pv-clean'))).toBe(true);
    expect(events).toEqual([{ zone: 'pv-clean' }]);

    setZone!(null);
    await flushPromises();
    expect(urlZone()).toBeNull();
    expect(events).toEqual([{ zone: 'pv-clean' }, { zone: null }]);

    wrapper.unmount();
    expect(zoneSetter(), '卸载要摘掉 window 桥').toBeUndefined();
    window.removeEventListener('znwd:zone', onZone);
  });

  it('外部派发 znwd:zone 能切换展区（detail 对象/字符串都认）且不回环', async () => {
    installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    const seen: unknown[] = [];
    const onZone = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('znwd:zone', onZone);

    window.dispatchEvent(new CustomEvent('znwd:zone', { detail: { zone: 'pv-clean' } }));
    await flushPromises();
    expect(wrapper.find('.zone-trigger').text()).toBe('光伏清洁');

    window.dispatchEvent(new CustomEvent('znwd:zone', { detail: 'wind-inspect' }));
    await flushPromises();
    expect(wrapper.find('.zone-trigger').text()).toBe('风场检测');

    const before = suggestionCalls().length;
    window.dispatchEvent(new CustomEvent('znwd:zone', { detail: { zone: 'wind-inspect' } }));
    await flushPromises();
    expect(suggestionCalls().length, '同值事件不重复请求').toBe(before);

    expect(seen, '外部监听只看到自己派的 3 次事件，本页不回声').toHaveLength(3);

    wrapper.unmount();
    window.removeEventListener('znwd:zone', onZone);

    const afterUnmount = suggestionCalls().length;
    window.dispatchEvent(new CustomEvent('znwd:zone', { detail: { zone: 'pv-doctor' } }));
    await flushPromises();
    expect(suggestionCalls().length, '卸载后事件监听要摘掉').toBe(afterUnmount);
  });
});
