// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SourcePanel from './SourcePanel.vue';
import type { Source } from '../api';

/**
 * 来源面板（SourcePanel.vue）：回答引用了哪几份资料，参观者与运营都会看。
 *
 * 后端已经按「与最高分同量级」筛过一轮（见 `RagPipeline.toSources`），这一层只管显示：
 * 标题、片段、展区，以及分数里**有值的部分**（融合分总有、语义分在降级模式下恒为 0、
 * 关键词分是这次筛选的依据）。
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

function mountWith(sources: Source[]) {
  return mount(SourcePanel, { props: { sources } });
}

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
