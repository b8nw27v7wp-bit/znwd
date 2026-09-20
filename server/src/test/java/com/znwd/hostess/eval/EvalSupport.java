package com.znwd.hostess.eval;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.knowledge.HybridHit;
import com.znwd.hostess.knowledge.RetrievedChunk;

/**
 * 评测/标定两个工具共用的部分：用例解析、命中判定、域外样本、报告写盘。
 *
 * <p>抽出来是为了让「评测」和「标定」用的是同一份用例与同一个命中口径——两份各自解析
 * 是评估类脚本最容易出的错：评测说 0.93，标定按另一套口径说该调阈值，最后谁也不敢信。
 */
public final class EvalSupport {

    /** 域外样本：展厅里访客会问、但知识库不该硬答的问题（与旧 scripts/calibrate.ts 同一批） */
    public static final List<String> OUT_OF_DOMAIN = List.of(
            "今天上海天气怎么样？",
            "帮我写一首诗",
            "你是谁？",
            "午饭吃什么好",
            "股票行情怎么样",
            "帮我订一张去北京的机票",
            "讲个笑话",
            "你用的什么大模型",
            "会议室在哪里",
            "洗手间怎么走");

    private static final DateTimeFormatter STAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss-SSS").withZone(ZoneId.of("Asia/Shanghai"));

    private EvalSupport() {
    }

    public record EvalCase(String id, String question, String zone, String pathIncludes, String context) {
    }

    /** 用例集：全部 / 多轮追问 / 计分用例（带期望展区或文件的那部分） */
    public record CaseSet(List<EvalCase> cases, List<EvalCase> followUps, List<EvalCase> scored) {
    }

    public static CaseSet loadCases(ObjectMapper mapper) throws IOException {
        Path file = casesFile();
        Map<String, Object> raw = mapper.readValue(Files.readString(file, StandardCharsets.UTF_8),
                new TypeReference<LinkedHashMap<String, Object>>() {
                });
        List<EvalCase> cases = toCases(raw.get("cases"));
        if (cases.isEmpty()) {
            throw new IllegalStateException("no eval cases at " + file);
        }
        List<EvalCase> followUps = toCases(raw.get("followUps")).stream()
                .filter(c -> c.context() != null && !c.context().isBlank())
                .toList();
        List<EvalCase> scored = cases.stream().filter(c -> c.zone() != null || c.pathIncludes() != null).toList();
        return new CaseSet(cases, followUps, scored);
    }

    public static Path casesFile() {
        return findRepoRoot().resolve("server/eval/retrieval-cases.json");
    }

    public static long totalChunksScored(CaseSet set) {
        return set.scored().size();
    }

    /** 命中判定与旧实现一致：展区匹配或路径包含，任一成立即算命中 */
    public static boolean matches(EvalCase c, HybridHit hit) {
        if (hit == null) {
            return false;
        }
        if (c.zone() != null && c.zone().equals(hit.zone())) {
            return true;
        }
        return c.pathIncludes() != null && hit.sourcePath() != null && hit.sourcePath().contains(c.pathIncludes());
    }

    /** 同上，给只跑关键词路的标定网格用（Retriever 返回的是 RetrievedChunk） */
    public static boolean matches(EvalCase c, RetrievedChunk hit) {
        if (hit == null) {
            return false;
        }
        if (c.zone() != null && c.zone().equals(hit.chunk().zone())) {
            return true;
        }
        return c.pathIncludes() != null && hit.chunk().sourcePath() != null
                && hit.chunk().sourcePath().contains(c.pathIncludes());
    }

    public static List<EvalCase> toCases(Object value) {
        List<EvalCase> out = new ArrayList<>();
        if (!(value instanceof List<?> list)) {
            return out;
        }
        for (Object item : list) {
            if (item instanceof Map<?, ?> m) {
                out.add(new EvalCase(
                        str(m.get("id")),
                        str(m.get("question")),
                        m.get("zone") == null ? null : str(m.get("zone")),
                        m.get("sourcePathIncludes") == null ? null : str(m.get("sourcePathIncludes")),
                        m.get("context") == null ? null : str(m.get("context"))));
            }
        }
        return out;
    }

    public static double rate(int hit, int total) {
        return round(hit / (double) total, 4);
    }

    public static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    public static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    public static String cut(String s, int max) {
        if (s == null) {
            return "";
        }
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    public static String normalizePath(Object path) {
        return path == null ? "" : String.valueOf(path).replace('\\', '/');
    }

    public static String stamp() {
        return STAMP.format(Instant.now());
    }

    /** 报告写进 docs/eval/，与旧脚本产物放一起（git 里能直接对比历史） */
    public static Path writeReport(ObjectMapper mapper, String name, Map<String, Object> report) throws IOException {
        Path dir = findRepoRoot().resolve("docs/eval");
        Files.createDirectories(dir);
        Path file = dir.resolve(name + "-" + stamp() + ".json");
        Files.writeString(file, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(report) + "\n",
                StandardCharsets.UTF_8);
        return file;
    }

    /** 仓库根：从当前目录往上找到含 knowledge/_meta/zones.json 的那层 */
    public static Path findRepoRoot() {
        Path base = Path.of("").toAbsolutePath();
        for (int i = 0; i < 4 && base != null; i++) {
            if (Files.isRegularFile(base.resolve("knowledge/_meta/zones.json"))) {
                return base;
            }
            base = base.getParent();
        }
        return Path.of("").toAbsolutePath();
    }
}
