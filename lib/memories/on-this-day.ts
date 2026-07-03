// lib/memories/on-this-day.ts — "On this day" memory resurfacing.
//
// Delight, not admin: at meaningful moments FamilyOS surfaces the family's own
// past. Given the photo library this pure module finds the ones taken on today's
// month+day in a previous year and labels them ("2 years ago"), newest match
// first. No I/O, so it's deterministic and unit-tested; a client reads
// family_photos and renders whatever this returns (nothing on an ordinary day).

export type DatedPhoto = {
  id: string;
  taken_at: string | null;
  url?: string | null;
  thumbnail_url?: string | null;
  caption?: string | null;
  media_type?: string;
};

export type OnThisDayPhoto<T extends DatedPhoto = DatedPhoto> = T & {
  yearsAgo: number;
  label: string;
};

/** "1 year ago" / "5 years ago". */
export function yearsAgoLabel(years: number): string {
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * Pick the photos taken on today's calendar day (same month + date) in a prior
 * year, most-recent match first, capped at `max`. Compares on the local date
 * parts of `taken_at`, ignores anything undated / future / same-year, and skips
 * the Feb-29 edge on non-leap days by exact month+date match.
 */
export function pickOnThisDay<T extends DatedPhoto>(
  photos: T[],
  now: Date = new Date(),
  max = 8,
): OnThisDayPhoto<T>[] {
  const m = now.getMonth();
  const d = now.getDate();
  const y = now.getFullYear();
  const out: OnThisDayPhoto<T>[] = [];
  for (const p of photos ?? []) {
    if (!p.taken_at) continue;
    const t = new Date(p.taken_at);
    if (Number.isNaN(t.getTime())) continue;
    if (t.getMonth() !== m || t.getDate() !== d) continue;
    const yearsAgo = y - t.getFullYear();
    if (yearsAgo < 1) continue; // today or the future never counts as a memory
    out.push({ ...p, yearsAgo, label: yearsAgoLabel(yearsAgo) });
  }
  out.sort((a, b) => a.yearsAgo - b.yearsAgo || (b.taken_at ?? '').localeCompare(a.taken_at ?? ''));
  return out.slice(0, max);
}

export type OnThisDayNotice = { title: string; body: string; relatedId: string };

/**
 * One family-wide notification for a day that resurfaces memories, or null on
 * an ordinary day. `relatedId` embeds today's calendar date, so the engine's
 * permanent related_id dedup fires this at most once per day — and naturally
 * again when the same date comes around with matches in a future year.
 */
export function onThisDayNotice(photos: DatedPhoto[], now: Date = new Date()): OnThisDayNotice | null {
  const matches = pickOnThisDay(photos, now, 50);
  if (matches.length === 0) return null;
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return {
    relatedId: `onthisday:${key}`,
    title: `📸 On this day ${matches[0].label}`,
    body: matches.length === 1
      ? 'A family memory from this day — tap to relive it.'
      : `${matches.length} family memories from this day — tap to relive them.`,
  };
}
