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
