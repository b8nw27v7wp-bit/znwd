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

/**
 * 关键词检索路：中文 bigram + IDF 加权 + 标题/标签加权。
 *
 * <p>不做单字命中——单字（「天」「上」「好」）会让任意闲聊问题都拿到分数，是「什么都能答」的根因，
 * bigram 才有区分度。这条规则有单测守着，别为了「查得更全」把单字加回来。
 */
public class Retriever {

    private static final Set<String> STOPWORDS = Set.of(
            "的", "了", "和", "与", "在", "是", "有", "请", "什么", "如何", "怎么", "吗", "呢", "啊",
            "我", "你", "他", "我们", "这", "那", "能", "会", "要", "可以",
            "the", "a", "an", "of", "to", "and", "is", "in", "for", "on", "how", "what");

    private static final Pattern NON_TOKEN = Pattern.compile("[^\\p{L}\\p{N}\\u4e00-\\u9fff]+");
    private static final Pattern LATIN_QUERY = Pattern.compile("[a-z0-9]+");
    private static final Pattern LATIN_DOC = Pattern.compile("[a-z0-9]{2,}");

    private final ScoringOptions opts;
    private volatile List<KnowledgeChunk> chunks = List.of();
    private volatile Map<String, Double> idf = Map.of();
    private volatile double avgLen = 1;

    public Retriever() {
        this(ScoringOptions.defaults());
    }

    public Retriever(ScoringOptions opts) {
        this.opts = opts;
    }

    public synchronized void replace(List<KnowledgeChunk> next) {
        this.chunks = List.copyOf(next);
        this.idf = buildIdf(this.chunks);
        double total = 0;
        for (KnowledgeChunk c : this.chunks) {
            total += docTokens(c.text()).size();
        }
        this.avgLen = this.chunks.isEmpty() ? 1 : total / this.chunks.size();
    }

    public List<KnowledgeChunk> list() {
        return chunks;
    }

    public Double idfOf(String token) {
        return idf.get(token);
    }

    public ScoringOptions options() {
        return opts;
    }

    public List<RetrievedChunk> retrieve(String query, int topK) {
        List<WeightedToken> tokens = weightedTokens(query, opts);
        if (tokens.isEmpty() || chunks.isEmpty()) {
            return List.of();
        }
        List<RetrievedChunk> scored = new ArrayList<>();
        for (KnowledgeChunk c : chunks) {
            Scored title = scoreText(tokens, idf, c.title(), opts.titleBoost(), opts, null);
            Scored zone = scoreText(tokens, idf,
                    c.zone() + " " + c.zoneTitle() + " " + String.join(" ", c.tags()),
                    opts.zoneBoost(), opts, null);
            Map<String, Integer> bodyFreq = docTokens(c.text());
            Scored body = scoreText(tokens, idf, c.text(), opts.bodyBoost(), opts, bodyFreq);
            // 长度归一化（BM25 的 b）：长片段命中更多 bigram 是长度优势，不是相关性
            double lenNorm = opts.lengthB() > 0
                    ? Math.max(0.3, 1 + opts.lengthB() * (bodyFreq.size() / avgLen - 1))
                    : 1;
            Set<String> matched = new LinkedHashSet<>();
            matched.addAll(title.matched());
            matched.addAll(zone.matched());
            matched.addAll(body.matched());
            double score = title.score() + zone.score() + body.score() / lenNorm;
            double gateScore = title.gateScore() + zone.gateScore() + body.gateScore() / lenNorm;
            if (score > 0) {
                scored.add(new RetrievedChunk(c, score, matched.size(), List.copyOf(matched), gateScore));
            }
        }
        scored.sort(Comparator.comparingDouble(RetrievedChunk::score).reversed());
        return scored.size() <= topK ? scored : new ArrayList<>(scored.subList(0, topK));
    }

    private static List<WeightedToken> weightedTokens(String query, ScoringOptions opts) {
        Synonyms.Expansion expansion = Synonyms.expandQueryParts(query);
        Map<String, Double> acc = new LinkedHashMap<>();
        for (String t : queryTokens(expansion.original())) {
            acc.put(t, 1.0);
        }
        for (String t : queryTokens(String.join(" ", expansion.extras()))) {
            acc.putIfAbsent(t, opts.expansionWeight());
        }
        List<WeightedToken> out = new ArrayList<>(acc.size());
        acc.forEach((t, w) -> out.add(new WeightedToken(t, w)));
        return out;
    }

