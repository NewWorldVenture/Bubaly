// lib/marketplace/trust.ts — the marketplace Trust Score (pure, tested).
//
// "Verified. Trusted. Safe." — every member gets a transparent trust score
// computed from what actually happened: the ratings others gave them, how many
// exchanges they completed, and how established they are on the board. No
// denormalized score column to drift; the server recomputes from live rows and
// the card explains exactly what went in.

export type TrustInput = {
  /** Ratings this member RECEIVED (1..5 each). */
  ratingsReceived: number[];
  /** Exchanges completed (as buyer or seller). */
  ordersCompleted: number;
  /** Listings this member has posted (any status). */
  listingsPosted: number;
  /** Open disputes / reported problems (reduces the score). */
  disputes?: number;
};

export type TrustBand = 'exceptional' | 'great' | 'good' | 'building';

export type TrustScore = {
  /** 0..100 composite. */
  score: number;
  /** The 5-point display form ("4.9"), derived from the composite. */
  stars: number;
  band: TrustBand;
  /** Plain-language factors the card lists. */
  factors: string[];
};

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * Composite: rating quality (0..60, needs volume to max out) + completed
 * exchanges (0..25) + activity on the board (0..15) − disputes (10 each).
 * A brand-new member starts at 50 ("building") rather than zero — trust is
 * earned up AND down, and an empty history isn't a red flag.
 */
export function computeTrustScore(input: TrustInput): TrustScore {
  const { ratingsReceived, ordersCompleted, listingsPosted, disputes = 0 } = input;

  const factors: string[] = [];

  let score: number;
  if (ratingsReceived.length === 0 && ordersCompleted === 0 && listingsPosted === 0) {
    score = 50;
    factors.push('New to the marketplace — complete an exchange to build trust.');
  } else {
    const avg = ratingsReceived.length
      ? ratingsReceived.reduce((a, b) => a + b, 0) / ratingsReceived.length
      : 0;
    // Rating quality: scaled by volume so one 5★ review isn't a perfect 60.
    const volumeFactor = clamp(ratingsReceived.length / 10, 0, 1);
    const ratingPts = (avg / 5) * 60 * (0.5 + 0.5 * volumeFactor);
    const orderPts = clamp(ordersCompleted / 20, 0, 1) * 25;
    const activityPts = clamp(listingsPosted / 10, 0, 1) * 15;
    score = ratingPts + orderPts + activityPts;

    if (ratingsReceived.length > 0) factors.push(`${avg.toFixed(1)}★ average from ${ratingsReceived.length} review${ratingsReceived.length === 1 ? '' : 's'}`);
    if (ordersCompleted > 0) factors.push(`${ordersCompleted} exchange${ordersCompleted === 1 ? '' : 's'} completed`);
    if (listingsPosted > 0) factors.push(`${listingsPosted} item${listingsPosted === 1 ? '' : 's'} listed`);
  }

  if (disputes > 0) {
    score -= disputes * 10;
    factors.push(`${disputes} open dispute${disputes === 1 ? '' : 's'}`);
  }

  score = Math.round(clamp(score, 0, 100));
  const stars = Math.round((score / 100) * 5 * 10) / 10;
  const band: TrustBand = score >= 90 ? 'exceptional' : score >= 75 ? 'great' : score >= 55 ? 'good' : 'building';
  return { score, stars, band, factors };
}

export const TRUST_BAND_LABELS: Record<TrustBand, string> = {
  exceptional: 'Exceptional', great: 'Great', good: 'Good', building: 'Building',
};

/** Average + count from raw ratings — the "4.9 (28)" chip on cards. */
export function ratingSummary(ratings: number[]): { avg: number; count: number } {
  if (ratings.length === 0) return { avg: 0, count: 0 };
  return { avg: Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10, count: ratings.length };
}
