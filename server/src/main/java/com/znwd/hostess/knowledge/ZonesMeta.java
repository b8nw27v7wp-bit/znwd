package com.znwd.hostess.knowledge;

import java.util.List;

/** {@code knowledge/_meta/zones.json}：展区定义与展项（media）到展区的映射。 */
public record ZonesMeta(List<ZoneDef> zones, List<MediaDef> media) {

    public ZonesMeta {
        zones = zones == null ? List.of() : List.copyOf(zones);
        media = media == null ? List.of() : List.copyOf(media);
    }

    public static ZonesMeta empty() {
        return new ZonesMeta(List.of(), List.of());
    }

    public record ZoneDef(
            String id,
            String dir,
            String title,
            List<String> aliases,
            List<String> suggestions) {

        public ZoneDef {
            aliases = aliases == null ? List.of() : List.copyOf(aliases);
            suggestions = suggestions == null ? List.of() : List.copyOf(suggestions);
        }
    }

    public record MediaDef(String mediaId, String title, String zoneId) {
    }
}
