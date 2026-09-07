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
// ONLY ONE SOURCE COUNTS, and getting that wrong is how a viral dashboard lies.
// A `referrals` row carries `referred_family_id`: a household that did not
// exist before now does. An `invites` row is `(family_id, email, role, token,
// accepted_by)` — accepting one adds a MEMBER to the family that sent it and
// writes no row in `families` at all. Summing the two put a household that
// invited a spouse, two grandparents and a sitter at a coefficient of 4.00 with
// zero new households behind it, on a tile whose own definition is "above 1 the
// product grows without spend".
//
// Accepted invites are still worth seeing, so they are reported beside the
// coefficient as `membersInvited` — a different unit, separately labelled, and
// deliberately NOT part of `joined` or of the division.

/** A referral row reduced to its status. */
export type ReferralStatusRow = { status: string };
/** An invite row reduced to its status. */
export type InviteStatusRow = { status: string };

export type ReferralCoefficient = {
  /** Existing households — the denominator. */
  households: number;
  /** Households that arrived through a referral code — the only source of new households. */
  fromReferrals: number;
  /**
   * People who accepted an invite into an EXISTING household. Reported so the
   * loop's other half is visible; never added to `joined`, because an invite
   * creates a member, not a family.
   */
  membersInvited: number;
  /** joined / households. `null` when there are no households to divide by. */
  coefficient: number | null;
  /** New households attributable to the loop. */
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
/** Accepted invites — counted as members joining a household, never as households. */
const ACCEPTED_INVITE_STATUSES = new Set(['accepted']);

/** X12 — new households per existing household. */
export function referralCoefficient(input: {
  households: number;
  referralRows: ReferralStatusRow[];
  inviteRows: InviteStatusRow[];
}): ReferralCoefficient {
  const households = Math.max(0, Math.trunc(input.households));
  const fromReferrals = input.referralRows.filter((r) => JOINED_REFERRAL_STATUSES.has(r.status)).length;
  const membersInvited = input.inviteRows.filter((r) => ACCEPTED_INVITE_STATUSES.has(r.status)).length;
  const joined = fromReferrals;
  return {
    households,
    fromReferrals,
    membersInvited,
    joined,
    coefficient: households > 0 ? Math.round((joined / households) * 100) / 100 : null,
  };
}
