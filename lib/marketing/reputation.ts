// lib/marketing/reputation.ts — pure helpers for testimonials + case studies.

/** URL-safe slug from a title (lowercase, hyphenated, trimmed). */
export function slugify(input: string): string {
  return (input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')       // non-alphanumerics → hyphen
    .replace(/^-+|-+$/g, '')           // trim hyphens
    .slice(0, 80) || 'item';
}

export interface PublishableLike { is_published: boolean; sort_order?: number }

/** Published items only (for the public marketing site), stable-sorted. */
export function publishedOnly<T extends PublishableLike>(items: T[]): T[] {
  return items
    .filter((t) => t.is_published)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/** Clamp a star rating to 1–5, or null when absent/invalid. */
export function clampRating(rating: number | null | undefined): number | null {
  if (rating == null || Number.isNaN(rating)) return null;
  return Math.max(1, Math.min(5, Math.round(rating)));
}
