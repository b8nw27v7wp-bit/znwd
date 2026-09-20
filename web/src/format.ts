/**
 * 把模型返回的轻量 Markdown 洗成展厅大屏能看的文本块。
 *
 * 为什么需要：模型习惯用 Markdown 分点，直接当纯文本渲染时大屏上会出现字面的
 * `**` 和 `*`（实测回答里就有「检测**无需停机**」这种）。完整的 Markdown 渲染器
 * 对这个场景太重——不需要链接、表格、代码，只需要粗体、列表和分段。
 *
 * 安全：这里不产出 HTML，只产出结构（段落/列表项 + 粗体片段），由 Vue 模板渲染，
 * 所以模型输出里的尖括号永远只是文字，不存在注入面。
 */

export type Segment = { text: string; bold: boolean };
export type Block = { kind: 'p' | 'li'; marker?: string; segments: Segment[] };

/** 行首的列表记号：`1.` `1、` `1)` 保留编号，`-` `*` `·` `•` 统一成中点 */
const LIST_RE = /^(\d+[.、)]|[-*·•])\s+(.*)$/;

/** 拆行内粗体：`**文字**` → bold 段；落单的 `**` 直接去掉，别让记号上屏 */
function inlineSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), bold: false });
    segments.push({ text: match[1], bold: true });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), bold: false });
  return segments
    .map((s) => ({ ...s, text: s.text.replace(/\*\*/g, '') }))
    .filter((s) => s.text.length > 0);
}

export function formatAnswer(raw: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (!paragraph.length) return;
    const segments = inlineSegments(paragraph.join(' ').trim());
    if (segments.length) blocks.push({ kind: 'p', segments });
    paragraph = [];
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('```')) continue; // 代码围栏本身不显示，里面的行按普通文本处理
    if (!line) {
      flush();
      continue;
    }
    const heading = line.replace(/^#{1,6}\s*/, ''); // 标题记号去掉，按普通段落排
    const list = LIST_RE.exec(heading);
    if (list) {
      flush();
      const marker = /^\d/.test(list[1]) ? list[1] : '·';
      const segments = inlineSegments(list[2].trim());
      if (segments.length) blocks.push({ kind: 'li', marker, segments });
      continue;
    }
    paragraph.push(heading);
  }
  flush();
  return blocks;
}
