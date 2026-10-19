package com.znwd.hostess.knowledge;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 标题感知分块：markdown 标题作为硬边界，块内保留标题上下文；长段落滑窗切分并保留重叠。
 *
 * <p>分块质量直接决定检索上限——按字符硬切会把「叶片检测是否停机」这类问答拆到两个块里，
 * 检索到哪一块都答不全。参数与原 Node 版保持一致（500/80），改这里要重跑评测。
 *
 * <p><b>2026-10-19 修的两条坑，都在「长段落 + 标题」这条路上：</b>
 * <ol>
 *   <li><b>标题要预留位置</b>：正文按 500 打包、拼上标题就超过 500，于是又走一次滑窗切分；那次切分
 *       切的是「标题 + 正文」的拼接串，产出的续块<b>没有标题</b>，还因为 80 字符重叠变成上一块尾部的
 *       复制品。实测 {@code 04_光伏运维行业知识/标准与规范索引.md} 的「国内主要标准」一节被切成
 *       500（硬断在「等同采用 IEC 617」）+ 99（无标题碎片）+ 334（正文开头是「测。」）三块。
 *       现在先按标题长度扣预算，正文只按剩余空间打包，拼上标题必然不超上限。</li>
 *   <li><b>切分点优先落在自然边界</b>：滑窗原来的切点是纯字符位置，会把条目、标准号、句子切一半。
 *       现在从窗口末尾往回最多找 30% 的换行或中文句末标点，找不到才硬切。</li>
 * </ol>
 */
public final class TextChunker {

    public static final int CHUNK_MAX_CHARS = 500;
    public static final int CHUNK_OVERLAP_CHARS = 80;

    private static final Pattern HEADING = Pattern.compile("^#{1,6}\\s+");
    private static final Pattern LINE_SPLIT = Pattern.compile("\\r?\\n");
    /** 续块的标题后缀，长度要算进「标题预留」里 */
    static final String CONTINUATION_SUFFIX = "（续）";
    /** 自然边界的回退比例：最多让出窗口的 30%，再远就宁可硬切（否则块会碎成一句一块） */
    private static final int BOUNDARY_LOOKBACK_PERCENT = 30;
    private static final String SENTENCE_ENDS = "。；！？";

    private TextChunker() {
    }

    public static List<String> chunkText(String text) {
        return chunkText(text, CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS);
    }

    public static List<String> chunkText(String text, int maxChars, int overlap) {
        int safeMax = Math.max(1, maxChars);
        int safeOverlap = Math.max(0, Math.min(overlap, safeMax - 1));
        List<Section> sections = new ArrayList<>();
        Section current = new Section("", new ArrayList<>());
        List<String> buf = new ArrayList<>();

        for (String line : LINE_SPLIT.split(text, -1)) {
            if (HEADING.matcher(line).find()) {
                buf = flushParagraph(buf, current);
                if (!current.heading().isEmpty() || !current.paragraphs().isEmpty()) {
                    sections.add(current);
                }
                current = new Section(HEADING.matcher(line).replaceFirst("").strip(), new ArrayList<>());
                continue;
            }
            if (line.isBlank()) {
                buf = flushParagraph(buf, current);
                continue;
            }
            buf.add(line);
        }
        flushParagraph(buf, current);
        if (!current.heading().isEmpty() || !current.paragraphs().isEmpty()) {
            sections.add(current);
        }

        List<String> chunks = new ArrayList<>();
        for (Section section : sections) {
            String heading = section.heading();
            int bodyMax = Math.max(1, safeMax - headingReserve(heading, safeMax));
            List<String> packed = packParagraphs(section.paragraphs(), bodyMax, safeOverlap);
            for (int i = 0; i < packed.size(); i++) {
                String body = packed.get(i);
                String composed = compose(heading, body, i == 0).strip();
                if (composed.isEmpty()) {
                    continue;
                }
                if (composed.length() <= safeMax) {
                    chunks.add(composed);
                    continue;
                }
                // 兜底：只有标题长到把正文预算挤没时才会走到这里。切的是**正文**，每块再补标题；
                // 绝不切「标题 + 正文」的拼接串——那样产出的续块没有标题，正是本轮修掉的那类碎片。
                List<String> parts = splitLong(body, bodyMax, safeOverlap);
                for (int j = 0; j < parts.size(); j++) {
                    String piece = compose(heading, parts.get(j), i == 0 && j == 0).strip();
                    if (!piece.isEmpty()) {
                        chunks.add(piece);
                    }
                }
            }
        }
        return chunks;
    }