    private static Scored scoreText(
            List<WeightedToken> tokens,
            Map<String, Double> idf,
            String text,
            double boost,
            ScoringOptions opts,
            Map<String, Integer> precomputedFreq) {
        Map<String, Integer> freq = precomputedFreq != null ? precomputedFreq : docTokens(text);
        List<WeightedToken> matched = new ArrayList<>();
        double hit = 0;
        // 只算原查询词条（扩展词权重 < 1）的那份分：闸门判定用，见 RetrievedChunk#gateScore
        double hitOriginal = 0;
        for (WeightedToken token : tokens) {
            Integer f = freq.get(token.token());
            if (f == null || f == 0) {
                continue;
            }
            double rawIdf = idf.getOrDefault(token.token(), 1.0);
            double tfGain = Math.min(1 + Math.log(1 + f), opts.maxTfBoost());
            double w = rawIdf * token.weight();
            hit += w * tfGain;
            if (token.weight() >= 1) {
                hitOriginal += rawIdf * tfGain;
            }
            matched.add(new WeightedToken(token.token(), w));
        }
        matched.sort(Comparator.comparingDouble(WeightedToken::weight).reversed());
        // 归一化按**原查询词条数**（不含扩展）：分数回答的是「这段文字有多贴合用户真正问的」，
        // 否则同义词表一改，所有分数整体平移，阈值也跟着漂。
        long base = Math.max(1, tokens.stream().filter(t -> t.weight() >= 1).count());
        double norm = boost / Math.sqrt(base + 1);
        List<String> matchedNames = new ArrayList<>(matched.size());
        for (WeightedToken m : matched) {
            matchedNames.add(m.token());
        }
        return new Scored(hit * norm, matchedNames, hitOriginal * norm);
    }

    public static Map<String, Double> buildIdf(List<KnowledgeChunk> chunks) {
        Map<String, Integer> df = new HashMap<>();
        int n = Math.max(chunks.size(), 1);
        for (KnowledgeChunk c : chunks) {
            Set<String> seen = docTokens(
                    c.title() + " " + c.zoneTitle() + " " + String.join(" ", c.tags()) + " " + c.text()).keySet();
            for (String t : seen) {
                df.merge(t, 1, Integer::sum);
            }
        }
        Map<String, Double> out = new HashMap<>();
        df.forEach((t, d) -> out.put(t, Math.log(1 + (double) n / (1 + d))));
        return out;
    }

    /** 查询侧词条：拉丁词（去停用词、长度 &gt; 1）+ 中文 bigram（任一字为停用词则跳过） */
    static List<String> queryTokens(String text) {
        String lower = NON_TOKEN.matcher(text.toLowerCase(Locale.ROOT)).replaceAll(" ");
        List<String> out = new ArrayList<>();
        Matcher latin = LATIN_QUERY.matcher(lower);
        while (latin.find()) {
            String t = latin.group();
            if (!STOPWORDS.contains(t) && t.length() > 1) {
                out.add(t);
            }
        }
        for (List<String> run : cjkRuns(lower)) {
            for (int i = 0; i + 1 < run.size(); i++) {
                String a = run.get(i);
                String b = run.get(i + 1);
                if (STOPWORDS.contains(a) || STOPWORDS.contains(b)) {
                    continue;
                }
                out.add(a + b);
            }
        }
        return out;
    }

    /** 文档侧词频（bigram + 拉丁词，不做停用词过滤） */
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

    /**
     * 连续 CJK 串：标点、空白、拉丁词都算边界。
     *
     * <p>不跨边界取 bigram 是刻意的：以前把整段文字的单字抽出来连成一条链，会在标点处
     * 造出「测外」（「叶片检测？外观…」）这种不存在的词；更糟的是同义词扩展把备选词拼成
     * 一个字符串再切，造出「件电」「灰清」（「组件 电站 清洗 积灰」），这些垃圾词条带着真实
     * IDF 参与打分，是「域外问题也被放行」的直接来源之一。
     */
    private static List<List<String>> cjkRuns(String text) {
        List<List<String>> runs = new ArrayList<>();
        List<String> cur = new ArrayList<>();
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (isCjk(ch)) {
                cur.add(String.valueOf(ch));
            } else if (!cur.isEmpty()) {
                runs.add(cur);
                cur = new ArrayList<>();
            }
        }
        if (!cur.isEmpty()) {
            runs.add(cur);
        }
        return runs;
    }

    static boolean isCjk(char c) {
        return (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff);
    }

    private record WeightedToken(String token, double weight) {
    }

    private record Scored(double score, List<String> matched, double gateScore) {
    }
}
