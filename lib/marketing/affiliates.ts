// lib/marketing/affiliates.ts — pure affiliate/commission helpers.

/** Normalizes an affiliate code: uppercase alphanumerics + dashes, trimmed. */
export function normalizeAffiliateCode(input: string): string {
  return (input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** Clamp a commission rate to 0–1 (accepts 20 → 0.2 when given a percent). */
export function clampRate(rate: number | null | undefined): number {
  if (rate == null || Number.isNaN(rate)) return 0;
  const r = rate > 1 ? rate / 100 : rate; // tolerate "20" meaning 20%
  return Math.max(0, Math.min(1, r));
}

/** Commission in cents for a sale amount (cents) at a given rate. */
export function commissionCents(amountCents: number, rate: number): number {
  return Math.round((amountCents || 0) * clampRate(rate));
}

export type ReferralStatus = 'pending' | 'converted' | 'paid' | 'void';

export interface ReferralLike {
  affiliate_id: string;
  status: ReferralStatus;
  commission_cents: number;
}

export interface AffiliateSummary {
  conversions: number;          // converted + paid
  pendingPayoutCents: number;   // converted (owed, not yet paid)
  paidCents: number;
}

/** Aggregates referral rows into payout figures. */
export function summarizeReferrals(referrals: ReferralLike[]): AffiliateSummary {
  let conversions = 0;
  let pendingPayoutCents = 0;
  let paidCents = 0;
  for (const r of referrals) {
    if (r.status === 'converted') { conversions += 1; pendingPayoutCents += r.commission_cents || 0; }
    else if (r.status === 'paid') { conversions += 1; paidCents += r.commission_cents || 0; }
  }
  return { conversions, pendingPayoutCents, paidCents };
}

/** Per-affiliate conversion + owed totals, keyed by affiliate_id. */
export function payoutByAffiliate(referrals: ReferralLike[]): Map<string, AffiliateSummary> {
  const map = new Map<string, ReferralLike[]>();
  for (const r of referrals) {
    const arr = map.get(r.affiliate_id) ?? [];
    arr.push(r);
    map.set(r.affiliate_id, arr);
  }
  const out = new Map<string, AffiliateSummary>();
  for (const [id, rs] of map) out.set(id, summarizeReferrals(rs));
  return out;
}
