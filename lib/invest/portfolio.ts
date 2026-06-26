// lib/invest/portfolio.ts — EDUCATIONAL investing math. PURE + tested.
//
// Powers the kids' simulated investing screen. Everything is computed from
// holdings (shares + avg cost) and a current price map. No real money, no real
// securities, no promised returns — this is a teaching tool (compound growth,
// diversification, gain/loss). All money values are integer cents.

export type Holding = { assetId: string; shares: number; avgCostCents: number };
export type PriceMap = Record<string, number>; // assetId -> current price (cents/share)

/** Current value of a position (cents). */
export function positionValue(h: Holding, prices: PriceMap): number {
  const price = prices[h.assetId] ?? 0;
  return Math.round(h.shares * price);
}

/** What the child paid for a position (cents). */
export function positionCost(h: Holding): number {
  return Math.round(h.shares * h.avgCostCents);
}

/** Total portfolio value across all holdings (cents). */
export function portfolioValue(holdings: Holding[], prices: PriceMap): number {
  return (holdings ?? []).reduce((sum, h) => sum + positionValue(h, prices), 0);
}

/** Total amount invested (cost basis) across all holdings (cents). */
export function portfolioCost(holdings: Holding[]): number {
  return (holdings ?? []).reduce((sum, h) => sum + positionCost(h), 0);
}

/** Gain/loss in cents (value − cost). */
export function gainLossCents(holdings: Holding[], prices: PriceMap): number {
  return portfolioValue(holdings, prices) - portfolioCost(holdings);
}

/** Gain/loss as a percentage of cost. 0 when nothing invested. */
export function gainLossPct(holdings: Holding[], prices: PriceMap): number {
  const cost = portfolioCost(holdings);
  if (cost <= 0) return 0;
  return (gainLossCents(holdings, prices) / cost) * 100;
}

/** Per-asset share of the portfolio (assetId -> % of value), for the pie/teaching. */
export function allocationBreakdown(holdings: Holding[], prices: PriceMap): Record<string, number> {
  const total = portfolioValue(holdings, prices);
  const out: Record<string, number> = {};
  if (total <= 0) return out;
  for (const h of holdings) out[h.assetId] = (positionValue(h, prices) / total) * 100;
  return out;
}

/**
 * Compound-growth teaching projector: start with `principalCents`, add
 * `monthlyCents` every month, growing at `annualRatePct` for `years`. Returns the
 * projected ending value in cents. Educational only — not a prediction.
 */
export function projectGrowth(principalCents: number, monthlyCents: number, years: number, annualRatePct: number): number {
  const months = Math.max(0, Math.round(years * 12));
  const monthlyRate = annualRatePct / 100 / 12;
  let bal = Math.max(0, principalCents);
  for (let i = 0; i < months; i++) {
    bal = bal * (1 + monthlyRate) + Math.max(0, monthlyCents);
  }
  return Math.round(bal);
}

/** Shares you can afford for `budgetCents` at `priceCents` (4-dp, like the schema). */
export function sharesForBudget(budgetCents: number, priceCents: number): number {
  if (priceCents <= 0 || budgetCents <= 0) return 0;
  return Math.floor((budgetCents / priceCents) * 10000) / 10000;
}

/** Cost (cents) of buying `shares` at `priceCents`, rounded to whole cents. */
export function orderAmountCents(shares: number, priceCents: number): number {
  return Math.round(shares * priceCents);
}
