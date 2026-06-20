import type { Metadata } from 'next';
import { ClipboardList } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/states';
import { createForm } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Forms', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function FormsPage() {
  const supabase = createServiceClient();
  const [{ data: forms }, { data: subs }] = await Promise.all([
    supabase.from('marketing_forms').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('marketing_form_submissions').select('form_id'),
  ]);
  const countByForm = new Map<string, number>();
  for (const s of subs ?? []) countByForm.set(s.form_id, (countByForm.get(s.form_id) ?? 0) + 1);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {(forms ?? []).length === 0 ? (
          <EmptyState icon={ClipboardList} title="No forms yet" description="Build a lead-capture form on the right." />
        ) : (
          (forms ?? []).map((f) => {
            const fields = Array.isArray(f.fields) ? f.fields as { label: string }[] : [];
            return (
              <Card key={f.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{f.name}</p>
                  <p className="mt-1 text-xs text-muted">{fields.map((x) => x.label).join(', ') || 'No fields'}</p>
                </div>
                <div className="shrink-0 text-right text-sm">
                  <p className="font-semibold">{countByForm.get(f.id) ?? 0}</p>
                  <p className="text-xs text-muted">submissions</p>
                </div>
              </Card>
            );
          })
        )}
        <p className="text-xs text-muted">
          Submissions write to <code>marketing_form_submissions</code> and can feed segments and automations.
        </p>
      </div>
      <Card className="h-fit">
        <h2 className="mb-3 font-semibold">New form</h2>
        <form action={createForm} className="space-y-3 text-sm">
          <input name="name" required placeholder="Form name" className={inputCls} />
          <input name="fields" placeholder="Fields, comma-separated (e.g. Name, Email, Phone)" className={inputCls} />
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Create form</button>
        </form>
      </Card>
    </div>
  );
}
