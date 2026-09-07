import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, BellRing, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SaveButton } from '@/components/marketplace/save-button';
import { AlertComposer } from '@/components/marketplace/alert-composer';
import { AlertActions } from '@/components/marketplace/alert-actions';
import {
  matchesForSearch, countNewSince, describeSearch, type MatchableListing,
} from '@/lib/marketplace/saved-search';
import {
  KIND_LABELS, CATEGORY_LABELS, priceLabel, type ListingKind, type RentPeriod,
} from '@/lib/marketplace/listings';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Alerts · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MarketplaceAlertsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const meId = ctx.active.member.id;
  const dataWarnings: string[] = [];

  const [{ data: searches, error: searchesError }, { data: listings, error: listingsError }, { data: saves, error: savesError }] = await Promise.all([
    sb.from('marketplace_saved_searches')
      .select('id, label, query, kind, category, max_price_cents, last_seen_at, created_at')
      .eq('family_id', familyId).eq('member_id', meId).order('created_at', { ascending: false }),
    sb.from('marketplace_listings')
      .select('id, title, description, kind, category, price_cents, rent_period, status, created_at, member_id')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(400),
    sb.from('marketplace_saves').select('listing_id').eq('family_id', familyId).eq('member_id', meId),
  ]);

  if (searchesError) {
    console.error('[marketplace-alerts] Saved searches read failed', searchesError);
    return <ErrorState message="Could not load your marketplace alerts. Refresh and try again." />;
  }
  if (listingsError) {
    console.error('[marketplace-alerts] Matching listings read failed', listingsError);
    dataWarnings.push('Matching listings');
  }
  if (savesError) {
    console.error('[marketplace-alerts] Saved listings read failed', savesError);
    dataWarnings.push('Saved listings');
  }

  const candidates = (listings ?? []) as (MatchableListing & { rent_period: string | null })[];
  const savedIds = new Set((saves ?? []).map((s) => s.listing_id));
  const rows = searches ?? [];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('marketplaceAlerts.alerts')}
        description="Tell Bubaly what you’re after — we’ll match new listings the moment they hit the board."
      />

      {dataWarnings.length > 0 && (
        <div role="status" aria-label={t('marketplaceAlerts.marketplaceAlertsDataHealth')} className="mb-4 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{t('marketplaceAlerts.someAlertDetailsAreTemporarilyUnavailable')} {dataWarnings.join(', ')}.</p>
        </div>
      )}

      <AlertComposer />

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          <BellRing className="mx-auto mb-2 h-6 w-6" />
          {t('marketplaceAlerts.noAlertsYetCreateOneAbove')}
        </div>
      ) : (
        <div className="space-y-6">
          {rows.map((s) => {
            const criteria = { query: s.query, kind: s.kind, category: s.category, maxPriceCents: s.max_price_cents };
            const matches = matchesForSearch(candidates, criteria, meId);
            const newCount = countNewSince(candidates, criteria, s.last_seen_at, meId);
            return (
              <section key={s.id} className="rounded-2xl border border-border bg-surface/30 p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="flex items-center gap-1.5 font-semibold">
                        <BellRing className="h-4 w-4 text-brand-text" />
                        {s.label?.trim() || describeSearch(criteria, KIND_LABELS, CATEGORY_LABELS)}
                      </h2>
                      {newCount > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[11px] font-semibold text-brand-text">
                          <Sparkles className="h-3 w-3" /> {newCount} new
                        </span>
                      )}
                    </div>
                    {s.label?.trim() && <p className="mt-0.5 text-xs text-muted">{describeSearch(criteria, KIND_LABELS, CATEGORY_LABELS)}</p>}
                    <p className="mt-0.5 text-xs text-muted">{matches.length} match{matches.length === 1 ? '' : 'es'} on the board</p>
                  </div>
                  <AlertActions id={s.id} newCount={newCount} />
                </div>

                {matches.length === 0 ? (
                  <p className="text-sm text-muted">{t('alerts.nothingMatchesYetWeLl')}</p>
                ) : (
                  <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {matches.slice(0, 12).map((l) => {
                      const isNew = l.created_at > s.last_seen_at;
                      const rentPeriod = (candidates.find((c) => c.id === l.id)?.rent_period ?? null) as RentPeriod | null;
                      const price = priceLabel(l.kind as ListingKind, l.price_cents, rentPeriod);
                      return (
                        <li key={l.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/60 p-3.5">
                          <div className="min-w-0 flex-1">
                            <Link href={`/marketplace/item/${l.id}`} className="line-clamp-2 text-sm font-medium hover:text-brand-text">
                              {l.title}
                              {isNew && <span className="ml-1.5 rounded bg-brand/15 px-1 py-0.5 text-[10px] font-semibold text-brand-text align-middle">NEW</span>}
                            </Link>
                            <p className="mt-1 text-xs text-muted">
                              {KIND_LABELS[l.kind as ListingKind] ?? l.kind}
                              {price && ` · ${price}`}
                              {` · ${CATEGORY_LABELS[l.category as keyof typeof CATEGORY_LABELS] ?? l.category}`}
                            </p>
                          </div>
                          <SaveButton listingId={l.id} saved={savedIds.has(l.id)} />
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
