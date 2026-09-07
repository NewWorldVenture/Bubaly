import type { Metadata } from 'next';
import { Target } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtMoney } from '@/lib/utils/format';
import { createAdCampaign } from '../actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Ads', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const PLATFORMS = ['meta', 'google', 'linkedin', 'tiktok', 'x'];

export default async function AdsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data: ads, error: adsError } = await supabase.from('marketing_ad_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false });
  if (adsError) {
    console.error('[admin-marketing-ads] campaign read failed', adsError);
    return <AdminAdsReadError />;
  }

  const totalBudget = (ads ?? []).reduce((s, a) => s + (a.budget_cents ?? 0), 0);
  const totalSpend = (ads ?? []).reduce((s, a) => s + (a.spend_cents ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">{t('ads.planPaidCampaignsAndTrack')}</div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card><p className="text-xs text-muted">{t('adminMarketingAds.campaigns')}</p><p className="text-2xl font-bold">{(ads ?? []).length}</p></Card>
        <Card><p className="text-xs text-muted">{t('adminMarketingAds.totalBudget')}</p><p className="text-2xl font-bold">{fmtMoney(totalBudget)}</p></Card>
        <Card><p className="text-xs text-muted">{t('adminMarketingAds.totalSpend')}</p><p className="text-2xl font-bold">{fmtMoney(totalSpend)}</p></Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {(ads ?? []).length === 0 ? (
            <EmptyState icon={Target} title={t('adminMarketingAds.noAdCampaignsYet')} description={t('ads.planYourFirstAdCampaign')} />
          ) : (
            (ads ?? []).map((a) => (
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
        </div>
        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">{t('adminMarketingAds.newAdCampaign')}</h2>
          <form action={createAdCampaign} className="space-y-3 text-sm">
            <input name="name" required placeholder={t('adminMarketingAds.campaignName')} className={inputCls} />
            <select name="platform" className={inputCls}>{PLATFORMS.map((p) => <option key={p} value={p} className="capitalize">{p}</option>)}</select>
            <input name="objective" placeholder={t('adminMarketingAds.objectiveEGSignups')} className={inputCls} />
            <input name="budgetDollars" type="number" min="0" placeholder={t('adminMarketingAds.budget')} className={inputCls} />
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{t('adminMarketingAds.create')}</button>
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
