import type { Metadata } from 'next';
import Link from 'next/link';
import { Send, Plus } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Campaigns', robots: { index: false } };
export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, 'neutral' | 'brand' | 'success' | 'warning'> = {
  draft: 'neutral', scheduled: 'warning', active: 'success', paused: 'warning', completed: 'brand', archived: 'neutral',
};

export default async function CampaignsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data: campaigns, error: campaignsError } = await supabase.from('marketing_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false });
  if (campaignsError) {
    console.error('[admin-marketing-campaigns] campaign read failed', campaignsError);
    return <AdminCampaignsReadError />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">{(campaigns ?? []).length} campaign{(campaigns ?? []).length === 1 ? '' : 's'}</p>
        <Link href="/admin/marketing/campaigns/new" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90">
          <Plus className="h-4 w-4" /> {t('adminMarketingCampaigns.newCampaign')}
        </Link>
      </div>

      {(campaigns ?? []).length === 0 ? (
        <EmptyState icon={Send} title={t('adminMarketingCampaigns.noCampaignsYet')} description={t('campaigns.createYourFirstMarketingCampaign')} />
      ) : (
        <div className="space-y-3">
          {(campaigns ?? []).map((c) => (
            <Link key={c.id} href={`/admin/marketing/campaigns/${c.id}`}>
              <Card className="flex items-center justify-between gap-4 transition hover:border-brand/40">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-semibold">{c.name}</p>
                    <Badge tone={STATUS_TONE[c.status] ?? 'neutral'} className="capitalize">{c.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted">
                    <span className="capitalize">{c.channel}</span> · <span className="capitalize">{c.type.replace('_', ' ')}</span>
                    {c.starts_at ? ` · starts ${fmtDate(c.starts_at)}` : ''}
                  </p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <p className="font-semibold">{c.budget_cents > 0 ? fmtMoney(c.budget_cents) : '—'}</p>
                  <p className="text-xs text-muted">budget</p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

async function AdminCampaignsReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('campaigns.marketingCampaigns')}</h1>
        <p className="mt-1 text-sm text-muted">{t('campaigns.planAndMonitorLifecycleCampaigns')}</p>
      </div>
      <ErrorState message={t('campaigns.couldNotLoadMarketingCampaigns')} />
      <Link href="/admin/marketing/campaigns" className="text-sm font-medium text-brand-text underline">{t('campaigns.refreshCampaigns')}</Link>
    </div>
  );
}
