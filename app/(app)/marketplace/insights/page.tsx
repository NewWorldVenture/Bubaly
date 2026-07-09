import type { Metadata } from 'next';
import Link from 'next/link';
import { Activity, TrendingUp, Package, HelpCircle, Flame, Tag, ArrowRight } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { marketplaceInsights, type InsightListing } from '@/lib/marketplace/insights';
import { KIND_LABELS, CATEGORY_LABELS, formatCents, type ListingKind, type ListingCategory } from '@/lib/marketplace/listings';

export const metadata: Metadata = { title: 'Pulse · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const kindLabel = (k: string) => KIND_LABELS[k as ListingKind] ?? k;
const catLabel = (c: string) => CATEGORY_LABELS[c as ListingCategory] ?? c;

function Bar({ label, value, max, hint }: { label: string; value: number; max: number; hint?: string }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="w-28 shrink-0 truncate text-muted">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/10">
        <div className="h-full rounded-full bg-brand" style={{ width: `${max ? Math.round((value / max) * 100) : 0}%` }} />
      </div>
      <span className="w-16 shrink-0 text-right tabular-nums">{hint ?? value}</span>
    </div>
  );
}

function Tile({ icon: Icon, label, value }: { icon: typeof Activity; label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted"><Icon className="h-4 w-4" /> {label}</div>
      <p className="mt-1.5 text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

export default async function MarketplaceInsightsPage() {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;

  const [{ data: listings }, { data: saves }, { data: offers }] = await Promise.all([
    sb.from('marketplace_listings').select('id, title, kind, category, status, price_cents, member_id')
      .eq('family_id', familyId).limit(2000),
    sb.from('marketplace_saves').select('listing_id').eq('family_id', familyId).limit(5000),
    sb.from('marketplace_offers').select('listing_id, status').eq('family_id', familyId).limit(5000),
  ]);

  const rows = (listings ?? []) as (InsightListing & { title: string })[];
  const titleOf = new Map(rows.map((l) => [l.id, l.title]));
  const savesByListing = new Map<string, number>();
  for (const s of saves ?? []) savesByListing.set(s.listing_id, (savesByListing.get(s.listing_id) ?? 0) + 1);
  const offersByListing = new Map<string, number>();
  for (const o of offers ?? []) if (o.status === 'open') offersByListing.set(o.listing_id, (offersByListing.get(o.listing_id) ?? 0) + 1);

  const ins = marketplaceInsights({ listings: rows, savesByListing, offersByListing });
  const maxKind = Math.max(1, ...ins.byKind.map((k) => k.count));

  return (
    <div className="space-y-6">
      <PageHeader title="Marketplace Pulse" description="The state of your family's board — supply, demand, prices, and what's hot right now." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile icon={Package} label="Active listings" value={ins.totalActive} />
        <Tile icon={HelpCircle} label="Open requests" value={ins.totalWanted} />
        <Tile icon={Tag} label="Categories" value={ins.categories.length} />
        <Tile icon={TrendingUp} label="Demand gaps" value={ins.demandGaps.length} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Supply by type */}
        <section className="rounded-2xl border border-border bg-surface/30 p-4">
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Package className="h-4 w-4 text-brand" /> Supply by type</h2>
          {ins.byKind.length === 0 ? <p className="text-sm text-muted">No active listings yet.</p> : (
            <div className="space-y-2.5">
              {ins.byKind.map((k) => <Bar key={k.kind} label={kindLabel(k.kind)} value={k.count} max={maxKind} />)}
            </div>
          )}
        </section>

        {/* Demand gaps */}
        <section className="rounded-2xl border border-border bg-surface/30 p-4">
          <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-brand" /> Where demand outruns supply</h2>
          {ins.demandGaps.length === 0 ? (
            <p className="text-sm text-muted">Supply is keeping up with requests — nice and balanced.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {ins.demandGaps.slice(0, 6).map((c) => (
                <li key={c.category} className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
                  <span className="font-medium">{catLabel(c.category)}</span>
                  <span className="text-xs text-amber-300">{c.wanted} wanted · {c.activeSupply} available</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Price benchmarks */}
      <section className="rounded-2xl border border-border bg-surface/30 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Tag className="h-4 w-4 text-brand" /> Price benchmarks (for sale)</h2>
        {ins.prices.length === 0 ? <p className="text-sm text-muted">No priced listings yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-left text-sm">
              <thead className="border-b border-border text-[11px] uppercase tracking-wide text-muted">
                <tr><th className="py-2 font-medium">Category</th><th className="py-2 font-medium">Listings</th><th className="py-2 font-medium">Median</th><th className="py-2 font-medium">Average</th></tr>
              </thead>
              <tbody>
                {ins.prices.map((p) => (
                  <tr key={p.category} className="border-b border-border/50 last:border-0">
                    <td className="py-2 font-medium">{catLabel(p.category)}</td>
                    <td className="py-2 tabular-nums text-muted">{p.count}</td>
                    <td className="py-2 tabular-nums">{formatCents(p.medianCents)}</td>
                    <td className="py-2 tabular-nums text-muted">{formatCents(p.avgCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Hot right now */}
      <section className="rounded-2xl border border-border bg-surface/30 p-4">
        <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Flame className="h-4 w-4 text-brand" /> Hot right now</h2>
        {ins.hot.length === 0 ? <p className="text-sm text-muted">No engagement yet — saves and offers surface the hottest items here.</p> : (
          <ul className="space-y-2">
            {ins.hot.map((h) => (
              <li key={h.listingId}>
                <Link href={`/marketplace/item/${h.listingId}`} className="flex items-center gap-3 rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm transition hover:border-brand/40">
                  <Flame className="h-4 w-4 shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1 truncate font-medium">{titleOf.get(h.listingId) ?? 'Listing'}</span>
                  <span className="shrink-0 text-xs text-muted">{h.saves} ♥ · {h.offers} offers</span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
