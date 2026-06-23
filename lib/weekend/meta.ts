// Weekend Planner display + option metadata. Pure, no deps.

/** Mileage radius choices for the "near me" dropdown. */
export const RADIUS_OPTIONS = [5, 10, 25, 50, 75, 100] as const;
export type RadiusMiles = (typeof RADIUS_OPTIONS)[number];

export const DEFAULT_RADIUS: RadiusMiles = 25;
export const DEFAULT_DAYS = 6;

/** Normalize a free-text provider segment/genre into a friendly category + emoji. */
export function categoryMeta(category: string | null | undefined): { label: string; emoji: string } {
  const c = (category ?? '').toLowerCase();
  if (/music|concert|festival/.test(c)) return { label: 'Music', emoji: '🎵' };
  if (/sport|game|athletic/.test(c)) return { label: 'Sports', emoji: '🏟️' };
  if (/family|children|kid/.test(c)) return { label: 'Family', emoji: '👨‍👩‍👧' };
  if (/art|theatre|theater|museum|cultural/.test(c)) return { label: 'Arts & Theatre', emoji: '🎭' };
  if (/comedy/.test(c)) return { label: 'Comedy', emoji: '😂' };
  if (/film|movie/.test(c)) return { label: 'Film', emoji: '🎬' };
  if (/food|drink|culinary/.test(c)) return { label: 'Food & Drink', emoji: '🍽️' };
  if (/fair|expo|community/.test(c)) return { label: 'Community', emoji: '🎡' };
  if (!c) return { label: 'Event', emoji: '📍' };
  return { label: category!.replace(/\b\w/g, (m) => m.toUpperCase()), emoji: '🎟️' };
}

export const PLAN_STATUSES: { value: 'interested' | 'going' | 'maybe' | 'passed'; label: string; tone: string }[] = [
  { value: 'interested', label: 'Interested', tone: 'text-blue-300 bg-blue-500/15' },
  { value: 'going', label: 'Going', tone: 'text-emerald-300 bg-emerald-500/15' },
  { value: 'maybe', label: 'Maybe', tone: 'text-amber-300 bg-amber-500/15' },
  { value: 'passed', label: 'Passed', tone: 'text-zinc-300 bg-zinc-500/15' },
];

export const isValidZip = (zip: string): boolean => /^\d{5}$/.test(zip.trim());

export const dollars = (cents: number | null | undefined): string =>
  cents == null ? '' : `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

/** "$10–$45", "from $10", or "" when unknown. */
export function priceRange(min: number | null | undefined, max: number | null | undefined): string {
  if (min == null && max == null) return '';
  if (min != null && max != null) return min === max ? dollars(min) : `${dollars(min)}–${dollars(max)}`;
  return min != null ? `from ${dollars(min)}` : `up to ${dollars(max)}`;
}
