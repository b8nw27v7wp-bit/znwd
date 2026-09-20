package com.znwd.hostess.knowledge;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * 知识库加载：遍历 knowledge/ 下的 .md/.txt，解析 frontmatter、归属展区、标题感知分块。
 *
 * <p>文件顺序固定按路径排序（原 Node 版依赖目录读取顺序），保证同一份语料每次启动得到
 * 相同的分块序列——否则同分候选的先后会漂移，评测数字不可复现。
 */
@Component
public class KnowledgeLoader {

    private static final Set<String> TEXT_EXT = Set.of(".md", ".txt", ".markdown");
    private static final Pattern FRONT_LINE = Pattern.compile("^([A-Za-z0-9_]+)\\s*:\\s*(.*)$");
    private static final Pattern H1 = Pattern.compile("^#\\s+");
    private static final Pattern TAG_SPLIT = Pattern.compile("[,，\\s]+");

    private final ObjectMapper mapper;

    public KnowledgeLoader(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    /** 展区定义；文件缺失或损坏时退化为空展区（不阻塞启动） */
    public ZonesMeta loadZonesMeta(Path knowledgeDir) {
        Path file = knowledgeDir.resolve("_meta").resolve("zones.json");
        try {
            if (!Files.isRegularFile(file)) {
                return ZonesMeta.empty();
            }
            return mapper.readValue(Files.readString(file, StandardCharsets.UTF_8), ZonesMeta.class);
        } catch (IOException e) {
            return ZonesMeta.empty();
        }
    }

    public List<KnowledgeChunk> load(Path knowledgeDir) {
        ZonesMeta meta = loadZonesMeta(knowledgeDir);
        List<KnowledgeChunk> chunks = new ArrayList<>();
        for (Path file : walk(knowledgeDir)) {
            String raw = readFile(file);
            Frontmatter fm = parseFrontmatter(raw);
            String rel = toRelativePath(knowledgeDir, file);
            ZonesMeta.ZoneDef zoneHit = zoneForPath(rel, meta.zones());

            String title = fm.meta().get("title");
            if (title == null || title.isBlank()) {
                title = firstH1(fm.body());
            }
            if (title == null || title.isBlank()) {
                title = stripExtension(file.getFileName().toString());
            }

            String zone = fm.meta().getOrDefault("zone", zoneHit.id());
            String zoneTitle = fm.meta().get("zoneTitle");
            if (zoneTitle == null || zoneTitle.isBlank()) {
                zoneTitle = zoneHit.title() == null || zoneHit.title().isBlank() ? "未分组" : zoneHit.title();
            }
            String tagSource = fm.meta().get("tags");
            if (tagSource == null || tagSource.isBlank()) {
                tagSource = String.join(",", zoneHit.aliases());
            }
            List<String> tags = new ArrayList<>();
            for (String t : TAG_SPLIT.split(tagSource)) {
                String trimmed = t.strip();
                if (!trimmed.isEmpty()) {
                    tags.add(trimmed);
                }
            }

            List<String> parts = TextChunker.chunkText(fm.body());
            for (int i = 0; i < parts.size(); i++) {
                chunks.add(new KnowledgeChunk(
                        rel + "#" + i,
                        title,
                        rel,
                        parts.get(i),
                        zone,
                        zoneTitle,
                        List.copyOf(tags)));
            }
        }
        return chunks;
    }

    /** 语料指纹：id + 标题 + 正文长度 + 正文哈希，排序后整体哈希（与旧实现同为向量索引复用判据） */
    public static String fingerprint(List<KnowledgeChunk> chunks) {
        List<String> parts = new ArrayList<>(chunks.size());
        for (KnowledgeChunk c : chunks) {
            parts.add(c.id() + "\u0001" + c.title() + "\u0001" + c.text().length()
                    + "\u0001" + com.znwd.hostess.util.Hashing.hashStr(c.text()));
        }
        parts.sort(Comparator.naturalOrder());
        return com.znwd.hostess.util.Hashing.hashStr(String.join("\n", parts));
    }

    private static String firstH1(String body) {
        for (String line : body.split("\\r?\\n", -1)) {
            if (line.startsWith("# ")) {
                return H1.matcher(line).replaceFirst("").strip();
            }
        }
        return null;
    }

    private static ZonesMeta.ZoneDef zoneForPath(String relPath, List<ZonesMeta.ZoneDef> zones) {
        String top = topSegment(relPath);
        for (ZonesMeta.ZoneDef z : zones) {
            if (z.dir() != null && (z.dir().equals(top) || relPath.startsWith(z.dir() + "/"))) {
                return z;
            }
        }
        return new ZonesMeta.ZoneDef("default", "", "未分组", List.of(), List.of());
    }

    private static String topSegment(String path) {
        int idx = path.indexOf('/');
        return idx < 0 ? path : path.substring(0, idx);
    }

    private static String toRelativePath(Path root, Path file) {
        return root.toAbsolutePath().normalize()
                .relativize(file.toAbsolutePath().normalize())
                .toString()
                .replace('\\', '/');
    }

    private static String stripExtension(String name) {
        int dot = name.lastIndexOf('.');
        return dot > 0 ? name.substring(0, dot) : name;
    }

    private static String readFile(Path file) {
        try {
            return Files.readString(file, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new UncheckedIOException("读取知识文件失败：" + file, e);
        }
    }

    private static List<Path> walk(Path dir) {
        List<Path> out = new ArrayList<>();
        try (Stream<Path> stream = Files.walk(dir)) {
            stream.filter(Files::isRegularFile)
                    .filter(p -> !isUnderMeta(dir, p))
                    .filter(p -> TEXT_EXT.contains(extension(p.getFileName().toString())))
                    .sorted(Comparator.comparing(p -> toRelativePath(dir, p)))
                    .forEach(out::add);
        } catch (IOException e) {
            return out;
        }
        return out;
    }

    private static boolean isUnderMeta(Path root, Path file) {
        Path rel = root.toAbsolutePath().normalize().relativize(file.toAbsolutePath().normalize());
        return rel.getNameCount() > 0 && "_meta".equals(rel.getName(0).toString());
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? "" : name.substring(dot).toLowerCase();
    }

    private static Frontmatter parseFrontmatter(String raw) {
        if (!raw.startsWith("---")) {
            return new Frontmatter(Map.of(), raw);
        }
        int end = raw.indexOf("\n---", 3);
        if (end < 0) {
            return new Frontmatter(Map.of(), raw);
        }
        String head = raw.substring(3, end).strip();
        String body = raw.substring(end + 4).replaceFirst("^\\r?\\n", "");
        Map<String, String> meta = new LinkedHashMap<>();
        for (String line : head.split("\\r?\\n", -1)) {
            Matcher m = FRONT_LINE.matcher(line);
            if (!m.matches()) {
                continue;
            }
            String value = m.group(2).strip();
            if (value.length() >= 2
                    && ((value.startsWith("\"") && value.endsWith("\""))
                        || (value.startsWith("'") && value.endsWith("'")))) {
                value = value.substring(1, value.length() - 1);
            }
            meta.put(m.group(1), value);
        }
        return new Frontmatter(meta, body);
    }

    private record Frontmatter(Map<String, String> meta, String body) {
    }
}
