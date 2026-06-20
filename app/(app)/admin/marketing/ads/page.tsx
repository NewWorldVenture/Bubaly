import type { Metadata } from 'next';
import { Target } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { fmtMoney } from '@/lib/utils/format';
import { createAdCampaign } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Ads', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const PLATFORMS = ['meta', 'google', 'linkedin', 'tiktok', 'x'];

export default async function AdsPage() {
  const supabase = createServiceClient();
  const { data: ads } = await supabase.from('marketing_ad_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false });

  const totalBudget = (ads ?? []).reduce((s, a) => s + (a.budget_cents ?? 0), 0);
  const totalSpend = (ads ?? []).reduce((s, a) => s + (a.spend_cents ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        Plan paid campaigns and track budget/spend. Performance (spend, impressions, conversions) is entered manually or imported from the ad platform — never fabricated.
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card><p className="text-xs text-muted">Campaigns</p><p className="text-2xl font-bold">{(ads ?? []).length}</p></Card>
        <Card><p className="text-xs text-muted">Total budget</p><p className="text-2xl font-bold">{fmtMoney(totalBudget)}</p></Card>
        <Card><p className="text-xs text-muted">Total spend</p><p className="text-2xl font-bold">{fmtMoney(totalSpend)}</p></Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {(ads ?? []).length === 0 ? (
            <EmptyState icon={Target} title="No ad campaigns yet" description="Plan your first ad campaign on the right." />
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
          <h2 className="mb-3 font-semibold">New ad campaign</h2>
          <form action={createAdCampaign} className="space-y-3 text-sm">
            <input name="name" required placeholder="Campaign name" className={inputCls} />
            <select name="platform" className={inputCls}>{PLATFORMS.map((p) => <option key={p} value={p} className="capitalize">{p}</option>)}</select>
            <input name="objective" placeholder="Objective (e.g. signups)" className={inputCls} />
            <input name="budgetDollars" type="number" min="0" placeholder="Budget ($)" className={inputCls} />
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Create</button>
          </form>
        </Card>
      </div>
    </div>
  );
}
