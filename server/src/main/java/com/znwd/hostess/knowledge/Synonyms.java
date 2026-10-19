package com.znwd.hostess.knowledge;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

public final class Synonyms {

    private static final Map<String, List<String>> DEFAULTS = Stream.of(
                    Map.entry("光伏", List.of("光伏", "太阳能", "光伏板", "太阳电池")),
                    Map.entry("清洁", List.of("清洁", "清洗", "清扫", "除尘", "积灰", "鸟粪")),
                    Map.entry("组件", List.of("组件", "光伏板", "太阳能板", "电池板")),
                    Map.entry("检测", List.of("检测", "巡检", "检查", "缺陷", "裂纹", "雷击")),
                    Map.entry("巡检", List.of("巡检", "检测", "复检", "检查")),
                    Map.entry("无人机", List.of("无人机", "飞行器", "UAV", "drone")),
                    Map.entry("培训", List.of("培训", "教学", "指导", "操作培训")),
                    Map.entry("合作", List.of("合作", "商务", "伙伴", "运维伙伴")),
                    Map.entry("报告", List.of("报告", "检测报告", "巡检报告", "作业报告")),
                    Map.entry("售后", List.of("售后", "技术支持", "备件", "服务")),
                    Map.entry("客户", List.of("客户", "客户数量", "客户情况", "服务客户", "客户案例")),
                    Map.entry("融资", List.of("融资", "融资阶段", "融资需求", "总融资额", "投资方")),
                    Map.entry("效益", List.of("效益", "社会效益", "环境效益", "经济效益")),
                    Map.entry("社会", List.of("社会", "社会价值", "社会效益")),
                    Map.entry("好处", List.of("好处", "效益", "价值", "优势")),
                    Map.entry("意义", List.of("意义", "价值", "作用", "目的")),
                    Map.entry("环保", List.of("环保", "绿色", "低碳", "减排", "环境")),
                    Map.entry("裂纹", List.of("裂纹", "缺陷", "损伤", "涂层")),
                    Map.entry("清洗", List.of("清洗", "清洁", "除尘")),
                    Map.entry("作业", List.of("作业", "流程", "模板", "报告")),
                    Map.entry("模板", List.of("模板", "报告", "作业")),
                    // 2026-10-19 补 04_光伏运维行业知识 展区上线后实测失手的问法：
                    // ① 口语问法（「板子上有灰要怎么办」原话分 5.05 < 6.5 被闸门拦空，命中词只剩「怎么/么办」）；
                    // ② 「标准」族（「清洗机器人有国家标准吗」真正的答案块排第 15 —— 表里没有任何一词与查询共现）；
                    // ③ 方式/多久/安全/划伤 这些"问法词"与文档里的"答法词"（分类、频次、规范条件、磨蚀）对不上。
                    // 加组原则：key 必须是访客原话里会出现的子串（展开是 `text.contains(key)` 触发的），
                    // alternatives 必须是文档里实际存在的词——否则只是往查询里灌噪声、把闸门抬高。
                    Map.entry("板子", List.of("板子", "光伏板", "太阳能板", "组件", "电池板")),
                    Map.entry("灰", List.of("灰", "积灰", "灰尘")),
                    Map.entry("脏", List.of("脏", "脏污", "积灰", "污渍", "清洁")),
                    Map.entry("洗", List.of("洗", "清洗", "清洁", "除尘", "清扫")),
                    // 「标准」直接当 key 会误伤「污渍标注标准是什么」这类问数据集标注口径的问法
                    // （实测它把两条 pv-doctor 用例抢到 04 标准索引上），所以只收窄到「国家标准 / 国标」这种行业标准说法
                    Map.entry("国家标准", List.of("国家标准", "国标", "标准", "规范", "规程")),
                    Map.entry("国标", List.of("国标", "国家标准", "标准", "规范")),
                    Map.entry("规范", List.of("规范", "标准", "规程", "要求")),
                    Map.entry("认证", List.of("认证", "标准", "规范", "资质")),
                    Map.entry("方式", List.of("方式", "方法", "形式", "类型", "种类", "分类")),
                    Map.entry("多久", List.of("多久", "频次", "周期", "次数", "时间间隔")),
                    Map.entry("安全", List.of("安全", "规范", "要求", "风险", "防护")),
                    Map.entry("划伤", List.of("划伤", "划痕", "磨蚀", "磨损", "损伤")),
                    // 运维组本来想补「运营维护/维护」，实测会把「运维服务怎么收费？」从商业模式与定价抢到
                    // 服务与合作（两个文件都在 project 展区、都讲运维服务），代价大于收益，故不设该组。
                    Map.entry("温差", List.of("温差", "温度", "测温", "热像", "红外")))
            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue,
                    (a, b) -> a, LinkedHashMap::new));

    private static final AtomicReference<State> state =
            new AtomicReference<>(new State(0, DEFAULTS, "builtin"));
    private static final AtomicLong generation = new AtomicLong();

    private Synonyms() {
    }

    public static Expansion expandQueryParts(String query) {
        return expandQueryParts(query, snapshot());
    }

    public static Expansion expandQueryParts(String query, Version version) {
        String text = query == null ? "" : query;
        Map<String, List<String>> table = version == null ? Map.of() : version.table();
        List<String> extras = new ArrayList<>();
        for (Map.Entry<String, List<String>> entry : table.entrySet()) {
            String key = entry.getKey();
            if (!text.contains(key)) {
                continue;
            }
            for (String alternative : entry.getValue()) {
                if (!text.contains(alternative) && !alternative.equals(key)) {
                    extras.add(alternative);
                }
            }
        }
        return new Expansion(text, List.copyOf(extras));
    }

    public static String expandQueryText(String query) {
        Expansion expansion = expandQueryParts(query);
        return expansion.extras().isEmpty()
                ? expansion.original()
                : expansion.original() + " " + String.join(" ", expansion.extras());
    }

    public static int size() {
        return snapshot().table().size();
    }

    public static Map<String, List<String>> asMap() {
        return snapshot().table();
    }

    public static String source() {
        return snapshot().source();
    }

    public static long generation() {
        return state.get().generation();
    }

    public static Version snapshot() {
        State current = state.get();
        return new Version(current.generation(), current.table(), current.source());
    }

    public static Version defaults() {
        return new Version(0, DEFAULTS, "builtin");
    }

    public static synchronized void resetDefaults() {
        publish(DEFAULTS, "builtin");
    }

    public static synchronized void replace(Map<String, List<String>> table, String from) {
        if (table == null || table.isEmpty()) {
            throw new IllegalArgumentException("同义词表不能为空");
        }
        Map<String, List<String>> cleaned = new LinkedHashMap<>();
        table.forEach((key, alternatives) -> {
            if (key == null || key.isBlank()) {
                return;
            }
            List<String> values = new ArrayList<>();
            values.add(key.strip());
            if (alternatives != null) {
                for (String alternative : alternatives) {
                    if (alternative != null && !alternative.isBlank() && !values.contains(alternative.strip())) {
                        values.add(alternative.strip());
                    }
                }
            }
            cleaned.put(key.strip(), List.copyOf(values));
        });
        if (cleaned.isEmpty()) {
            throw new IllegalArgumentException("同义词表内容为空");
        }
        publish(cleaned, from == null ? "unknown" : from);
    }

    public static synchronized int loadFromFile(Path file) throws IOException {
        Version prepared = prepareFromFile(file);
        if (prepared == null) {
            return 0;
        }
        activate(prepared);
        return prepared.table().size();
    }

    public static Version prepareFromFile(Path file) throws IOException {
        if (file == null || !Files.isRegularFile(file)) {
            return null;
        }
        Map<String, List<String>> table = new LinkedHashMap<>();
        for (String rawLine : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            String line = rawLine.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int tab = line.indexOf('\t');
            String key = (tab < 0 ? line : line.substring(0, tab)).strip();
            String rest = tab < 0 ? "" : line.substring(tab + 1);
            List<String> alternatives = new ArrayList<>();
            if (!key.isEmpty()) {
                alternatives.add(key);
            }
            for (String alternative : rest.split("[,，]")) {
                if (!alternative.isBlank() && !alternatives.contains(alternative.strip())) {
                    alternatives.add(alternative.strip());
                }
            }
            if (!alternatives.isEmpty()) {
                table.put(key, List.copyOf(alternatives));
            }
        }
        return table.isEmpty() ? null : new Version(0, table, file.toString());
    }

    public static synchronized void activate(Version version) {
        if (version == null || version.table().isEmpty()) {
            return;
        }
        publish(version.table(), version.source());
    }

    public static synchronized Version activateIfUnchanged(long expectedGeneration, Version version) {
        State current = state.get();
        if (current.generation() != expectedGeneration) {
            return new Version(current.generation(), current.table(), current.source());
        }
        if (version == null || version.table().isEmpty()) {
            return new Version(current.generation(), current.table(), current.source());
        }
        publish(version.table(), version.source());
        State activated = state.get();
        return new Version(activated.generation(), activated.table(), activated.source());
    }

    public static String toTsv() {
        State current = state.get();
        StringBuilder result = new StringBuilder("# 主词\t备选词（逗号分隔）\n");
        current.table().forEach((key, alternatives) -> {
            result.append(key).append('\t');
            List<String> rest = new ArrayList<>(alternatives);
            rest.remove(key);
            result.append(String.join(",", rest)).append('\n');
        });
        return result.toString();
    }

    private static void publish(Map<String, List<String>> table, String source) {
        long next = generation.incrementAndGet();
        state.set(new State(next, immutable(table), source == null ? "unknown" : source));
    }

    private static Map<String, List<String>> immutable(Map<String, List<String>> table) {
        Map<String, List<String>> result = new LinkedHashMap<>();
        table.forEach((key, values) -> result.put(key, List.copyOf(values)));
        return Map.copyOf(result);
    }

    private record State(long generation, Map<String, List<String>> table, String source) {
    }

    public record Version(long generation, Map<String, List<String>> table, String source) {
        public Version {
            table = immutable(table == null ? Map.of() : table);
            source = source == null ? "unknown" : source;
        }
    }

    private static final Pattern NOT_TOKEN = Pattern.compile("[^\\p{L}\\p{N}\\u4e00-\\u9fff]+");

    static List<String> bigrams(String text) {
        String cleaned = NOT_TOKEN.matcher(text.toLowerCase(Locale.ROOT)).replaceAll(" ");
        List<String> out = new ArrayList<>();
        var matcher = Pattern.compile("[a-z0-9]+").matcher(cleaned);
        while (matcher.find()) {
            out.add(matcher.group());
        }
        return out;
    }

    public record Expansion(String original, List<String> extras) {
    }
}
