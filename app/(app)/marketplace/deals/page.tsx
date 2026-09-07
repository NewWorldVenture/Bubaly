import type { Metadata } from 'next';
import Link from 'next/link';
import { Tag, Flame } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { ListingImage } from '@/components/marketplace/listing-image';
import { ErrorState } from '@/components/ui/states';
import {
  priceBand, assessPrice, dealLabel, discountVsMedianPercent, isDeal, type Comp,
} from '@/lib/marketplace/price-coach';
import { cn } from '@/lib/utils/cn';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Deals · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="module-page space-y-4">
      <PageHeader title={t('deals.deals')} description={t('deals.dealDiscoveryIsTemporarilyUnavailable')} />
      <ErrorState message={t('deals.couldNotLoadMarketplaceDeals')} />
      <Link href="/marketplace/deals" className="text-sm font-medium text-brand-text underline">{t('deals.refreshDeals')}</Link>
    </div>
  );
}

type Row = { id: string; title: string; photo_url: string | null; category: string; condition: string | null; price_cents: number };

/** Deals feed — reachable, available sale listings priced at or below their
 *  category's comp band, ranked by how far below the median they sit. Turns the
 *  Price Coach from a per-item check into a discovery surface. */
export default async function DealsPage() {
  const t = await getTranslations();
  await requireUserContext();
  const sb = await createServer();

  const { data, error } = await sb
    .from('marketplace_listings')
    .select('id, title, photo_url, category, condition, price_cents')
    .eq('kind', 'sell').eq('status', 'available').gt('price_cents', 0)
    .order('created_at', { ascending: false })
    .limit(400);
  if (error) {
    console.error('[marketplace-deals] listing read failed', error);
    return <ReadFailure />;
  }

  const rows = (data ?? []) as Row[];

  // Comps per category = all reachable sale listings in that category.
  const compsByCat = new Map<string, Comp[]>();
  for (const r of rows) {
    const list = compsByCat.get(r.category) ?? [];
    list.push({ category: r.category, condition: r.condition, priceCents: r.price_cents, kind: 'sell' });
    compsByCat.set(r.category, list);
  }

  type Deal = Row & { discount: number; verdict: ReturnType<typeof dealLabel>; low: number; high: number };
  const deals: Deal[] = [];
  for (const r of rows) {
    const band = priceBand(r.category, r.condition, compsByCat.get(r.category) ?? []);
    if (!band || !isDeal(r.price_cents, band)) continue;
    deals.push({
      ...r, discount: discountVsMedianPercent(r.price_cents, band),
      verdict: dealLabel(assessPrice(r.price_cents, band)),
      low: band.lowCents, high: band.highCents,
    });
  }
  deals.sort((a, b) => b.discount - a.discount);

  return (
    <div className="module-page">
      <PageHeader title={t('marketplaceDeals.deals')} description={t('deals.itemsPricedBelowWhatSimilar')} />

      {deals.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-10 text-center">
          <Tag className="mx-auto h-8 w-8 text-muted/40" />
          <p className="mt-3 text-sm font-semibold">{t('marketplaceDeals.noStandoutDealsRightNow')}</p>
          <p className="mt-1 text-sm text-muted">{t('marketplaceDeals.whenSomethingIsListedBelowIts')}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {deals.map((d) => (
            <Link key={d.id} href={`/marketplace/item/${d.id}`}
              className="group overflow-hidden rounded-2xl border border-border bg-surface/40 transition hover:border-brand/40">
              <div className="relative aspect-square">
                <ListingImage src={d.photo_url} alt={d.title} className="h-full w-full object-cover"
                  fallback={<div className="flex h-full w-full items-center justify-center bg-elevated"><Tag className="h-8 w-8 text-muted/40" /></div>} />
                {d.discount > 0 && (
                  <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-rose-500/90 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur">
                    <Flame className="h-2.5 w-2.5" /> {d.discount}% under
                  </span>
                )}
              </div>
              <div className="p-3">
                <p className="truncate text-sm font-semibold">{d.title}</p>
                <div className="mt-1 flex items-baseline justify-between">
                  <span className="text-base font-bold tabular-nums">{money(d.price_cents)}</span>
                  {d.verdict && (
                    <span className={cn('text-[10px] font-bold',
                      d.verdict.tone === 'ok' ? 'text-emerald-500' : 'text-sky-500')}>{d.verdict.text}</span>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] text-muted">Similar: ${Math.round(d.low / 100)}–${Math.round(d.high / 100)}</p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
