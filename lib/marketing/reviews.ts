// lib/marketing/reviews.ts
// Pure logic for Reviews & Reputation (Marketing Pillar 2). Rating math, status/
// source config, and public-platform routing — no DB/network, unit-tested.

export type ReviewSource = 'internal' | 'google' | 'app_store' | 'trustpilot' | 'nps' | 'import';
export type ReviewStatus = 'pending' | 'approved' | 'featured' | 'rejected';

export const SOURCE_LABELS: Record<ReviewSource, string> = {
  internal: 'Direct', google: 'Google', app_store: 'App Store', trustpilot: 'Trustpilot', nps: 'From NPS', import: 'Imported',
};
export const STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: 'Pending', approved: 'Approved', featured: 'Featured', rejected: 'Rejected',
};
export const STATUS_TONE: Record<ReviewStatus, 'neutral' | 'success' | 'brand' | 'danger'> = {
  pending: 'neutral', approved: 'success', featured: 'brand', rejected: 'danger',
};

export function isReviewStatus(v: unknown): v is ReviewStatus {
  return v === 'pending' || v === 'approved' || v === 'featured' || v === 'rejected';
}

/** Reviews that show on the public wall: approved or featured (and not deleted). */
export const PUBLIC_STATUSES: ReviewStatus[] = ['approved', 'featured'];

export type RatingStats = {
  average: number;       // rounded to 1 decimal
  total: number;
  distribution: { star: number; count: number; pct: number }[]; // 5..1
  fiveStarCount: number;
  positivePct: number;   // % of 4–5 star
};

const valid = (ratings: (number | null | undefined)[]): number[] =>
  ratings.filter((r): r is number => typeof r === 'number' && r >= 1 && r <= 5);

export function ratingStats(ratings: (number | null | undefined)[]): RatingStats {
  const r = valid(ratings);
  const total = r.length;
  if (total === 0) {
    return { average: 0, total: 0, distribution: [5, 4, 3, 2, 1].map((star) => ({ star, count: 0, pct: 0 })), fiveStarCount: 0, positivePct: 0 };
  }
  const counts = new Map<number, number>([[1, 0], [2, 0], [3, 0], [4, 0], [5, 0]]);
  for (const v of r) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sum = r.reduce((a, b) => a + b, 0);
  const positive = r.filter((v) => v >= 4).length;
  return {
    average: Math.round((sum / total) * 10) / 10,
    total,
    distribution: [5, 4, 3, 2, 1].map((star) => {
      const count = counts.get(star) ?? 0;
      return { star, count, pct: Math.round((count / total) * 100) };
    }),
    fiveStarCount: counts.get(5) ?? 0,
    positivePct: Math.round((positive / total) * 100),
  };
}

/** Whether to invite the reviewer to also post on public platforms (Google etc.). */
export function shouldRouteToPublic(rating: number, minPublicRating = 4): boolean {
  return rating >= minPublicRating;
}

/** ★★★★☆ string for a rating. */
export function stars(rating: number): string {
  const n = Math.max(0, Math.min(5, Math.round(rating)));
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}

export const DEFAULT_REPUTATION = {
  request_headline: 'How was your experience with Bubaly?',
  request_message: 'Your feedback helps other families and helps us improve.',
  thank_you_high: 'Thank you! Would you share your experience publicly to help other families?',
  thank_you_low: 'Thank you for the honest feedback — we’ll use it to improve. Someone from our team may reach out.',
  min_public_rating: 4,
};
