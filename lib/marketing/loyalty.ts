// lib/marketing/loyalty.ts
// Pure loyalty logic for Marketing Pillar 3: tier computation, progress to the
// next tier, and redemption checks. No DB/network — unit-tested directly. Shared
// by the admin console, the family rewards page, and the server engine.

export type Tier = 'bronze' | 'silver' | 'gold';

export type TierThresholds = { silverAt: number; goldAt: number };

export const TIER_LABELS: Record<Tier, string> = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold' };
export const TIER_ORDER: Tier[] = ['bronze', 'silver', 'gold'];

/** Tier from lifetime points (lifetime never decreases, so tiers never demote). */
export function computeTier(lifetimePoints: number, t: TierThresholds): Tier {
  if (lifetimePoints >= t.goldAt) return 'gold';
  if (lifetimePoints >= t.silverAt) return 'silver';
  return 'bronze';
}

export type TierProgress = {
  tier: Tier;
  next: Tier | null;
  pointsToNext: number;   // 0 when at the top tier
  pct: number;            // progress within the current tier band, 0–100
};

export function tierProgress(lifetimePoints: number, t: TierThresholds): TierProgress {
  const tier = computeTier(lifetimePoints, t);
  if (tier === 'gold') return { tier, next: null, pointsToNext: 0, pct: 100 };
  if (tier === 'silver') {
    const span = Math.max(1, t.goldAt - t.silverAt);
    const into = lifetimePoints - t.silverAt;
    return { tier, next: 'gold', pointsToNext: Math.max(0, t.goldAt - lifetimePoints), pct: Math.min(100, Math.round((into / span) * 100)) };
  }
  const span = Math.max(1, t.silverAt);
  return { tier, next: 'silver', pointsToNext: Math.max(0, t.silverAt - lifetimePoints), pct: Math.min(100, Math.round((lifetimePoints / span) * 100)) };
}

export function canRedeem(balance: number, costPoints: number): boolean {
  return costPoints >= 0 && balance >= costPoints;
}

/** Points earned for a purchase amount, given points-per-dollar. */
export function pointsForSpend(amountCents: number, perDollar: number): number {
  return Math.max(0, Math.floor((amountCents / 100) * perDollar));
}

export const REWARD_KINDS = ['credit', 'free_month', 'discount', 'swag', 'donation', 'custom'] as const;
export const REWARD_KIND_LABELS: Record<string, string> = {
  credit: 'Account credit', free_month: 'Free month', discount: 'Discount', swag: 'Swag', donation: 'Donation', custom: 'Custom',
};

export const DEFAULT_LOYALTY = {
  program_name: 'Bubaly Rewards',
  points_label: 'points',
  earn_signup: 100,
  earn_referral: 500,
  earn_review: 50,
  earn_per_dollar: 1,
  tier_silver_at: 1000,
  tier_gold_at: 5000,
};
