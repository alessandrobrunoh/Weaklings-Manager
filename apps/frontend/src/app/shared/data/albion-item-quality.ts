/** Albion item quality grades, matching the render CDN `quality=` query (1..=5). */
export const ALBION_ITEM_QUALITIES = [
  { id: 1, label: 'Normal', short: 'N' },
  { id: 2, label: 'Good', short: 'G' },
  { id: 3, label: 'Outstanding', short: 'O' },
  { id: 4, label: 'Excellent', short: 'E' },
  { id: 5, label: 'Masterpiece', short: 'M' },
] as const;

export type AlbionItemQuality = (typeof ALBION_ITEM_QUALITIES)[number]['id'];

/** Excellent — the guild default for new loadout slots and omitted API fields. */
export const DEFAULT_ALBION_ITEM_QUALITY: AlbionItemQuality = 4;

/** True when `value` is a real Albion quality id. */
export function isAlbionItemQuality(value: number): value is AlbionItemQuality {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

/** Coerces an API/UI value to a valid quality, defaulting to Excellent. */
export function normalizeAlbionItemQuality(value: number | null | undefined): AlbionItemQuality {
  const candidate = value ?? Number.NaN;
  return isAlbionItemQuality(candidate) ? candidate : DEFAULT_ALBION_ITEM_QUALITY;
}

/** Full English grade name, e.g. `Excellent`. */
export function albionItemQualityLabel(value: number | null | undefined): string {
  const quality = normalizeAlbionItemQuality(value);
  return ALBION_ITEM_QUALITIES.find((entry) => entry.id === quality)?.label ?? 'Excellent';
}

/** Rewrites an Albion render URL so its `quality` query matches `quality`. */
export function albionIconUrlWithQuality(
  icon: string | null | undefined,
  quality: number | null | undefined,
): string {
  const iconUrl = icon?.trim() ?? '';
  if (!iconUrl) return '';
  const grade = normalizeAlbionItemQuality(quality);
  if (iconUrl.includes('quality=')) {
    return iconUrl.replace(/([?&]quality=)\d+/, `$1${grade}`);
  }
  return iconUrl.includes('?') ? `${iconUrl}&quality=${grade}` : `${iconUrl}?quality=${grade}`;
}
