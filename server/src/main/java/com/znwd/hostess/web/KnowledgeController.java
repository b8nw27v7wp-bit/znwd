package com.znwd.hostess.web;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import jakarta.servlet.http.HttpServletRequest;

import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.znwd.hostess.config.AppProperties;
import com.znwd.hostess.config.KnowledgeService;
import com.znwd.hostess.http.ApiError;
import com.znwd.hostess.knowledge.HybridHit;
import com.znwd.hostess.knowledge.RetrievalDiagnostics;
import com.znwd.hostess.knowledge.RetrievalOutcome;
import com.znwd.hostess.knowledge.RetrievalVerdict;
import com.znwd.hostess.knowledge.Synonyms;

/** 知识库管理：清单、热重载、检索诊断、同义词在线维护。 */
@RestController
public class KnowledgeController {

    private static final Logger log = LoggerFactory.getLogger(KnowledgeController.class);

    private final KnowledgeService knowledge;
    private final AppProperties props;

    public KnowledgeController(KnowledgeService knowledge, AppProperties props) {
        this.knowledge = knowledge;
        this.props = props;
    }

    @GetMapping("/api/knowledge/list")
    public Map<String, Object> list() {
        Map<String, KnowledgeService.FileStat> byFile = knowledge.byFile();
        List<Map<String, Object>> docs = new ArrayList<>();
        byFile.entrySet().stream()
                .sorted(Comparator.comparing(Map.Entry::getKey))
                .forEach(e -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("path", e.getKey());
                    row.put("title", e.getValue().title());
                    row.put("zone", e.getValue().zone());
                    row.put("zoneTitle", e.getValue().zoneTitle());
                    row.put("chunks", e.getValue().chunks());
                    docs.add(row);
                });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("knowledgeDir", knowledge.knowledgeDir().toString());
        out.put("fileCount", docs.size());
        out.put("chunkCount", knowledge.chunks().size());
        out.put("retrieval", knowledge.stats());
        out.put("zones", knowledge.zonesMeta().zones());
        out.put("synonyms", synonymsSummary());
        out.put("docs", docs);
        return out;
    }

    /** 热更新知识并重建向量索引；reload 会清答案缓存（旧索引时代的答案不该继续命中） */
    @PostMapping("/api/knowledge/reload")
    public Map<String, Object> reload(
            @RequestHeader(value = "authorization", required = false) String authorization,
            HttpServletRequest request) {
        AdminGuard.require(authorization, props, request.getLocalAddr());
        try {
            int chunks = knowledge.reload();
            Map<String, Integer> perFile = new LinkedHashMap<>();
            for (var chunk : knowledge.chunks()) {
                perFile.merge(chunk.sourcePath(), 1, Integer::sum);
            }
            List<Map<String, Object>> files = new ArrayList<>();
            perFile.forEach((path, count) -> files.add(Map.of("sourcePath", path, "chunks", count)));

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("ok", true);
            out.put("knowledgeChunks", chunks);
            out.put("generation", knowledge.retriever().generation());
            out.put("retrieval", knowledge.stats());
            out.put("synonyms", synonymsSummary());
            out.put("files", files);
            return out;
        } catch (RuntimeException e) {
            log.error("[knowledge] reload 失败", e);
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    ApiError.INTERNAL_ERROR, "服务内部错误");
        }
    }

    /**
     * 检索诊断：这句话为什么被拦、为什么命中、离阈值还差多少。
     *
     * <p>走的是与线上完全相同的检索入口（同一套阈值与索引），所以结论可以直接用来判案。
     */
    @GetMapping("/api/admin/diagnostics")
    public Map<String, Object> diagnostics(
            @RequestHeader(value = "authorization", required = false) String authorization,
            @RequestParam(value = "q", required = false) String q,
            @RequestParam(value = "topK", required = false, defaultValue = "4") int topK,
            HttpServletRequest request) {
        AdminGuard.require(authorization, props, request.getLocalAddr());
        if (q == null || q.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, ApiError.VALIDATION_ERROR, "q is required");
        }
        int k = Math.min(Math.max(topK, 1), 20);
        RetrievalOutcome outcome = knowledge.retriever().retrieveWithDiagnostics(q, k);
        RetrievalDiagnostics d = outcome.diagnostics();

        List<Map<String, Object>> hits = new ArrayList<>();
        for (HybridHit hit : outcome.hits()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("title", hit.title());
            row.put("sourcePath", hit.sourcePath());
            row.put("zone", hit.zone());
            row.put("zoneTitle", hit.zoneTitle());
            row.put("fuseScore", hit.score());
            row.put("keywordScore", hit.keywordScore());
            row.put("vectorScore", hit.vectorScore());
            row.put("matchedTokens", hit.matchedTokens());
            row.put("matched", hit.matched());
            row.put("snippet", cut(hit.text(), 160));
            hits.add(row);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("query", q);
        out.put("topK", k);
        out.put("hits", hits);
        out.put("gated", d.gated());
        out.put("mode", d.mode());
        out.put("reason", d.reason());
        out.put("semantic", d.semantic());
        out.put("degraded", d.degraded());
        out.put("keywordGateScore", d.keywordGateScore());
        out.put("keywordBestScore", d.keywordBestScore());
        out.put("vectorBestCosine", d.vectorBestCosine());
        out.put("candidates", d.candidates());
        out.put("thresholds", d.thresholds());
        out.put("distanceToGate", RetrievalVerdict.distanceToGate(d));
        out.put("verdict", RetrievalVerdict.describe(d));
        return out;
    }

    /** 当前生效的同义词表（在线维护：改完立刻对下一个问题生效，不用重启） */
    @GetMapping("/api/admin/synonyms")
    public Map<String, Object> getSynonyms(
            @RequestHeader(value = "authorization", required = false) String authorization,
            HttpServletRequest request) {
        AdminGuard.require(authorization, props, request.getLocalAddr());
        List<Map<String, Object>> entries = new ArrayList<>();
        Synonyms.asMap().forEach((key, alts) -> {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", key);
            row.put("alternatives", alts);
            entries.add(row);
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("count", Synonyms.size());
        out.put("source", Synonyms.source());
        out.put("file", knowledge.synonymsFile().toString());
        out.put("entries", entries);
        out.put("tsv", Synonyms.toTsv());
        return out;
    }

    /**
     * 替换整张同义词表。
     *
     * <p>两种写法都收：{@code {"lines":["光伏\t光伏,太阳能"]}} 或
     * {@code {"entries":{"光伏":["光伏","太阳能"]}}}；{@code persist=false} 表示只改内存不落盘。
     */
    @PutMapping("/api/admin/synonyms")
    @SuppressWarnings("unchecked")
    public Map<String, Object> putSynonyms(
            @RequestHeader(value = "authorization", required = false) String authorization,
            @RequestBody(required = false) Map<String, Object> body,
            HttpServletRequest request) {
        AdminGuard.require(authorization, props, request.getLocalAddr());
        if (body == null || body.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, ApiError.VALIDATION_ERROR, "请求体不能为空");
        }
        Map<String, List<String>> table = new LinkedHashMap<>();

        Object lines = body.get("lines");
        if (lines instanceof List<?> list) {
            for (Object item : list) {
                String line = item == null ? "" : String.valueOf(item).strip();
                if (line.isEmpty() || line.startsWith("#")) {
                    continue;
                }
                int tab = line.indexOf('\t');
                String key = (tab < 0 ? line : line.substring(0, tab)).strip();
                String rest = tab < 0 ? "" : line.substring(tab + 1);
                List<String> alts = new ArrayList<>();
                alts.add(key);
                for (String alt : rest.split("[,，]")) {
                    if (!alt.isBlank()) {
                        alts.add(alt.strip());
                    }
                }
                table.put(key, alts);
            }
        }

        Object entries = body.get("entries");
        if (entries instanceof Map<?, ?> map) {
            ((Map<String, Object>) map).forEach((key, value) -> {
                List<String> alts = new ArrayList<>();
                if (value instanceof List<?> list) {
                    for (Object alt : list) {
                        if (alt != null && !String.valueOf(alt).isBlank()) {
                            alts.add(String.valueOf(alt).strip());
                        }
                    }
                } else if (value != null && !String.valueOf(value).isBlank()) {
                    for (String alt : String.valueOf(value).split("[,，]")) {
                        if (!alt.isBlank()) {
                            alts.add(alt.strip());
                        }
                    }
                }
                table.put(String.valueOf(key).strip(), alts);
            });
        }

        if (table.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, ApiError.VALIDATION_ERROR,
                    "请提供 lines 或 entries");
        }

        boolean persist = !Boolean.FALSE.equals(body.get("persist"));
        try {
            Synonyms.replace(table, persist ? knowledge.synonymsFile().toString() : "api");
        } catch (IllegalArgumentException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, ApiError.VALIDATION_ERROR, e.getMessage());
        }

        String persistedTo = null;
        if (persist) {
            try {
                Path file = knowledge.synonymsFile();
                Files.createDirectories(file.getParent());
                Files.writeString(file, Synonyms.toTsv(), StandardCharsets.UTF_8);
                persistedTo = file.toString();
            } catch (IOException e) {
                // 内存已生效，落盘失败只是"重启后丢失"，如实上报而不是假装成功
                log.error("[synonyms] 写回文件失败：{}", knowledge.synonymsFile(), e);
            }
        }
        // 同义词在查询时生效，不需要重建索引；但旧答案缓存必须清掉
        knowledge.invalidateAnswerCache();

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("count", Synonyms.size());
        out.put("source", Synonyms.source());
        out.put("persistedTo", persistedTo);
        out.put("persistRequested", persist);
        out.put("reloadRequired", false);
        return out;
    }

    private Map<String, Object> synonymsSummary() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("count", Synonyms.size());
        out.put("source", Synonyms.source());
        out.put("file", knowledge.synonymsFile().toString());
        return out;
    }

    private static String cut(String text, int max) {
        if (text == null) {
            return "";
        }
        String flat = text.replaceAll("\\s+", " ").strip();
        return flat.length() <= max ? flat : flat.substring(0, max) + "…";
    }
}