    /** 续块的标题也得装得下：预留 = 标题长度 + 空行 + 「（续）」；标题超长时最多占上限的三分之一 */
    private static int headingReserve(String heading, int maxChars) {
        if (heading == null || heading.isEmpty()) {
            return 0;
        }
        return Math.min(heading.length() + 2 + CONTINUATION_SUFFIX.length(), maxChars / 3);
    }

    private static String compose(String heading, String body, boolean first) {
        if (heading == null || heading.isEmpty()) {
            return body;
        }
        return first ? heading + "\n\n" + body : heading + CONTINUATION_SUFFIX + "\n\n" + body;
    }

    private static List<String> flushParagraph(List<String> buf, Section current) {
        if (!buf.isEmpty()) {
            String p = String.join("\n", buf).strip();
            if (!p.isEmpty()) {
                current.paragraphs().add(p);
            }
        }
        return new ArrayList<>();
    }

    private static List<String> packParagraphs(List<String> paragraphs, int maxChars, int overlap) {
        List<String> chunks = new ArrayList<>();
        String buf = "";
        for (String p : paragraphs) {
            if (buf.isEmpty()) {
                buf = p;
            } else if (buf.length() + p.length() + 2 <= maxChars) {
                buf = buf + "\n\n" + p;
            } else {
                chunks.add(buf);
                buf = p;
            }
            // 单段超长：先落盘已累积内容，再滑窗切分该段
            if (buf.length() > maxChars) {
                chunks.addAll(splitLong(buf, maxChars, overlap));
                buf = "";
            }
        }
        if (!buf.isEmpty()) {
            chunks.add(buf);
        }
        return chunks;
    }

    /**
     * 滑窗切分：窗口上限 {@code maxChars}，相邻窗口重叠 {@code overlap} 个字符。
     *
     * <p>切点优先落在自然边界（换行或中文句末标点）：从窗口末尾往回找，最多让出窗口的
     * {@link #BOUNDARY_LOOKBACK_PERCENT}%，找到就把窗口收在那里；找不到（整段没有标点的长串）才硬切。
     */
    private static List<String> splitLong(String text, int maxChars, int overlap) {
        List<String> parts = new ArrayList<>();
        int start = 0;
        while (start < text.length()) {
            int end = Math.min(text.length(), start + maxChars);
            if (end < text.length()) {
                int boundary = lastBoundary(text, start, end);
                if (boundary > start) {
                    end = boundary;
                }
            }
            parts.add(text.substring(start, end));
            if (end >= text.length()) {
                break;
            }
            int next = end - overlap;
            // 保证前进：overlap 大过窗口时不能让 start 原地不动，否则死循环
            start = next > start ? next : end;
        }
        return parts;
    }

    /** 在 {@code (floor, end]} 里找最靠后的自然断点，返回断点**之后**的下标（含该字符）；找不到返回 -1 */
    private static int lastBoundary(String text, int start, int end) {
        int lookback = Math.max(1, (end - start) * BOUNDARY_LOOKBACK_PERCENT / 100);
        int floor = Math.max(start + 1, end - lookback);
        for (int i = end; i > floor; i--) {
            char c = text.charAt(i - 1);
            if (c == '\n' || SENTENCE_ENDS.indexOf(c) >= 0) {
                return i;
            }
        }
        return -1;
    }

    private record Section(String heading, List<String> paragraphs) {
    }
}
