package com.znwd.hostess.eval;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.znwd.hostess.HostessApplication;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.knowledge.HybridRetriever;
import com.znwd.hostess.knowledge.RetrievalOutcome;
import com.znwd.hostess.knowledge.RetrievedChunk;
import com.znwd.hostess.knowledge.Retriever;
import com.znwd.hostess.knowledge.ScoringOptions;

/**
 * 标定（旧 scripts/calibrate.ts + tune-scoring.mjs 的 Java 版）。
 *
 * <p>回答两个问题，都靠数据而不是手感：
 * <ol>
 *   <li><b>闸门阈值还合不合适</b>：同一批问题下「在域用例最低关键词分」与「域外问题最高关键词分」
 *       之间还有没有区间。区间塌了就说明同义词或语料出了问题，闸门再调也救不回来。</li>
 *   <li><b>打分参数该不该换</b>（{@code --grid}）：对小参数网格搜索 top1/top3，选出更好的组合。</li>
 * </ol>
 *
 * <p>参数全部取自 Spring 容器里的同一套知识/同义词/阈值，避免"评测一套、线上另一套"。
 *
 * <pre>
 * 运行（在 server/ 目录）：
 *   mvn -q test-compile exec:java@calibrate
 * 参数：
 *   --grid        额外跑打分参数网格搜索
 *   --no-write    只打印，不写 docs/eval/calibration-*.json
 *   --gate-check  只守两条「域外不越线」：关键词域外最高分不得过阈值（越线退出码 3）、
 *                 语义域外最高余弦不得过 MIN_VECTOR_SCORE（越线退出码 4）
 *   退出码：区间不成立 → 2；关键词越线 → 3；语义兜底越线 → 4
 * </pre>
 */
public final class Calibrate {

