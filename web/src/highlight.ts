export interface HighlightSegment {
  text: string;
  hit: boolean;
}

/**
 * 把命中分块切成「命中词前 / 命中词 / 命中词后」三段，供来源面板展开时高亮。
 *
 * <p>matchOffset 为 -1、matchTerm 缺省（后端 jackson non_null，key 可能整个不给）
 * 或 offset 对不上位时，整段原文当一段返回——展示可以降级，但不能切错。
 * offset 是 Java String.indexOf 的字符下标（UTF-16），与 JS slice 同一套口径。
 */
export function highlightSegments(
  chunkText: string | null | undefined,
  matchTerm: string | null | undefined,
  matchOffset: number | null | undefined,
): HighlightSegment[] {
  if (!chunkText) return [];
  if (typeof matchTerm === 'string' && matchTerm.length > 0 && typeof matchOffset === 'number' && matchOffset >= 0) {
    const end = matchOffset + matchTerm.length;
    if (end <= chunkText.length && chunkText.slice(matchOffset, end) === matchTerm) {
      return [
        { text: chunkText.slice(0, matchOffset), hit: false },
        { text: matchTerm, hit: true },
        { text: chunkText.slice(end), hit: false },
      ];
    }
  }
  return [{ text: chunkText, hit: false }];
}
