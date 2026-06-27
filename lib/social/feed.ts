// lib/social/feed.ts — Social Feed platform metadata + filtering. PURE + tested.
//
// Backs the "All your social feeds. One place." consumption feed. Platform
// metadata (label + brand tint) drives the source chips & item badges; the
// filter/quick-filter helpers power the tabs and the right-rail counts. No I/O.

export type Platform =
  | 'facebook' | 'instagram' | 'tiktok' | 'youtube' | 'x'
  | 'linkedin' | 'reddit' | 'whatsapp' | 'pinterest';

export type PlatformMeta = { key: Platform; label: string; tint: string };

/** Ordered to match the mockup's source row. `tint` is a Tailwind text color. */
export const PLATFORMS: PlatformMeta[] = [
  { key: 'facebook',  label: 'Facebook',  tint: 'text-blue-500' },
  { key: 'instagram', label: 'Instagram', tint: 'text-pink-500' },
  { key: 'tiktok',    label: 'TikTok',    tint: 'text-fg' },
  { key: 'youtube',   label: 'YouTube',   tint: 'text-red-500' },
  { key: 'x',         label: 'X',         tint: 'text-fg' },
  { key: 'linkedin',  label: 'LinkedIn',  tint: 'text-sky-600' },
  { key: 'reddit',    label: 'Reddit',    tint: 'text-orange-500' },
  { key: 'whatsapp',  label: 'WhatsApp',  tint: 'text-green-500' },
  { key: 'pinterest', label: 'Pinterest', tint: 'text-rose-600' },
];

const PLATFORM_BY_KEY = new Map(PLATFORMS.map((p) => [p.key, p]));

export function isPlatform(v: unknown): v is Platform {
  return typeof v === 'string' && PLATFORM_BY_KEY.has(v as Platform);
}

export function platformMeta(key: string): PlatformMeta {
  return PLATFORM_BY_KEY.get(key as Platform) ?? { key: key as Platform, label: key, tint: 'text-muted' };
}

export function platformLabel(key: string): string {
  return platformMeta(key).label;
}

// ── Feed filtering ───────────────────────────────────────────────────────────

export type FeedTab = 'all' | 'favorites' | 'family' | 'friends' | 'groups';
export type QuickFilter = 'unread' | 'favorites' | 'videos' | 'photos' | 'links';

export type FeedItemLike = {
  kind: 'post' | 'video' | 'photo' | 'link';
  category: 'family' | 'friends' | 'groups' | 'other';
  is_favorite: boolean;
  is_read: boolean;
  media_urls?: string[];
  posted_at: string;
};

/** Apply the top tab. 'all' passes everything; category tabs match `category`. */
export function applyTab<T extends FeedItemLike>(items: T[], tab: FeedTab): T[] {
  const list = items ?? [];
  switch (tab) {
    case 'favorites': return list.filter((i) => i.is_favorite);
    case 'family':    return list.filter((i) => i.category === 'family');
    case 'friends':   return list.filter((i) => i.category === 'friends');
    case 'groups':    return list.filter((i) => i.category === 'groups');
    default:          return list;
  }
}

/** Apply an optional quick filter (right rail). */
export function applyQuickFilter<T extends FeedItemLike>(items: T[], qf: QuickFilter | null): T[] {
  const list = items ?? [];
  switch (qf) {
    case 'unread':    return list.filter((i) => !i.is_read);
    case 'favorites': return list.filter((i) => i.is_favorite);
    case 'videos':    return list.filter((i) => i.kind === 'video');
    case 'photos':    return list.filter((i) => i.kind === 'photo' || (i.media_urls?.length ?? 0) > 0);
    case 'links':     return list.filter((i) => i.kind === 'link');
    default:          return list;
  }
}

/** Newest first, then filter by tab + quick filter — the feed the user sees. */
export function buildFeed<T extends FeedItemLike>(items: T[], tab: FeedTab, qf: QuickFilter | null): T[] {
  const sorted = [...(items ?? [])].sort((a, b) => Date.parse(b.posted_at) - Date.parse(a.posted_at));
  return applyQuickFilter(applyTab(sorted, tab), qf);
}

export type QuickFilterCounts = Record<QuickFilter, number>;

/** Counts for the right-rail Quick Filters badges. */
export function quickFilterCounts<T extends FeedItemLike>(items: T[]): QuickFilterCounts {
  const list = items ?? [];
  return {
    unread: list.filter((i) => !i.is_read).length,
    favorites: list.filter((i) => i.is_favorite).length,
    videos: list.filter((i) => i.kind === 'video').length,
    photos: list.filter((i) => i.kind === 'photo' || (i.media_urls?.length ?? 0) > 0).length,
    links: list.filter((i) => i.kind === 'link').length,
  };
}
