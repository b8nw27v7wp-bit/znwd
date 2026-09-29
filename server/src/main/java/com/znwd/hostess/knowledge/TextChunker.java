package com.znwd.hostess.knowledge;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 标题感知分块：markdown 标题作为硬边界，块内保留标题上下文；长段落滑窗切分并保留重叠。
 *
 * <p>分块质量直接决定检索上限——按字符硬切会把「叶片检测是否停机」这类问答拆到两个块里，
 * 检索到哪一块都答不全。参数与原 Node 版保持一致（500/80），改这里要重跑评测。
 */
public final class TextChunker {

    public static final int CHUNK_MAX_CHARS = 500;
    public static final int CHUNK_OVERLAP_CHARS = 80;

    private static final Pattern HEADING = Pattern.compile("^#{1,6}\\s+");
    private static final Pattern LINE_SPLIT = Pattern.compile("\\r?\\n");

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
            List<String> packed = packParagraphs(section.paragraphs(), safeMax, safeOverlap);
            for (int i = 0; i < packed.size(); i++) {
                String body = packed.get(i);
                String withHeading;
                if (section.heading().isEmpty()) {
                    withHeading = body;
                } else if (i == 0) {
                    withHeading = section.heading() + "\n\n" + body;
                } else {
                    // 后续块也带标题，避免脱离上下文后语义漂移
                    withHeading = section.heading() + "（续）\n\n" + body;
                }
                String trimmed = withHeading.strip();
                if (!trimmed.isEmpty()) {
                    if (trimmed.length() > safeMax) {
                        chunks.addAll(splitLong(trimmed, safeMax, safeOverlap));
                    } else {
                        chunks.add(trimmed);
                    }
                }
            }
        }
        return chunks;
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

    private static List<String> splitLong(String text, int maxChars, int overlap) {
        List<String> parts = new ArrayList<>();
        int step = Math.max(1, maxChars - overlap);
        for (int i = 0; i < text.length(); i += step) {
            parts.add(text.substring(i, Math.min(text.length(), i + maxChars)));
        }
        return parts;
    }

    private record Section(String heading, List<String> paragraphs) {
    }
}
