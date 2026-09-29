// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SourcePanel from './SourcePanel.vue';
import { highlightSegments } from '../highlight';
import type { Source } from '../api';

/**
 * 来源面板（SourcePanel.vue）：回答引用了哪几份资料，参观者与运营都会看。
 *
 * 后端已经按「与最高分同量级」筛过一轮（见 `RagPipeline.toSources`），这一层只管显示：
 * 标题、片段、展区，以及分数里**有值的部分**（融合分总有、语义分在降级模式下恒为 0、
 * 关键词分是这次筛选的依据）。后端补了命中定位三件套后，还能点开整段原文、
 * 在 matchOffset 处高亮 matchTerm——切分逻辑单独钉在 highlightSegments 上。
 */

const base: Source = {
  title: '项目与团队常见问题',
  snippet: '申报书按“以合同为准”填写：客户数量 0 个',
  score: 0.0164,
  sourcePath: '03_项目与团队/常见问题.md',
  zone: 'project',
  zoneTitle: '项目与团队',
  vectorScore: 0,
  keywordScore: 8.4,
};

const located: Source = {
  ...base,
  chunkText: '巡检时发现叶片有裂纹',
  matchTerm: '叶片',
  matchOffset: 5,
};

function mountWith(sources: Source[]) {
  return mount(SourcePanel, { props: { sources } });
}

describe('命中高亮切分（highlightSegments）', () => {
  it('按 matchOffset 切出命中词前 / 命中词 / 命中词后', () => {
    expect(highlightSegments('巡检时发现叶片有裂纹', '叶片', 5)).toEqual([
      { text: '巡检时发现', hit: false },
      { text: '叶片', hit: true },
      { text: '有裂纹', hit: false },
    ]);
  });

  it('offset 为 -1、命中词缺省或为 null：整段原文不切', () => {
    expect(highlightSegments('整段原文', '叶片', -1)).toEqual([{ text: '整段原文', hit: false }]);
    expect(highlightSegments('整段原文', undefined, 3)).toEqual([{ text: '整段原文', hit: false }]);
    expect(highlightSegments('整段原文', null, null)).toEqual([{ text: '整段原文', hit: false }]);
  });

  it('offset 对不上或越界时宁可不高亮也不错切', () => {
    expect(highlightSegments('巡检时发现叶片有裂纹', '叶片', 0)).toEqual([
      { text: '巡检时发现叶片有裂纹', hit: false },
    ]);
    expect(highlightSegments('短文', '叶片', 99)).toEqual([{ text: '短文', hit: false }]);
  });

  it('没有 chunkText 时返回空数组（面板不渲染展开区）', () => {
    expect(highlightSegments(undefined, '叶片', 0)).toEqual([]);
    expect(highlightSegments('', '叶片', 0)).toEqual([]);
  });
});

describe('来源面板', () => {
  it('没有来源时给一句说明，不渲染卡片', () => {
    const wrapper = mountWith([]);
    expect(wrapper.text()).toContain('回答引用到的资料会显示在这里');
    expect(wrapper.findAll('.card').length).toBe(0);
    wrapper.unmount();
  });

  it('每条来源渲染标题、片段与展区', () => {
    const wrapper = mountWith([base, { ...base, title: '商业模式与定价', sourcePath: '03_项目与团队/商业模式与定价.md' }]);
    const cards = wrapper.findAll('.card');
    expect(cards.length).toBe(2);
    expect(cards[0]!.find('.title').text()).toBe('项目与团队常见问题');
    expect(cards[0]!.find('.snippet').text()).toContain('客户数量 0 个');
    expect(cards[0]!.find('.meta').text()).toContain('项目与团队');
    wrapper.unmount();
  });

  it('分数只显示有值的部分：语义分为 0 时不显示', () => {
    const degraded = mountWith([base]);
    const meta = degraded.find('.meta').text();
    expect(meta).toContain('融合 0.02');
    expect(meta).toContain('关键词 8.4');
    expect(meta).not.toContain('语义');
    degraded.unmount();

    // 真语义向量接上之后（vectorScore > 0）才会多出这一段
    const semantic = mountWith([{ ...base, vectorScore: 0.78 }]);
    expect(semantic.find('.meta').text()).toContain('语义 0.78');
    semantic.unmount();
  });

  it('缺展区信息时回落为「未分展区」', () => {
    const wrapper = mountWith([{ ...base, zone: null, zoneTitle: null }]);
    expect(wrapper.find('.meta').text()).toContain('未分展区');
    wrapper.unmount();
  });

  it('片段里的尖括号当文字渲染，不生成元素', () => {
    const xss = '<img src=x onerror=alert(1)>';
    const wrapper = mountWith([{ ...base, snippet: `片段 ${xss}` }]);
    expect(wrapper.element.querySelector('img')).toBeNull();
    expect(wrapper.find('.snippet').text()).toContain(xss);
    expect(wrapper.find('.snippet').html()).toContain('&lt;img');
    wrapper.unmount();
  });
});

describe('来源面板：展开完整原文与高亮', () => {
  it('有 chunkText 时整行标题可点，展开后在命中处高亮', async () => {
    const wrapper = mountWith([located]);
    const head = wrapper.find('button.src-head');
    expect(head.exists()).toBe(true);
    expect(head.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('.src-full').exists()).toBe(false);

    await head.trigger('click');
    expect(head.attributes('aria-expanded')).toBe('true');
    const full = wrapper.find('.src-full');
    expect(full.text()).toBe('巡检时发现叶片有裂纹');
    const mark = full.find('mark');
    expect(mark.text()).toBe('叶片');
    expect(mark.element.previousElementSibling?.textContent).toBe('巡检时发现');
    expect(mark.element.nextElementSibling?.textContent).toBe('有裂纹');

    await head.trigger('click');
    expect(wrapper.find('.src-full').exists()).toBe(false);
    wrapper.unmount();
  });

  it('未定位（matchOffset=-1、matchTerm 缺省）时只展示原文，不高亮', async () => {
    const wrapper = mountWith([{ ...base, chunkText: '整段原文没有高亮', matchOffset: -1 }]);
    await wrapper.find('button.src-head').trigger('click');
    const full = wrapper.find('.src-full');
    expect(full.exists()).toBe(true);
    expect(full.find('mark').exists()).toBe(false);
    expect(full.text()).toBe('整段原文没有高亮');
    wrapper.unmount();
  });

  it('多条来源各自独立展开', async () => {
    const wrapper = mountWith([located, { ...located, sourcePath: 'other.md' }]);
    const heads = wrapper.findAll('button.src-head');
    expect(heads.length).toBe(2);
    await heads[0]!.trigger('click');
    expect(wrapper.findAll('.src-full').length).toBe(1);
    await heads[1]!.trigger('click');
    expect(wrapper.findAll('.src-full').length).toBe(2);
    wrapper.unmount();
  });

  it('没有 chunkText（老服务端）时不给展开入口，原有信息照常渲染', () => {
    const wrapper = mountWith([base]);
    expect(wrapper.find('button.src-head').exists()).toBe(false);
    expect(wrapper.find('.title').text()).toBe('项目与团队常见问题');
    expect(wrapper.find('.snippet').exists()).toBe(true);
    expect(wrapper.find('.meta').exists()).toBe(true);
    wrapper.unmount();
  });
});
