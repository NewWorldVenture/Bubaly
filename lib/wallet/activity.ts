// lib/wallet/activity.ts — pure helpers for the wallet activity (full ledger)
// views. Transaction-type labels, signed display, day grouping and filtering.
// No Supabase/React; the immutable ledger rows are the input.
import type { WalletTxnType } from '@/lib/database.types';

const TYPE_LABEL: Record<string, string> = {
  gift_received: 'Gift', parent_top_up: 'Top-up', allowance: 'Allowance', chore_reward: 'Chore reward',
  babysitter_payment: 'Babysitter', card_spend: 'Card spend', card_refund: 'Refund', goal_transfer: 'Goal',
  bucket_transfer: 'Transfer', transfer: 'Transfer', withdrawal: 'Withdrawal', fee: 'Fee', adjustment: 'Adjustment', reversal: 'Reversal',
};

export function txnTypeLabel(type: string): string {
  return TYPE_LABEL[type] ?? type.replace(/_/g, ' ');
}

export type ActivityTxn = {
  id: string;
  child_wallet_id: string | null;
  type: WalletTxnType | string;
  status: string;
  direction: 'credit' | 'debit';
  amount_cents: number;
  description: string | null;
  created_at: string;
};

/** +amount for a credit, −amount for a debit (display only). */
export function signedAmountCents(txn: Pick<ActivityTxn, 'direction' | 'amount_cents'>): number {
  const amt = Math.max(0, Math.trunc(txn.amount_cents));
  return txn.direction === 'credit' ? amt : -amt;
}

export type ActivityFilter = { childWalletId?: string | null; type?: string | null; direction?: 'credit' | 'debit' | null };

export function filterTxns<T extends ActivityTxn>(txns: T[], f: ActivityFilter): T[] {
  return txns.filter((t) =>
    (!f.childWalletId || t.child_wallet_id === f.childWalletId) &&
    (!f.type || t.type === f.type) &&
    (!f.direction || t.direction === f.direction),
  );
}

/** Group transactions by calendar day (YYYY-MM-DD), newest day first, and keep
 *  each day's rows in their incoming (newest-first) order. */
export function groupByDay<T extends ActivityTxn>(txns: T[]): Array<{ date: string; txns: T[] }> {
  const map = new Map<string, T[]>();
  for (const t of txns) {
    const day = t.created_at.slice(0, 10);
    const arr = map.get(day) ?? [];
    arr.push(t);
    map.set(day, arr);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, txns]) => ({ date, txns }));
}

/** Net total (credits − debits, completed only) over a set of rows. */
export function netCents(txns: ActivityTxn[]): number {
  return txns.reduce((s, t) => (t.status === 'completed' ? s + signedAmountCents(t) : s), 0);
}

// ── Statement export (CSV) ────────────────────────────────────────────────────
// A family financial OS needs an exportable record. This is pure + deterministic
// so it's unit-tested and callable from a client "Download statement" button.

type CsvTxn = ActivityTxn & { childName?: string | null };

/** Escape one CSV field per RFC 4180: wrap in quotes when it contains a comma,
 *  quote, or newline, doubling any embedded quotes. */
function csvField(value: string | number): string {
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Dollars string with sign, from signed cents: 12345 → "123.45", -50 → "-0.50". */
function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Render transactions (assumed newest-first) to a CSV statement string with a
 * header row and a trailing running-balance column computed OLDEST→newest over
 * completed rows only, so the last data row's balance is the current total.
 * Columns: Date, Time, Type, Description, Child, Direction, Amount, Status, Balance.
 */
export function toStatementCsv(txns: CsvTxn[]): string {
  const header = ['Date', 'Time', 'Type', 'Description', 'Child', 'Direction', 'Amount', 'Status', 'Balance'];

  // Running balance accrues oldest→newest (completed only); map back to the
  // incoming newest-first order for output.
  const oldestFirst = [...txns].reverse();
  const balanceById = new Map<string, number>();
  let running = 0;
  for (const t of oldestFirst) {
    if (t.status === 'completed') running += signedAmountCents(t);
    balanceById.set(t.id, running);
  }

  const rows = txns.map((t) => {
    const iso = t.created_at;
    const date = iso.slice(0, 10);
    const time = iso.slice(11, 19) || '';
    return [
      date,
      time,
      txnTypeLabel(t.type),
      t.description ?? '',
      t.childName ?? '',
      t.direction === 'credit' ? 'in' : 'out',
      dollars(signedAmountCents(t)),
      t.status.replace(/_/g, ' '),
      dollars(balanceById.get(t.id) ?? 0),
    ].map(csvField).join(',');
  });

  return [header.join(','), ...rows].join('\r\n');
}

/** Stable, date-stamped statement filename, e.g. "bubaly-wallet-statement-2026-07-03.csv". */
export function statementFilename(now: Date = new Date()): string {
  return `bubaly-wallet-statement-${now.toISOString().slice(0, 10)}.csv`;
}
