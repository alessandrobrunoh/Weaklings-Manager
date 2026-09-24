import sharp from 'sharp';
import type { BuildItemView } from '../api/types.js';

const TILE_SIZE = 160;
const ICON_SIZE = 100;
const GRID_COLUMNS = 5;
const GRID_GAP = 16;
const GRID_PADDING = 24;

const SLOT_ORDER = [
  'head',
  'armor',
  'shoes',
  'weapon',
  'off_hand',
  'cape',
  'bag',
  'mount',
  'food',
  'potion',
] as const;

/**
 * Downloads and composes the item icons into one PNG attachment for Discord.
 *
 * Icons are supplied by the backend's OpenAlbion catalog. A failed or missing
 * icon becomes a labelled placeholder so one bad catalog URL cannot prevent a
 * build from being shown.
 */
export async function createBuildImage(items: readonly BuildItemView[]): Promise<Buffer> {
  if (items.length === 0) {
    throw new Error('This build has no items to display.');
  }

  const orderedItems = [...items].sort(compareItems);
  const rows = Math.ceil(orderedItems.length / GRID_COLUMNS);
  const width =
    GRID_PADDING * 2 + GRID_COLUMNS * TILE_SIZE + (GRID_COLUMNS - 1) * GRID_GAP;
  const height =
    GRID_PADDING * 2 + rows * TILE_SIZE + (rows - 1) * GRID_GAP;

  const layers = await Promise.all(
    orderedItems.map(async (item, index) => {
      const column = index % GRID_COLUMNS;
      const row = Math.floor(index / GRID_COLUMNS);
      const x = GRID_PADDING + column * (TILE_SIZE + GRID_GAP);
      const y = GRID_PADDING + row * (TILE_SIZE + GRID_GAP);
      const icon = await loadIcon(item);

      return [
        {
          input: tileSvg(item),
          left: x,
          top: y,
        },
        {
          input: icon,
          left: x + Math.floor((TILE_SIZE - ICON_SIZE) / 2),
          top: y + 8,
        },
      ];
    }),
  );

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 24, g: 27, b: 34, alpha: 1 },
    },
  })
    .composite(layers.flat())
    .png()
    .toBuffer();
}

function compareItems(left: BuildItemView, right: BuildItemView): number {
  const loadoutOrder = left.loadout === right.loadout ? 0 : left.loadout === 'main' ? -1 : 1;
  if (loadoutOrder !== 0) return loadoutOrder;

  const leftSlot = SLOT_ORDER.indexOf(left.slot as (typeof SLOT_ORDER)[number]);
  const rightSlot = SLOT_ORDER.indexOf(right.slot as (typeof SLOT_ORDER)[number]);
  return (leftSlot === -1 ? SLOT_ORDER.length : leftSlot) -
    (rightSlot === -1 ? SLOT_ORDER.length : rightSlot);
}

async function loadIcon(item: BuildItemView): Promise<Buffer> {
  const iconUrl = item.openalbion_item_icon;
  if (!iconUrl || !/^https?:\/\//i.test(iconUrl)) {
    return placeholderIcon();
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(iconUrl, { signal: controller.signal });
      if (!response.ok) return placeholderIcon();

      const source = Buffer.from(await response.arrayBuffer());
      return await sharp(source)
        .resize(ICON_SIZE, ICON_SIZE, { fit: 'contain' })
        .png()
        .toBuffer();
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return placeholderIcon();
  }
}

function placeholderIcon(): Buffer {
  return Buffer.from(
    `<svg width="${ICON_SIZE}" height="${ICON_SIZE}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" rx="12" fill="#3b414d"/>
      <path d="M22 72 42 48l15 14 10-12 21 22H22Z" fill="#87909f"/>
      <circle cx="70" cy="35" r="8" fill="#c5a059"/>
    </svg>`,
  );
}

function tileSvg(item: BuildItemView): Buffer {
  const slot = escapeXml(item.slot.replace('_', ' ').toUpperCase());
  const name = escapeXml(item.openalbion_item_name.slice(0, 22));
  const loadout = item.loadout === 'swap' ? 'SWAP' : 'MAIN';

  return Buffer.from(
    `<svg width="${TILE_SIZE}" height="${TILE_SIZE}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" rx="14" fill="#313640" stroke="#c5a059" stroke-width="2"/>
      <text x="80" y="124" fill="#f1f3f5" font-size="12" text-anchor="middle"
        font-family="Arial, sans-serif">${slot}</text>
      <text x="80" y="141" fill="#aeb6c2" font-size="10" text-anchor="middle"
        font-family="Arial, sans-serif">${name}</text>
      <text x="148" y="16" fill="#c5a059" font-size="9" text-anchor="end"
        font-family="Arial, sans-serif">${loadout}</text>
    </svg>`,
  );
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
