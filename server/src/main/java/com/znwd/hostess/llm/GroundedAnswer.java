package com.znwd.hostess.llm;

import java.util.ArrayList;
import java.util.List;

/**
 * 离线演示模型：尽量从检索片段抽取要点，减少空话。接入 openai_compat 后由真实模型覆盖。
 *
 * <p>存在价值：展厅断网/网关额度用尽时界面仍然能演示，且评测不依赖外部服务。
 */
public class GroundedAnswer {

    private GroundedAnswer() {
    }

    public static String build(String question, String context, int historyTurns) {
        List<Chunk> chunks = extractChunks(context);
        String multi = historyTurns > 0 ? "\n（已结合前序 " + historyTurns + " 轮对话）" : "";

        if (chunks.isEmpty()) {
            return String.join("\n",
                    "关于「" + question + "」：展厅资料中没有这方面的内容。",
                    "可以换个问法，例如：",
                    "   · 光伏清洁无人机是做什么的？",
                    "   · 风场检测无人机怎么检测叶片？",
                    "   · 提供哪些培训与服务合作？",
                    "（Mock 演示回复 · 未命中知识片段）" + multi);
        }

        List<String> lines = new ArrayList<>();
        lines.add("关于「" + question + "」，根据展厅资料：");
        List<Chunk> shown = chunks.size() <= 3 ? chunks : chunks.subList(0, 3);
        for (int i = 0; i < shown.size(); i++) {
            Chunk c = shown.get(i);
            List<String> bullets = pickLines(c.body(), 3);
            if (!bullets.isEmpty()) {
                lines.add("\n" + (i + 1) + ". 【" + c.title() + "】");
                for (String b : bullets) {
                    lines.add("   · " + b);
                }
            } else {
                lines.add("\n" + (i + 1) + ". 【" + c.title() + "】" + cut(c.body(), 80));
            }
        }
        lines.add("\n如需完整参数或方案对接，请联系现场讲解或业务同事。" + multi);
        lines.add("（Mock 演示回复 · 基于检索片段整理）");
        return String.join("\n", lines);
    }

    private static String cut(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max);
    }

    private static List<String> pickLines(String text, int max) {
        List<String> out = new ArrayList<>();
        for (String raw : text.split("\\n+")) {
            String l = raw.replaceAll("^#+\\s*", "")
                    .replaceAll("^\\s*[-*+•]\\s+", "")
                    .replaceAll("^\\s*\\d+[.、)]\\s*", "")
                    .replace("**", "")
                    .strip();
            if (l.length() >= 8 && !l.startsWith("|") && !l.startsWith("---")) {
                out.add(l);
            }
            if (out.size() >= max) {
                break;
            }
        }
        return out;
    }

    /** 从 system 上下文里抽「【片段 i｜title｜zone｜path】 body」 */
    private static List<Chunk> extractChunks(String context) {
        List<Chunk> out = new ArrayList<>();
        int idx = 0;
        while (true) {
            int start = context.indexOf("【片段", idx);
            if (start < 0) {
                break;
            }
            int headerEnd = context.indexOf("】", start);
            if (headerEnd < 0) {
                break;
            }
            String header = context.substring(start + 3, headerEnd);
            String[] parts = header.split("｜");
            String title = parts.length > 0 ? parts[0].strip() : "";
            int bodyStart = headerEnd + 1;
            if (bodyStart < context.length() && context.charAt(bodyStart) == '\n') {
                bodyStart++;
            }
            int next = context.indexOf("\n\n【片段", bodyStart);
            String body = (next < 0 ? context.substring(bodyStart) : context.substring(bodyStart, next)).strip();
            out.add(new Chunk(title, body));
            idx = next < 0 ? headerEnd : next;
            if (next < 0) {
                break;
            }
        }
        return out;
    }

    private record Chunk(String title, String body) {
    }
}
