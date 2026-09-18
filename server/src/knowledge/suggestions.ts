import type { ZonesMeta } from './loader.js';

const DEFAULT: string[] = [
  '研究院主要做哪些方向？',
  '参观需要预约吗？',
  '能否现场参观？有讲解吗？',
  '如何接入开放平台？',
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
