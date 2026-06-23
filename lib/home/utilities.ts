// lib/home/utilities.ts — pure helpers for Utility Tracking. Latest-per-kind,
// monthly totals, trend and period-over-period delta. No Supabase/React.

export const UTILITY_KINDS = ['electric', 'gas', 'water', 'sewer', 'trash', 'internet', 'phone', 'cable', 'other'] as const;
export type UtilityKind = (typeof UTILITY_KINDS)[number];

export function utilityLabel(kind: string): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

export function usd(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export type BillLike = { kind: string; period_month: string; amount_cents: number };

/** Most recent bill per kind (by period_month). */
export function latestByKind<T extends BillLike>(bills: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const b of bills) {
    const cur = m.get(b.kind);
    if (!cur || b.period_month > cur.period_month) m.set(b.kind, b);
  }
  return m;
}

/** Sum of the latest bill across each kind — the household's current monthly run-rate. */
export function monthlyTotalCents(bills: BillLike[]): number {
  let sum = 0;
  for (const b of latestByKind(bills).values()) sum += b.amount_cents;
  return sum;
}

/** Chronological amount series for one kind (oldest→newest). */
export function trendForKind(bills: BillLike[], kind: string): BillLike[] {
  return bills.filter((b) => b.kind === kind).sort((a, b) => a.period_month.localeCompare(b.period_month));
}

/** Percent change of the latest vs previous bill for a kind (null if <2 bills). */
export function deltaPct(bills: BillLike[], kind: string): number | null {
  const series = trendForKind(bills, kind);
  if (series.length < 2) return null;
  const prev = series[series.length - 2].amount_cents;
  const cur = series[series.length - 1].amount_cents;
  if (prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}
