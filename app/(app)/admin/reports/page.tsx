import type { Metadata } from 'next';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { Home, Users, CreditCard, DollarSign, FolderLock, Activity } from 'lucide-react';
import { createServiceClient, describeConfiguredServiceKey } from '@/lib/supabase/server';
import { settleAll, describeReadError, credentialHint } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Donut, Bars } from '@/components/admin/charts';
import { fmtMoney } from '@/lib/utils/format';
import { planMonthlyCents, planName } from '@/lib/constants/plans';
import { getTranslations } from '@/lib/i18n/server';
import { StrategyMetricTiles } from '@/components/admin/strategy-metric-tiles';
import { loadStrategyMetrics } from '@/lib/metric/strategy-server';

export const metadata: Metadata = { title: 'Reports & Analytics', robots: { index: false } };
export const dynamic = 'force-dynamic';

const MS_DAY = 86_400_000;

const planLabel = (plan: string | null): string => planName(plan);
function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function monthBuckets<T extends { created_at: string }>(rows: T[], valueOf: (r: T) => number) {
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - (5 - i), 1);
    const start = d.getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const value = rows
      .filter((r) => { const t = new Date(r.created_at).getTime(); return t >= start && t < end; })
      .reduce((sum, r) => sum + valueOf(r), 0);
    return { label: d.toLocaleDateString('en-US', { month: 'short' }), value };
  });
}

