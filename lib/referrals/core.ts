// Pure, dependency-free referral logic — safe to unit test and import anywhere.

export type ReferralConfig = {
  enabled: boolean;
  /** Credit the referrer earns when a referred family converts to paid. */
  referrerRewardCents: number;
  /** Credit the referred family earns on conversion. */
  referredRewardCents: number;
  /** Display label for the reward, e.g. "$10 credit" or "1 month free". */
  rewardLabel: string;
};

export const DEFAULT_REFERRAL_CONFIG: ReferralConfig = {
  enabled: true,
  referrerRewardCents: 1000,
  referredRewardCents: 1000,
  rewardLabel: '$10 credit',
};

/** Merge a partial config (from marketing_settings) over the defaults. */
export function resolveReferralConfig(raw: unknown): ReferralConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReferralConfig>;
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_REFERRAL_CONFIG.enabled,
    referrerRewardCents: Number.isFinite(c.referrerRewardCents as number)
      ? Math.max(0, Math.round(c.referrerRewardCents as number))
      : DEFAULT_REFERRAL_CONFIG.referrerRewardCents,
    referredRewardCents: Number.isFinite(c.referredRewardCents as number)
      ? Math.max(0, Math.round(c.referredRewardCents as number))
      : DEFAULT_REFERRAL_CONFIG.referredRewardCents,
    rewardLabel: typeof c.rewardLabel === 'string' && c.rewardLabel.trim()
      ? c.rewardLabel.trim()
      : DEFAULT_REFERRAL_CONFIG.rewardLabel,
  };
}

// Ambiguous characters (0/O, 1/I) are excluded so codes are easy to read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Build a human-friendly referral code, e.g. "SMITH-7K4Q". */
export function generateReferralCode(seed?: string, rand: () => number = Math.random): string {
  const prefix = (seed ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 5);
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    suffix += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  }
  return prefix ? `${prefix}-${suffix}` : suffix;
}

/** Normalize user-entered codes for comparison/storage (uppercase, trimmed). */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

/** Absolute share link a family hands to friends. */
export function referralLink(code: string, base = 'https://www.bubaly.com'): string {
  return `${base.replace(/\/$/, '')}/signup?ref=${encodeURIComponent(code)}`;
}

export type ReferralRow = {
  status: string;
  referrer_reward_cents: number;
  referred_reward_cents: number;
};

export type ReferralSummary = {
  total: number;
  pending: number;
  signedUp: number;
  converted: number;
  /** Reward cents the referrer has actually earned (converted + rewarded). */
  earnedCents: number;
};

/** Roll a referrer's referral rows up into headline numbers. */
export function summarizeReferrals(rows: ReferralRow[]): ReferralSummary {
  const out: ReferralSummary = { total: 0, pending: 0, signedUp: 0, converted: 0, earnedCents: 0 };
  for (const r of rows) {
    out.total++;
    if (r.status === 'pending') out.pending++;
    else if (r.status === 'signed_up') out.signedUp++;
    else if (r.status === 'converted' || r.status === 'rewarded') {
      out.converted++;
      out.earnedCents += r.referrer_reward_cents ?? 0;
    }
  }
  return out;
}
