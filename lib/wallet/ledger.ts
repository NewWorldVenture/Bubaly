// lib/wallet/ledger.ts — pure helpers for the Family Wallet.
// Bucket allocation math, balance computation, goal tracking.
// No Supabase/React — deterministically testable.

export type WalletKind = 'deposit' | 'withdrawal' | 'transfer' | 'chore' | 'gift' | 'adjustment';

export const DEFAULT_BUCKETS = ['save', 'spend', 'give', 'invest'] as const;
export type DefaultBucket = (typeof DEFAULT_BUCKETS)[number];

export const BUCKET_META: Record<DefaultBucket, { label: string; emoji: string; color: string }> = {
  save:   { label: 'Save',   emoji: '🏦', color: 'text-blue-500' },
  spend:  { label: 'Spend',  emoji: '🛍️', color: 'text-green-500' },
  give:   { label: 'Give',   emoji: '💝', color: 'text-pink-500' },
  invest: { label: 'Invest', emoji: '📈', color: 'text-amber-500' },
};

export const DEFAULT_SPLIT = { save: 50, spend: 30, give: 10, invest: 10 } as const;

export interface AllocationRule {
  bucket: string;
  pct: number;
}

export interface BucketLike {
  member_id: string;
  bucket: string;
  balance_cents: number;
  target_cents: number | null;
}

export interface TxnLike {
  member_id: string;
  bucket: string;
  amount_cents: number;
  kind: string;
  created_at: string;
}

export function splitTotal(totalCents: number, rules: AllocationRule[]): Map<string, number> {
  const out = new Map<string, number>();
  if (rules.length === 0 || totalCents <= 0) return out;

  const pctSum = rules.reduce((s, r) => s + r.pct, 0);
  if (pctSum === 0) return out;

  let remaining = totalCents;
  const sorted = [...rules].sort((a, b) => b.pct - a.pct);

  for (let i = 0; i < sorted.length; i++) {
    if (i === sorted.length - 1) {
      out.set(sorted[i].bucket, remaining);
    } else {
      const share = Math.round((sorted[i].pct / pctSum) * totalCents);
      out.set(sorted[i].bucket, share);
      remaining -= share;
    }
  }
  return out;
}

export function totalBalance(buckets: BucketLike[], memberId?: string): number {
  const filtered = memberId ? buckets.filter((b) => b.member_id === memberId) : buckets;
  return filtered.reduce((s, b) => s + b.balance_cents, 0);
}

export function bucketBalance(buckets: BucketLike[], memberId: string, bucket: string): number {
  return buckets.find((b) => b.member_id === memberId && b.bucket === bucket)?.balance_cents ?? 0;
}

export function weeksToGoal(currentCents: number, targetCents: number, weeklyRateCents: number): number | null {
  if (weeklyRateCents <= 0) return null;
  const remaining = targetCents - currentCents;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / weeklyRateCents);
}

export function weeklyRate(txns: TxnLike[], memberId: string, bucket: string, weeks: number = 4): number {
  if (weeks <= 0) return 0;
  const now = new Date();
  const cutoff = new Date(now.getTime() - weeks * 7 * 24 * 60 * 60 * 1000);
  const credits = txns.filter(
    (t) => t.member_id === memberId && t.bucket === bucket && t.amount_cents > 0 && new Date(t.created_at) >= cutoff,
  );
  const total = credits.reduce((s, t) => s + t.amount_cents, 0);
  return Math.round(total / weeks);
}

export function rulesValid(rules: AllocationRule[]): boolean {
  return rules.every((r) => r.pct >= 0) && rules.reduce((s, r) => s + r.pct, 0) === 100;
}

export interface WalletSummary {
  totalCents: number;
  byBucket: Array<{ bucket: string; cents: number; pct: number }>;
  topBucket: string | null;
  goalProgress: Array<{ bucket: string; currentCents: number; targetCents: number; pct: number; weeksLeft: number | null }>;
}

export function walletSummary(
  buckets: BucketLike[],
  memberId: string,
  txns: TxnLike[] = [],
): WalletSummary {
  const mine = buckets.filter((b) => b.member_id === memberId);
  const total = mine.reduce((s, b) => s + b.balance_cents, 0);
  const byBucket = mine.map((b) => ({
    bucket: b.bucket,
    cents: b.balance_cents,
    pct: total > 0 ? Math.round((b.balance_cents / total) * 100) : 0,
  }));
  byBucket.sort((a, b) => b.cents - a.cents);
  const topBucket = byBucket.length > 0 ? byBucket[0].bucket : null;

  const goalProgress = mine
    .filter((b) => b.target_cents != null && b.target_cents > 0)
    .map((b) => {
      const rate = weeklyRate(txns, memberId, b.bucket);
      return {
        bucket: b.bucket,
        currentCents: b.balance_cents,
        targetCents: b.target_cents!,
        pct: Math.min(100, Math.round((b.balance_cents / b.target_cents!) * 100)),
        weeksLeft: weeksToGoal(b.balance_cents, b.target_cents!, rate),
      };
    });

  return { totalCents: total, byBucket, topBucket, goalProgress };
}

export function fmtMoney(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function bucketLabel(bucket: string): string {
  const meta = BUCKET_META[bucket as DefaultBucket];
  return meta ? meta.label : bucket.charAt(0).toUpperCase() + bucket.slice(1);
}

export function bucketEmoji(bucket: string): string {
  const meta = BUCKET_META[bucket as DefaultBucket];
  return meta ? meta.emoji : '💰';
}
