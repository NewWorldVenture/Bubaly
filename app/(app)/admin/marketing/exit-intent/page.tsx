import type { Metadata } from 'next';
import Link from 'next/link';
import { LogOut, Eye, EyeOff } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import type { Tables } from '@/lib/database.types';
import type { AudienceMatch } from '@/lib/marketing/personalization';
import { summarizeExitIntent, conversionRate, normalizeTrigger } from '@/lib/marketing/exit-intent';
import { createExitIntentAction, toggleExitIntentAction, deleteExitIntentAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';
import { SubmitButton } from '@/components/ui/submit-button';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('exitIntent.exitIntentPopups'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

type Offer = Tables<'marketing_exit_intent'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
/** The offers the list holds. */
const LISTED = 200;
/** Offers the summary may page through before it says it is not shown. */
const SUM_ROW_CEILING = 10_000;
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:brightness-95';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-black sm:text-2xl">{t('exitIntent.exitIntentPopups')}</h1>
      <ErrorState message={t('exitIntent.couldNotLoadExitIntent')} />
      <Link href="/admin/marketing/exit-intent" className="text-sm font-medium text-brand-text underline">{t('exitIntent.refreshExitIntentOffers')}</Link>
    </div>
  );
}

function matchSummary(m: AudienceMatch): string {
  const p: string[] = [];
  if (m.source?.length) p.push(`source: ${m.source.join('/')}`);
  if (m.campaign?.length) p.push(`campaign: ${m.campaign.join('/')}`);
  if (m.paths?.length) p.push(`path: ${m.paths.join('/')}`);
  if (m.countries?.length) p.push(`country: ${m.countries.join('/')}`);
  if (typeof m.returning === 'boolean') p.push(m.returning ? 'returning' : 'new visitor');
  if (m.minSessions) p.push(`≥${m.minSessions} sessions`);
  return p.length ? p.join(' · ') : 'Everyone';
}

