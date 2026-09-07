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

// ── Signup capture ────────────────────────────────────────────────────────────
// A `/signup?ref=CODE` visit is remembered two ways — an httpOnly cookie set by
// the signup page, and `referral_code` in the auth user's metadata for the
// email path — so whichever avenue the family signs up through (email, phone,
// OAuth), the code is still there when the wizard creates their family.

/** Cookie the signup page sets from `?ref=`; read once by the onboarding finalizer. */
export const REFERRAL_COOKIE = 'bubaly_ref';
/** 30 days: long enough to cover an email confirmation that waits a few weeks. */
export const REFERRAL_COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
/** `referrals.source` for a family attributed from the signup link. */
export const REFERRAL_SIGNUP_SOURCE = 'signup_link';
/** `referrals.source` for a family invited by email from the referral panel. */
export const REFERRAL_EMAIL_SOURCE = 'email';
/** `user_preferences.notification_prefs` key holding when the home referral card was dismissed. */
export const REFERRAL_HOME_CARD_DISMISSED_KEY = 'referralHomeCardDismissedAt';

/**
 * A code we are willing to keep around: the normalized alphabet a generated
 * code uses, 4–16 characters. Anything else is a typo or a crafted value and
 * is dropped rather than stored in a cookie.
 */
export function isPlausibleReferralCode(raw: string | null | undefined): boolean {
  if (!raw) return false;
  return /^[A-Z0-9-]{4,16}$/.test(normalizeCode(raw));
}

/**
 * Pick the code to apply at the end of onboarding. The cookie wins because it
 * is the most recent visit; the auth metadata is the fallback for a browser
 * that dropped cookies between signup and confirmation.
 */
export function referralCodeFromSignup(input: { cookieCode?: string | null; metadataCode?: unknown }): string | null {
  const candidates = [input.cookieCode, typeof input.metadataCode === 'string' ? input.metadataCode : null];
  for (const c of candidates) {
    if (isPlausibleReferralCode(c)) return normalizeCode(c as string);
  }
  return null;
}

// ── Referral email throttle ───────────────────────────────────────────────────
// Same shape as lib/auth/child-throttle.ts: a pure policy evaluated from
// persisted state. The state lives in columns that already exist — every
// send is appended to `referrals.metadata.email_sent_at` on the invited
// family's row — so nothing new has to be migrated to enforce the limit.

export type ReferralEmailPolicy = { limit: number; windowMs: number };

export const REFERRAL_EMAIL_POLICY: ReferralEmailPolicy = {
  limit: 10,
  windowMs: 24 * 60 * 60_000,
};

/** The send timestamps recorded on one referral row's metadata. */
export function referralEmailSendTimes(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as { email_sent_at?: unknown }).email_sent_at;
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

export type ReferralEmailDecision = {
  allowed: boolean;
  /** Sends inside the window so far. */
  used: number;
  remaining: number;
  /** Seconds until the oldest send leaves the window (0 when allowed). */
  retryAfterSec: number;
};

/** May this family send another referral email right now? Deterministic given `now`. */
export function evaluateReferralEmailThrottle(
  rows: ReadonlyArray<{ metadata: unknown }>,
  now: Date = new Date(),
  policy: ReferralEmailPolicy = REFERRAL_EMAIL_POLICY,
): ReferralEmailDecision {
  const floor = now.getTime() - policy.windowMs;
  const recent: number[] = [];
  for (const row of rows) {
    for (const iso of referralEmailSendTimes(row.metadata)) {
      const t = Date.parse(iso);
      if (!Number.isNaN(t) && t > floor && t <= now.getTime()) recent.push(t);
    }
  }
  const used = recent.length;
  if (used < policy.limit) return { allowed: true, used, remaining: policy.limit - used, retryAfterSec: 0 };
  const oldest = Math.min(...recent);
  return { allowed: false, used, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((oldest + policy.windowMs - now.getTime()) / 1000)) };
}

/** The row's metadata after recording one more send (keeps the last 50 timestamps). */
export function withReferralEmailSent(metadata: unknown, now: Date = new Date()): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  const sent = [...referralEmailSendTimes(metadata), now.toISOString()].slice(-50);
  return { ...base, email_sent_at: sent };
}

// ── Reward fulfilment ─────────────────────────────────────────────────────────
// A referral is 'rewarded' only after Stripe has confirmed BOTH credits. The
// balance-transaction ids are kept in `referrals.metadata.reward` so a webhook
// retry after a partial failure credits only the side that is still owed.

export type ReferralRewardSide = 'referrer' | 'referred';

export type ReferralRewardRecord = {
  referrer_txn?: string | null;
  referred_txn?: string | null;
  /** Set when a side had nothing to credit (a zero reward in the config). */
  referrer_skipped?: string | null;
  referred_skipped?: string | null;
};

export function rewardRecordFrom(metadata: unknown): ReferralRewardRecord {
  if (!metadata || typeof metadata !== 'object') return {};
  const raw = (metadata as { reward?: unknown }).reward;
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { referrer_txn: s(r.referrer_txn), referred_txn: s(r.referred_txn), referrer_skipped: s(r.referrer_skipped), referred_skipped: s(r.referred_skipped) };
}

/** Is this side settled — credited (a Stripe id on file) or deliberately skipped? */
export function rewardSideSettled(record: ReferralRewardRecord, side: ReferralRewardSide): boolean {
  return side === 'referrer'
    ? Boolean(record.referrer_txn || record.referrer_skipped)
    : Boolean(record.referred_txn || record.referred_skipped);
}

/** The sides still owed a credit, in the order they are attempted. */
export function rewardSidesOwed(record: ReferralRewardRecord): ReferralRewardSide[] {
  const out: ReferralRewardSide[] = [];
  if (!rewardSideSettled(record, 'referrer')) out.push('referrer');
  if (!rewardSideSettled(record, 'referred')) out.push('referred');
  return out;
}

/** Merge a reward patch into a row's metadata without clobbering other keys. */
export function withRewardRecord(metadata: unknown, patch: Partial<ReferralRewardRecord>): Record<string, unknown> {
  const base = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  return { ...base, reward: { ...rewardRecordFrom(metadata), ...patch } };
}

/** The Stripe idempotency key for one side of one referral's credit. */
export function rewardIdempotencyKey(referralId: string, side: ReferralRewardSide): string {
  return `referral-reward-${referralId}-${side}`;
}
