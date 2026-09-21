// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import App from './App.vue';

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

function stubFetch(storageAvailable = true, streamFails = false, answer = ANSWER, sources: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({ ok: true, knowledgeChunks: 134, llmProvider: 'mock', embedding: 'bag', retrieval: 'keyword', storage: 'mysql', storageAvailable, activeSessions: 0, minRelevanceScore: 6.3, uptimeSec: 1 }),
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
  vi.unstubAllGlobals();
  stubFetch();
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
