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

// ─── X12 · the referral coefficient ──────────────────────────────────────────
//
// How many NEW households each existing household brings in. Above 1 the
// product grows without spend; below it, every family is a customer you had to
// buy. It is one number, and the whole flywheel argument rests on it, so it is
// defined here in the same pure module as the rest of the referral logic rather
// than assembled inside a page.
//
// Two sources, because a family recruits in two ways: a referral code a
// stranger redeems, and an invite a relative accepts. Both create a household
// that would not otherwise exist, and counting only the first understated the
// loop by exactly the share of families who invite Grandma before they think
// about a code.

/** A referral row reduced to its status. */
export type ReferralStatusRow = { status: string };
/** An invite row reduced to its status. */
export type InviteStatusRow = { status: string };

export type ReferralCoefficient = {
  /** Existing households — the denominator. */
  households: number;
  /** Households that arrived through a referral code. */
  fromReferrals: number;
  /** Households that arrived by accepting an invite. */
  fromInvites: number;
  /** joined / households. `null` when there are no households to divide by. */
  coefficient: number | null;
  /** Total new households attributable to the loop. */
  joined: number;
};

/**
 * Referral statuses that mean a household actually arrived.
 *
 * `pending` is a code that was handed out and nothing more — counting it would
 * measure enthusiasm rather than growth, which is the mistake every viral
 * dashboard makes once.
 */
const JOINED_REFERRAL_STATUSES = new Set(['signed_up', 'converted', 'rewarded']);
const JOINED_INVITE_STATUSES = new Set(['accepted']);

/** X12 — new households per existing household. */
export function referralCoefficient(input: {
  households: number;
  referralRows: ReferralStatusRow[];
  inviteRows: InviteStatusRow[];
}): ReferralCoefficient {
  const households = Math.max(0, Math.trunc(input.households));
  const fromReferrals = input.referralRows.filter((r) => JOINED_REFERRAL_STATUSES.has(r.status)).length;
  const fromInvites = input.inviteRows.filter((r) => JOINED_INVITE_STATUSES.has(r.status)).length;
  const joined = fromReferrals + fromInvites;
  return {
    households,
    fromReferrals,
    fromInvites,
    joined,
    coefficient: households > 0 ? Math.round((joined / households) * 100) / 100 : null,
  };
}
