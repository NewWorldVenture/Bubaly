// lib/display/tiles.ts — the Kitchen Display tile model + layout normalization
// (pure, tested).
//
// `display_layouts.tiles` is family-writable jsonb that flows straight into the
// page's SERVER render — and React error boundaries cannot catch SSR throws, so
// a single malformed element (a literal JSON `null` from a historical sparse-
// array save, a string, a renamed widget) crashed the whole kiosk into the
// error boundary on every render, deterministically. This module makes the
// stored layout untrusted input like everything else: `resolveTiles` validates
// every element and always returns a renderable layout.

export const WIDGET_KEYS = [
  'clock', 'weather', 'schedule', 'upcoming', 'calendar', 'chores',
  'meals', 'grocery', 'members', 'reminders', 'birthdays', 'featured', 'notes', 'timers',
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

export const TILE_SIZES = ['sm', 'md', 'lg', 'wide', 'hero'] as const;
export type TileSize = (typeof TILE_SIZES)[number];

export type Tile = { id: string; widget: WidgetKey; size: TileSize };

export const DEFAULT_TILES: Tile[] = [
  { id: 't1', widget: 'featured', size: 'hero' },
  { id: 't2', widget: 'schedule', size: 'md' },
  { id: 't3', widget: 'timers', size: 'md' },
  { id: 't4', widget: 'weather', size: 'sm' },
  { id: 't5', widget: 'meals', size: 'sm' },
  { id: 't6', widget: 'chores', size: 'sm' },
  { id: 't7', widget: 'grocery', size: 'sm' },
  { id: 't8', widget: 'calendar', size: 'md' },
  { id: 't9', widget: 'members', size: 'wide' },
];

// ── Size → how much vertical room a tile has ─────────────────────────────────
// The grid maps each size to a row-span; widgets read these so their CONTENT is
// dynamic to the selected size (a compact tile shows a condensed layout; a
// taller one shows the full thing) — that's what keeps a small Weather tile from
// clipping its forecast, and lets a large list show more rows.

/** Vertical rows a size occupies in the display grid (1 = short, 3 = hero). */
export function tileRowSpan(size: TileSize): number {
  switch (size) {
    case 'sm':
    case 'wide': return 1;
    case 'hero': return 3;
    case 'md':
    case 'lg':
    default: return 2;
  }
}

/** True when a tile is only one row tall — render the condensed widget layout. */
export function isCompactTile(size: TileSize): boolean {
  return tileRowSpan(size) <= 1;
}

/** How many list rows a widget should show at a given size (scales with height). */
export function tileListLimit(size: TileSize, base = 3): number {
  const rows = tileRowSpan(size);
  if (rows <= 1) return base;
  if (rows === 2) return base * 2 + 1;
  return base * 3 + 2;
}

const fallbackUid = () => Math.random().toString(36).slice(2, 9);

/**
 * Coerce an untrusted stored layout into a valid, renderable Tile[]:
 *  - non-arrays → the default layout;
 *  - null / non-object / unknown-widget elements are DROPPED (a renamed or
 *    removed widget must never crash the kiosk);
 *  - an unknown size coerces to 'sm'; a missing/short id gets a fresh one;
 *  - nothing valid left → the default layout (never an empty screen).
 */
export function resolveTiles(raw: unknown, uid: () => string = fallbackUid): Tile[] {
  if (!Array.isArray(raw)) return DEFAULT_TILES;
  const tiles: Tile[] = [];
  for (const el of raw) {
    if (!el || typeof el !== 'object' || Array.isArray(el)) continue;
    const r = el as Record<string, unknown>;
    if (!(WIDGET_KEYS as readonly string[]).includes(r.widget as string)) continue;
    tiles.push({
      id: typeof r.id === 'string' && r.id.length > 0 ? r.id : uid(),
      widget: r.widget as WidgetKey,
      size: (TILE_SIZES as readonly string[]).includes(r.size as string) ? r.size as TileSize : 'sm',
    });
  }
  return tiles.length ? tiles : DEFAULT_TILES;
}
