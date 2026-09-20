package com.znwd.hostess.knowledge;

import java.util.ArrayList;
import java.util.List;

/** 推荐问法：优先取展区定义的 suggestions，展区没配时用通用兜底。 */
public final class Suggestions {

    private static final List<String> DEFAULT = List.of(
            "光伏清洁无人机是做什么的？",
            "风场检测无人机是做什么的？",
            "叶片检测要停机吗？",
            "清洁作业流程是怎样的？",
            "提供培训吗？",
            "展厅有哪些安全注意事项？");

    private Suggestions() {
    }

    public static List<String> all(ZonesMeta meta) {
        List<String> fromZones = new ArrayList<>();
        for (ZonesMeta.ZoneDef z : meta.zones()) {
            fromZones.addAll(z.suggestions());
        }
        if (fromZones.isEmpty()) {
            return DEFAULT;
        }
        return fromZones.size() <= 6 ? fromZones : new ArrayList<>(fromZones.subList(0, 6));
    }

    /** @param zoneOrMedia zoneId、zone.dir 或 mediaId（展项） */
    public static List<String> forZone(ZonesMeta meta, String zoneOrMedia) {
        if (zoneOrMedia == null || zoneOrMedia.isBlank()) {
            return all(meta);
        }
        String key = zoneOrMedia.strip();
        String zoneId = key;
        for (ZonesMeta.MediaDef m : meta.media()) {
            if (key.equals(m.mediaId())) {
                zoneId = m.zoneId();
                break;
            }
        }
        // 展项（mediaId）先映射到所属展区；找不到再按 zoneId / 目录名 / 别名匹配
        final String resolvedZoneId = zoneId;
        ZonesMeta.ZoneDef zone = find(meta, z -> z.id() != null && z.id().equals(resolvedZoneId));
        if (zone == null) {
            zone = find(meta, z -> z.dir() != null && z.dir().equals(key));
        }
        if (zone == null) {
            zone = find(meta, z -> z.aliases().stream()
                    .anyMatch(a -> a.contains(key) || key.contains(a)));
        }
        return zone != null && !zone.suggestions().isEmpty() ? zone.suggestions() : all(meta);
    }

    private static ZonesMeta.ZoneDef find(ZonesMeta meta, java.util.function.Predicate<ZonesMeta.ZoneDef> predicate) {
        for (ZonesMeta.ZoneDef z : meta.zones()) {
            if (predicate.test(z)) {
                return z;
            }
        }
        return null;
    }
}
