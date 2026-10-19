package com.znwd.hostess.eval;

import java.io.PrintStream;
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

import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.HostessApplication;
import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.knowledge.HybridHit;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.RetrievalOutcome;
import com.znwd.hostess.llm.ChatMessage;
import com.znwd.hostess.llm.ChatRole;
import com.znwd.hostess.rag.QueryRewriter;
import com.znwd.hostess.rag.RewriteResult;

/**
 * 检索评测（老 server/scripts/eval-retrieval.ts 的 Java 版）。
 *
 * <p>关键：知识、向量、阈值都从 Spring 容器取 —— 评测与线上跑的是同一套参数。
 * 老版本的教训是「评测通过、线上是另一套阈值」，所以这里不自己读 env、不写第二份默认值。
 *
 * <pre>
 * 运行（在 server/ 目录）：
 *   mvn -q test-compile
 *   mvn -q dependency:build-classpath -Dmdep.outputFile=target/cp.txt
 *   java -cp "target/classes;target/test-classes;$(cat target/cp.txt)" com.znwd.hostess.eval.RetrievalEval
 * 常用参数：
 *   --no-write                只打印，不写报告
 *   --baseline=docs/eval/baseline-java.json   逐例对比已提交基线（top1Path 是否一致）
 *   -Dznwd.knowledge-dir=...  临时换语料（用于「同一语料」对齐）
 * </pre>
 */
public final class RetrievalEval {

    private static final DateTimeFormatter STAMP = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH-mm-ss-SSS")
            .withZone(ZoneId.of("Asia/Shanghai"));

