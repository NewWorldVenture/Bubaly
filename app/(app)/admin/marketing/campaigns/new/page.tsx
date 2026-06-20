import type { Metadata } from 'next';
import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { createCampaign } from '../../actions';

export const metadata: Metadata = { title: 'Marketing · New Campaign', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const CHANNELS = ['email', 'sms', 'social', 'ads', 'seo', 'aeo', 'content', 'referral', 'multi'];
const TYPES = ['campaign', 'launch', 're_engagement', 'win_back', 'referral', 'fundraising', 'retargeting'];

export default async function NewCampaignPage() {
  const supabase = createServiceClient();
  const { data: segments } = await supabase.from('marketing_segments').select('id, name').is('deleted_at', null).order('name');

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/admin/marketing/campaigns" className="text-sm text-muted hover:text-fg">← Back to campaigns</Link>
      <Card className="mt-3">
        <h2 className="mb-4 text-lg font-bold">New campaign</h2>
        <form action={createCampaign} className="space-y-4 text-sm">
          <label className="block">Name<span className="text-danger">*</span>
            <input name="name" required placeholder="Spring win-back" className={`mt-1 ${inputCls}`} />
          </label>
          <label className="block">Objective
            <input name="objective" placeholder="Re-activate lapsed families" className={`mt-1 ${inputCls}`} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">Channel
              <select name="channel" className={`mt-1 ${inputCls}`}>{CHANNELS.map((c) => <option key={c} value={c} className="capitalize">{c}</option>)}</select>
            </label>
            <label className="block">Type
              <select name="type" className={`mt-1 ${inputCls}`}>{TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select>
            </label>
          </div>
          <label className="block">Audience segment
            <select name="segment_id" className={`mt-1 ${inputCls}`}>
              <option value="">No segment</option>
              {(segments ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-3 gap-3">
            <label className="block">Budget ($)
              <input name="budgetDollars" type="number" min="0" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="block">Starts
              <input name="starts_at" type="date" className={`mt-1 ${inputCls}`} />
            </label>
            <label className="block">Ends
              <input name="ends_at" type="date" className={`mt-1 ${inputCls}`} />
            </label>
          </div>
          <label className="block">Notes
            <textarea name="notes" rows={3} className="mt-1 w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          </label>
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Create campaign</button>
        </form>
      </Card>
    </div>
  );
}
