// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import KnowledgePanel from './KnowledgePanel.vue';

/**
 * 知识库管理（KnowledgePanel.vue）：文档清单、重载、同义词热更新。
 *
 * 这三件事以前只能 curl（带 ADMIN_TOKEN），接口已经在 docs/api.md 冻结，
 * 这一层钉的是接线：口令带没带、401 说没说人话、重载的进行中/成功/失败三个状态、
 * 保存 PUT 出去的行和 persist 标志对不对。
 */

const LIST = {
  knowledgeDir: 'E:\\znwd\\knowledge',
  fileCount: 2,
  chunkCount: 7,
  synonyms: { count: 2, source: 'builtin', file: null },
  docs: [
    {
      path: '01_光伏清洁机器人/产品概述.md',
      title: '两栖光伏清洁机器人产品概述',
      zone: 'pv-clean',
      zoneTitle: '光伏清洁机器人',
      chunks: 5,
    },
    { path: '03_项目与团队/常见问题.md', title: null, zone: null, zoneTitle: null, chunks: 2 },
  ],
};

const SYNONYMS = {
  count: 2,
  source: 'builtin',
  file: 'E:\\znwd\\knowledge\\_meta\\synonyms.tsv',
  entries: [
    { key: '叶片', alternatives: ['叶片', '风叶'] },
    { key: '客户', alternatives: ['客户', '用户'] },
  ],
  tsv: '# 主词\t备选词\n叶片\t风叶\n客户\t用户',
};

const RELOAD = { ok: true, knowledgeChunks: 219, generation: 2 };
const SAVE = {
  ok: true,
  count: 3,
  persistedTo: 'E:\\znwd\\knowledge\\_meta\\synonyms.tsv',
  persistRequested: true,
};

function stubApi(
  options: {
    unauthorized?: boolean;
    reload?: () => Promise<Response>;
    saveStatus?: number;
    saveBody?: unknown;
  } = {},
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (options.unauthorized) return new Response('{"error":"unauthorized"}', { status: 401 });
      if (url.includes('/api/knowledge/reload')) {
        if (options.reload) return options.reload();
        return new Response(JSON.stringify(RELOAD), { status: 200 });
      }
      if (url.includes('/api/knowledge/list')) return new Response(JSON.stringify(LIST), { status: 200 });
      if (url.includes('/api/admin/synonyms')) {
        if (init?.method === 'PUT') {
          return new Response(JSON.stringify(options.saveBody ?? SAVE), { status: options.saveStatus ?? 200 });
        }
        return new Response(JSON.stringify(SYNONYMS), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function calls(): Array<[string, RequestInit | undefined]> {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } }).mock.calls;
}

function findButton(wrapper: ReturnType<typeof mount>, label: string) {
  const button = wrapper.findAll('button').find((b) => b.text() === label);
  expect(button, `按钮「${label}」应当存在`).toBeTruthy();
  return button!;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubApi();
});

