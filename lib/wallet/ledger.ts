// lib/wallet/ledger.ts — the Family Wallet's money math. PURE + exhaustively
// tested. All amounts are integer cents; no floats ever touch a balance.
//
// The wallet is an IMMUTABLE LEDGER: balances are DERIVED by summing
// `wallet_transactions` (credits add, debits subtract, only `completed` counts).
// Corrections are reversal rows, never edits. This module is the single source
// of truth for allocation splits, balance computation, and goal forecasting so
// the same logic runs on the server (writes) and client (display) identically.

export type BucketKind = 'spend' | 'save' | 'give' | 'invest' | 'goal';
export type Direction = 'credit' | 'debit';

/** Allocation split as whole-number percentages that must sum to 100. */
export type Split = { spend: number; save: number; give: number; invest: number };

export const DEFAULT_SPLIT: Split = { spend: 40, save: 40, give: 10, invest: 10 };

/** Order used to distribute rounding remainder + to render buckets. */
export const SPLIT_ORDER: (keyof Split)[] = ['save', 'spend', 'give', 'invest'];

export function isValidSplit(split: Partial<Split> | null | undefined): split is Split {
  if (!split) return false;
  const keys: (keyof Split)[] = ['spend', 'save', 'give', 'invest'];
  let total = 0;
  for (const k of keys) {
    const v = split[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return false;
    total += v;
  }
  return total === 100;
}

/** Coerce an arbitrary stored value into a valid Split, falling back to default. */
export function normalizeSplit(split: Partial<Split> | null | undefined): Split {
  return isValidSplit(split) ? split : DEFAULT_SPLIT;
}

/** Sum of a (possibly in-progress) split's buckets — for live "must total 100%" UI. */
export function splitTotal(split: Partial<Split> | null | undefined): number {
  const s = split ?? {};
  return (s.spend ?? 0) + (s.save ?? 0) + (s.give ?? 0) + (s.invest ?? 0);
}

/**
 * Split an amount (cents) across buckets by percentage, conserving every cent.
 * Floors each bucket, then hands out the leftover cents one at a time in
 * SPLIT_ORDER so the parts always sum back to exactly `amountCents`.
 */
export function allocate(amountCents: number, split: Partial<Split> | null | undefined = DEFAULT_SPLIT): Split {
  const s = normalizeSplit(split);
  const amount = Math.max(0, Math.trunc(amountCents));
  const base: Split = {
    spend: Math.floor((amount * s.spend) / 100),
    save: Math.floor((amount * s.save) / 100),
    give: Math.floor((amount * s.give) / 100),
    invest: Math.floor((amount * s.invest) / 100),
  };
  let remainder = amount - (base.spend + base.save + base.give + base.invest);
  for (let i = 0; remainder > 0; i = (i + 1) % SPLIT_ORDER.length) {
    // only top up buckets that have a non-zero share, so a 0% bucket stays 0
    const k = SPLIT_ORDER[i];
    if (s[k] > 0) { base[k] += 1; remainder -= 1; }
    else if (SPLIT_ORDER.every((kk) => s[kk] === 0)) { base.spend += remainder; remainder = 0; }
  }
  return base;
}

/** The minimal shape of a ledger row the balance math needs. */
export type LedgerEntry = {
  direction: Direction;
  amount_cents: number;
  status: string;
  bucket_kind?: BucketKind | null;
};

const COUNTS_TOWARD_BALANCE = new Set(['completed']);

/** Net signed value of one entry (credit +, debit −), or 0 if it doesn't count. */
export function signedValue(e: LedgerEntry): number {
  if (!COUNTS_TOWARD_BALANCE.has(e.status)) return 0;
  const amt = Math.max(0, Math.trunc(e.amount_cents));
  return e.direction === 'credit' ? amt : -amt;
}

/** Total wallet balance (cents) derived from the ledger. */
export function balanceFromLedger(entries: LedgerEntry[]): number {
  return entries.reduce((sum, e) => sum + signedValue(e), 0);
}

/** Per-bucket balances (cents). Entries without a bucket fall under `spend`. */
export function bucketBalances(entries: LedgerEntry[]): Record<BucketKind, number> {
  const out: Record<BucketKind, number> = { spend: 0, save: 0, give: 0, invest: 0, goal: 0 };
  for (const e of entries) {
    const v = signedValue(e);
    if (v === 0) continue;
    out[e.bucket_kind ?? 'spend'] += v;
  }
  return out;
}

/** Build the reversal counterpart of a transaction (flips direction). */
export function reversalOf(txn: { id: string; direction: Direction; amount_cents: number; bucket_id?: string | null }): {
  reverses_id: string; direction: Direction; amount_cents: number; type: 'reversal'; status: 'completed'; bucket_id: string | null;
} {
  return {
    reverses_id: txn.id,
    direction: txn.direction === 'credit' ? 'debit' : 'credit',
    amount_cents: Math.max(0, Math.trunc(txn.amount_cents)),
    type: 'reversal',
    status: 'completed',
    bucket_id: txn.bucket_id ?? null,
  };
}

/** Goal progress as a 0..1 fraction. */
export function goalProgress(savedCents: number, targetCents: number): number {
  if (targetCents <= 0) return savedCents > 0 ? 1 : 0;
  return Math.max(0, Math.min(1, savedCents / targetCents));
}

/**
 * Weeks until a goal is reached at a given weekly contribution rate. Returns
 * null when the goal is already met (0) is distinct from "never" (rate ≤ 0).
 */
export function weeksToGoal(savedCents: number, targetCents: number, weeklyCents: number): number | null {
  const remaining = targetCents - savedCents;
  if (remaining <= 0) return 0;
  if (weeklyCents <= 0) return null;
  return Math.ceil(remaining / weeklyCents);
}

/** Format integer cents as USD (whole dollars; cents when present). */
export function formatCents(cents: number, currency = 'USD'): string {
  const dollars = cents / 100;
  const hasCents = cents % 100 !== 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency,
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  }).format(dollars);
}
