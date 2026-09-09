import type { Metadata } from 'next';
import Link from 'next/link';
import { LogOut, Eye, EyeOff } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import type { Tables } from '@/lib/database.types';
import type { AudienceMatch } from '@/lib/marketing/personalization';
import { summarizeExitIntent, conversionRate, normalizeTrigger } from '@/lib/marketing/exit-intent';
import { createExitIntentAction, toggleExitIntentAction, deleteExitIntentAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Exit-Intent Popups', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Offer = Tables<'marketing_exit_intent'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

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
  const { data, error } = await supabase
    .from('marketing_exit_intent')
    .select('*')
    .is('deleted_at', null)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('[admin-marketing-exit-intent] offer read failed', error);
    return <ReadFailure />;
  }
  const offers = (data ?? []) as Offer[];
  const stats = summarizeExitIntent(offers);

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Show a targeted offer when a visitor is about to leave (mouseleave) or scrolls past a threshold. Shown at most once per visitor per week; impressions/conversions are tracked.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Offers', stats.offers], ['Active', stats.active],
          ['Impressions', stats.impressions], ['Conversion rate', `${stats.conversionRate}%`],
        ].map(([label, val]) => (
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
            <select name="status" defaultValue="active" className={inputCls}>
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
            <select name="mode" defaultValue="mouseleave" className={inputCls}>
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
            <select name="returning" defaultValue="" className={inputCls}>
              <option value="">{t('adminMarketingExitIntent.newOrReturning')}</option>
              <option value="true">{t('adminMarketingExitIntent.returningOnly')}</option>
              <option value="false">{t('adminMarketingExitIntent.newVisitorsOnly')}</option>
            </select>
            <input name="minSessions" type="number" min="0" placeholder={t('adminMarketingExitIntent.minSessions')} className={inputCls} />
            <button type="submit" className={`${btnCls} lg:col-span-2`}>{t('adminMarketingExitIntent.createOffer')}</button>
          </div>
        </form>
      </Card>

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
                    <button type="submit" className="text-muted hover:text-fg" title={o.status === 'active' ? 'Pause' : 'Activate'}>
                      {o.status === 'active' ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </form>
                  <form action={deleteExitIntentAction.bind(null, o.id)}>
                    <button type="submit" className="text-xs text-muted hover:text-rose-400">✕</button>
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
