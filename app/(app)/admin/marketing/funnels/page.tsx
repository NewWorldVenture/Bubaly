import type { Metadata } from 'next';
import { Filter } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { createFunnel } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Funnels', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function FunnelsPage() {
  const supabase = createServiceClient();
  const { data: funnels } = await supabase.from('marketing_funnels').select('*').is('deleted_at', null).order('created_at', { ascending: false });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {(funnels ?? []).length === 0 ? (
          <EmptyState icon={Filter} title="No funnels yet" description="Define your first funnel on the right." />
        ) : (
          (funnels ?? []).map((f) => {
            const steps = Array.isArray(f.steps) ? f.steps as { label: string }[] : [];
            return (
              <Card key={f.id}>
                <p className="font-semibold">{f.name}</p>
                <ol className="mt-3 space-y-2">
                  {steps.map((s, i) => (
                    <li key={i} className="flex items-center gap-3 text-sm">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-semibold text-brand-text">{i + 1}</span>
                      {s.label}
                    </li>
                  ))}
                </ol>
              </Card>
            );
          })
        )}
      </div>
      <Card className="h-fit">
        <h2 className="mb-3 font-semibold">New funnel</h2>
        <form action={createFunnel} className="space-y-3 text-sm">
          <input name="name" required placeholder="Funnel name" className={inputCls} />
          <textarea name="steps" rows={5} placeholder="One step per line, e.g.&#10;Landing page&#10;Sign up&#10;Onboarding&#10;Subscribe" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Create funnel</button>
        </form>
      </Card>
    </div>
  );
}
