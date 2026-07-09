// lib/marketplace/trust.ts — the marketplace trust & safety engine (pure,
// unit-tested). The spec: "build trust score using completed transactions,
// reviews, ratings, response time, disputes, cancellations, verification level"
// and surface trust indicators + badges before transacting. Backs the
// marketplace_trust_scores table and the two-sided-rating summary.
//
// Deterministic and framework-free: the server feeds it a member's aggregated
// signals and persists the score; the UI shows the score + badges on profiles,
// listings, and checkout.

export type VerificationKind = 'email' | 'phone' | 'payment_method' | 'identity' | 'address' | 'community';

export interface TrustSignals {
  completedTransactions?: number;
  /** Mean of received review ratings, 1..5. */
  averageRating?: number | null;
  ratingCount?: number;
  /** Median first-response time in minutes (lower is better). */
  responseMinutes?: number | null;
  disputes?: number;
  cancellations?: number;
  verifications?: VerificationKind[];
}

export interface TrustResult {
  score: number;                       // 0..100
  badges: string[];
  breakdown: {
    verification: number;              // 0..30
    ratings: number;                   // 0..30
    experience: number;                // 0..20
    reliability: number;               // 0..20
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** Points (0..30) for identity verification level. */
const VERIFICATION_POINTS: Record<VerificationKind, number> = {
  email: 4, phone: 8, payment_method: 6, identity: 10, address: 4, community: 4,
};

export function verificationScore(verifications: VerificationKind[] = []): number {
  const uniq = new Set(verifications);
  let pts = 0;
  for (const v of uniq) pts += VERIFICATION_POINTS[v] ?? 0;
  return clamp(pts, 0, 30);
}

/**
 * Compute a 0–100 trust score from a member's aggregated marketplace signals,
 * plus the badges they've earned. Each component is capped so no single signal
 * dominates; ratings are confidence-weighted by how many reviews back them.
 */
export function computeTrustScore(signals: TrustSignals): TrustResult {
  const completed = Math.max(0, signals.completedTransactions ?? 0);
  const disputes = Math.max(0, signals.disputes ?? 0);
  const cancellations = Math.max(0, signals.cancellations ?? 0);
  const ratingCount = Math.max(0, signals.ratingCount ?? 0);

  // Verification (0..30).
  const verification = verificationScore(signals.verifications);

  // Ratings (0..30): scale mean 1..5 → 0..30, damped when few reviews back it.
  const mean = signals.averageRating ?? 0;
  const ratingConfidence = ratingCount > 0 ? Math.min(1, ratingCount / 5) : 0; // full weight at ≥5 reviews
  const ratings = clamp(((mean - 1) / 4) * 30 * ratingConfidence, 0, 30);

  // Experience (0..20): diminishing returns on completed transactions.
  const experience = clamp(Math.log2(completed + 1) * 5, 0, 20);

  // Reliability (0..20): start full, penalize disputes/cancellations vs volume.
  const volume = Math.max(1, completed);
  const disputeRate = disputes / volume;
  const cancelRate = cancellations / volume;
  const reliability = clamp(20 - disputeRate * 40 - cancelRate * 20, 0, 20);

  const score = Math.round(verification + ratings + experience + reliability);

  const badges: string[] = [];
  if (signals.verifications?.includes('identity')) badges.push('id_verified');
  if (verification >= 12) badges.push('verified');
  if (completed >= 5) badges.push('repeat_seller');
  if (signals.responseMinutes != null && signals.responseMinutes <= 60) badges.push('fast_responder');
  if (mean >= 4.8 && ratingCount >= 5) badges.push('top_rated');
  if (score >= 85) badges.push('trusted');

  return { score, badges, breakdown: { verification, ratings, experience, reliability } };
}

const BADGE_LABELS: Record<string, string> = {
  id_verified: 'ID verified', verified: 'Verified', repeat_seller: 'Repeat seller',
  fast_responder: 'Fast responder', top_rated: 'Top rated', trusted: 'Trusted',
};
export function badgeLabel(badge: string): string {
  return BADGE_LABELS[badge] ?? badge.replace(/_/g, ' ');
}

/** A short trust tier for quick display: New · Building · Established · Trusted. */
export function trustTier(score: number): 'new' | 'building' | 'established' | 'trusted' {
  if (score >= 85) return 'trusted';
  if (score >= 60) return 'established';
  if (score >= 30) return 'building';
  return 'new';
}
