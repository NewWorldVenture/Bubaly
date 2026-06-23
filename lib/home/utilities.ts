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

// ── Savings analysis (pure, never fabricates — only states facts from data) ────

/** Annualised run-rate: current monthly total × 12. */
export function annualTotalCents(bills: BillLike[]): number {
  return monthlyTotalCents(bills) * 12;
}

/**
 * Average of every bill for a kind EXCEPT the latest — the "typical" baseline
 * the latest bill is compared against. Null if fewer than 3 readings (not
 * enough history to call something a spike honestly).
 */
export function trailingAvgCents(bills: BillLike[], kind: string): number | null {
  const series = trendForKind(bills, kind);
  if (series.length < 3) return null;
  const prior = series.slice(0, -1);
  const sum = prior.reduce((s, b) => s + b.amount_cents, 0);
  return Math.round(sum / prior.length);
}

/** Percent the latest bill sits ABOVE the trailing average (null if not enough data or not above). */
export function spikePct(bills: BillLike[], kind: string): number | null {
  const baseline = trailingAvgCents(bills, kind);
  if (baseline === null || baseline === 0) return null;
  const series = trendForKind(bills, kind);
  const latest = series[series.length - 1].amount_cents;
  const pct = Math.round(((latest - baseline) / baseline) * 100);
  return pct > 0 ? pct : null;
}

export type UtilitySummary = {
  monthlyTotalCents: number;
  annualTotalCents: number;
  perKind: {
    kind: string;
    latestCents: number;
    months: number;
    deltaPct: number | null;
    spikePct: number | null;
    baselineCents: number | null;
  }[];
  topCostKind: string | null;
  biggestMover: { kind: string; deltaPct: number } | null;
};

/** Roll up the household's utility picture for grounding the AI and the UI. */
export function summarizeUtilities(bills: BillLike[]): UtilitySummary {
  const latest = latestByKind(bills);
  const perKind = [...latest.values()]
    .map((b) => ({
      kind: b.kind,
      latestCents: b.amount_cents,
      months: trendForKind(bills, b.kind).length,
      deltaPct: deltaPct(bills, b.kind),
      spikePct: spikePct(bills, b.kind),
      baselineCents: trailingAvgCents(bills, b.kind),
    }))
    .sort((a, b) => b.latestCents - a.latestCents);

  let biggestMover: { kind: string; deltaPct: number } | null = null;
  for (const k of perKind) {
    if (k.deltaPct == null) continue;
    if (!biggestMover || Math.abs(k.deltaPct) > Math.abs(biggestMover.deltaPct)) {
      biggestMover = { kind: k.kind, deltaPct: k.deltaPct };
    }
  }

  return {
    monthlyTotalCents: monthlyTotalCents(bills),
    annualTotalCents: annualTotalCents(bills),
    perKind,
    topCostKind: perKind[0]?.kind ?? null,
    biggestMover,
  };
}

export type SavingsFinding = {
  kind: string;
  severity: 'high' | 'medium' | 'info';
  title: string;
  detail: string;
};

/**
 * Deterministic, data-grounded savings findings — computed with zero AI so the
 * feature still delivers value (and never fabricates a number) when the model
 * is unconfigured. Every finding restates a fact already in the bill history.
 */
export function deterministicSavingsFindings(bills: BillLike[]): SavingsFinding[] {
  const summary = summarizeUtilities(bills);
  const findings: SavingsFinding[] = [];

  // 1. Real spikes vs the household's own typical spend (needs ≥3 months).
  for (const k of summary.perKind) {
    if (k.spikePct != null && k.spikePct >= 15 && k.baselineCents != null) {
      findings.push({
        kind: k.kind,
        severity: k.spikePct >= 40 ? 'high' : 'medium',
        title: `${utilityLabel(k.kind)} is ${k.spikePct}% above your typical bill`,
        detail: `Latest ${usd(k.latestCents)} vs your usual ${usd(k.baselineCents)}. Worth checking usage, a rate change, or a leak/fault.`,
      });
    }
  }

  // 2. Sharp month-over-month jumps not already flagged as a spike.
  for (const k of summary.perKind) {
    const alreadyFlagged = findings.some((f) => f.kind === k.kind);
    if (!alreadyFlagged && k.deltaPct != null && k.deltaPct >= 25) {
      findings.push({
        kind: k.kind,
        severity: 'medium',
        title: `${utilityLabel(k.kind)} rose ${k.deltaPct}% since last month`,
        detail: `Now ${usd(k.latestCents)}. A jump this size is usually seasonal use or a price increase — confirm which.`,
      });
    }
  }

  // 3. Largest line item — where a percentage saving is worth the most.
  if (summary.topCostKind) {
    const top = summary.perKind.find((k) => k.kind === summary.topCostKind)!;
    if (!findings.some((f) => f.kind === top.kind)) {
      findings.push({
        kind: top.kind,
        severity: 'info',
        title: `${utilityLabel(top.kind)} is your largest utility at ${usd(top.latestCents)}/mo`,
        detail: `That's about ${usd(top.latestCents * 12)}/yr — the best place to focus efficiency upgrades or shopping for a better rate.`,
      });
    }
  }

  return findings;
}
