// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AdminPanel from './AdminPanel.vue';

/**
 * 运营视图（AdminPanel.vue）的接线测试。
 *
 * 这一层以前完全靠人工点：三个统计接口、口令的存与带、401 的处理都只在浏览器里验过。
 * 面板本身不复杂，但它是运营补资料的唯一入口——「待补资料的问题」列不出来，运营就不知道该补什么，
 * 所以至少要有一条能跑的回归。
 */

const STATS = {
  chatTotal: 634,
  ragHits: 75,
  noHit: 559,
  rewritten: 14,
  errors: 0,
  activeSessions: 0,
  tokens: { prompt: 57405, completion: 6453, total: 63858 },
};
const UNCOVERED = { items: [{ question: '你们有多少客户', at: 1790044695025 }] };
const FEEDBACK = { up: 28, down: 0, topDown: [] };
const KNOWLEDGE_LIST = {
  knowledgeDir: 'E:\\znwd\\knowledge',
  fileCount: 1,
  chunkCount: 3,
  synonyms: { count: 1, source: 'builtin', file: null },
  docs: [{ path: '01_光伏清洁机器人/产品概述.md', title: '产品概述', zone: 'pv-clean', zoneTitle: '光伏清洁机器人', chunks: 3 }],
};
const SYNONYMS = { count: 1, source: 'builtin', file: null, entries: [], tsv: '叶片\t风叶' };

function stubApi(options: { unauthorized?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (options.unauthorized) return new Response('{"error":"unauthorized"}', { status: 401 });
      if (url.includes('/api/stats')) return new Response(JSON.stringify(STATS), { status: 200 });
      if (url.includes('/api/admin/uncovered')) return new Response(JSON.stringify(UNCOVERED), { status: 200 });
      if (url.includes('/api/admin/feedback-stats')) return new Response(JSON.stringify(FEEDBACK), { status: 200 });
      if (url.includes('/api/knowledge/list')) return new Response(JSON.stringify(KNOWLEDGE_LIST), { status: 200 });
      if (url.includes('/api/admin/synonyms')) return new Response(JSON.stringify(SYNONYMS), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function calls(): Array<[string, RequestInit | undefined]> {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } }).mock.calls;
}

beforeEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
  stubApi();
});

describe('运营视图：统计、未覆盖问题与口令', () => {
  it('挂载即拉三个接口并把统计与待补资料渲染出来', async () => {
    const wrapper = mount(AdminPanel);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('问答总数');
    expect(text).toContain('634');
    expect(text).toContain('559');
    expect(text).toContain('入 57405 / 出 6453 / 计费 63858');
    expect(text).toContain('有帮助');
    expect(text).toContain('28');

    // 未覆盖问题（运营补资料的靶子）连同时间一起显示
    expect(wrapper.text()).toContain('待补资料的问题');
    expect(wrapper.text()).toContain('你们有多少客户');
    expect(wrapper.find('.meta').text()).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);

    const urls = calls().map((c) => String(c[0]));
    expect(urls).toContain('/api/stats');
    expect(urls).toContain('/api/admin/uncovered');
    expect(urls).toContain('/api/admin/feedback-stats');
    wrapper.unmount();
  });

  it('口令只进 sessionStorage，并作为 authorization 头带上', async () => {
    const wrapper = mount(AdminPanel);
    await flushPromises();

    await wrapper.find('input[type="password"]').setValue('ci-only-token');
    await wrapper.find('button.linkish').trigger('click');
    await flushPromises();

    expect(sessionStorage.getItem('znwd.adminToken')).toBe('ci-only-token');
    const headers = calls()[calls().length - 1]![1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ci-only-token');

    // 清空口令后不再带 authorization，且 sessionStorage 里的旧值被清掉
    await wrapper.find('input[type="password"]').setValue('');
    await wrapper.find('button.linkish').trigger('click');
    await flushPromises();
    expect(sessionStorage.getItem('znwd.adminToken')).toBeNull();
    const last = calls()[calls().length - 1]![1]?.headers as Record<string, string>;
    expect(last.authorization).toBeUndefined();
    wrapper.unmount();
  });

  it('口令不对时给一句人话，不渲染半张统计表', async () => {
    stubApi({ unauthorized: true });
    const wrapper = mount(AdminPanel);
    await flushPromises();

    expect(wrapper.text()).toContain('口令不正确（401）');
    expect(wrapper.find('table').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('问答总数');
    wrapper.unmount();
  });

  it('接口挂掉时把原因显示出来，而不是留一片空白', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('请求失败（500）');
      }),
    );
    const wrapper = mount(AdminPanel);
    await flushPromises();

    expect(wrapper.find('.snippet').text()).toContain('请求失败（500）');
    wrapper.unmount();
  });

  it('知识库子面板与统计共用同一口令：knowledge 接口也带 authorization', async () => {
    const wrapper = mount(AdminPanel);
    await flushPromises();

    await wrapper.find('input[type="password"]').setValue('shared-token');
    await wrapper.find('button.linkish').trigger('click');
    await flushPromises();

    const knowledgeCalls = calls().filter(([url]) => String(url).includes('/api/knowledge/list'));
    expect(knowledgeCalls.length).toBeGreaterThan(0);
    // 提交口令后的那一次（列表最后一条）必须带上 authorization
    const last = knowledgeCalls[knowledgeCalls.length - 1]!;
    expect((last[1]!.headers as Record<string, string>).authorization).toBe('Bearer shared-token');
    // 口令提交后子面板拿的是 committed 值，不是输入框里的半截字
    expect(wrapper.text()).toContain('01_光伏清洁机器人/产品概述.md');
    wrapper.unmount();
  });
});
