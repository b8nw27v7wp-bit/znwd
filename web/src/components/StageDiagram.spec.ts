// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StageDiagram from './StageDiagram.vue';

/**
 * 大屏右侧的项目讲解图（StageDiagram.vue）。
 *
 * 它是纯展示组件，但有一件事必须守住：**图上的数字与仓库口径一致**。
 * 组件注释里写明「改资料或阈值时只改这里的常量，不会出现图和代码对不上」——
 * 这条约定没有测试兜着就只是愿望，所以下面既断言结构，也断言当前口径的关键数字。
 * 语料/阈值/评测数字变了而图没跟着改，这里就会红。
 */
describe('项目讲解图', () => {
  it('三块内容都在：链路图、RAG 原理、技术栈与实测数据', () => {
    const wrapper = mount(StageDiagram);
    const text = wrapper.text();
    expect(text).toContain('一次问答的链路');
    expect(text).toContain('RAG 的基本原理');
    expect(text).toContain('用到的技术栈');
    expect(wrapper.findAll('svg').length).toBe(2);
    wrapper.unmount();
  });

  it('链路图四个节点都渲染，闸门那一步标为关键', () => {
    const wrapper = mount(StageDiagram);
    const text = wrapper.text();
    for (const node of ['资料库', '双路检索', '相关性闸门', '生成回答']) {
      expect(text).toContain(node);
    }
    for (const step of ['01', '02', '03', '04']) {
      expect(text).toContain(step);
    }
    // 关键一步靠边框深浅区分（不用颜色）：闸门节点的 stroke 比其余节点深
    const strokes = wrapper.findAll('rect').map((r) => r.attributes('stroke'));
    expect(strokes).toContain('#1d1d1f');
    expect(strokes).toContain('#e5e5ea');
    wrapper.unmount();
  });

  it('未命中支路写明固定拒答且不调模型', () => {
    const wrapper = mount(StageDiagram);
    const text = wrapper.text();
    expect(text).toContain('未命中');
    expect(text).toContain('固定拒答（0 token）');
    expect(text).toContain('记入未覆盖清单');
    wrapper.unmount();
  });

  it('技术栈与实测数据都是 6 项', () => {
    const wrapper = mount(StageDiagram);
    expect(wrapper.findAll('.stack li').length).toBe(6);
    expect(wrapper.findAll('.metrics > div').length).toBe(6);
    wrapper.unmount();
  });

  it('图上的数字与仓库当前口径一致（改了图没改这里会红）', () => {
    const wrapper = mount(StageDiagram);
    const text = wrapper.text();
    // 语料：knowledge 209 块（/api/health 实测）
    expect(text).toContain('209 个片段');
    expect(text).toContain('209 片段');
    // 阈值：四处同步的 MIN_RELEVANCE_SCORE=6.3
    expect(text).toContain('阈值 6.3');
    // 评测基线：137 条计分用例 top1/top3 = 1.0，闸门误拦 2 条
    expect(text).toContain('1.0 / 1.0');
    expect(text).toContain('2 / 137');
    // 冒烟项数
    expect(text).toContain('56 项');
    wrapper.unmount();
  });
});