export default async function ExitIntentPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  // The four tiles were summed from the list, the first 200 by priority, so
  // past them each was the list's total presented as every offer's (coverage
  // sweep round 9, class B). Offers is a head:true count now, and the others
  // are summed over every offer, paged on the id (impressions tick up while
  // this reads) to a ceiling past which they say they are not shown. Started
  // before the list is awaited; any of them that fails is the read-error state.
  const summaryRead = settleAll([
    supabase.from('marketing_exit_intent').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('marketing_exit_intent').select('id, status, impressions, conversions').is('deleted_at', null);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
  ]);
  const { data, error } = await supabase
    .from('marketing_exit_intent')
    .select('*')
    .is('deleted_at', null)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(LISTED);
  if (error) {
    console.error('[admin-marketing-exit-intent] offer read failed', error);
    return <ReadFailure />;
  }
  const [countResult, summaryResult] = await summaryRead;
  const summaryCeiling = 'truncated' in summaryResult && summaryResult.truncated;
  const summaryError = countResult.error ?? (summaryCeiling ? null : summaryResult.error);
  if (summaryError) {
    console.error('[admin-marketing-exit-intent] offer summary read failed', summaryError);
    return <ReadFailure />;
  }
  const offers = (data ?? []) as Offer[];
  const offerCount = countResult.count ?? 0;
  const stats = summarizeExitIntent(summaryResult.data ?? []);
  const unavailable = t('strategyMetrics.unavailable');
  const summed = (value: string | number) => (summaryCeiling ? unavailable : value);
  const tiles = [
    ['Offers', offerCount], ['Active', summed(stats.active)],
    ['Impressions', summed(stats.impressions)], ['Conversion rate', summed(`${stats.conversionRate}%`)],
  ];

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Show a targeted offer when a visitor is about to leave (mouseleave) or scrolls past a threshold. Shown at most once per visitor per week; impressions/conversions are tracked.
      </p>

      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={summaryCeiling ? tiles.slice(1).map(([label]) => String(label)) : []}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map(([label, val]) => (
          <Card key={String(label)} className="py-3">
            <p className="text-xs text-muted">{label}</p>
            <p className="text-xl font-semibold">{val}</p>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><LogOut className="h-4 w-4 text-brand-text" /> {t('adminMarketingExitIntent.newOffer')}</h2>
        <form action={createExitIntentAction} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input name="name" required placeholder={t('adminMarketingExitIntent.internalName')} className={`${inputCls} lg:col-span-2`} />
            <input name="priority" type="number" defaultValue={0} placeholder={t('adminMarketingExitIntent.priority')} className={inputCls} />
            <select name="status" defaultValue="paused" aria-label={t('adminMarketingExitIntent.status')} className={inputCls}>
              <option value="active">{t('adminMarketingExitIntent.active')}</option>
              <option value="paused">{t('adminMarketingExitIntent.paused')}</option>
            </select>
            <input name="headline" required placeholder={t('adminMarketingExitIntent.headline')} className={`${inputCls} lg:col-span-2`} />
            <input name="cta_label" placeholder={t('adminMarketingExitIntent.ctaLabel')} className={inputCls} />
            <input name="cta_href" placeholder={t('adminMarketingExitIntent.ctaHrefEGSignup')} className={inputCls} />
            <input name="body" placeholder={t('adminMarketingExitIntent.body')} className={`${inputCls} lg:col-span-4`} />
          </div>
          <p className="text-xs font-medium text-muted">{t('adminMarketingExitIntent.trigger')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <select name="mode" defaultValue="mouseleave" aria-label={t('adminMarketingExitIntent.trigger')} className={inputCls}>
              <option value="mouseleave">{t('adminMarketingExitIntent.onExitMouseleave')}</option>
              <option value="scroll">{t('adminMarketingExitIntent.onScrollDepth')}</option>
            </select>
            <input name="delayMs" type="number" min="0" defaultValue={0} placeholder={t('adminMarketingExitIntent.minDelayMs')} className={inputCls} />
            <input name="scrollPercent" type="number" min="0" max="100" defaultValue={60} placeholder={t('adminMarketingExitIntent.scrollScrollMode')} className={inputCls} />
          </div>
          <p className="text-xs font-medium text-muted">{t('adminMarketingExitIntent.audienceBlankEveryoneAllSetConditions')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input name="source" placeholder={t('adminMarketingExitIntent.utmSourceS')} className={inputCls} />
            <input name="campaign" placeholder={t('adminMarketingExitIntent.utmCampaignS')} className={inputCls} />
            <input name="paths" placeholder={t('adminMarketingExitIntent.pathPrefixEs')} className={inputCls} />
            <input name="countries" placeholder={t('adminMarketingExitIntent.countryCodeS')} className={inputCls} />
            <select name="returning" defaultValue="" aria-label={t('adminMarketingExitIntent.returning')} className={inputCls}>
              <option value="">{t('adminMarketingExitIntent.newOrReturning')}</option>
              <option value="true">{t('adminMarketingExitIntent.returningOnly')}</option>
              <option value="false">{t('adminMarketingExitIntent.newVisitorsOnly')}</option>
            </select>
            <SubmitButton className={`${btnCls} lg:col-span-2`}>{t('adminMarketingExitIntent.createOffer')}</SubmitButton>
          </div>
        </form>
      </Card>

      {offerCount > offers.length && (
        <p className="text-xs text-muted">{t('adminCeiling.listShowsPart', { shown: offers.length.toLocaleString(), total: offerCount.toLocaleString() })}</p>
      )}
      {offers.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('adminMarketingExitIntent.noExitIntentOffersYet')}</p>
      ) : (
        <div className="space-y-2">
          {offers.map((o) => {
            const m = (o.match ?? {}) as AudienceMatch;
            const trig = normalizeTrigger(o.trigger_config);
            return (
              <Card key={o.id} className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {o.name}
                    <Badge tone="neutral">P{o.priority}</Badge>
                    <Badge tone={o.status === 'active' ? 'success' : 'neutral'}>{o.status === 'active' ? 'Active' : 'Paused'}</Badge>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-fg/80">“{o.headline}”{o.cta_label ? ` → [${o.cta_label}]` : ''}</p>
                  <p className="mt-1 text-xs text-muted">
                    {matchSummary(m)} · {trig.mode === 'scroll' ? `scroll ${trig.scrollPercent}%` : 'mouseleave'} · {o.impressions} shown · {o.conversions} converted ({conversionRate(o.conversions, o.impressions)}%)
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <form action={toggleExitIntentAction.bind(null, o.id, o.status !== 'active')}>
                    <SubmitButton className="text-muted hover:text-fg" title={o.status === 'active' ? 'Pause' : 'Activate'}>
                      {o.status === 'active' ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </SubmitButton>
                  </form>
                  <form action={deleteExitIntentAction.bind(null, o.id)}>
                    <SubmitButton className="text-xs text-muted hover:text-rose-400">✕</SubmitButton>
                  </form>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
