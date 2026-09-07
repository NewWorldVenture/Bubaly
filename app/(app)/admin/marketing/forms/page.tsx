import type { Metadata } from 'next';
import Link from 'next/link';
import { ClipboardList, ExternalLink } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { createForm, setFormStatus } from '../actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Forms', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function FormsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [formsResult, submissionsResult] = await settleAll([
    supabase.from('marketing_forms').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('marketing_form_submissions').select('form_id'),
  ]);
  const readError = formsResult.error ?? submissionsResult.error;
  if (readError) {
    console.error('[admin-marketing-forms] form read failed', readError);
    return <AdminFormsReadError />;
  }
  const { data: forms } = formsResult;
  const { data: subs } = submissionsResult;
  const countByForm = new Map<string, number>();
  for (const s of subs ?? []) countByForm.set(s.form_id, (countByForm.get(s.form_id) ?? 0) + 1);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {(forms ?? []).length === 0 ? (
          <EmptyState icon={ClipboardList} title={t('adminMarketingForms.noFormsYet')} description={t('forms.buildALeadCaptureForm')} />
        ) : (
          (forms ?? []).map((f) => {
            const fields = Array.isArray(f.fields) ? f.fields as { label: string }[] : [];
            const active = f.status === 'active';
            return (
              <Card key={f.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{f.name}</p>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${active ? 'bg-success/15 text-success' : 'bg-border/50 text-muted'}`}>
                      {active ? 'Active' : 'Archived'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted">{fields.map((x) => x.label).join(', ') || 'No fields'}</p>
                  <div className="mt-2 flex items-center gap-3 text-xs">
                    {active && (
                      <a href={`/f/${f.id}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                        <ExternalLink className="h-3 w-3" />{' '}{t('forms.viewPublicForm')}</a>
                    )}
                    <form action={setFormStatus}>
                      <input type="hidden" name="id" value={f.id} />
                      <input type="hidden" name="activate" value={active ? '0' : '1'} />
                      <button className="text-muted hover:text-fg hover:underline">{active ? 'Archive' : 'Activate'}</button>
                    </form>
                  </div>
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
          {t('adminMarketingForms.activeFormsAreLiveAt')} <code>/f/&lt;id&gt;</code>{t('adminMarketingForms.submissionsWriteTo')}{' '}
          <code>marketing_form_submissions</code> {t('adminMarketingForms.andFireAny')} <code>form_submitted</code> automation.
        </p>
      </div>
      <Card className="h-fit">
        <h2 className="mb-3 font-semibold">{t('adminMarketingForms.newForm')}</h2>
        <form action={createForm} className="space-y-3 text-sm">
          <input name="name" required placeholder={t('adminMarketingForms.formName')} className={inputCls} />
          <input name="fields" placeholder={t('adminMarketingForms.fieldsCommaSeparatedEGName')} className={inputCls} />
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{t('adminMarketingForms.createForm')}</button>
        </form>
      </Card>
    </div>
  );
}

async function AdminFormsReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('forms.marketingForms')}</h1>
        <p className="mt-1 text-sm text-muted">{t('forms.createAndMonitorPublicLead')}</p>
      </div>
      <ErrorState message={t('forms.couldNotLoadMarketingForms')} />
      <Link href="/admin/marketing/forms" className="text-sm font-medium text-brand-text underline">{t('forms.refreshForms')}</Link>
    </div>
  );
}
