// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

/**
 * 展厅页面（App.vue）的语音播报接线测试：用真组件 + 假合成器，验证三条现场行为——
 * 1) 回答流式结束后整段自动朗读，且读的是洗过的正文；
 * 2) 点「朗读：关」后不再朗读，且选择落 localStorage（重启保持）；
 * 3) 换问题/开新对话时立刻停掉上一条。
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
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(text: string) {
    this.text = text;
  }
}

function installSpeech() {
  const spoken: string[] = [];
  const synth = {
    speaking: false,
    speak(u: FakeUtterance) {
      spoken.push(u.text);
      synth.speaking = true;
    },
    cancel() {
      synth.speaking = false;
    },
    resume() {},
    getVoices: () => [{ lang: 'zh-CN', name: 'Tingting' }],
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true });
  return { spoken, synth };
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

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({ ok: true, knowledgeChunks: 134, llmProvider: 'mock', embedding: 'bag', retrieval: 'keyword', storage: 'mysql', storageAvailable: true, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 }),
          { status: 200 },
        );
      }
      if (url.includes('/api/zones')) return new Response(JSON.stringify({ zones: [] }), { status: 200 });
      if (url.includes('/api/suggestions')) return new Response(JSON.stringify({ items: ['叶片检测要停机吗？'] }), { status: 200 });
      if (url.includes('/api/chat/stream')) {
        return sse(
          'event:meta\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[]}\n\n',
          `event:delta\ndata:{"text":${JSON.stringify(ANSWER)}}\n\n`,
          `event:done\ndata:{"mode":"rag","provider":"mock","retrieval":"keyword","noHit":false,"cached":false,"sources":[],"answer":${JSON.stringify(ANSWER)},"latencyMs":42}\n\n`,
        );
      }
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

beforeEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  stubFetch();
});

describe('展厅页面：语音播报接线', () => {
  it('回答流式结束后自动朗读洗过的正文，开关默认开', async () => {
    const { spoken } = installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.text()).toContain('朗读：开');

    await askAndWait(wrapper);

    const read = spoken.join('');
    expect(read).toContain('叶片检测不需要停机'); // 洗掉了 ** 与 URL
    expect(read).not.toContain('**');
    expect(read).not.toContain('http');

    wrapper.unmount();
  });

  it('关掉开关后不再朗读，且选择落 localStorage', async () => {
    const { spoken } = installSpeech();
    const wrapper = mount(App);
    await flushPromises();

    const toggle = wrapper.findAll('button').find((b) => b.text().startsWith('朗读：'));
    expect(toggle).toBeTruthy();
    await toggle!.trigger('click');
    expect(wrapper.text()).toContain('朗读：关');
    expect(localStorage.getItem('znwd.speak')).toBe('0');

    const before = spoken.length;
    await askAndWait(wrapper);
    expect(spoken.length).toBe(before); // 关掉后一个字都不读

    wrapper.unmount();
  });

  it('开新对话时停掉正在读的回答', async () => {
    const { spoken, synth } = installSpeech();
    const cancelSpy = vi.spyOn(synth, 'cancel');
    const wrapper = mount(App);
    await flushPromises();
    await askAndWait(wrapper);
    expect(spoken.length).toBeGreaterThan(0);

    const newChat = wrapper.findAll('button').find((b) => b.text() === '新对话');
    await newChat!.trigger('click');
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
    expect(wrapper.text()).toContain('朗读：开'); // 停读不等于静音

    wrapper.unmount();
  });
});
