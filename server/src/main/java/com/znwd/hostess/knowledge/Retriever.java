package com.znwd.hostess.knowledge;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class Retriever {

    private static final Set<String> STOPWORDS = Set.of(
            "的", "了", "和", "与", "在", "是", "有", "请", "什么", "如何", "怎么", "吗", "呢", "啊",
            "我", "你", "他", "我们", "这", "那", "能", "会", "要", "可以",
            "the", "a", "an", "of", "to", "and", "is", "in", "for", "on", "how", "what");

    private static final Pattern NON_TOKEN = Pattern.compile("[^\\p{L}\\p{N}\\u4e00-\\u9fff]+");
    private static final Pattern LATIN_QUERY = Pattern.compile("[a-z0-9]+");
    private static final Pattern LATIN_DOC = Pattern.compile("[a-z0-9]{2,}");

    private final ScoringOptions opts;
    private volatile Index index = new Index(List.of(), Map.of(), 1, Synonyms.snapshot());

    public Retriever() {
        this(ScoringOptions.defaults());
    }

    public Retriever(ScoringOptions opts) {
        this.opts = opts;
    }

    public synchronized void replace(List<KnowledgeChunk> next) {
        replace(next, Synonyms.snapshot());
    }

    public synchronized void replace(List<KnowledgeChunk> next, Synonyms.Version synonyms) {
        List<KnowledgeChunk> chunks = next == null ? List.of() : List.copyOf(next);
        Map<String, Double> nextIdf = buildIdf(chunks);
        double total = 0;
        for (KnowledgeChunk chunk : chunks) {
            total += docTokens(chunk.text()).size();
        }
        double nextAvgLen = chunks.isEmpty() ? 1 : total / chunks.size();
        index = new Index(chunks, nextIdf, nextAvgLen,
                synonyms == null ? Synonyms.snapshot() : synonyms);
    }

    public List<KnowledgeChunk> list() {
        return index.chunks();
    }

    public Double idfOf(String token) {
        return index.idf().get(token);
    }

    public ScoringOptions options() {
        return opts;
    }

    public List<RetrievedChunk> retrieve(String query, int topK) {
        Index current = index;
        return retrieve(current, query, topK, current.synonyms());
    }

    List<RetrievedChunk> retrieve(String query, int topK, Synonyms.Version synonyms) {
        return retrieve(index, query, topK, synonyms == null ? index.synonyms() : synonyms);
    }

    private List<RetrievedChunk> retrieve(Index current, String query, int topK, Synonyms.Version synonyms) {
        List<WeightedToken> tokens = weightedTokens(query, opts, synonyms);
        if (tokens.isEmpty() || current.chunks().isEmpty() || topK <= 0) {
            return List.of();
        }
        List<RetrievedChunk> scored = new ArrayList<>();
        for (KnowledgeChunk chunk : current.chunks()) {
            Scored title = scoreText(tokens, current.idf(), chunk.title(), opts.titleBoost(), opts, null);
            Scored zone = scoreText(tokens, current.idf(),
                    chunk.zone() + " " + chunk.zoneTitle() + " " + String.join(" ", chunk.tags()),
                    opts.zoneBoost(), opts, null);
            Map<String, Integer> bodyFreq = docTokens(chunk.text());
            Scored body = scoreText(tokens, current.idf(), chunk.text(), opts.bodyBoost(), opts, bodyFreq);
            double lenNorm = opts.lengthB() > 0
                    ? Math.max(0.3, 1 + opts.lengthB() * (bodyFreq.size() / current.avgLen() - 1))
                    : 1;
            Set<String> matched = new LinkedHashSet<>();
            matched.addAll(title.matched());
            matched.addAll(zone.matched());
            matched.addAll(body.matched());
            double score = title.score() + zone.score() + body.score() / lenNorm;
            double gateScore = title.gateScore() + zone.gateScore() + body.gateScore() / lenNorm;
            if (score > 0) {
                scored.add(new RetrievedChunk(chunk, score, matched.size(), List.copyOf(matched), gateScore));
            }
        }
        scored.sort(Comparator.comparingDouble(RetrievedChunk::score).reversed());
        return scored.size() <= topK ? scored : new ArrayList<>(scored.subList(0, topK));
    }

    private static List<WeightedToken> weightedTokens(String query, ScoringOptions opts, Synonyms.Version synonyms) {
        Synonyms.Expansion expansion = synonyms == null
                ? Synonyms.expandQueryParts(query)
                : Synonyms.expandQueryParts(query, synonyms);
        Map<String, Double> acc = new LinkedHashMap<>();
        for (String token : queryTokens(expansion.original())) {
            acc.put(token, 1.0);
        }
        for (String token : queryTokens(String.join(" ", expansion.extras()))) {
            acc.putIfAbsent(token, opts.expansionWeight());
        }
        List<WeightedToken> out = new ArrayList<>(acc.size());
        acc.forEach((token, weight) -> out.add(new WeightedToken(token, weight)));
        return out;
    }

    private static Scored scoreText(
            List<WeightedToken> tokens,
            Map<String, Double> idf,
            String text,
            double boost,
            ScoringOptions opts,
            Map<String, Integer> precomputedFreq) {
        Map<String, Integer> freq = precomputedFreq == null ? docTokens(text) : precomputedFreq;
        List<WeightedToken> matched = new ArrayList<>();
        double hit = 0;
        double hitOriginal = 0;
        for (WeightedToken token : tokens) {
            Integer frequency = freq.get(token.token());
            if (frequency == null || frequency == 0) {
                continue;
            }
            double rawIdf = idf.getOrDefault(token.token(), 1.0);
            double tfGain = Math.min(1 + Math.log(1 + frequency), opts.maxTfBoost());
            double weight = rawIdf * token.weight();
            hit += weight * tfGain;
            if (token.weight() >= 1) {
                hitOriginal += rawIdf * tfGain;
            }
            matched.add(new WeightedToken(token.token(), weight));
        }
        matched.sort(Comparator.comparingDouble(WeightedToken::weight).reversed());
        long base = Math.max(1, tokens.stream().filter(t -> t.weight() >= 1).count());
        double norm = boost / Math.sqrt(base + 1);
        List<String> matchedNames = new ArrayList<>(matched.size());
        for (WeightedToken value : matched) {
            matchedNames.add(value.token());
        }
        return new Scored(hit * norm, matchedNames, hitOriginal * norm);
    }

    public static Map<String, Double> buildIdf(List<KnowledgeChunk> chunks) {
        Map<String, Integer> df = new HashMap<>();
        int n = Math.max(chunks.size(), 1);
        for (KnowledgeChunk chunk : chunks) {
            Set<String> seen = docTokens(
                    chunk.title() + " " + chunk.zoneTitle() + " " + String.join(" ", chunk.tags()) + " "
                            + chunk.text()).keySet();
            for (String token : seen) {
                df.merge(token, 1, Integer::sum);
            }
        }
        Map<String, Double> out = new HashMap<>();
        df.forEach((token, count) -> out.put(token, Math.log(1 + (double) n / (1 + count))));
        return out;
    }

    static List<String> queryTokens(String text) {
        String lower = NON_TOKEN.matcher(text.toLowerCase(Locale.ROOT)).replaceAll(" ");
        List<String> out = new ArrayList<>();
        Matcher latin = LATIN_QUERY.matcher(lower);
        while (latin.find()) {
            String token = latin.group();
            if (!STOPWORDS.contains(token) && token.length() > 1) {
                out.add(token);
            }
        }
        for (List<String> run : cjkRuns(lower)) {
            for (int i = 0; i + 1 < run.size(); i++) {
                String first = run.get(i);
                String second = run.get(i + 1);
                if (STOPWORDS.contains(first) || STOPWORDS.contains(second)) {
                    continue;
                }
                out.add(first + second);
            }
        }
        return out;
    }

    static Map<String, Integer> docTokens(String text) {
        Map<String, Integer> freq = new HashMap<>();
        String lower = text.toLowerCase(Locale.ROOT);
        Matcher latin = LATIN_DOC.matcher(lower);
        while (latin.find()) {
            freq.merge(latin.group(), 1, Integer::sum);
        }
        for (List<String> run : cjkRuns(lower)) {
            for (int i = 0; i + 1 < run.size(); i++) {
                freq.merge(run.get(i) + run.get(i + 1), 1, Integer::sum);
            }
        }
        return freq;
    }

    private static List<List<String>> cjkRuns(String text) {
        List<List<String>> runs = new ArrayList<>();
        List<String> current = new ArrayList<>();
        for (int i = 0; i < text.length(); i++) {
            char value = text.charAt(i);
            if (isCjk(value)) {
                current.add(String.valueOf(value));
            } else if (!current.isEmpty()) {
                runs.add(current);
                current = new ArrayList<>();
            }
        }
        if (!current.isEmpty()) {
            runs.add(current);
        }
        return runs;
    }

    static boolean isCjk(char value) {
        return (value >= 0x4e00 && value <= 0x9fff)
                || (value >= 0x3400 && value <= 0x4dbf)
                || (value >= 0xf900 && value <= 0xfaff);
    }

    private record WeightedToken(String token, double weight) {
    }

    private record Scored(double score, List<String> matched, double gateScore) {
    }

    private record Index(List<KnowledgeChunk> chunks, Map<String, Double> idf, double avgLen,
                         Synonyms.Version synonyms) {
        private Index {
            chunks = List.copyOf(chunks);
            idf = Map.copyOf(idf);
        }
    }
}
