import type { Metadata } from 'next';
import Link from 'next/link';
import { MessageSquare, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { createSmsDraft } from '../actions';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · SMS', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function SmsPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [smsResult, segmentsResult] = await Promise.all([
    supabase.from('marketing_sms_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('marketing_segments').select('id, name').is('deleted_at', null).order('name'),
  ]);
  const readError = smsResult.error ?? segmentsResult.error;
  if (readError) {
    console.error('[admin-marketing-sms] SMS read failed', readError);
    return <AdminSmsReadError />;
  }
  const { data: sms } = smsResult;
  const { data: segments } = segmentsResult;
  const ready = isTwilioConfigured();

  return (
    <div className="space-y-4">
      <div className={`flex items-center gap-3 rounded-2xl border p-4 text-sm ${ready ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'}`}>
        {ready ? <CheckCircle2 className="h-5 w-5 text-success" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
        {ready
          ? <span>{t('adminMarketingSms.smsProviderConnectedOnlySmsConsented')}</span>
          : <span><strong>{t('adminMarketingSms.noSmsProviderConfigured')}</strong> Set <code>TWILIO_AUTH_TOKEN</code> {t('adminMarketingSms.toEnableSendingDraftNowSends')}</span>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {(sms ?? []).length === 0 ? (
            <EmptyState icon={MessageSquare} title={t('adminMarketingSms.noSmsCampaignsYet')} description="Draft your first message on the right." />
          ) : (
            (sms ?? []).map((s) => (
              <Card key={s.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{s.message}</p>
                  <p className="mt-1 text-xs text-muted">Created {fmtDate(s.created_at)}{s.recipients ? ` · ${s.recipients} sent` : ''}</p>
                </div>
                <Badge tone={s.status === 'sent' ? 'success' : 'neutral'} className="capitalize">{s.status}</Badge>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">{t('adminMarketingSms.newSmsDraft')}</h2>
          <form action={createSmsDraft} className="space-y-3 text-sm">
            <select name="segment_id" className={inputCls}>
              <option value="">{t('adminMarketingSms.smsConsentedContacts')}</option>
              {(segments ?? []).map((sg) => <option key={sg.id} value={sg.id}>{sg.name}</option>)}
            </select>
            <textarea name="message" required maxLength={320} rows={4} placeholder={t('adminMarketingSms.messageKeepUnder160CharsInclude')} className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
            <p className="text-xs text-muted">{t('adminMarketingSms.alwaysIncludeReplyStopToOpt')}</p>
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{t('adminMarketingSms.saveDraft')}</button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function AdminSmsReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing SMS</h1>
        <p className="mt-1 text-sm text-muted">Draft and manage consent-aware SMS campaigns.</p>
      </div>
      <ErrorState message="Could not load marketing SMS data from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/sms" className="text-sm font-medium text-brand-text underline">Refresh SMS</Link>
    </div>
  );
}
