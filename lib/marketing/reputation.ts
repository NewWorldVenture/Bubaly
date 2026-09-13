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

/**
 * Rows created by the database seeder carry a slug of `seed-<table>-<n>`.
 *
 * These are not hypothetical. On 2026-09-13 the production homepage rendered
 * three of them under the heading "Family stories", as customer quotes "in
 * their own words":
 *
 *     Seed Case Studies #450 — Seed Summary value 450 — Seed Result Metric value 450
 *
 * and each linked to a detail page that answered 200
 * (`/customers/seed-case_studies-450`). Presenting placeholder records as real
 * families is the one failure mode this section cannot have, so the filter lives
 * with the shared reputation helpers rather than at a single call site — the
 * list and the detail page must agree, which is precisely where the equivalent
 * blog defect came from when they did not.
 *
 * `is_published` cannot carry this: the seeder sets it true, which is what made
 * them public in the first place.
 */
export function isSyntheticSeedSlug(slug: string | null | undefined): boolean {
  return /^seed-[a-z0-9_]+-\d+$/i.test((slug ?? '').trim());
}

export interface PublishableLike { is_published: boolean; sort_order?: number; slug?: string | null }

/** Published items only (for the public marketing site), stable-sorted. */
export function publishedOnly<T extends PublishableLike>(items: T[]): T[] {
  return items
    .filter((t) => t.is_published && !isSyntheticSeedSlug(t.slug))
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

/** Clamp a star rating to 1–5, or null when absent/invalid. */
export function clampRating(rating: number | null | undefined): number | null {
  if (rating == null || Number.isNaN(rating)) return null;
  return Math.max(1, Math.min(5, Math.round(rating)));
}
