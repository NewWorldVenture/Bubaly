import type { Metadata } from 'next';
import { Target } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { settle, settleAll } from '@/lib/supabase/settle';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtMoney } from '@/lib/utils/format';
import { createAdCampaign } from '../actions';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export const metadata: Metadata = { title: 'Marketing · Ads', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const PLATFORMS = ['meta', 'google', 'linkedin', 'tiktok', 'x'];
/** Rows the summed campaign read may page through before it is reported as a prefix (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;
/** Past that ceiling the list is the newest this many campaigns, and says so. */
const LIST_SHOWN = 500;

export default async function AdsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // The total budget and total spend are summed from these rows, so they are
  // read to a real ceiling: an unbounded select is answered with at most
  // `db-max-rows` (1,000) and no error. The campaign count is an exact
  // `head: true` count.
  //
  // It pages on the id, not on offsets. Paged newest first, a campaign created
  // between two pages landed at offset 0 and pushed the last row of the first
  // page onto the second, so that campaign's budget and spend were added twice.
  // On `id > last` no write between pages brings a row back; the list is put
  // newest first in memory instead.
  //
  // Reaching the ceiling costs the two totals, not the page (review
  // R4-SIB-MARKETING-CAMPAIGN-CEILINGS): it was an error that took the list
  // and the New ad campaign form to the read-error state with it. The read
  // keeps its prefix (failOnMax: false) only to know it was cut short; it is
  // not summed then, the totals say they are not shown, and the list is a
  // newest-first page of its own. Any failure is still the read-error state.
  const [adsResult, countResult] = await settleAll([
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('marketing_ad_campaigns').select('*').is('deleted_at', null);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING, failOnMax: false }),
    supabase.from('marketing_ad_campaigns').select('id', { count: 'exact', head: true }).is('deleted_at', null),
  ]);
  const { data: adRows, error: adsError } = adsResult;
  const totalsCeiling = 'truncated' in adsResult && adsResult.truncated;
  const newestResult = totalsCeiling
    ? await settle(supabase.from('marketing_ad_campaigns').select('*').is('deleted_at', null)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(LIST_SHOWN))
    : null;
  const readError = adsError ?? countResult.error ?? newestResult?.error;
  if (readError) {
    console.error('[admin-marketing-ads] campaign read failed', readError);
    return <AdminAdsReadError />;
  }
  if (totalsCeiling) console.warn('[admin-marketing-ads] the campaign read reached its ceiling; the totals are not shown');
  const ads = totalsCeiling
    ? newestResult?.data ?? []
    : [...(adRows ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));

  const totalBudget = ads.reduce((s, a) => s + (a.budget_cents ?? 0), 0);
  const totalSpend = ads.reduce((s, a) => s + (a.spend_cents ?? 0), 0);
  const unavailable = t('strategyMetrics.unavailable');

  return (
    <div className="space-y-4">
      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={totalsCeiling ? [t('adminMarketingAds.totalBudget'), t('adminMarketingAds.totalSpend')] : []}
      />
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">{t('ads.planPaidCampaignsAndTrack')}</div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card><p className="text-xs text-muted">{t('adminMarketingAds.campaigns')}</p><p className="text-2xl font-bold">{countResult.count ?? 0}</p></Card>
        <Card><p className="text-xs text-muted">{t('adminMarketingAds.totalBudget')}</p><p className="text-2xl font-bold">{totalsCeiling ? unavailable : fmtMoney(totalBudget)}</p></Card>
        <Card><p className="text-xs text-muted">{t('adminMarketingAds.totalSpend')}</p><p className="text-2xl font-bold">{totalsCeiling ? unavailable : fmtMoney(totalSpend)}</p></Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-3">
          {ads.length === 0 ? (
            <EmptyState icon={Target} title={t('adminMarketingAds.noAdCampaignsYet')} description={t('ads.planYourFirstAdCampaign')} />
          ) : (
            ads.map((a) => (
              <Card key={a.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-semibold">{a.name}</p>
                    <Badge tone="neutral" className="capitalize">{a.platform}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted">{a.objective ?? '—'} · {a.status}</p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <p className="font-semibold">{fmtMoney(a.budget_cents)}</p>
                  <p className="text-xs text-muted">budget</p>
                </div>
              </Card>
            ))
          )}
          {totalsCeiling && (
            <p className="text-center text-xs text-muted">{t('adminMarketingAds.theListIsTheNewest', { n: LIST_SHOWN.toLocaleString() })}</p>
          )}
        </div>
        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">{t('adminMarketingAds.newAdCampaign')}</h2>
          <form action={createAdCampaign} className="space-y-3 text-sm">
            <input name="name" required placeholder={t('adminMarketingAds.campaignName')} className={inputCls} />
            <select name="platform" aria-label={t('adminMarketingAds.platform')} className={inputCls}>{PLATFORMS.map((p) => <option key={p} value={p} className="capitalize">{p}</option>)}</select>
            <input name="objective" placeholder={t('adminMarketingAds.objectiveEGSignups')} className={inputCls} />
            <input name="budgetDollars" type="number" min="0" placeholder={t('adminMarketingAds.budget')} className={inputCls} />
            <SubmitButton className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:brightness-95">{t('adminMarketingAds.create')}</SubmitButton>
          </form>
        </Card>
      </div>
    </div>
  );
}

async function AdminAdsReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('ads.advertising')}</h1>
        <p className="mt-1 text-sm text-muted">{t('ads.planPaidCampaignsAndTrack2')}</p>
      </div>
      <ErrorState message={t('ads.couldNotLoadAdvertisingCampaigns')} />
      <a href="/admin/marketing/ads" className="text-sm font-medium text-brand-text underline">{t('ads.refreshAdvertising')}</a>
    </div>
  );
}
