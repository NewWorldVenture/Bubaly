import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Users, UserPlus, TrendingDown, DollarSign, Layers, Send,
  Mail, Search, Sparkles, MessageSquareText, ArrowRight,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { fmtMoney } from '@/lib/utils/format';
import { CUSTOMER_FAMILY_CEILING, getMarketingCustomersWithError, summarizeCustomers } from '@/lib/marketing/customers';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('marketing.marketing'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

/** Rows a summed read may page through before it is reported as a prefix (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;

export default async function MarketingDashboard() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { customers, error: loadedCustomersError, truncated: customersCeiling = false } = await getMarketingCustomersWithError(supabase);
  const m = summarizeCustomers(customers);

  // Email Open Rate and AEO readiness were reduced from two unbounded selects,
  // which PostgREST answers with at most `db-max-rows` (1,000) and no error, so
  // past a thousand campaigns or questions each was a prefix shown as the
  // whole. The sent emails are summed, so they page on the id to a real
  // ceiling, and a deleted campaign is left out, as /admin/marketing/analytics
  // and the email list leave it out. Readiness needs only two numbers, so it is
  // two exact `head: true` counts.
  //
  // A summed read that reaches its ceiling costs its own figures, not the
  // dashboard (review R5-DASHBOARD-CEILING-STILL-WHOLE-PAGE): Email Open Rate,
  // or — when the customer view (lib/marketing/customers.ts) reaches its
  // own — the customer tiles, the lifecycle and the recommendations drawn from
  // them, each said to be not shown and named in the banner. Any other failure
  // is still the read-error state.
  const customersError = customersCeiling ? null : loadedCustomersError;
  const [
    activeSegmentsResult,
    activeCampaignsResult,
    emailsResult,
    leadsResult,
    seoPagesResult,
    aeoTotalResult,
    aeoAnsweredResult,
  ] = await settleAll([
    supabase.from('marketing_segments').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('marketing_campaigns').select('id', { count: 'exact', head: true }).in('status', ['active', 'scheduled']),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('marketing_email_campaigns').select('id, recipients, opens, clicks, status').is('deleted_at', null);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING }),
    supabase.from('support_tickets').select('id', { count: 'exact', head: true }).contains('tags', ['contact-form']),
    supabase.from('marketing_seo_pages').select('id', { count: 'exact', head: true }),
    supabase.from('marketing_aeo_questions').select('id', { count: 'exact', head: true }),
    supabase.from('marketing_aeo_questions').select('id', { count: 'exact', head: true }).in('status', ['answered', 'published']),
  ]);

  const emailsCeiling = 'truncated' in emailsResult && emailsResult.truncated;
  const readError = customersError
    ?? activeSegmentsResult.error
    ?? activeCampaignsResult.error
    ?? (emailsCeiling ? null : emailsResult.error)
    ?? leadsResult.error
    ?? seoPagesResult.error
    ?? aeoTotalResult.error
    ?? aeoAnsweredResult.error;
  if (readError) {
    console.error('[admin-marketing] dashboard read failed', readError);
    return <MarketingDashboardReadError />;
  }
  if (emailsCeiling || customersCeiling) console.warn('[admin-marketing] a summed read reached its ceiling; its figures are not shown');
  const unavailable = t('strategyMetrics.unavailable');

  const { count: activeSegments } = activeSegmentsResult;
  const { count: activeCampaigns } = activeCampaignsResult;
  const { data: emails } = emailsResult;
  const { count: leads } = leadsResult;
  const { count: seoPages } = seoPagesResult;
  const aeoTotal = aeoTotalResult.count ?? 0;

  const emailRows = emails ?? [];
  // Every campaign that delivered mail: a stopped or capped send records what
  // went out in `recipients` on a `failed` or `draft` row (lib/marketing/send.ts).
  const sent = emailRows.filter((e) => e.status === 'sent' || (e.recipients ?? 0) > 0);
  const totalRecipients = sent.reduce((s, e) => s + (e.recipients ?? 0), 0);
  const totalOpens = sent.reduce((s, e) => s + (e.opens ?? 0), 0);
  const openRate = totalRecipients > 0 ? Math.round((totalOpens / totalRecipients) * 100) : null;

  const aeoAnswered = aeoAnsweredResult.count ?? 0;
  const aeoReadiness = aeoTotal > 0 ? Math.round((aeoAnswered / aeoTotal) * 100) : null;

  // Recommended next actions — deterministic, derived from real data (not AI guesses).
  // The customer recommendations need the customer view; past its ceiling they are not made.
  const recs: { text: string; href: string }[] = [];
  if (!customersCeiling && m.lapsed > 0) recs.push({ text: m.lapsed === 1 ? t('adminMarketing.lapsedOne') : t('adminMarketing.lapsedMany', { n: m.lapsed }), href: '/admin/marketing/campaigns/new' });
  if (!customersCeiling && m.byLifecycle.free > 0) recs.push({ text: m.byLifecycle.free === 1 ? t('adminMarketing.freeFamiliesOne') : t('adminMarketing.freeFamiliesMany', { n: m.byLifecycle.free }), href: '/admin/marketing/segments' });
  if (!customersCeiling && m.newThisMonth > 0) recs.push({ text: m.newThisMonth === 1 ? t('adminMarketing.newCustomersOne') : t('adminMarketing.newCustomersMany', { n: m.newThisMonth }), href: '/admin/marketing/email' });
  if ((activeSegments ?? 0) === 0) recs.push({ text: t('adminMarketing.noSegmentsYet'), href: '/admin/marketing/segments' });
  if (aeoTotal === 0) recs.push({ text: 'No AEO questions tracked — seed answer-engine opportunities.', href: '/admin/marketing/aeo' });

  const customerFigure = (value: string) => (customersCeiling ? unavailable : value);
  const stats = [
    { label: 'Total Customers', value: customerFigure(m.total.toLocaleString()), icon: Users, tint: 'text-violet-400 bg-violet-500/15' },
    { label: 'New This Month', value: customerFigure(m.newThisMonth.toLocaleString()), icon: UserPlus, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Lapsed / Churned', value: customerFigure(m.lapsed.toLocaleString()), icon: TrendingDown, tint: 'text-rose-400 bg-rose-500/15' },
    { label: 'Est. MRR', value: customerFigure(fmtMoney(m.estMrrCents)), icon: DollarSign, tint: 'text-amber-400 bg-amber-500/15' },
    { label: 'Active Segments', value: (activeSegments ?? 0).toLocaleString(), icon: Layers, tint: 'text-blue-400 bg-blue-500/15' },
    { label: 'Active Campaigns', value: (activeCampaigns ?? 0).toLocaleString(), icon: Send, tint: 'text-cyan-400 bg-cyan-500/15' },
    { label: 'Email Open Rate', value: emailsCeiling ? unavailable : openRate == null ? '—' : `${openRate}%`, icon: Mail, tint: 'text-indigo-400 bg-indigo-500/15' },
    { label: 'Inbound Leads', value: (leads ?? 0).toLocaleString(), icon: MessageSquareText, tint: 'text-pink-400 bg-pink-500/15' },
  ];
  // The four customer tiles, then the lifecycle card; and the open-rate tile.
  const customerFiguresNotShown = customersCeiling ? [...stats.slice(0, 4).map((s) => s.label), t('adminMarketing.customerLifecycle')] : [];
  const emailFiguresNotShown = emailsCeiling ? [stats[6].label] : [];

  const lifecycleBars: { label: string; value: number; color: string }[] = [
    { label: 'New', value: m.byLifecycle.new, color: '#34d399' },
    { label: 'Active', value: m.byLifecycle.active, color: '#7c5dff' },
    { label: 'Lapsed', value: m.byLifecycle.lapsed, color: '#fbbf24' },
    { label: 'Churned', value: m.byLifecycle.churned, color: '#f87171' },
    { label: 'Free', value: m.byLifecycle.free, color: '#64748b' },
  ];
  const maxBar = Math.max(...lifecycleBars.map((b) => b.value), 1);

  return (
    <div className="space-y-5">
      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: CUSTOMER_FAMILY_CEILING.toLocaleString() })}
        failures={customerFiguresNotShown}
      />
      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={emailFiguresNotShown}
      />
      <p className="text-sm text-muted">
        {t('adminMarketing.realTimeViewOfYourCustomer')}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-xl font-bold leading-none">{s.value}</p>
              <p className="mt-1 text-xs text-muted">{s.label}</p>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="mb-4 text-base font-semibold">{t('adminMarketing.customerLifecycle')}</h2>
          {customersCeiling && <p className="text-sm text-muted">{unavailable}</p>}
          <div className="space-y-3">
            {!customersCeiling && lifecycleBars.map((b) => (
              <div key={b.label} className="flex items-center gap-3 text-sm">
                <span className="w-16 shrink-0 text-muted">{b.label}</span>
                <div className="h-3 flex-1 overflow-hidden rounded-full bg-elevated">
                  <div className="h-full rounded-full" style={{ width: `${(b.value / maxBar) * 100}%`, background: b.color }} />
                </div>
                <span className="w-10 shrink-0 text-right font-semibold tabular-nums">{b.value}</span>
              </div>
            ))}
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border pt-4 text-sm">
            <div><p className="text-xs text-muted">{t('adminMarketing.paying')}</p><p className="font-semibold">{customerFigure(String(m.paying))}</p></div>
            <div><p className="text-xs text-muted">{t('adminMarketing.estLifetimeValue')}</p><p className="font-semibold">{customerFigure(fmtMoney(m.estLtvCents))}</p></div>
            <div><p className="text-xs text-muted">{t('adminMarketing.aeoReadiness')}</p><p className="font-semibold">{aeoReadiness == null ? '—' : `${aeoReadiness}%`}</p></div>
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-text" />
            <h2 className="text-base font-semibold">{t('adminMarketing.recommendedNextActions')}</h2>
          </div>
          {recs.length > 0 ? (
            <ul className="space-y-2">
              {recs.slice(0, 5).map((r) => (
                <li key={r.text}>
                  <Link href={r.href} className="group flex items-start gap-2 rounded-xl border border-border bg-surface/30 p-3 text-sm transition hover:border-brand/40">
                    <span className="flex-1">{r.text}</span>
                    <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t('adminMarketing.everythingLooksHealthyNoUrgentActions')}</p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <Link href="/admin/marketing/seo" className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 hover:bg-elevated"><Search className="h-3.5 w-3.5 shrink-0" /> SEO {seoPages != null ? `(${seoPages})` : ''}</Link>
            <Link href="/admin/marketing/aeo" className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 hover:bg-elevated"><MessageSquareText className="h-3.5 w-3.5 shrink-0" /> AEO {aeoReadiness != null ? `(${aeoReadiness}%)` : ''}</Link>
            <Link href="/admin/marketing/campaigns/new" className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 hover:bg-elevated"><Send className="h-3.5 w-3.5 shrink-0" /> {t('adminMarketing.newCampaign')}</Link>
          </div>
        </Card>
      </div>
    </div>
  );
}

async function MarketingDashboardReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('marketing.marketing')}</h1>
        <p className="mt-1 text-sm text-muted">{t('marketing.liveCustomerCampaignAndGrowth')}</p>
      </div>
      <ErrorState message={t('marketing.couldNotLoadMarketingDashboard')} />
      <a href="/admin/marketing" className="text-sm font-medium text-brand-text underline">{t('marketing.refreshMarketingDashboard')}</a>
    </div>
  );
}
