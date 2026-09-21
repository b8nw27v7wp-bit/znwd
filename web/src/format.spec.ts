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

/**
 * 注入面：模型输出（以及被注入的提问）最终会上大屏，排版函数的产出只允许是
 * 「结构 + 文本」，任何能让浏览器当 HTML/JS 解析的东西都不该在这里出现。
 * 这批用例是安全测试的一部分（见 tools/security.py 的 S 组与 docs/security-testing.md）。
 */
describe('回答排版的注入面', () => {
  it('HTML 标签与事件属性原样当文字，结构里没有 HTML 字段', () => {
    const blocks = formatAnswer('结果 <img src=x onerror=alert(1)> 如下');
    const segs = blocks.flatMap((b) => b.segments);
    expect(segs.map((s) => s.text).join('')).toContain('<img src=x onerror=alert(1)>');
    // 唯一允许的字段就是 text/bold：模板外没有任何地方能塞 href/src/onerror
    expect(segs.every((s) => Object.keys(s).sort().join() === 'bold,text')).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain('onerror":');
  });

  it('链接语法不产生可点击节点（没有 href/url 字段）', () => {
    const blocks = formatAnswer('[点我](javascript:alert(1)) 与 [x](https://evil.example)');
    expect(JSON.stringify(blocks)).not.toContain('"href"');
    expect(JSON.stringify(blocks)).not.toContain('"url"');
    expect(blocks[0]?.segments.map((s) => s.text).join('')).toContain('javascript:alert(1)');
  });

  it('用粗体记号闭合属性也逃不出文本段', () => {
    const blocks = formatAnswer('**"><img src=x onerror=alert(1)>**');
    const bold = blocks.flatMap((b) => b.segments).filter((s) => s.bold).map((s) => s.text).join('');
    expect(bold).toContain('<img src=x onerror=alert(1)>');
    expect(Object.keys(blocks.flatMap((b) => b.segments)[0]!).sort().join()).toBe('bold,text');
  });
});