export default async function AdminReportsPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();
  const fourteenDaysAgo = new Date(Date.now() - 14 * MS_DAY).toISOString();

  // X3/X5/X10/X12 — read with the SERVICE client, like the rest of this page,
  // because they are platform-wide. Each field fails closed on its own: the
  // tiles say "unavailable" rather than showing a zero this page cannot stand
  // behind, so one broken table does not take the whole report down.
  //
  // It answers a StrategyMetrics, not a PostgREST envelope, so it cannot ride
  // inside the settleAll below — and because it is started BEFORE that batch, it
  // carries its own catch: a `.from()` that throws while the array is still
  // being built would otherwise leave this promise running with nobody on it.
  // The fallback is the all-unavailable value, which is what the tiles already
  // render for a field that could not be read.
  const strategyMetricsPromise = loadStrategyMetrics(supabase).catch((cause) => {
    console.error('[admin/reports] strategy metrics read threw', cause);
    return { rework: null, compression: null, compressionRead: 'failed' as const, conversion: null, referrals: null };
  });

  const [familyCountResult, userCountResult, activeSubCountResult, familiesResult, profilesResult, subscriptionsResult, docsResult, activityResult] = await settleAll([
    supabase.from('families').select('id', { count: 'exact', head: true }),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('families').select('created_at'),
    supabase.from('profiles').select('created_at'),
    supabase.from('subscriptions').select('plan, status, created_at'),
    supabase.from('documents').select('size_bytes'),
    supabase.from('audit_logs').select('created_at').gte('created_at', fourteenDaysAgo),
  ]);

  // Awaited here, before any early return, so the in-flight read always has an
  // owner — a page that returns while a promise is outstanding leaves an
  // unhandled rejection behind if it ever throws.
  const strategyMetrics = await strategyMetricsPromise;

  const familyCount = familyCountResult.count;
  const userCount = userCountResult.count;
  const activeSubCount = activeSubCountResult.count;
  const families = familiesResult.data;
  const profiles = profilesResult.data;
  const subscriptions = subscriptionsResult.data;
  const docs = docsResult.data;
  const activity = activityResult.data;
  const readFailures = ([
    ['family count', familyCountResult],
    ['user count', userCountResult],
    ['active sub count', activeSubCountResult],
    ['families', familiesResult],
    ['profiles', profilesResult],
    ['subscriptions', subscriptionsResult],
    ['docs', docsResult],
    ['activity', activityResult],
  ] as const)
    .filter(([, res]) => res.error)
    .map(([label, res]) => `${label}: ${describeReadError(res.error)}`);
  const readError = readFailures.length > 0;
  if (readError) {
    // Degraded, not fatal: every consumer below defaults an absent read to an
    // empty list or zero, so one unavailable table costs its own tile rather
    // than the page. Production's migration ledger stops at 0001-0003, so a
    // later table being absent is the normal case there, not an anomaly.
    console.warn('[admin-reports] report read failed — rendering degraded', readError);
  }

  const activeSubs = (subscriptions ?? []).filter((s) => s.status === 'active');
  const mrrCents = activeSubs.reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const usedBytes = (docs ?? []).reduce((sum, d) => sum + (d.size_bytes ?? 0), 0);

  const familyGrowth = monthBuckets(families ?? [], () => 1);
  const userGrowth = monthBuckets(profiles ?? [], () => 1);
  const revenueTrend = monthBuckets(subscriptions ?? [], (r) => planMonthlyCents(r.plan));
  const maxFamily = Math.max(...familyGrowth.map((m) => m.value), 1);
  const maxUser = Math.max(...userGrowth.map((m) => m.value), 1);
  const maxRevenue = Math.max(...revenueTrend.map((m) => m.value), 1);

  const planColors: Record<string, string> = {
    'Bubaly Family': '#7c5dff',
    'Bubaly Family (Annual)': '#22c55e',
    Free: '#64748b',
  };
  const planBuckets = new Map<string, number>();
  for (const s of activeSubs) planBuckets.set(planLabel(s.plan), (planBuckets.get(planLabel(s.plan)) ?? 0) + 1);
  const subSegments = [...planBuckets.entries()].map(([label, value]) => ({ label, value, color: planColors[label] ?? '#64748b' }));

  const activityByDay = Array.from({ length: 14 }, (_, i) => {
    const dayStart = Date.now() - (13 - i) * MS_DAY;
    const d = new Date(dayStart);
    return {
      label: d.toLocaleDateString('en-US', { day: 'numeric' }),
      value: (activity ?? []).filter((a) => { const t = new Date(a.created_at).getTime(); return t >= dayStart && t < dayStart + MS_DAY; }).length,
    };
  });
  const maxActivity = Math.max(...activityByDay.map((a) => a.value), 1);

  const metrics = [
    { icon: Home, key: 'families', label: tr('adminReports.totalFamilies'), value: (familyCount ?? 0).toLocaleString(), tint: 'text-violet-400 bg-violet-500/15' },
    { icon: Users, key: 'users', label: tr('adminReports.totalUsers'), value: (userCount ?? 0).toLocaleString(), tint: 'text-blue-400 bg-blue-500/15' },
    { icon: CreditCard, key: 'subscriptions', label: tr('adminReports.activeSubscriptions'), value: (activeSubCount ?? 0).toLocaleString(), tint: 'text-emerald-400 bg-emerald-500/15' },
    { icon: DollarSign, key: 'revenue', label: tr('adminReports.monthlyRevenue'), value: fmtMoney(mrrCents), tint: 'text-amber-400 bg-amber-500/15' },
    { icon: FolderLock, key: 'documents', label: tr('adminReports.documents'), value: (docs ?? []).length.toLocaleString(), tint: 'text-rose-400 bg-rose-500/15' },
    { icon: Activity, key: 'storage', label: tr('adminReports.storageUsed'), value: fmtBytes(usedBytes), tint: 'text-cyan-400 bg-cyan-500/15' },
  ];

  return (
    <div className="module-page space-y-5">
      <PartialReadBanner title={"This report is incomplete — some reads failed:"} failures={readFailures} hint={credentialHint(readFailures, describeConfiguredServiceKey())} />
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminReports.reportsAmpAnalytics')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('adminReports.growthRevenueAndEngagementAcrossEvery')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {metrics.map((m) => (
          <Card key={m.key} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${m.tint}`}><m.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-xl font-bold leading-none">{m.value}</p>
              <p className="mt-1 text-xs text-muted">{m.label}</p>
            </div>
          </Card>
        ))}
      </div>

      <StrategyMetricTiles metrics={strategyMetrics} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-3 text-base font-semibold">{tr('adminReports.newFamilies')}</h2>
          <Bars data={familyGrowth} max={maxFamily} />
          <p className="mt-2 text-xs text-muted">{tr('adminReports.last6Months')}</p>
        </Card>
        <Card>
          <h2 className="mb-3 text-base font-semibold">{tr('adminReports.newUsers')}</h2>
          <Bars data={userGrowth} max={maxUser} />
          <p className="mt-2 text-xs text-muted">{tr('adminReports.last6Months')}</p>
        </Card>
        <Card>
          <h2 className="mb-3 text-base font-semibold">{tr('adminReports.newMrr')}</h2>
          <Bars data={revenueTrend} max={maxRevenue} money />
          <p className="mt-2 text-xs text-muted">{tr('adminReports.revenueAddedLast6Months')}</p>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-3 text-base font-semibold">{tr('adminReports.subscriptionsByPlan')}</h2>
          {subSegments.length === 0 ? (
            <EmptyState icon={CreditCard} title={tr('adminReports.noActiveSubscriptions')} />
          ) : (
            <div className="flex items-center gap-4">
              <Donut segments={subSegments} total={activeSubs.length} />
              <ul className="space-y-1.5 text-xs">
                {subSegments.map((s) => (
                  <li key={s.label} className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                    <span className="text-muted">{s.label}</span>
                    <span className="ml-auto font-semibold">{s.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
        <Card className="lg:col-span-2">
          <h2 className="mb-3 text-base font-semibold">{tr('adminReports.activityVolume')}</h2>
          <Bars data={activityByDay} max={maxActivity} />
          <p className="mt-2 text-xs text-muted">{tr('adminReports.auditedActionsPerDayLast14')}</p>
        </Card>
      </div>
    </div>
  );
}

async function AdminReportsReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminReports.reportsAmpAnalytics')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('reports.growthRevenueAndEngagementAcross')}</p>
      </div>
      <ErrorState message={tr('reports.couldNotLoadReportsFrom')} />
      <a href="/admin/reports" className="text-sm font-medium text-brand-text underline">{tr('reports.refreshReports')}</a>
    </div>
  );
}