    public static void main(String[] args) throws Exception {
        // Windows 控制台默认 GBK，中文报告会花屏——工具类输出统一按 UTF-8
        System.setOut(new PrintStream(System.out, true, StandardCharsets.UTF_8));
        List<String> argv = List.of(args);
        boolean noWrite = argv.contains("--no-write");
        boolean withGrid = argv.contains("--grid");
        boolean gateCheck = argv.contains("--gate-check");

        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(HostessApplication.class)
                .web(WebApplicationType.NONE)
                .run(args)) {
            ObjectMapper mapper = ctx.getBean(ObjectMapper.class);
            KnowledgeService knowledge = ctx.getBean(KnowledgeService.class);
            HybridRetriever retriever = knowledge.retriever();
            EvalSupport.CaseSet set = EvalSupport.loadCases(mapper);

            double effective = retriever.stats().thresholds().minKeywordScore();
            System.out.printf("chunks=%d mode=%s semantic=%s 当前阈值 minKeywordScore=%.2f%n",
                    knowledge.chunks().size(), retriever.stats().mode(), retriever.stats().semantic(), effective);

            List<Sample> inDomain = new ArrayList<>();
            for (EvalSupport.EvalCase c : set.scored()) {
                inDomain.add(measure(retriever, c.id(), c.question()));
            }
            inDomain.sort(Comparator.comparingDouble(Sample::keywordBest));

            List<Sample> ood = new ArrayList<>();
            for (int i = 0; i < EvalSupport.OUT_OF_DOMAIN.size(); i++) {
                ood.add(measure(retriever, "ood-" + i, EvalSupport.OUT_OF_DOMAIN.get(i)));
            }
            ood.sort(Comparator.comparingDouble(Sample::keywordBest).reversed());

            List<Sample> oodNear = new ArrayList<>();
            for (int i = 0; i < EvalSupport.OUT_OF_DOMAIN_NEAR.size(); i++) {
                oodNear.add(measure(retriever, "near-" + i, EvalSupport.OUT_OF_DOMAIN_NEAR.get(i)));
            }
            oodNear.sort(Comparator.comparingDouble(Sample::vectorBest).reversed());

            System.out.println("\n== 在域用例：关键词分最弱的 8 条（越弱越可能被闸门误拦）==");
            inDomain.stream().limit(8).forEach(s -> System.out.println("  " + s.line()));

            System.out.println("\n== 域外问题：关键词分降序（越高越可能被闸门放过去乱答）==");
            ood.forEach(s -> System.out.println("  " + s.line()));

            double minInOriginal = inDomain.isEmpty() ? 0 : inDomain.get(0).keywordBest();
            double maxOodOriginal = ood.isEmpty() ? 0 : ood.get(0).keywordBest();
            int minCovIn = inDomain.isEmpty() ? 0 : inDomain.stream().mapToInt(Sample::matchedTokens).min().orElse(0);
            int maxCovOod = ood.isEmpty() ? 0 : ood.stream().mapToInt(Sample::matchedTokens).max().orElse(0);
            // 区间与建议必须和闸门同一口径：HybridRetriever.keywordPass 比的是排序分
            // （keywordBestScore，含同义词扩展），不是只算原话的 keywordGateScore。用原话口径会
            // 报出「区间不成立」的假象（补同义词把短问句抬过阈值后尤其明显），而线上其实零误拦。
            double minIn = inDomain.isEmpty() ? 0
                    : inDomain.stream().mapToDouble(Sample::rankingBest).min().orElse(0);
            double maxOod = ood.isEmpty() ? 0
                    : ood.stream().mapToDouble(Sample::rankingBest).max().orElse(0);

            System.out.printf("%n闸门分（排序分，与 HybridRetriever 判闸门同一口径）：在域最低=%.3f  域外最高=%.3f  比阈值%s%n",
                    minIn, maxOod, marginNote(minIn, maxOod, effective));
            System.out.printf("参考·原话分（只算用户原话词条，同义词扩展仅作诊断）：在域最低=%.3f 域外最高=%.3f%n",
                    minInOriginal, maxOodOriginal);

            Map<String, Object> report = new LinkedHashMap<>();
            report.put("chunks", knowledge.chunks().size());
            report.put("mode", String.valueOf(retriever.stats().mode()));
            report.put("semantic", retriever.stats().semantic());
            report.put("effectiveThreshold", effective);
            report.put("gateMetric", "keywordBestScore（排序分，含同义词扩展，与 HybridRetriever 判闸门同一口径）");
            report.put("inDomainWeakest", rows(inDomain));
            report.put("outOfDomain", rows(ood));
            report.put("minInDomain", EvalSupport.round(minIn, 4));
            report.put("maxOutOfDomain", EvalSupport.round(maxOod, 4));
            report.put("minInDomainOriginal", EvalSupport.round(minInOriginal, 4));
            report.put("maxOutOfDomainOriginal", EvalSupport.round(maxOodOriginal, 4));
            report.put("minMatchedTokensInDomain", minCovIn);
            report.put("maxMatchedTokensOutOfDomain", maxCovOod);

            boolean separated = minIn > maxOod;
            if (separated) {
                double suggested = EvalSupport.round((maxOod + minIn) / 2, 1);
                System.out.printf("区间可用：建议 minKeywordScore=%.1f（当前生效 %.2f）%n", suggested, effective);
                System.out.printf("余量：域外最高 %.3f / 阈值 %.2f / 在域最低 %.3f%n", maxOod, effective, minIn);
                if (maxOod / Math.max(effective, 1e-9) > 0.9) {
                    System.out.printf("警告：阈值距域外最高分只剩 %.1f%% 余量，闸门偏松——建议上调到 %.1f 附近%n",
                            100 - (maxOod / effective) * 100, suggested);
                }
                report.put("suggestedThreshold", suggested);
                report.put("separated", true);
            } else {
                System.out.println("警告：分数区间不成立（域外最高分不低于在域最低分）：需要补同义词或换语义向量模型");
                report.put("separated", false);
            }
            // 闸门判据用的是排序分（keywordBestScore，含同义词扩展）——与上面的区间同一口径，
            // CI 要守的就是这条线：域外最高分一旦越线，展厅就会对域外问题硬答，比误拦更难收拾。
            boolean gateSafe = maxOod < effective;
            report.put("gateMetricUsedByGate", "keywordBestScore（排序分，与 HybridRetriever 判闸门同一口径）");
            report.put("gateSafe", gateSafe);
            report.put("gateMargin", EvalSupport.round(effective - maxOod, 4));
            System.out.printf("闸门余量（排序分口径）：域外最高 %.3f / 阈值 %.2f → %s（余量 %.3f）%n",
                    maxOod, effective, gateSafe ? "守住" : "越线！域外问题会被放行",
                    effective - maxOod);
            System.out.printf("参考：命中词条数 在域最低=%d 域外最高=%d（该维度不足以单独区分，仅作观察）%n",
                    minCovIn, maxCovOod);

            // ── 语义兜底（MIN_VECTOR_SCORE）标定 ──────────────────────────────
            // 兜底口子的危险面和关键词闸门相反：不是「拦太多」，而是「放太宽」——
            // 域外问题的余弦天然不低（话题相邻就更不低），开大了等于给闸门开了个侧门。
            double effectiveVector = retriever.stats().thresholds().minVectorScore();
            boolean semanticNow = retriever.stats().semantic();
            // 判据必须与闸门一致：闸门比的是**排序分**（keywordBestScore，含同义词扩展），
            // 不是只算原话的 keywordGateScore。用错口径会报出「误拦 2 条」而线上其实 0 条误拦
            // （2026-09-23 补了「客户」「融资」同义词后就是这样：原话分 4.90/5.90 没到 6.3，
            // 但排序分已经过了闸门）。
            List<Sample> gatedInDomain = inDomain.stream()
                    .filter(s -> s.rankingBest() < effective)
                    .sorted(Comparator.comparingDouble(Sample::vectorBest))
                    .toList();
            double maxOodVector = Math.max(
                    ood.isEmpty() ? 0 : ood.stream().mapToDouble(Sample::vectorBest).max().orElse(0),
                    oodNear.isEmpty() ? 0 : oodNear.stream().mapToDouble(Sample::vectorBest).max().orElse(0));
            double minGatedVector = gatedInDomain.isEmpty() ? 0 : gatedInDomain.get(0).vectorBest();
            boolean hatchSeparated = !gatedInDomain.isEmpty() && maxOodVector < minGatedVector;

            System.out.printf("%n== 语义兜底阈值（MIN_VECTOR_SCORE，当前生效 %.2f，语义路%s）==%n",
                    effectiveVector, semanticNow ? "已启用" : "未启用（bag）");
            System.out.printf("  被关键词闸门误拦、需要兜底救回的在域用例：%d 条（排序分口径，与闸门一致）%n", gatedInDomain.size());
            gatedInDomain.forEach(s -> System.out.println("    " + s.line()));
            System.out.println("  近域域外样本（余弦降序，卡兜底口子用）：");
            oodNear.forEach(s -> System.out.println("    " + s.line()));
            System.out.printf("  域外最高余弦=%.4f  待救在域最低余弦=%.4f → %s%n",
                    maxOodVector, minGatedVector, hatchSeparated ? "区间可用" : "无可用区间");
            if (hatchSeparated) {
                double suggestedVector = EvalSupport.round((maxOodVector + minGatedVector) / 2, 2);
                System.out.printf("  建议 MIN_VECTOR_SCORE=%.2f（当前 %.2f）%n", suggestedVector, effectiveVector);
            } else {
                System.out.println("  建议：MIN_VECTOR_SCORE 设到域外最高余弦之上——语义向量不参与普通查询排序"
                        + "（关键词路答得对的时候不让它插手，实测插手会顶掉 top1），"
                        + "只保留「关键词没过闸门时兜底 + 诊断里给余弦」两种用途；误拦靠补语料/补同义词解决");
            }
            if (semanticNow && maxOodVector >= effectiveVector) {
                System.out.printf("  警告：生效阈值 %.2f 低于域外最高余弦 %.4f —— 域外问题会被语义兜底放行%n",
                        effectiveVector, maxOodVector);
            }
            // 语义兜底阈值相关：域外最高余弦是硬边界，被误拦用例的最低余弦是它要救的对象
            report.put("effectiveMinVectorScore", EvalSupport.round(effectiveVector, 4));
            report.put("maxOutOfDomainVector", EvalSupport.round(maxOodVector, 4));
            report.put("minGatedInDomainVector", EvalSupport.round(minGatedVector, 4));
            report.put("outOfDomainNear", rows(oodNear));
            report.put("gatedInDomainWeakest", rows(gatedInDomain));
            report.put("vectorHatchSeparated", hatchSeparated);
            if (hatchSeparated) {
                report.put("suggestedMinVectorScore",
                        EvalSupport.round((maxOodVector + minGatedVector) / 2, 2));
            }

            if (withGrid) {
                report.put("scoringGrid", grid(knowledge, set));
            }

            if (!noWrite) {
                var file = EvalSupport.writeReport(mapper, "calibration", report);
                System.out.println("\n报告已写入 " + file);
            }
            if (gateCheck) {
                // CI 只守「域外不越线」：区间不成立是当前语料的已知事实（见 docs/eval.md），
                // 拿它当失败条件会让 CI 长期红着，反而没人看。
                if (!gateSafe) {
                    System.exit(3);
                }
                // 语义兜底同样守「域外不越线」：开了语义路之后，域外问题可以绕过关键词闸门
                // 从余弦这边进来，所以这条线和上面那条一起守。
                boolean hatchSafe = !semanticNow || maxOodVector < effectiveVector;
                if (!hatchSafe) {
                    System.out.printf("兜底越线：域外最高余弦 %.4f ≥ 生效 MIN_VECTOR_SCORE %.2f%n",
                            maxOodVector, effectiveVector);
                    System.exit(4);
                }
            } else if (!separated) {
                System.exit(2);
            }
        }
    }

    /** 打分参数网格：与旧 tune-scoring.mjs 同一批组合（扩展词权重 / 词频上限 / 展区加权 / 长度归一） */
    private static List<Map<String, Object>> grid(KnowledgeService knowledge, EvalSupport.CaseSet set) {
        double[] expansionWeights = {0.45, 0.7, 1.0};
        double[] maxTfBoosts = {2.2, 5.0};
        double[] zoneBoosts = {1.0, 1.5};
        double[] lengthBs = {0.0, 0.3, 0.6};

        List<Map<String, Object>> results = new ArrayList<>();
        for (double ew : expansionWeights) {
            for (double tf : maxTfBoosts) {
                for (double zb : zoneBoosts) {
                    for (double lb : lengthBs) {
                        ScoringOptions opts = new ScoringOptions(ScoringOptions.DEFAULT_TITLE_BOOST, zb, 1.0, ew, tf, lb);
                        Retriever r = new Retriever(opts);
                        r.replace(knowledge.chunks());
                        int top1 = 0;
                        int top3 = 0;
                        List<String> misses = new ArrayList<>();
                        for (EvalSupport.EvalCase c : set.scored()) {
                            List<RetrievedChunk> hits = r.retrieve(c.question(), 4);
                            boolean hit1 = EvalSupport.matches(c, hits.isEmpty() ? null : hits.get(0));
                            if (hit1) {
                                top1++;
                            } else {
                                misses.add(c.id());
                            }
                            if (hits.stream().limit(3).anyMatch(h -> EvalSupport.matches(c, h))) {
                                top3++;
                            }
                        }
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("expansionWeight", ew);
                        row.put("maxTfBoost", tf);
                        row.put("zoneBoost", zb);
                        row.put("lengthB", lb);
                        row.put("top1Rate", EvalSupport.rate(top1, set.scored().size()));
                        row.put("top3Rate", EvalSupport.rate(top3, set.scored().size()));
                        row.put("misses", misses);
                        row.put("isDefault", opts.equals(ScoringOptions.defaults()));
                        results.add(row);
                    }
                }
            }
        }
        results.sort(Comparator
                .comparingDouble((Map<String, Object> r) -> (double) r.get("top1Rate")).reversed()
                .thenComparing(Comparator.comparingDouble((Map<String, Object> r) -> (double) r.get("top3Rate")).reversed()));

        System.out.println("\n== 打分参数网格（按 top1 降序，前 6 组）==");
        for (Map<String, Object> row : results.subList(0, Math.min(6, results.size()))) {
            System.out.printf("  top1=%.4f top3=%.4f  ew=%.2f tf=%.1f zone=%.1f b=%.1f%s  漏=%s%n",
                    row.get("top1Rate"), row.get("top3Rate"), row.get("expansionWeight"), row.get("maxTfBoost"),
                    row.get("zoneBoost"), row.get("lengthB"), Boolean.TRUE.equals(row.get("isDefault")) ? "  ← 当前默认" : "",
                    row.get("misses"));
        }
        return results;
    }

    private static String marginNote(double minIn, double maxOod, double effective) {
        if (minIn <= maxOod) {
            return "（无区间）";
        }
        String head = effective < minIn ? "" : "（当前阈值已高过在域最低分，会误拦）";
        return String.format("，区间 %.3f~%.3f%s", maxOod, minIn, head);
    }

    private static List<Map<String, Object>> rows(List<Sample> samples) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Sample s : samples) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", s.id());
            row.put("question", s.question());
            row.put("keywordBest", EvalSupport.round(s.keywordBest(), 4));
            row.put("vectorBest", EvalSupport.round(s.vectorBest(), 4));
            row.put("topTitle", s.topTitle());
            row.put("matchedTokens", s.matchedTokens());
            row.put("matched", s.matched());
            out.add(row);
        }
        return out;
    }

    private static Sample measure(HybridRetriever retriever, String id, String question) {
        // 关掉闸门取诊断：标定要的是"原始分"，不是被闸门裁过的结果
        RetrievalOutcome outcome = retriever.retrieveWithDiagnostics(question, 8, false);
        List<RetrievedChunk> kw = retriever.retrieveKeyword(question, 8);
        RetrievedChunk top = kw.isEmpty() ? null : kw.get(0);
        return new Sample(
                id,
                question,
                outcome.diagnostics().keywordGateScore(),
                outcome.diagnostics().keywordBestScore(),
                top == null ? "-" : top.chunk().title(),
                top == null ? 0 : top.matchedTokens(),
                top == null ? List.of() : top.matched(),
                outcome.diagnostics().vectorBestCosine());
    }

    private record Sample(String id, String question, double keywordBest, double rankingBest, String topTitle,
                          int matchedTokens, List<String> matched, double vectorBest) {

        private String line() {
            return String.format("kw=%.3f(rank %.3f) cos=%.4f cov=%d  %s  %s → %s  [%s]",
                    keywordBest, rankingBest, vectorBest, matchedTokens, id, question, topTitle,
                    String.join("/", matched.size() > 6 ? matched.subList(0, 6) : matched));
        }
    }
}
