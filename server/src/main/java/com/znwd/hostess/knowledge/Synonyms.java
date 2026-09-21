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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * 展区同义词扩展（评测驱动迭代）。
 *
 * <p>扩展词是**提示**不是要求：它与原查询词同权时，会把「碰巧含这些泛词的无关文档」抬到正确文档之上
 * （实测：闪光灯→拍摄 把风机拍摄方案抬到展厅须知之上），因此检索器给扩展词降权（0.45）。
 *
 * <p>表里只放**同义或同域复合词**（报告 → 检测报告/巡检报告/作业报告），不放话题联想词。
 * 曾经「光伏 → 组件/电站/清洗/积灰/清洁」这种枢纽式条目把域外问题（「光伏和风电哪个更赚钱」）
 * 的分抬过闸门；跨话题的联想应该靠语料和语义向量，不能塞进同义词表。
 *
 * <p>表是可替换的：内置表当默认值，`knowledge/_meta/synonyms.tsv` 若存在则覆盖（随知识库 reload 一起生效），
 * 也可由管理接口在线替换（见 KnowledgeController 的同义词端点）。检索器在**查询时**读这张表，
 * 所以替换后无需重建索引，下一个问题立即生效。
 */
public final class Synonyms {

    private static final Map<String, List<String>> DEFAULTS = Stream.of(
                    // 「光伏」这条以前是「光伏 + 太阳能 + 组件 + 电站 + 清洗 + 积灰 + 清洁」——
                    // 那是话题枢纽不是同义词：只因为问了「光伏」就把清洗/积灰/电站 5 个泛词塞进查询，
                    // 于是「光伏和风电哪个更赚钱」靠这 5 个词的分被闸门放行（实测 10.96，高过在域最低 8.93）。
                    // 同义词表只收**同一个意思的另一种说法**；跨话题联想交给语料本身（组件/清洁 各有自己的条目，
                    // 用户真说了那个词才展开）。
                    Map.entry("光伏", List.of("光伏", "太阳能", "光伏板", "太阳电池")),
                    Map.entry("清洁", List.of("清洁", "清洗", "清扫", "除尘", "积灰", "鸟粪")),
                    Map.entry("组件", List.of("组件", "光伏板", "太阳能板", "电池板")),
                    Map.entry("风场", List.of("风场", "风电", "风机", "风力", "风电场")),
                    Map.entry("叶片", List.of("叶片", "叶轮", "风叶", "桨叶")),
                    Map.entry("检测", List.of("检测", "巡检", "检查", "缺陷", "裂纹", "雷击")),
                    Map.entry("巡检", List.of("巡检", "检测", "复检", "检查")),
                    Map.entry("无人机", List.of("无人机", "飞行器", "UAV", "drone")),
                    Map.entry("培训", List.of("培训", "教学", "指导", "操作培训")),
                    Map.entry("合作", List.of("合作", "商务", "伙伴", "运维伙伴")),
                    Map.entry("预约", List.of("预约", "预定", "预订", "参观")),
                    Map.entry("报告", List.of("报告", "检测报告", "巡检报告", "作业报告")),
                    Map.entry("售后", List.of("售后", "技术支持", "备件", "服务")),
                    Map.entry("安全", List.of("安全", "须知", "参观须知", "注意事项")),
                    Map.entry("闪光灯", List.of("闪光灯", "拍照", "摄影", "拍摄")),
                    Map.entry("裂纹", List.of("裂纹", "缺陷", "损伤", "涂层")),
                    Map.entry("清洗", List.of("清洗", "清洁", "除尘")),
                    Map.entry("塔筒", List.of("塔筒", "塔架", "风机塔")),
                    Map.entry("作业", List.of("作业", "流程", "模板", "报告")),
                    Map.entry("模板", List.of("模板", "报告", "作业")),
                    Map.entry("触摸", List.of("触摸", "展品", "飞行器", "安全")),
                    Map.entry("摸", List.of("摸", "触摸", "展品", "安全")),
                    Map.entry("展品", List.of("展品", "触摸", "安全")))
            .collect(Collectors.toMap(Map.Entry::getKey, Map.Entry::getValue,
                    (a, b) -> a, java.util.LinkedHashMap::new));

    /** 当前生效的表。整体替换（不可变 map），读侧无锁 */
    private static volatile Map<String, List<String>> current = DEFAULTS;
    private static volatile String source = "builtin";

    private Synonyms() {
    }

