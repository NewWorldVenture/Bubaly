import type { Metadata } from 'next';
import { Layers } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { PLANS } from '@/lib/constants/plans';
import { getMarketingCustomers, evaluateSegment, type SegmentRules } from '@/lib/marketing/customers';
import { createSegment, archiveSegment } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Segments', robots: { index: false } };
export const dynamic = 'force-dynamic';

const LIFECYCLES = ['new', 'active', 'lapsed', 'churned', 'free'] as const;
const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function SegmentsPage() {
  const supabase = createServiceClient();
  const [{ data: segments }, customers] = await Promise.all([
    supabase.from('marketing_segments').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    getMarketingCustomers(supabase),
  ]);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <p className="text-sm text-muted">Dynamic audiences recomputed live against your customer base.</p>
        {(segments ?? []).length === 0 ? (
          <EmptyState icon={Layers} title="No segments yet" description="Create your first audience on the right." />
        ) : (
          <div className="space-y-3">
            {(segments ?? []).map((s) => {
              const count = evaluateSegment(customers, (s.rules ?? {}) as SegmentRules).length;
              const rules = (s.rules ?? {}) as SegmentRules;
              return (
                <Card key={s.id} className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-semibold">{s.name}</p>
                      <Badge tone="brand">{count} matching</Badge>
                    </div>
                    {s.description && <p className="mt-1 text-sm text-muted">{s.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted">
                      {rules.lifecycle?.map((l) => <span key={l} className="rounded bg-elevated px-2 py-0.5 capitalize">{l}</span>)}
                      {rules.plans?.map((p) => <span key={p} className="rounded bg-elevated px-2 py-0.5">{p}</span>)}
                      {rules.minLtvCents ? <span className="rounded bg-elevated px-2 py-0.5">LTV ≥ ${(rules.minLtvCents / 100).toFixed(0)}</span> : null}
                      {rules.inactiveForDays ? <span className="rounded bg-elevated px-2 py-0.5">inactive {rules.inactiveForDays}d</span> : null}
                    </div>
                  </div>
                  <form action={archiveSegment}>
                    <input type="hidden" name="id" value={s.id} />
                    <button className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted hover:bg-elevated hover:text-danger">Archive</button>
                  </form>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Card className="h-fit">
        <h2 className="mb-3 font-semibold">New segment</h2>
        <form action={createSegment} className="space-y-3 text-sm">
          <input name="name" required placeholder="Segment name" className={inputCls} />
          <input name="description" placeholder="Description (optional)" className={inputCls} />
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Lifecycle</p>
            <div className="flex flex-wrap gap-2">
              {LIFECYCLES.map((l) => (
                <label key={l} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 capitalize">
                  <input type="checkbox" name="lifecycle" value={l} /> {l}
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Plans</p>
            <div className="flex flex-wrap gap-2">
              {PLANS.map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1">
                  <input type="checkbox" name="plans" value={p.id} /> {p.name}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted">Min est. LTV ($)
              <input name="minLtvDollars" type="number" min="0" className={inputCls} />
            </label>
            <label className="text-xs text-muted">Inactive for (days)
              <input name="inactiveForDays" type="number" min="0" className={inputCls} />
            </label>
          </div>
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand/90">Create segment</button>
        </form>
      </Card>
    </div>
  );
}
