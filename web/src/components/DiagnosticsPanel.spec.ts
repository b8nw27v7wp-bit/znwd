// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import DiagnosticsPanel from './DiagnosticsPanel.vue';

/**
 * 检索诊断（DiagnosticsPanel.vue）：给一个真实问题，看这次会被闸门怎么判。
 *
 * 面板的三个承诺各钉一条：请求带口令且 q 正确编码（中文问句在 GBK 控制台下最容易栽在这）、
 * 判定/分数/原因/距离都显示成人话、失败（401、网络）绝不静默。
 */

const GATED = {
  query: '有客户了吗',
  gated: true,
  mode: 'keyword',
  reason: 'below_threshold',
  keywordGateScore: 4.9037,
  keywordBestScore: 4.9037,
  vectorBestCosine: 0.6389,
  candidates: 16,
  thresholds: { minKeywordScore: 6.3, minVectorScore: 0.75 },
  distanceToGate: 1.3963,
  verdict: '关键词 4.90，差 1.40 分；余弦 0.64 不够兜底',
  hits: [],
};

const PASS = {
  query: '清洁作业流程是怎样的？',
  gated: false,
  mode: 'keyword',
  reason: 'keyword_hit',
  keywordGateScore: 31.58,
  keywordBestScore: 32.89,
  vectorBestCosine: 0.41,
  candidates: 3,
  thresholds: { minKeywordScore: 6.3, minVectorScore: 0.75 },
  distanceToGate: -26.59,
  verdict: '命中：关键词余量 26.59',
  hits: [
    {
      title: '清洁作业流程',
      sourcePath: '01_光伏清洁机器人/清洁作业流程.md',
      zone: 'pv-clean',
      zoneTitle: '光伏清洁机器人',
      fuseScore: 0.91,
      keywordScore: 32.89,
      vectorScore: 0,
      snippet: '巡检前先……',
    },
  ],
};

function stubApi(options: { unauthorized?: boolean; result?: unknown } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (options.unauthorized) return new Response('{"error":"unauthorized"}', { status: 401 });
      if (url.includes('/api/admin/diagnostics')) {
        // 回显请求里的 q：连续诊断的测试要靠它区分每一条结果
        const q = decodeURIComponent(url.split('q=')[1] ?? '');
        const base = (options.result ?? GATED) as Record<string, unknown>;
        return new Response(JSON.stringify({ ...base, query: q }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

function calls(): Array<[string, RequestInit | undefined]> {
  return (fetch as unknown as { mock: { calls: Array<[string, RequestInit | undefined]> } }).mock.calls;
}

async function ask(wrapper: ReturnType<typeof mount>, question: string): Promise<void> {
  await wrapper.find('input[type="text"]').setValue(question);
  await wrapper.find('button').trigger('click');
  await flushPromises();
}

beforeEach(() => {
  vi.unstubAllGlobals();
  stubApi();
});

describe('检索诊断', () => {
  it('点「诊断」：请求带口令且 q 编码正确，判定、分数、原因都显示出来', async () => {
    const wrapper = mount(DiagnosticsPanel, { props: { token: 'tok' } });
    await ask(wrapper, '有客户了吗');

    const call = calls().find(([url]) => String(url).includes('/api/admin/diagnostics'));
    expect(call).toBeTruthy();
    expect(String(call![0])).toBe(`/api/admin/diagnostics?q=${encodeURIComponent('有客户了吗')}`);
    expect((call![1]!.headers as Record<string, string>).authorization).toBe('Bearer tok');

    const text = wrapper.text();
    expect(text).toContain('有客户了吗');
    expect(text).toContain('拦下');
    expect(text).toContain('低于阈值');
    expect(text).toContain('4.90'); // 关键词闸门分
    expect(text).toContain('6.30 / 0.75'); // 阈值
    expect(text).toContain('还差 1.40 分'); // 距离闸门
    expect(text).toContain('16'); // 候选数
    expect(text).toContain('关键词 4.90，差 1.40 分；余弦 0.64 不够兜底'); // verdict
    wrapper.unmount();
  });

  it('通过闸门的诊断显示「通过」并列出命中资料', async () => {
    stubApi({ result: PASS });
    const wrapper = mount(DiagnosticsPanel, { props: { token: '' } });
    await ask(wrapper, '清洁作业流程是怎样的？');

    const text = wrapper.text();
    expect(text).toContain('通过');
    expect(text).toContain('关键词命中');
    expect(text).toContain('已超出 26.59 分');
    expect(text).toContain('清洁作业流程');
    expect(text).toContain('光伏清洁机器人');
    wrapper.unmount();
  });

  it('口令不对时给出「口令不正确（401）」，不渲染结果', async () => {
    stubApi({ unauthorized: true });
    const wrapper = mount(DiagnosticsPanel, { props: { token: 'bad' } });
    await ask(wrapper, '叶片检测要停机吗？');

    expect(wrapper.text()).toContain('口令不正确（401）');
    expect(wrapper.find('table').exists()).toBe(false);
    wrapper.unmount();
  });

  it('空问题不发请求；有内容才发，且按去空格后的问题发', async () => {
    const wrapper = mount(DiagnosticsPanel, { props: { token: '' } });
    const button = wrapper.find('button');
    expect(button.attributes('disabled')).toBeDefined();

    await wrapper.find('input[type="text"]').setValue('   ');
    await button.trigger('click');
    await flushPromises();
    expect(calls().length).toBe(0);

    await wrapper.find('input[type="text"]').setValue('  有客户了吗 ');
    expect(button.attributes('disabled')).toBeUndefined();
    await button.trigger('click');
    await flushPromises();
    expect(calls().length).toBe(1);
    expect(String(calls()[0]![0])).toContain(encodeURIComponent('有客户了吗'));
    wrapper.unmount();
  });

  it('连续诊断按新→旧保留最近 5 次，可一键清空', async () => {
    const wrapper = mount(DiagnosticsPanel, { props: { token: '' } });
    for (const question of ['问一', '问二', '问三', '问四', '问五', '问六']) {
      await ask(wrapper, question);
    }

    const items = wrapper.findAll('.diag-item');
    expect(items.length).toBe(5);
    expect(items[0]!.text()).toContain('问六');
    expect(items[4]!.text()).toContain('问二');

    const clear = wrapper.findAll('button').find((b) => b.text() === '清空')!;
    await clear.trigger('click');
    expect(wrapper.findAll('.diag-item').length).toBe(0);
    wrapper.unmount();
  });

  it('诊断中不允许重复提交', async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => gate),
    );
    const wrapper = mount(DiagnosticsPanel, { props: { token: '' } });
    await wrapper.find('input[type="text"]').setValue('有客户了吗');
    const button = wrapper.find('button');
    await button.trigger('click');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.text()).toContain('诊断中');

    release(new Response(JSON.stringify(GATED), { status: 200 }));
    await flushPromises();
    expect(wrapper.findAll('.diag-item').length).toBe(1);
    expect(button.text()).toBe('诊断');
    wrapper.unmount();
  });

  it('换口令后旧结果作废', async () => {
    const wrapper = mount(DiagnosticsPanel, { props: { token: 'a' } });
    await ask(wrapper, '有客户了吗');
    expect(wrapper.findAll('.diag-item').length).toBe(1);

    await wrapper.setProps({ token: 'b' });
    await flushPromises();
    expect(wrapper.findAll('.diag-item').length).toBe(0);
    wrapper.unmount();
  });
});
