import type { Metadata } from 'next';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { createCampaign } from '../../actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · New Campaign', robots: { index: false } };
export const dynamic = 'force-dynamic';

async function ReadFailure() {
  const tr = await getTranslations();
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <Link href="/admin/marketing/campaigns" className="text-sm text-muted hover:text-fg">&lt;- Back to campaigns</Link>
      <ErrorState message={tr('new.couldNotLoadCampaignSegments')} />
      <Link href="/admin/marketing/campaigns/new" className="text-sm font-medium text-brand-text underline">{tr('new.refreshCampaignForm')}</Link>
    </div>
  );
}

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const CHANNELS = ['email', 'sms', 'social', 'ads', 'seo', 'aeo', 'content', 'referral', 'multi'];
const TYPES = ['campaign', 'launch', 're_engagement', 'win_back', 'referral', 'fundraising', 'retargeting'];

export default async function NewCampaignPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  const { data: segments, error } = await supabase.from('marketing_segments').select('id, name').is('deleted_at', null).order('name');
  if (error) {
    console.error('[admin-marketing-campaign-new] segment read failed', error);
    return <ReadFailure />;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/admin/marketing/campaigns" className="text-sm text-muted hover:text-fg">{tr('adminMarketingCampaignsNew.backToCampaigns')}</Link>
      <Card className="mt-3">
        <h2 className="mb-4 text-lg font-bold">{tr('adminMarketingCampaignsNew.newCampaign')}</h2>
        <form action={createCampaign} className="space-y-4 text-sm">
          <label className="block">{tr('adminMarketingCampaignsNew.name')}<span className="text-danger">*</span>
            <input name="name" required placeholder={tr('adminMarketingCampaignsNew.springWinBack')} className={`mt-1 ${inputCls}`} />
          </label>
          <label className="block">{tr('adminMarketingCampaignsNew.objective')}
            <input name="objective" placeholder={tr('adminMarketingCampaignsNew.reActivateLapsedFamilies')} className={`mt-1 ${inputCls}`} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">{tr('adminMarketingCampaignsNew.channel')}
              <select name="channel" className={`mt-1 ${inputCls}`}>{CHANNELS.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}</select>
            </label>
            <label className="block">{tr('adminMarketingCampaignsNew.type')}
              <select name="type" className={`mt-1 ${inputCls}`}>{TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select>
            </label>
          </div>
          <label className="block">{tr('adminMarketingCampaignsNew.audienceSegment')}
            <select name="segment_id" className={`mt-1 ${inputCls}`}>
              <option value="">{tr('adminMarketingCampaignsNew.noSegment')}</option>
              {(segments ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">{tr('adminMarketingCampaignsNew.budget')}
              <input name="budgetDollars" type="number" min="0" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="block">{tr('adminMarketingCampaignsNew.starts')}
              <input name="starts_at" type="date" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="block">{tr('adminMarketingCampaignsNew.ends')}
              <input name="ends_at" type="date" className={`mt-1 ${inputCls}`} />
            </label>
          </div>
          <label className="block">{tr('adminMarketingCampaignsNew.notes')}
            <textarea name="notes" rows={3} className="mt-1 w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          </label>
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{tr('adminMarketingCampaignsNew.createCampaign')}</button>
        </form>
      </Card>
    </div>
  );
}
