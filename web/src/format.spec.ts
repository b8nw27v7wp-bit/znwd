import { describe, expect, it } from 'vitest';
import { formatAnswer } from './format';

/** 回答排版：大屏上不能出现字面的 Markdown 记号，但结构要留住（粗体、分点、分段） */
describe('回答排版', () => {
  it('粗体转成 bold 片段，记号不上屏', () => {
    const blocks = formatAnswer('风机叶片检测**无需停机**。');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('p');
    expect(blocks[0]?.segments).toEqual([
      { text: '风机叶片检测', bold: false },
      { text: '无需停机', bold: true },
      { text: '。', bold: false },
    ]);
  });

  it('有序列表保留编号，无序列表统一成中点', () => {
    const blocks = formatAnswer('两种方案：\n1.  地面拍摄方案\n2. 无人机检测方案\n*   补充说明');
    expect(blocks.map((b) => [b.kind, b.marker])).toEqual([
      ['p', undefined],
      ['li', '1.'],
      ['li', '2.'],
      ['li', '·'],
    ]);
    expect(blocks[3]?.segments[0]?.text).toBe('补充说明');
  });

  it('空行分段，连续行并成一段', () => {
    const blocks = formatAnswer('第一段第一行\n第一段第二行\n\n第二段');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.segments[0]?.text).toBe('第一段第一行 第一段第二行');
    expect(blocks[1]?.segments[0]?.text).toBe('第二段');
  });

  it('去掉标题记号与代码围栏，内容按普通文本保留', () => {
    const blocks = formatAnswer('## 结论\n\n```\n检测流程\n```');
    const texts = blocks.map((b) => b.segments.map((s) => s.text).join(''));
    expect(texts).toEqual(['结论', '检测流程']);
    expect(texts.join('')).not.toContain('`');
    expect(texts.join('')).not.toContain('#');
  });

  it('落单的 ** 不残留，尖括号只是文字（不产出 HTML）', () => {
    const blocks = formatAnswer('这里有**落单记号 <script>alert(1)</script>');
    const text = blocks[0]?.segments.map((s) => s.text).join('') ?? '';
    expect(text).not.toContain('**');
    expect(text).toContain('<script>alert(1)</script>');
    // 结构里只有 text/bold，没有 HTML 字段 —— 渲染交给模板，天然无注入
    expect(Object.keys(blocks[0]!.segments[0]!)).toEqual(['text', 'bold']);
  });

  it('空回答与纯空白返回空数组', () => {
    expect(formatAnswer('')).toEqual([]);
    expect(formatAnswer('   \n\n  ')).toEqual([]);
  });
});
