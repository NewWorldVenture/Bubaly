// lib/finance/splits.ts — pure helpers for Expense Splitting (family accounting).
// Even-split math (cent-accurate), per-member balances, and minimal-transfer
// settlement suggestions. No Supabase/React so it's deterministically testable.

export function usd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** Split a total evenly across members; leftover cents go to the first members
 *  so the shares always sum exactly to the total. */
export function splitEvenly(totalCents: number, memberIds: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const n = memberIds.length;
  if (n === 0 || totalCents < 0) return out;
  const base = Math.floor(totalCents / n);
  let remainder = totalCents - base * n;
  for (const id of memberIds) {
    const extra = remainder > 0 ? 1 : 0;
    out.set(id, base + extra);
    if (remainder > 0) remainder--;
  }
  return out;
}

export type SplitLike = { id: string; total_cents: number; paid_by: string | null };
export type ShareLike = { split_id: string; member_id: string; share_cents: number; settled: boolean };

/**
 * Net balance per member across all UNSETTLED shares.
 *   +ve = the family owes this member (they fronted more than their own share)
 *   -ve = this member owes the family
 * A member's own share of an expense they paid for nets to zero (excluded).
 */
export function memberBalances(splits: SplitLike[], shares: ShareLike[]): Map<string, number> {
  const payerBySplit = new Map(splits.map((s) => [s.id, s.paid_by]));
  const net = new Map<string, number>();
  const add = (id: string, amt: number) => net.set(id, (net.get(id) ?? 0) + amt);
  for (const sh of shares) {
    if (sh.settled) continue;
    const payer = payerBySplit.get(sh.split_id) ?? null;
    if (!payer || payer === sh.member_id) continue; // own share, nothing owed
    add(sh.member_id, -sh.share_cents); // debtor owes
    add(payer, sh.share_cents);          // payer is owed
  }
  return net;
}

export type Transfer = { from: string; to: string; cents: number };

/** Greedy minimal-transfer settlement from a net-balance map. */
export function settlementSuggestions(net: Map<string, number>): Transfer[] {
  const debtors: Array<[string, number]> = [];
  const creditors: Array<[string, number]> = [];
  for (const [id, bal] of net) {
    if (bal < 0) debtors.push([id, -bal]);
    else if (bal > 0) creditors.push([id, bal]);
  }
  debtors.sort((a, b) => b[1] - a[1]);
  creditors.sort((a, b) => b[1] - a[1]);
  const transfers: Transfer[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i][1], creditors[j][1]);
    if (pay > 0) transfers.push({ from: debtors[i][0], to: creditors[j][0], cents: pay });
    debtors[i][1] -= pay;
    creditors[j][1] -= pay;
    if (debtors[i][1] === 0) i++;
    if (creditors[j][1] === 0) j++;
  }
  return transfers;
}

/** Outstanding (unsettled) total a single member owes others. */
export function owedByMember(memberId: string, net: Map<string, number>): number {
  const bal = net.get(memberId) ?? 0;
  return bal < 0 ? -bal : 0;
}

export function summarizeSplits(splits: SplitLike[], shares: ShareLike[]) {
  const total = splits.reduce((s, x) => s + x.total_cents, 0);
  const unsettled = shares.filter((s) => !s.settled).reduce((s, x) => s + x.share_cents, 0);
  return { count: splits.length, totalCents: total, unsettledCents: unsettled };
}