    /** 拆出「原查询」与「扩展词」两部分，供检索器给扩展词降权 */
    public static Expansion expandQueryParts(String query) {
        List<String> extras = new ArrayList<>();
        for (Map.Entry<String, List<String>> entry : current.entrySet()) {
            String key = entry.getKey();
            if (!query.contains(key)) {
                continue;
            }
            for (String alt : entry.getValue()) {
                if (!query.contains(alt) && !alt.equals(key)) {
                    extras.add(alt);
                }
            }
        }
        return new Expansion(query, extras);
    }

    public static String expandQueryText(String query) {
        Expansion expansion = expandQueryParts(query);
        return expansion.extras().isEmpty() ? query : expansion.original() + " " + String.join(" ", expansion.extras());
    }

    /** 同义词表大小（健康检查/评测报告用） */
    public static int size() {
        return current.size();
    }

    /** 当前生效的表（管理接口导出用） */
    public static Map<String, List<String>> asMap() {
        return current;
    }

    /** 表的来源：builtin / 文件路径 / api */
    public static String source() {
        return source;
    }

    public static synchronized void resetDefaults() {
        current = DEFAULTS;
        source = "builtin";
    }

    /** 在线替换整张表（管理接口用）。空表会被拒：没有同义词等于把检索能力悄悄砍掉一半。 */
    public static synchronized void replace(Map<String, List<String>> table, String from) {
        if (table == null || table.isEmpty()) {
            throw new IllegalArgumentException("同义词表不能为空");
        }
        Map<String, List<String>> cleaned = new LinkedHashMap<>();
        table.forEach((key, alts) -> {
            if (key == null || key.isBlank()) {
                return;
            }
            List<String> list = new ArrayList<>();
            list.add(key.strip());
            for (String alt : alts == null ? List.<String>of() : alts) {
                if (alt != null && !alt.isBlank() && !list.contains(alt.strip())) {
                    list.add(alt.strip());
                }
            }
            cleaned.put(key.strip(), List.copyOf(list));
        });
        if (cleaned.isEmpty()) {
            throw new IllegalArgumentException("同义词表内容为空");
        }
        current = Map.copyOf(cleaned);
        source = from == null ? "unknown" : from;
    }

    /**
     * 从 TSV 读取覆盖表：每行 {@code 主词<TAB>备选1,备选2,...}，{@code #} 开头为注释。
     * 文件不存在返回 0（不报错，视为"没有覆盖表"）。
     */
    public static synchronized int loadFromFile(Path file) throws IOException {
        if (file == null || !Files.isRegularFile(file)) {
            return 0;
        }
        Map<String, List<String>> table = new LinkedHashMap<>();
        for (String rawLine : Files.readAllLines(file, StandardCharsets.UTF_8)) {
            String line = rawLine.strip();
            if (line.isEmpty() || line.startsWith("#")) {
                continue;
            }
            int tab = line.indexOf('\t');
            String key = tab < 0 ? line : line.substring(0, tab);
            String rest = tab < 0 ? "" : line.substring(tab + 1);
            List<String> alts = new ArrayList<>();
            alts.add(key.strip());
            for (String alt : rest.split("[,，]")) {
                if (!alt.isBlank()) {
                    alts.add(alt.strip());
                }
            }
            table.put(key.strip(), List.copyOf(alts));
        }
        if (table.isEmpty()) {
            return 0;
        }
        replace(table, file.toString());
        return table.size();
    }

    /** 导出成 TSV（管理接口 GET 与"写回文件"共用，保证读回来一致） */
    public static String toTsv() {
        StringBuilder sb = new StringBuilder("# 主词\t备选词（逗号分隔）\n");
        current.forEach((key, alts) -> {
            sb.append(key).append('\t');
            List<String> rest = new ArrayList<>(alts);
            rest.remove(key);
            sb.append(String.join(",", rest)).append('\n');
        });
        return sb.toString();
    }

    private static final Pattern NOT_TOKEN = Pattern.compile("[^\\p{L}\\p{N}\\u4e00-\\u9fff]+");

    /** 供测试与排查：把中文 bigram 拆出来 */
    static List<String> bigrams(String text) {
        String cleaned = NOT_TOKEN.matcher(text.toLowerCase(Locale.ROOT)).replaceAll(" ");
        List<String> out = new ArrayList<>();
        Matcher m = Pattern.compile("[a-z0-9]+").matcher(cleaned);
        while (m.find()) {
            out.add(m.group());
        }
        return out;
    }

    public record Expansion(String original, List<String> extras) {
    }
}
