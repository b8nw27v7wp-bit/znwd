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
  /**
   * 声学遥测：前端定期上报的增量计数 + 服务端算好的均值。
   * 语句数 10 与自动 6 / 手动 3 的差就是「超时结束」1——面板按这套分解显示。
   */
  speech: {
    utterances: 10,
    autoEnds: 6,
    manualEnds: 3,
    noSpeechAborts: 2,
    falseTriggers: 4,
    suspectedTruncations: 1,
    suppressedAbandons: 1,
    segmentCalls: 12,
    segmentFailures: 2,
    segmentDropped: 1,
    avgNoiseRms: 0.014,
    avgNoiseDb: -37.1,
    avgSpeechThreshold: 0.028,
    partialLatencyCount: 10,
    avgPartialLatencyMs: 820.5,
    // 三段延迟（§4 P2 修订 1）+ §5 S8 的音频秒数
    finalCalls: 7,
    avgFinalEndDelayMs: 1010,
    avgFinalLatencyMs: 1340,
    avgFinalServerMs: 240,
    firstSentenceCount: 7,
    avgFirstSentenceMs: 700,
    firstAudioCount: 7,
    avgFirstAudioMs: 420,
    asrAudioSec: 96.4,
    // 播报期间的回声与插话（P3a）
    echoSamples: 400,
    avgEchoRms: 0.031,
    avgEchoDb: -30.2,
    echoOverRate: 0.12,
    echoFarOverRate: 0.02,
    bargeIns: 3,
    bargeInRejected: 1,
  },
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

  it('把声学遥测渲染出来（底噪 / 语句分解 / 分段成败）', async () => {
    const wrapper = mount(AdminPanel);
    await flushPromises();

    const text = wrapper.text();
    expect(text).toContain('平均底噪');
    expect(text).toContain('-37.1 dB');
    expect(text).toContain('语句数');
    // 超时结束没有独立计数，面板按「语句数 − 自动 − 手动」显示：10 - 6 - 3 = 1
    expect(text).toContain('6 / 3 / 1');
    // 分段：调用 12 含失败 2，丢弃 1（并发上限挡下的那些）
    expect(text).toContain('12 / 2 / 1');
    expect(text).toContain('空识别误触');
    wrapper.unmount();
  });

  it('三段延迟各自成行、并带上音频秒与回声比例（§4 P2 / §5 S8 / P3a）', async () => {
    const wrapper = mount(AdminPanel);
    await flushPromises();

    // 按行首文案取值列：面板上数字很多（「3 / 1」这种组合在别处也出现过），
    // 只断言「整页文本里出现过」会把别的行一起认进去
    const cell = (label: string) => {
      const row = wrapper.findAll('tr').find((tr) => tr.text().startsWith(label));
      return row?.findAll('td')[1]?.text() ?? '';
    };
    // 自适应阈值要与底噪并排，才看得出「底噪有没有真的参与判决」
    expect(cell('当前说话阈值')).toBe('RMS 0.028');
    expect(cell('疑似漏断')).toContain('1');
    expect(cell('分段平均延迟')).toBe('820.5 ms');
    expect(cell('说完 → 收尾判决')).toBe('1010 ms');
    expect(cell('说完 → 终稿文本')).toBe('1340 ms（服务端 240 ms）');
    expect(cell('提问 → 首句生成')).toBe('700 ms');
    expect(cell('首句 → 首段音频')).toBe('420 ms');
    expect(cell('ASR 音频秒')).toBe('96.4 s');
    // 回声：这两行比例就是「插话门限该抬多高」的依据
    expect(cell('播报期间回声')).toBe('-30.2 dB（RMS 0.031）');
    expect(cell('其中越过说话阈值')).toBe('12.0% / 2.0%');
    expect(cell('判出的插话')).toBe('3 / 1');
    wrapper.unmount();
  });

  it('只有分段样本、没有终稿样本时，延迟表只出分段那一行（§5 S4 的边界）', async () => {
    // 现场真会出现「分段正常、整段全挂」（超时/配额只卡长音频）：那时 finalCalls 是 0，
    // 而分段延迟本来一直看得到——整表一个条件会把它一起藏掉，排查时反而少一条线索
    const { speech, ...rest } = STATS;
    const onlySegments = {
      ...rest,
      speech: {
        ...speech,
        finalCalls: 0,
        avgFinalEndDelayMs: 0,
        avgFinalLatencyMs: 0,
        avgFinalServerMs: 0,
        firstSentenceCount: 0,
        avgFirstSentenceMs: 0,
        firstAudioCount: 0,
        avgFirstAudioMs: 0,
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/stats')) return new Response(JSON.stringify(onlySegments), { status: 200 });
      if (url.includes('/api/admin/uncovered')) return new Response(JSON.stringify(UNCOVERED), { status: 200 });
      if (url.includes('/api/admin/feedback-stats')) return new Response(JSON.stringify(FEEDBACK), { status: 200 });
      if (url.includes('/api/knowledge/list')) return new Response(JSON.stringify(KNOWLEDGE_LIST), { status: 200 });
      if (url.includes('/api/admin/synonyms')) return new Response(JSON.stringify(SYNONYMS), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const wrapper = mount(AdminPanel);
    await flushPromises();

    const cell = (label: string) => {
      const row = wrapper.findAll('tr').find((tr) => tr.text().startsWith(label));
      return row?.findAll('td')[1]?.text() ?? '';
    };
    expect(cell('分段平均延迟'), '分段这一路照常可见').toBe('820.5 ms');
    expect(wrapper.text()).not.toContain('说完 → 终稿文本');
    expect(wrapper.text(), '一行样本都没有的路径不显示').not.toContain('提问 → 首句生成');
    // 一行都没有时整表也不该留着空壳
    expect(wrapper.text()).toContain('ASR 音频秒');
    wrapper.unmount();
  });

  it('没有回声样本时不出回声表（没开常开聆听的部署不该挂一排 0）', async () => {
    const { speech, ...rest } = STATS;
    const withoutEcho = { ...rest, speech: { ...speech, echoSamples: 0 } };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/stats')) return new Response(JSON.stringify(withoutEcho), { status: 200 });
      if (url.includes('/api/admin/uncovered')) return new Response(JSON.stringify(UNCOVERED), { status: 200 });
      if (url.includes('/api/admin/feedback-stats')) return new Response(JSON.stringify(FEEDBACK), { status: 200 });
      if (url.includes('/api/knowledge/list')) return new Response(JSON.stringify(KNOWLEDGE_LIST), { status: 200 });
      if (url.includes('/api/admin/synonyms')) return new Response(JSON.stringify(SYNONYMS), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const wrapper = mount(AdminPanel);
    await flushPromises();

    expect(wrapper.text(), '声学统计本身照常').toContain('平均底噪');
    expect(wrapper.text()).not.toContain('播报期间回声');
    wrapper.unmount();
  });

  it('没见过任何上报就不显示声学行（没开常开聆听的部署不该挂着一排 0）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/stats')) {
          const { speech: _speech, ...withoutSpeech } = STATS;
          return new Response(JSON.stringify(withoutSpeech), { status: 200 });
        }
        if (url.includes('/api/admin/uncovered')) return new Response(JSON.stringify(UNCOVERED), { status: 200 });
        if (url.includes('/api/admin/feedback-stats')) return new Response(JSON.stringify(FEEDBACK), { status: 200 });
        if (url.includes('/api/knowledge/list')) return new Response(JSON.stringify(KNOWLEDGE_LIST), { status: 200 });
        if (url.includes('/api/admin/synonyms')) return new Response(JSON.stringify(SYNONYMS), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const wrapper = mount(AdminPanel);
    await flushPromises();

    expect(wrapper.text()).toContain('问答总数'); // 统计本身照常
    expect(wrapper.text()).not.toContain('平均底噪');
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