    public static void main(String[] args) throws Exception {
        // Windows 控制台默认 GBK，中文报告会花屏——工具类输出统一按 UTF-8
        System.setOut(new PrintStream(System.out, true, StandardCharsets.UTF_8));
        List<String> argv = List.of(args);
        boolean noWrite = argv.contains("--no-write");
        String baselinePath = argv.stream().filter(a -> a.startsWith("--baseline=")).findFirst()
                .map(a -> a.substring("--baseline=".length())).orElse(null);

        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(HostessApplication.class)
                .web(WebApplicationType.NONE)
                .run(args)) {
            ObjectMapper mapper = ctx.getBean(ObjectMapper.class);
            KnowledgeService knowledge = ctx.getBean(KnowledgeService.class);
            AppProperties props = ctx.getBean(AppProperties.class);
            HybridRetriever retriever = knowledge.retriever();

            Path repoRoot = findRepoRoot();
            Path casesFile = repoRoot.resolve("server/eval/retrieval-cases.json");
            Map<String, Object> raw = mapper.readValue(Files.readString(casesFile, StandardCharsets.UTF_8),
                    new TypeReference<LinkedHashMap<String, Object>>() {
                    });
            List<EvalCase> cases = toCases(raw.get("cases"));
            List<EvalCase> followUps = toCases(raw.get("followUps")).stream()
                    .filter(c -> c.context() != null && !c.context().isBlank()).toList();
            if (cases.isEmpty()) {
                throw new IllegalStateException("no eval cases at " + casesFile);
            }

            List<EvalCase> scored = cases.stream().filter(c -> c.zone() != null || c.pathIncludes() != null).toList();
            List<Map<String, Object>> rows = new ArrayList<>();
            int top1 = 0;
            int top3 = 0;
            int gatedTop1 = 0;
            int gatedTop3 = 0;
            List<String> gateBlocked = new ArrayList<>();

            for (EvalCase c : scored) {
                List<HybridHit> hits = retriever.retrieve(c.question(), 4);
                RetrievalOutcome outcome = retriever.retrieveWithDiagnostics(c.question(), 4);
                boolean hit1 = matches(c, hits.isEmpty() ? null : hits.get(0));
                boolean hit3 = hits.stream().limit(3).anyMatch(h -> matches(c, h));
                if (hit1) {
                    top1++;
                }
                if (hit3) {
                    top3++;
                }
                // 生产路径（含闸门）是否误拦本该能答的问题：误拦就是漏答
                boolean gHit1 = matches(c, outcome.hits().isEmpty() ? null : outcome.hits().get(0));
                boolean gHit3 = outcome.hits().stream().limit(3).anyMatch(h -> matches(c, h));
                if (gHit1) {
                    gatedTop1++;
                }
                if (gHit3) {
                    gatedTop3++;
                }
                if (outcome.hits().isEmpty()) {
                    gateBlocked.add(c.id());
                }
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", c.id());
                row.put("question", c.question());
                row.put("expectZone", c.zone());
                row.put("top1", hits.isEmpty() ? null : hits.get(0).title());
                row.put("top1Path", hits.isEmpty() ? null : hits.get(0).sourcePath());
                row.put("hit1", hit1);
                row.put("hit3", hit3);
                row.put("gated", outcome.diagnostics().gated());
                row.put("reason", outcome.diagnostics().reason().value());
                row.put("keywordBestScore", round(outcome.diagnostics().keywordBestScore(), 3));
                rows.add(row);
            }

            List<Map<String, Object>> followRows = new ArrayList<>();
            int fuRawTop1 = 0;
            int fuRawTop3 = 0;
            int fuRwTop1 = 0;
            int fuRwTop3 = 0;
            int fuRewritten = 0;
            for (EvalCase c : followUps) {
                List<HybridHit> rawHits = retriever.retrieve(c.question(), 4);
                List<ChatMessage> history = List.of(new ChatMessage(ChatRole.USER, c.context()),
                        new ChatMessage(ChatRole.ASSISTANT, ""));
                RewriteResult rw = QueryRewriter.rewrite(retriever, c.question(), history);
                List<HybridHit> rwHits = retriever.retrieveWithDiagnostics(rw.query(), 4).hits();
                boolean rawHit1 = matches(c, rawHits.isEmpty() ? null : rawHits.get(0));
                boolean rawHit3 = rawHits.stream().limit(3).anyMatch(h -> matches(c, h));
                boolean rwHit1 = matches(c, rwHits.isEmpty() ? null : rwHits.get(0));
                boolean rwHit3 = rwHits.stream().limit(3).anyMatch(h -> matches(c, h));
                if (rawHit1) {
                    fuRawTop1++;
                }
                if (rawHit3) {
                    fuRawTop3++;
                }
                if (rwHit1) {
                    fuRwTop1++;
                }
                if (rwHit3) {
                    fuRwTop3++;
                }
                if (rw.rewritten()) {
                    fuRewritten++;
                }
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("id", c.id());
                row.put("context", c.context());
                row.put("question", c.question());
                row.put("rewritten", rw.rewritten());
                row.put("reason", rw.reason().value());
                row.put("rawTop1", rawHits.isEmpty() ? null : rawHits.get(0).title());
                row.put("rwTop1", rwHits.isEmpty() ? null : rwHits.get(0).title());
                row.put("rawHit1", rawHit1);
                row.put("rwHit1", rwHit1);
                row.put("rwHit3", rwHit3);
                followRows.add(row);
            }

            int n = Math.max(scored.size(), 1);
            Map<String, Object> summary = new LinkedHashMap<>();
            summary.put("at", Instant.now().toString());
            summary.put("runtime", "spring-boot/java");
            summary.put("embedProvider", knowledge.stats().vector().provider());
            summary.put("semantic", knowledge.stats().vector().semantic());
            summary.put("llmProvider", props.llmProvider());
            summary.put("knowledgeChunks", knowledge.chunks().size());
            summary.put("knowledgeDir", knowledge.knowledgeDir().toString());
            summary.put("generation", retriever.generation());
            summary.put("cases", scored.size());
            summary.put("openCases", cases.size() - scored.size());
            summary.put("top1Hit", top1);
            summary.put("top3Hit", top3);
            summary.put("top1Rate", rate(top1, n));
            summary.put("top3Rate", rate(top3, n));
            summary.put("gatedTop1Rate", rate(gatedTop1, n));
            summary.put("gatedTop3Rate", rate(gatedTop3, n));
            summary.put("gateBlockedCount", gateBlocked.size());
            summary.put("gateBlocked", gateBlocked);
            summary.put("minKeywordScore", props.minRelevanceScore());
            summary.put("followUpCases", followUps.size());
            summary.put("followUpRawTop1Rate", followUps.isEmpty() ? 0 : rate(fuRawTop1, followUps.size()));
            summary.put("followUpRawTop3Rate", followUps.isEmpty() ? 0 : rate(fuRawTop3, followUps.size()));
            summary.put("followUpRewrittenTop1Rate", followUps.isEmpty() ? 0 : rate(fuRwTop1, followUps.size()));
            summary.put("followUpRewrittenTop3Rate", followUps.isEmpty() ? 0 : rate(fuRwTop3, followUps.size()));
            summary.put("followUpRewriteTriggered", fuRewritten);

            System.out.println("== 评测汇总");
            summary.forEach((k, v) -> System.out.println("  " + k + " = " + v));
            System.out.println("== 逐例");
            for (Map<String, Object> row : rows) {
                System.out.printf("  %-4s %-5s %-7s %-28s → %s%n",
                        row.get("hit1").equals(true) ? "H1" : row.get("hit3").equals(true) ? "H3" : "MISS",
                        row.get("gated").equals(true) ? "GATED" : "",
                        row.get("id"),
                        cut(String.valueOf(row.get("question")), 26),
                        row.get("top1Path") == null ? "-" : row.get("top1Path"));
            }
            if (!followRows.isEmpty()) {
                System.out.println("== 追问（多轮指代改写）");
                for (Map<String, Object> row : followRows) {
                    System.out.printf("  %-4s %-14s %-26s → %s%n",
                            row.get("rwHit1").equals(true) ? "H1" : row.get("rwHit3").equals(true) ? "H3" : "MISS",
                            "RW:" + row.get("reason"), cut(String.valueOf(row.get("question")), 24),
                            row.get("rwTop1") == null ? "-" : row.get("rwTop1"));
                }
            }

            if (baselinePath != null) {
                boolean baselinePassed = compareBaseline(mapper, repoRoot, baselinePath, summary, rows);
                if (!baselinePassed) {
                    throw new IllegalStateException("检索结果未通过已提交基线：docs/eval/baseline-java.json");
                }
            }

            if (noWrite) {
                System.out.println("(--no-write：未写报告)");
                return;
            }
            Path outDir = repoRoot.resolve("docs/eval");
            Files.createDirectories(outDir);
            Map<String, Object> report = new LinkedHashMap<>();
            report.put("summary", summary);
            report.put("rows", rows);
            report.put("followUps", followRows);
            String json = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(report);
            Path reportPath = outDir.resolve("retrieval-java-" + STAMP.format(Instant.now()) + ".json");
            Files.writeString(reportPath, json, StandardCharsets.UTF_8);
            // Java 版的基准单独成文件：历史 baseline.json 是 Node 时代同一语料的证据，不能覆盖
            Files.writeString(outDir.resolve("baseline-java.json"), json, StandardCharsets.UTF_8);
            System.out.println("wrote " + reportPath);
        }
    }

    /** 逐例对比历史基准：判定的是「同一个语料下 Java 是否复现了 Node 的 top1 选择」 */
    private static boolean compareBaseline(ObjectMapper mapper, Path repoRoot, String baselinePath,
                                           Map<String, Object> summary, List<Map<String, Object>> rows) throws Exception {
        Path path = Path.of(baselinePath);
        if (!path.isAbsolute()) {
            path = repoRoot.resolve(baselinePath);
        }
        Map<String, Object> baseline = mapper.readValue(Files.readString(path, StandardCharsets.UTF_8),
                new TypeReference<LinkedHashMap<String, Object>>() {
                });
        Map<String, Object> baseSummary = asMap(baseline.get("summary"));
        List<Map<String, Object>> baseRows = asRows(baseline.get("rows"));
        boolean metricsPassed = true;
        for (String metric : List.of("top1Rate", "top3Rate", "gatedTop1Rate", "gatedTop3Rate")) {
            double current = number(summary.get(metric));
            double base = number(baseSummary.get(metric));
            if (current + 1e-9 < base) {
                System.out.println("  REGRESSION " + metric + " current=" + current + " baseline=" + base);
                metricsPassed = false;
            }
        }
        int currentBlocked = (int) number(summary.get("gateBlockedCount"));
        int baseBlocked = (int) number(baseSummary.get("gateBlockedCount"));
        if (currentBlocked > baseBlocked) {
            System.out.println("  REGRESSION gateBlockedCount current=" + currentBlocked
                    + " baseline=" + baseBlocked);
            metricsPassed = false;
        }
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Map<String, Object> r : baseRows) {
            byId.put(String.valueOf(r.get("id")), r);
        }

        System.out.println("== 与历史基准逐例对比（" + path.getFileName() + "）");
        System.out.println("  基准语料块数=" + baseSummary.get("knowledgeChunks")
                + " 阈值=" + baseSummary.get("minKeywordScore")
                + " top1Rate=" + baseSummary.get("top1Rate"));
        int compared = 0;
        int mismatch = 0;
        for (Map<String, Object> row : rows) {
            Map<String, Object> base = byId.get(String.valueOf(row.get("id")));
            if (base == null) {
                continue;
            }
            compared++;
            String mine = normalizePath(row.get("top1Path"));
            String theirs = normalizePath(base.get("top1Path"));
            if (!mine.equals(theirs)) {
                mismatch++;
                System.out.println("  DIFF " + row.get("id") + " 问题=" + row.get("question")
                        + "\n       java=" + mine + "\n       node=" + theirs);
            }
        }
        System.out.println("  对比例数=" + compared + " top1 不一致=" + mismatch
                + (mismatch == 0 ? " → 检索行为与历史实现一致" : " → 需排查差异来源"));
        return metricsPassed && compared == rows.size() && baseRows.size() == rows.size() && mismatch == 0;
    }

    private static double number(Object value) {
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        if (value == null) {
            return 0;
        }
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (NumberFormatException e) {
            throw new IllegalStateException("基线指标不是数字：" + value, e);
        }
    }

    private static Map<String, Object> asMap(Object value) {
        if (value instanceof Map<?, ?> m) {
            Map<String, Object> out = new LinkedHashMap<>();
            m.forEach((k, v) -> out.put(String.valueOf(k), v));
            return out;
        }
        return new LinkedHashMap<>();
    }

    private static List<Map<String, Object>> asRows(Object value) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (value instanceof List<?> list) {
            for (Object item : list) {
                out.add(asMap(item));
            }
        }
        return out;
    }

    private static String normalizePath(Object path) {
        return path == null ? "" : String.valueOf(path).replace('\\', '/');
    }

    private static List<EvalCase> toCases(Object value) {
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

    /** 命中判定与旧实现一致：展区匹配或路径包含，任一成立即算命中 */
    private static boolean matches(EvalCase c, HybridHit hit) {
        if (hit == null) {
            return false;
        }
        if (c.zone() != null && c.zone().equals(hit.zone())) {
            return true;
        }
        return c.pathIncludes() != null && hit.sourcePath() != null && hit.sourcePath().contains(c.pathIncludes());
    }

    private static double rate(int hit, int total) {
        return round(hit / (double) total, 4);
    }

    private static double round(double value, int digits) {
        double factor = Math.pow(10, digits);
        return Math.round(value * factor) / factor;
    }

    private static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    private static String cut(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max) + "…";
    }

    /** 仓库根：从当前目录往上找到含 knowledge/_meta/zones.json 的那层 */
    private static Path findRepoRoot() {
        Path base = Path.of("").toAbsolutePath();
        for (int i = 0; i < 4 && base != null; i++) {
            if (Files.isRegularFile(base.resolve("knowledge/_meta/zones.json"))) {
                return base;
            }
            base = base.getParent();
        }
        return Path.of("").toAbsolutePath();
    }

    private record EvalCase(String id, String question, String zone, String pathIncludes, String context) {
    }
}
