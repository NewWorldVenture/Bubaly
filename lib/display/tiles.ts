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

// `ask` and `handled_today` are appended, never inserted: a stored layout is
// matched by key, so the ORDER of this list is free — but DEFAULT_TILES below
// is what a family with no saved layout sees, and reshuffling that would move
// the tiles under the hands of every household that never customised the wall.
// Both new tiles are opt-in from the layout editor for exactly that reason.
export const WIDGET_KEYS = [
  'clock', 'weather', 'schedule', 'upcoming', 'calendar', 'chores',
  'meals', 'grocery', 'members', 'reminders', 'birthdays', 'featured', 'notes', 'timers',
  'ask', 'handled_today',
] as const;
export type WidgetKey = (typeof WIDGET_KEYS)[number];

export const TILE_SIZES = ['sm', 'md', 'lg', 'wide', 'hero'] as const;
export type TileSize = (typeof TILE_SIZES)[number];

/** A launcher tile for ANY app service/feature: opens `href` when tapped.
 *  Grants the display editor 100% flexibility beyond the built-in widgets. */
export const SERVICE_WIDGET = 'service' as const;
export type TileWidget = WidgetKey | typeof SERVICE_WIDGET;

export type Tile = { id: string; widget: TileWidget; size: TileSize; href?: string };

// Internal app path only — the editor picks from the service catalog, but the
// STORED value is untrusted jsonb. Must start with a single '/', the charset
// excludes ':' entirely (blocks javascript:/https: schemes) while allowing the
// catalog's query/hash deep links (?view=…, #members). 120-char cap.
const SERVICE_HREF_RE = /^\/[a-z0-9\-_/?=&#.[\]]{0,119}$/i;
export function isServiceHref(v: unknown): v is string {
  return typeof v === 'string' && SERVICE_HREF_RE.test(v) && !v.startsWith('//');
}

/** The layout a family with no saved row sees. Deliberately UNCHANGED by the
 *  `ask` / `handled_today` additions: this array is the wall every household
 *  that never opened the editor is looking at, and its order is stable. */
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
    const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : uid();
    const size = (TILE_SIZES as readonly string[]).includes(r.size as string) ? r.size as TileSize : 'sm';

    if ((WIDGET_KEYS as readonly string[]).includes(r.widget as string)) {
      // Built-in widget — never carries an href (strip any stored junk).
      tiles.push({ id, widget: r.widget as WidgetKey, size });
    } else if (r.widget === SERVICE_WIDGET && isServiceHref(r.href)) {
      // Service launcher — only with a valid internal app path.
      tiles.push({ id, widget: SERVICE_WIDGET, size, href: r.href });
    }
    // anything else (unknown widget, bad href) is dropped, never crashes
  }
  return tiles.length ? tiles : DEFAULT_TILES;
}
