import type { Metadata } from 'next';
import Link from 'next/link';
import { Mail, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { createEmailDraft } from '../actions';
import { SendCampaignButton } from '@/components/admin/send-campaign-button';
import { campaignAudience, campaignDelivery, finishesCampaign } from '@/lib/marketing/send';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export const metadata: Metadata = { title: 'Marketing · Email', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function EmailPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [emailsResult, segmentsResult] = await settleAll([
    supabase.from('marketing_email_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }),
    supabase.from('marketing_segments').select('id, name').is('deleted_at', null).order('name'),
  ]);
  const readError = emailsResult.error ?? segmentsResult.error;
  if (readError) {
    console.error('[admin-marketing-email] email read failed', readError);
    return <AdminEmailReadError />;
  }
  const { data: emails } = emailsResult;
  const { data: segments } = segmentsResult;
  const finishing = await cappedDraftsWithNoOneLeft(supabase, emails ?? []);

  const providerReady = !!process.env.RESEND_API_KEY;

  return (
    <div className="space-y-4">
      <div className={`flex items-center gap-3 rounded-2xl border p-4 text-sm ${providerReady ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'}`}>
        {providerReady ? <CheckCircle2 className="h-5 w-5 text-success" /> : <AlertTriangle className="h-5 w-5 text-warning" />}
        {providerReady
          ? <span>{t('adminMarketingEmail.emailProviderConnectedResendDraftsCan')}</span>
          : <span><strong>{t('adminMarketingEmail.noEmailProviderConfigured')}</strong> Set <code>RESEND_API_KEY</code> {t('adminMarketingEmail.toEnableSendingYouCanStill')}</span>}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          {(emails ?? []).length === 0 ? (
            <EmptyState icon={Mail} title={t('adminMarketingEmail.noEmailCampaignsYet')} description={t('email.draftYourFirstEmailOn')} />
          ) : (
            (emails ?? []).map((e) => (
              <Card key={e.id} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-semibold">{e.subject}</p>
                    <Badge tone={e.status === 'sent' ? 'success' : e.status === 'failed' ? 'danger' : 'neutral'} className="capitalize">{e.status}</Badge>
                  </div>
                  {e.preview_text && <p className="mt-0.5 truncate text-sm text-muted">{e.preview_text}</p>}
                  <p className="mt-1 text-xs text-muted">Created {fmtDate(e.created_at)}</p>
                </div>
                {e.status === 'sent' ? (
                  <div className="shrink-0 text-right text-xs text-muted">
                    <p className="font-semibold text-fg">{e.recipients}</p> sent
                    <p className="mt-1">{e.opens} opens · {e.clicks} clicks</p>
                  </div>
                ) : (e.status === 'draft' || e.status === 'failed') && providerReady ? (
                  // A failed send that reached part of its audience says how
                  // much: Send resumes it for the rest (lib/marketing/send.ts),
                  // it does not mail those families again.
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {e.status === 'failed' && e.recipients > 0 && (
                      <p className="text-xs text-muted">{t('adminMarketingEmail.sentBeforeItStopped', { n: e.recipients })}</p>
                    )}
                    {/* A send past the per-send cap reached its first part and
                        came back to draft with the rest held (lib/marketing/send.ts). */}
                    {e.status === 'draft' && <CappedNote t={t} recipients={e.recipients} metadata={e.metadata} finishes={finishing.has(e.id)} />}
                    <SendCampaignButton id={e.id} />
                  </div>
                ) : e.status === 'failed' && e.recipients > 0 ? (
                  <p className="shrink-0 text-xs text-muted">{t('adminMarketingEmail.sentBeforeItStopped', { n: e.recipients })}</p>
                ) : e.status === 'draft' ? (
                  <CappedNote t={t} recipients={e.recipients} metadata={e.metadata} finishes={finishing.has(e.id)} />
                ) : null}
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">{t('adminMarketingEmail.newEmailDraft')}</h2>
          <form action={createEmailDraft} className="space-y-3 text-sm">
            <input name="subject" required placeholder={t('adminMarketingEmail.subjectLine')} className={inputCls} />
            <input name="preview_text" placeholder={t('adminMarketingEmail.previewText')} className={inputCls} />
            <input name="from_name" placeholder={t('adminMarketingEmail.fromNameOptional')} className={inputCls} />
            <select name="segment_id" aria-label={t('adminMarketingEmail.audience')} className={inputCls}>
              <option value="">{t('adminMarketingEmail.allCustomers')}</option>
              {(segments ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <textarea name="body_html" rows={5} placeholder={t('adminMarketingEmail.emailBodyHtmlOrText')} className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
            <SubmitButton className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{t('adminMarketingEmail.saveDraft')}</SubmitButton>
          </form>
        </Card>
      </div>
    </div>
  );
}

/**
 * The capped drafts whose held addresses have all left the audience, so the
 * next Send only marks them sent (finishesCampaign). Their note said Send
 * reaches the rest. Read only for a capped draft, the one card whose note
 * makes that promise; an audience that cannot be read keeps the note, and
 * Send's own preview still answers who it reaches.
 */
async function cappedDraftsWithNoOneLeft(
  supabase: ReturnType<typeof createServiceClient>,
  emails: readonly { id: string; status: string; segment_id: string | null; metadata: unknown }[],
): Promise<Set<string>> {
  const finishing = new Set<string>();
  for (const e of emails) {
    if (e.status !== 'draft' || campaignDelivery(e.metadata)?.outcome !== 'capped') continue;
    try {
      const { remaining, prior } = await campaignAudience(supabase, e);
      if (finishesCampaign(prior, remaining)) finishing.add(e.id);
    } catch (err) {
      console.error('[admin-marketing-email] capped draft audience read failed', err);
    }
  }
  return finishing;
}

/** "N of M sent" for a draft an earlier, capped send reached part of; nothing otherwise. */
function CappedNote({ t, recipients, metadata, finishes }: { t: Awaited<ReturnType<typeof getTranslations>>; recipients: number; metadata: unknown; finishes: boolean }) {
  const delivery = campaignDelivery(metadata);
  if (delivery?.outcome !== 'capped' || recipients <= 0) return null;
  if (finishes) return <p className="shrink-0 text-xs text-muted">{t('adminMarketingEmail.sentNoOneLeft', { n: recipients })}</p>;
  return <p className="shrink-0 text-xs text-muted">{t('adminMarketingEmail.sentOfAudienceSoFar', { n: recipients, total: recipients + (delivery.held ?? 0) })}</p>;
}

async function AdminEmailReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('email.marketingEmail')}</h1>
        <p className="mt-1 text-sm text-muted">{t('email.draftReviewAndSendCustomer')}</p>
      </div>
      <ErrorState message={t('email.couldNotLoadMarketingEmail')} />
      <Link href="/admin/marketing/email" className="text-sm font-medium text-brand-text underline">{t('email.refreshEmail')}</Link>
    </div>
  );
}
