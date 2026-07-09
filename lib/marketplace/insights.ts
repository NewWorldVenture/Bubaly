// lib/marketplace/insights.ts — "Marketplace Pulse" intelligence (pure, tested).
//
// A read-only, deterministic view of the board's health: what's in supply by
// kind, where demand (open `wanted` requests) outruns supply, price benchmarks
// per category, and the most-engaged listings. DB-free — the server feeds live
// rows; this does the math. Powers /marketplace/insights.

export type InsightListing = {
  id: string;
  kind: string;
  category: string;
  status: string;
  price_cents: number;
  member_id: string | null;
};

export type InsightsInput = {
  listings: InsightListing[];
  savesByListing?: Map<string, number>;
  offersByListing?: Map<string, number>;
};

export type KindCount = { kind: string; count: number };
export type CategoryStat = {
  category: string;
  activeSupply: number;   // available/pending, non-wanted
  wanted: number;         // active wanted requests
  demandIndex: number;    // wanted / max(activeSupply,1) — >1 = under-supplied
};
export type PriceStat = { category: string; count: number; medianCents: number; avgCents: number };
export type HotListing = { listingId: string; saves: number; offers: number; heat: number };

export type MarketplaceInsights = {
  totalActive: number;     // open supply listings
  totalWanted: number;     // open wanted requests
  byKind: KindCount[];     // open supply by kind, desc
  categories: CategoryStat[]; // supply/demand per category, most under-supplied first
  prices: PriceStat[];     // sell-price benchmarks per category, most-listed first
  hot: HotListing[];       // most-engaged open listings, top N
  demandGaps: CategoryStat[]; // categories where wanted > supply (opportunities)
};

const OPEN = new Set(['available', 'pending']);

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}
function mean(nums: number[]): number {
  return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0;
}

export function marketplaceInsights(input: InsightsInput, topN = 6): MarketplaceInsights {
  const saves = input.savesByListing ?? new Map<string, number>();
  const offers = input.offersByListing ?? new Map<string, number>();
  const open = input.listings.filter((l) => OPEN.has(l.status));
  const supply = open.filter((l) => l.kind !== 'wanted');
  const wanted = open.filter((l) => l.kind === 'wanted');

  // By kind (supply only).
  const kindMap = new Map<string, number>();
  for (const l of supply) kindMap.set(l.kind, (kindMap.get(l.kind) ?? 0) + 1);
  const byKind: KindCount[] = [...kindMap.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  // Supply/demand per category.
  const cats = new Set<string>([...supply, ...wanted].map((l) => l.category));
  const supplyByCat = new Map<string, number>();
  const wantedByCat = new Map<string, number>();
  for (const l of supply) supplyByCat.set(l.category, (supplyByCat.get(l.category) ?? 0) + 1);
  for (const l of wanted) wantedByCat.set(l.category, (wantedByCat.get(l.category) ?? 0) + 1);
  const categories: CategoryStat[] = [...cats]
    .map((category) => {
      const activeSupply = supplyByCat.get(category) ?? 0;
      const w = wantedByCat.get(category) ?? 0;
      return { category, activeSupply, wanted: w, demandIndex: Math.round((w / Math.max(activeSupply, 1)) * 100) / 100 };
    })
    .sort((a, b) => b.demandIndex - a.demandIndex || b.wanted - a.wanted || a.category.localeCompare(b.category));

  // Price benchmarks (sell listings with a real price).
  const priceByCat = new Map<string, number[]>();
  for (const l of supply) {
    if (l.kind === 'sell' && l.price_cents > 0) {
      const arr = priceByCat.get(l.category) ?? [];
      arr.push(l.price_cents);
      priceByCat.set(l.category, arr);
    }
  }
  const prices: PriceStat[] = [...priceByCat.entries()]
    .map(([category, arr]) => ({ category, count: arr.length, medianCents: median(arr), avgCents: mean(arr) }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));

  // Hot listings (engagement).
  const hot: HotListing[] = supply
    .map((l) => {
      const s = saves.get(l.id) ?? 0;
      const o = offers.get(l.id) ?? 0;
      return { listingId: l.id, saves: s, offers: o, heat: s * 2 + o * 3 };
    })
    .filter((h) => h.heat > 0)
    .sort((a, b) => b.heat - a.heat || a.listingId.localeCompare(b.listingId))
    .slice(0, topN);

  const demandGaps = categories.filter((c) => c.wanted > c.activeSupply && c.wanted > 0);

  return {
    totalActive: supply.length,
    totalWanted: wanted.length,
    byKind,
    categories,
    prices,
    hot,
    demandGaps,
  };
}
