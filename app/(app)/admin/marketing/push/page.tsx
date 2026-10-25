import type { Metadata } from 'next';
import Link from 'next/link';
import { BellRing, Send, AlertTriangle } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';
import { pushConfigured } from '@/lib/server/push';
import { summarizePush, canSendPush, canDeletePush, needsPushReview, pushDeliveryCounts, pushDeliveryPhase, staleSendingResolution } from '@/lib/marketing/push';
import { createPushCampaignAction, sendPushCampaignAction, deletePushCampaignAction, resolveStalePushCampaignAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export const metadata: Metadata = { title: 'Marketing · Push', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Campaign = Tables<'marketing_push_campaigns'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:brightness-95';

const STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'danger'> = {
  draft: 'neutral', sending: 'warning', sent: 'success', failed: 'danger',
};

/** The newest campaigns the list holds. */
const LISTED = 200;
/** Campaigns the summary may page through before it says it is not shown (one round trip per 1,000). */
const SUM_ROW_CEILING = 10_000;

export default async function PushPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // Campaigns, Accepted and Review were summed from the list, the newest 200,
  // so past them each was the list's total presented as the program's
  // (coverage sweep round 9, class B). Campaigns is a head:true count now, and
  // the other two are summed over every campaign, paged on the id (a send
  // updates its row while this reads) to a ceiling past which they say they
  // are not shown. The list says when it holds part of the campaigns.
  const [campaignsResult, devicesResult, campaignCountResult, summaryResult] = await settleAll([
    supabase.from('marketing_push_campaigns').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(LISTED),
    supabase.from('push_devices').select('id', { count: 'exact', head: true }).eq('enabled', true),
    supabase.from('marketing_push_campaigns').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('marketing_push_campaigns').select('id, status, sent, recipients, metadata').is('deleted_at', null);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
  ]);
  const summaryCeiling = 'truncated' in summaryResult && summaryResult.truncated;
  const readError = campaignsResult.error ?? devicesResult.error ?? campaignCountResult.error ?? (summaryCeiling ? null : summaryResult.error);
  if (readError) {
    console.error('[admin-marketing-push] push read failed', readError);
    return <AdminPushReadError />;
  }
  const { data } = campaignsResult;
  const { count: deviceCount } = devicesResult;
  const campaigns = (data ?? []) as Campaign[];
  const stats = summarizePush((summaryResult.data ?? []) as Campaign[]);
  const campaignCount = campaignCountResult.count ?? 0;
  const unavailable = t('strategyMetrics.unavailable');
  const cfg = pushConfigured();

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        {t('adminMarketingPush.broadcastAPushToAllOpted')}
      </p>

      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={summaryCeiling ? [t('marketingPush.accepted'), t('marketingPush.review')] : []}
      />

      {!cfg.web && !cfg.native && (
        <Card className="flex items-start gap-2 border-amber-500/30 bg-amber-500/5 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
          <p>{t('adminMarketingPush.pushDeliveryIsnAposTConfigured')} <strong>skipped</strong> {t('adminMarketingPush.untilKeysAreSet')}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          [t('marketingPush.enabledDevices'), deviceCount ?? 0],
          ['Campaigns', campaignCount],
          [t('marketingPush.accepted'), summaryCeiling ? unavailable : stats.totalSent],
          [t('marketingPush.review'), summaryCeiling ? unavailable : stats.reviewCampaigns],
        ].map(([label, val]) => (
          <Card key={String(label)} className="py-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-xl font-semibold">{val}</p>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><BellRing className="h-4 w-4 text-brand-text" /> {t('adminMarketingPush.newPush')}</h2>
        <form action={createPushCampaignAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input name="title" required placeholder={t('adminMarketingPush.title')} className={`${inputCls} lg:col-span-2`} />
          <input name="url" placeholder={t('adminMarketingPush.clickUrlEGPricing')} className={`${inputCls} lg:col-span-2`} />
          <input name="body" placeholder={t('adminMarketingPush.bodyText')} className={`${inputCls} lg:col-span-3`} />
          <SubmitButton className={btnCls}>{t('adminMarketingPush.createDraft')}</SubmitButton>
        </form>
      </Card>

      {campaignCount > campaigns.length && (
        <p className="text-xs text-muted">{t('adminCeiling.listShowsTheNewest', { shown: campaigns.length.toLocaleString(), total: campaignCount.toLocaleString() })}</p>
      )}
      {campaigns.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('adminMarketingPush.noPushCampaignsYet')}</p>
      ) : (
        <div className="space-y-2">
          {campaigns.map((c) => {
            const review = needsPushReview(c);
            const phase = pushDeliveryPhase(c.metadata);
            const counts = pushDeliveryCounts(c.metadata);
            return (
            <Card key={c.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">{c.title} <Badge tone={review ? 'warning' : STATUS_TONE[c.status] ?? 'neutral'} className="capitalize">{review ? t('marketingPush.review') : c.status === 'sent' ? t('marketingPush.completed') : c.status}</Badge></p>
                {c.body && <p className="mt-0.5 truncate text-xs text-muted">{c.body}</p>}
                <p className="mt-1 text-xs text-muted">
                  {c.status === 'sending' ? t('marketingPush.unconfirmed')
                    : phase === 'preflight_failed' ? t('marketingPush.notStarted')
                    : phase === 'reviewed' ? t('marketingPush.outcomeUnknown')
                    : c.status !== 'draft' ? counts
                      ? t('marketingPush.outcomes', counts)
                      : t('marketingPush.legacyCounts', { accepted: c.sent, failed: c.failed, skipped: c.skipped })
                    : c.url ? `→ ${c.url}` : 'Draft'}
                  {c.sent_at && c.status !== 'sending' ? ` · ${fmtDate(c.sent_at)}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3 text-sm">
                {canSendPush(c.status, c.metadata) && (
                  <form action={sendPushCampaignAction.bind(null, c.id)}>
                    <SubmitButton className="inline-flex items-center gap-1 font-semibold text-brand-text hover:underline">
                      <Send className="h-3.5 w-3.5" />{' '}{t('push.send')}</SubmitButton>
                  </form>
                )}
                {staleSendingResolution(c.status, c.metadata, c.updated_at) && (
                  <form action={resolveStalePushCampaignAction.bind(null, c.id)}>
                    <SubmitButton className="text-xs font-semibold text-brand-text hover:underline">{t('marketingPush.resolveStale')}</SubmitButton>
                  </form>
                )}
                {canDeletePush(c.status, c.metadata) && <form action={deletePushCampaignAction.bind(null, c.id)}>
                  <SubmitButton className="text-xs text-muted hover:text-rose-400">{t('push.delete')}</SubmitButton>
                </form>}
              </div>
            </Card>
          ); })}
        </div>
      )}
    </div>
  );
}

async function AdminPushReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('push.marketingPush')}</h1>
        <p className="mt-1 text-sm text-muted">{t('push.createAndDeliverConsentAware')}</p>
      </div>
      <ErrorState message={t('push.couldNotLoadPushCampaigns')} />
      <Link href="/admin/marketing/push" className="text-sm font-medium text-brand-text underline">{t('push.refreshPush')}</Link>
    </div>
  );
}