describe('知识库管理：清单、重载、同义词', () => {
  it('挂载即拉清单与同义词表：文件、展区、状态与 TSV 都渲染出来，请求带口令', async () => {
    const wrapper = mount(KnowledgePanel, { props: { token: 'tok-1' } });
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('01_光伏清洁机器人/产品概述.md');
    expect(text).toContain('两栖光伏清洁机器人产品概述');
    expect(text).toContain('已索引 5 块');
    expect(text).toContain('未分展区');
    expect(text).toContain('共 2 份文档 · 7 块');
    expect(text).toContain('共 2 组');
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(SYNONYMS.tsv);

    expect(calls().length).toBeGreaterThanOrEqual(2);
    for (const [url, init] of calls()) {
      expect(String(url)).toMatch(/\/api\/(knowledge\/list|admin\/synonyms)/);
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    }
    wrapper.unmount();
  });

  it('口令不对时给出「口令不正确（401）」，不渲染半张表', async () => {
    stubApi({ unauthorized: true });
    const wrapper = mount(KnowledgePanel, { props: { token: 'bad' } });
    await flushPromises();

    expect(wrapper.text()).toContain('口令不正确（401）');
    expect(wrapper.find('table').exists()).toBe(false);
    wrapper.unmount();
  });

  it('网络错误不静默：把失败原因显示出来', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('网络断了');
      }),
    );
    const wrapper = mount(KnowledgePanel, { props: { token: '' } });
    await flushPromises();

    expect(wrapper.text()).toContain('知识库加载失败：网络断了');
    wrapper.unmount();
  });

  it('重载：进行中按钮禁用，完成后报块数与代数并重新拉清单', async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    stubApi({ reload: () => gate });
    const wrapper = mount(KnowledgePanel, { props: { token: 'tok' } });
    await flushPromises();
    const listCalls = () => calls().filter(([url]) => String(url).includes('/api/knowledge/list')).length;
    expect(listCalls()).toBe(1);

    const button = findButton(wrapper, '重载知识库');
    await button.trigger('click');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('重载中');

    release(new Response(JSON.stringify(RELOAD), { status: 200 }));
    await flushPromises();

    expect(wrapper.text()).toContain('重载完成：219 块 · 第 2 代索引');
    expect(listCalls()).toBe(2);
    const restored = findButton(wrapper, '重载知识库');
    expect(restored.attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('重载失败把原因显示出来，按钮恢复可点', async () => {
    stubApi({
      reload: async () => new Response(JSON.stringify({ message: '重建索引失败' }), { status: 500 }),
    });
    const wrapper = mount(KnowledgePanel, { props: { token: 'tok' } });
    await flushPromises();

    await findButton(wrapper, '重载知识库').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('重载失败：重建索引失败');
    expect(findButton(wrapper, '重载知识库').attributes('disabled')).toBeUndefined();
    wrapper.unmount();
  });

  it('改完同义词点保存：PUT 整表带口令与 persist，成功回执可见', async () => {
    const wrapper = mount(KnowledgePanel, { props: { token: 'tok-9' } });
    await flushPromises();

    await wrapper.find('textarea').setValue('叶片\t风叶,桨叶\n客户\t用户');
    await findButton(wrapper, '保存').trigger('click');
    await flushPromises();

    const put = calls().find(([url, init]) => String(url).includes('/api/admin/synonyms') && init?.method === 'PUT');
    expect(put).toBeTruthy();
    const body = JSON.parse(String(put![1]!.body)) as { lines: string[]; persist: boolean };
    expect(body.lines).toContain('叶片\t风叶,桨叶');
    expect(body.lines).toContain('客户\t用户');
    expect(body.persist).toBe(true);
    expect((put![1]!.headers as Record<string, string>).authorization).toBe('Bearer tok-9');

    expect(wrapper.text()).toContain('已保存（3 组）');
    expect(wrapper.text()).toContain(SAVE.persistedTo);
    wrapper.unmount();
  });

  it('取消「持久化到文件」时 persist=false，回执写明仅内存生效', async () => {
    const wrapper = mount(KnowledgePanel, { props: { token: 'tok' } });
    await flushPromises();

    await wrapper.find('input[type="checkbox"]').setValue(false);
    await findButton(wrapper, '保存').trigger('click');
    await flushPromises();

    const put = calls().find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put![1]!.body)).persist).toBe(false);
    expect(wrapper.text()).toContain('仅内存生效');
    wrapper.unmount();
  });

  it('保存失败（401）给出明确提示', async () => {
    const wrapper = mount(KnowledgePanel, { props: { token: 'bad' } });
    await flushPromises();
    // 加载成功后口令失效（或后端收紧了）：PUT 被拦也要说人话
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 })),
    );
    await findButton(wrapper, '保存').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('保存失败：口令不正确（401）');
    wrapper.unmount();
  });

  it('换口令（props 变化）后整段重拉', async () => {
    const wrapper = mount(KnowledgePanel, { props: { token: 'a' } });
    await flushPromises();
    expect(calls().length).toBe(2);

    await wrapper.setProps({ token: 'b' });
    await flushPromises();
    const listCalls = calls().filter(([url]) => String(url).includes('/api/knowledge/list'));
    expect(listCalls.length).toBe(2);
    expect((listCalls[1]![1]!.headers as Record<string, string>).authorization).toBe('Bearer b');
    wrapper.unmount();
  });
});
