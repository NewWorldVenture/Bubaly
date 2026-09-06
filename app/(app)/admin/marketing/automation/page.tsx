import type { Metadata } from 'next';
import { Workflow } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { createAutomation, setAutomationStatus } from '../actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Automation', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const TRIGGERS = ['customer_created', 'joins_segment', 'form_submitted', 'payment_completed', 'payment_failed', 'email_opened', 'email_clicked', 'checkout_abandoned', 'customer_inactive', 'high_value_detected'];
const ACTIONS = ['send_email', 'send_sms', 'add_to_segment', 'remove_from_segment', 'apply_tag', 'create_task', 'notify_admin', 'update_lead_score'];

export default async function AutomationPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  const { data: flows, error: flowsError } = await supabase.from('marketing_automation_workflows').select('*').is('deleted_at', null).order('created_at', { ascending: false });
  if (flowsError) {
    console.error('[admin-marketing-automation] workflow read failed', flowsError);
    return <AdminAutomationReadError />;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        {(flows ?? []).length === 0 ? (
          <EmptyState icon={Workflow} title={tr('adminMarketingAutomation.noWorkflowsYet')} description="Build your first automation on the right." />
        ) : (
          (flows ?? []).map((w) => {
            const steps = Array.isArray(w.steps) ? w.steps as { action: string }[] : [];
            return (
              <Card key={w.id} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{w.name}</p>
                    <Badge tone={w.status === 'active' ? 'success' : 'neutral'} className="capitalize">{w.status}</Badge>
                  </div>
                  <span className="text-xs text-muted">{w.run_count} runs</span>
                </div>
                <p className="text-xs text-muted">When <span className="text-fg">{w.trigger.replace(/_/g, ' ')}</span> → {steps.map((s) => s.action.replace(/_/g, ' ')).join(' → ') || 'no steps'}</p>
                <div className="flex gap-2 pt-1">
                  {['active', 'paused', 'draft'].map((st) => (
                    <form key={st} action={setAutomationStatus}>
                      <input type="hidden" name="id" value={w.id} />
                      <input type="hidden" name="status" value={st} />
                      <button disabled={st === w.status} className={`rounded-lg border px-2.5 py-1 text-xs capitalize ${st === w.status ? 'cursor-default border-brand/40 bg-brand/15 text-brand-text' : 'border-border text-muted hover:bg-elevated'}`}>{st}</button>
                    </form>
                  ))}
                </div>
              </Card>
            );
          })
        )}
      </div>
      <Card className="h-fit">
        <h2 className="mb-3 font-semibold">{tr('adminMarketingAutomation.newWorkflow')}</h2>
        <form action={createAutomation} className="space-y-3 text-sm">
          <input name="name" required placeholder={tr('adminMarketingAutomation.workflowName')} className={inputCls} />
          <label className="block text-xs text-muted">{tr('adminMarketingAutomation.trigger')}
            <select name="trigger" className={`mt-1 ${inputCls}`}>{TRIGGERS.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select>
          </label>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">{tr('adminMarketingAutomation.actionsInOrder')}</p>
            <div className="flex flex-wrap gap-2">
              {ACTIONS.map((a) => (
                <label key={a} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs">
                  <input type="checkbox" name="actions" value={a} /> {a.replace(/_/g, ' ')}
                </label>
              ))}
            </div>
          </div>
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{tr('adminMarketingAutomation.createWorkflow')}</button>
        </form>
      </Card>
    </div>
  );
}

function AdminAutomationReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Automation</h1>
        <p className="mt-1 text-sm text-muted">Build and manage marketing workflows.</p>
      </div>
      <ErrorState message="Could not load marketing workflows from Supabase. Refresh and try again." />
      <a href="/admin/marketing/automation" className="text-sm font-medium text-brand-text underline">Refresh automation</a>
    </div>
  );
}
