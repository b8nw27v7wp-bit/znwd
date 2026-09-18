import type { ZonesMeta } from './loader.js';

const DEFAULT: string[] = [
  '光伏清洁无人机是做什么的？',
  '风场检测无人机是做什么的？',
  '叶片检测要停机吗？',
  '清洁作业流程是怎样的？',
  '提供培训吗？',
  '展厅有哪些安全注意事项？',
];

export function allSuggestions(zonesMeta: ZonesMeta): string[] {
  const fromZones = zonesMeta.zones.flatMap((z) => z.suggestions || []);
  return fromZones.length ? fromZones.slice(0, 6) : DEFAULT;
}

export function suggestionsForZone(zonesMeta: ZonesMeta, zoneOrMedia?: string): string[] {
  if (!zoneOrMedia) return allSuggestions(zonesMeta);
  const key = zoneOrMedia.trim();
  const media = zonesMeta.media?.find((m) => m.mediaId === key);
  const zoneId = media?.zoneId || key;
  const zone =
    zonesMeta.zones.find((z) => z.id === zoneId) ||
    zonesMeta.zones.find((z) => z.dir === key) ||
    zonesMeta.zones.find((z) =>
      (z.aliases || []).some((a) => a.includes(key) || key.includes(a)),
    );
  return zone?.suggestions?.length ? zone.suggestions : allSuggestions(zonesMeta);
}

export const SUGGESTIONS = DEFAULT;
