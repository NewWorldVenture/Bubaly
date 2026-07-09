// lib/marketplace/reviews.ts — two-sided rating aggregation (pure, unit-tested).
// The spec's Uber-style ratings: after each transaction both sides rate each
// other across dimensions (communication, reliability, item accuracy, timeliness,
// condition returned, overall). This rolls a member's received reviews up into an
// average, a star distribution, per-dimension means, and the most recent few —
// and feeds the trust engine's rating signals. Backs marketplace_reviews +
// marketplace_ratings.

import type { TrustSignals } from './trust';

export type RatingDimension =
  | 'communication' | 'reliability' | 'item_accuracy' | 'timeliness' | 'condition_returned' | 'overall';

export const RATING_DIMENSIONS: RatingDimension[] = [
  'communication', 'reliability', 'item_accuracy', 'timeliness', 'condition_returned', 'overall',
];

export interface ReviewInput {
  /** Overall star rating, 1..5. */
  rating: number;
  role?: string | null;                                   // buyer/seller/renter/owner/borrower/lender
  dimensions?: Partial<Record<RatingDimension, number>>;  // per-dimension 1..5
  createdAt?: string | null;                              // ISO
  body?: string | null;
}

export interface ReviewSummary {
  averageRating: number | null;                           // mean overall, 1 decimal
  count: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;        // star histogram
  byDimension: Partial<Record<RatingDimension, number>>;  // mean per dimension, 1 decimal
  recent: ReviewInput[];                                  // newest first, capped
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const validStar = (n: unknown): n is number => typeof n === 'number' && n >= 1 && n <= 5;
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Aggregate a member's received reviews. Ignores out-of-range stars; averages are
 * rounded to one decimal; `recent` is sorted newest-first (by createdAt) and
 * capped. An empty set yields a null average and a zeroed distribution.
 */
export function aggregateReviews(reviews: ReviewInput[], opts: { recentLimit?: number } = {}): ReviewSummary {
  const recentLimit = opts.recentLimit ?? 5;
  const distribution: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const overall: number[] = [];
  const perDim = new Map<RatingDimension, number[]>();

  for (const r of reviews) {
    if (!validStar(r.rating)) continue;
    const star = Math.round(r.rating) as 1 | 2 | 3 | 4 | 5;
    distribution[star] += 1;
    overall.push(r.rating);
    for (const dim of RATING_DIMENSIONS) {
      const v = r.dimensions?.[dim];
      if (validStar(v)) {
        const arr = perDim.get(dim) ?? [];
        arr.push(v);
        perDim.set(dim, arr);
      }
    }
  }

  const byDimension: Partial<Record<RatingDimension, number>> = {};
  for (const [dim, arr] of perDim) {
    const m = mean(arr);
    if (m != null) byDimension[dim] = round1(m);
  }

  const avg = mean(overall);
  const recent = [...reviews]
    .filter((r) => validStar(r.rating))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, recentLimit);

  return {
    averageRating: avg == null ? null : round1(avg),
    count: overall.length,
    distribution,
    byDimension,
    recent,
  };
}

/** Bridge a review summary into the trust engine's rating signals. */
export function toTrustRatingSignals(summary: ReviewSummary): Pick<TrustSignals, 'averageRating' | 'ratingCount'> {
  return { averageRating: summary.averageRating, ratingCount: summary.count };
}

/** One-line label, e.g. "4.8 ★ (23 reviews)" or "No reviews yet". */
export function ratingLabel(summary: ReviewSummary): string {
  if (summary.count === 0 || summary.averageRating == null) return 'No reviews yet';
  return `${summary.averageRating.toFixed(1)} ★ (${summary.count} ${summary.count === 1 ? 'review' : 'reviews'})`;
}
