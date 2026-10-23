import type { Metadata } from 'next';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { CheckCircle2, XCircle, Users, Home, DollarSign, FolderLock, Database, RefreshCw } from 'lucide-react';
import { createServiceClient, describeConfiguredServiceKey } from '@/lib/supabase/server';
import { settle, describeReadError, credentialHint } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { GrowthChart } from '@/components/admin/growth-chart';
import { checkDatabase, checkStorage, checkAuth, checkStripe, checkEmail, type HealthCheck } from '@/lib/server/health';
import { PLANS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';
import { getFormat } from '@/lib/utils/format-server';
import { ADMIN_ZONE, lastUtcDays } from '@/lib/admin/clock';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('system.systemOverview'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

/** Rows a summed read may page through before it is reported as a prefix (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function HealthRow({ check }: { check: HealthCheck }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-3">
        {check.ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
        <span className="text-sm">{check.name}</span>
      </div>
      <div className="text-right">
        <p className={`text-xs font-semibold ${check.ok ? 'text-success' : 'text-danger'}`}>{check.ok ? 'Operational' : 'Unavailable'}</p>
        <p className="text-[11px] text-muted">{check.latencyMs !== null ? `${check.latencyMs}ms` : check.detail}</p>
      </div>
    </div>
  );
}

export default async function AdminSystemPage() {
  const t = await getTranslations();
  // "Checked at" names its zone; a bare `toLocaleString()` was the host's zone
  // in the host's locale, and an operator could not tell which.
  const { fmtDate } = await getFormat(ADMIN_ZONE);
  const supabase = createServiceClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  // The growth chart's first day. Every account older than it is one number,
  // counted; only the accounts inside the chart are read row by row.
  const chartStart = new Date(lastUtcDays(30)[0].start).toISOString();

  const [
    healthResults,
    userCountResult,
    familyCountResult,
    newUsersResult,
    chartBaseResult,
    profilesResult,
    subscriptionsResult,
    documentsResult,
  ] = await Promise.all([
    Promise.all([checkDatabase(supabase), checkStorage(supabase), checkAuth(supabase), checkStripe(), Promise.resolve(checkEmail())]),
    settle(supabase.from('profiles').select('id', { count: 'exact', head: true })),
    settle(supabase.from('families').select('id', { count: 'exact', head: true })),
    // New users and the chart were taken from the 2,000 newest profiles, read
    // on offsets while people sign up. Past 2,000 accounts that read reached
    // its ceiling, so the banner never went away and both read zero; below
    // it, a sign-up between two pages counted someone twice.
    settle(supabase.from('profiles').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo)),
    settle(supabase.from('profiles').select('id', { count: 'exact', head: true }).lt('created_at', chartStart)),
    settle(readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('profiles').select('id, created_at').gte('created_at', chartStart);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING })),
    // Summed below, so read to a REAL ceiling: an unbounded select is answered
    // with at most `db-max-rows` (1,000) and no error, and these two tiles
    // summed that prefix as the platform's revenue and storage while the
    // profiles read beside them paged. Reaching the ceiling is an error, which
    // joins readFailures and names itself in the banner instead of rendering
    // a smaller platform than exists. Both page on the id, not on offsets:
    // a checkout or an upload landing between two pages shifted every later
    // offset by one, and one row's price or bytes was added twice.
    settle(readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('subscriptions').select('id, plan, status');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING })),
    settle(readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('documents').select('id, size_bytes');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: SUM_ROW_CEILING })),
  ]);

  // A summed read that reached its ceiling did not fail: its figure says it is
  // not shown and the ceiling banner names it, rather than $0 or 0 B beside the
  // failure banner. Any other failure is still named in that banner.
  const reachedCeiling = (res: object) => 'truncated' in res && res.truncated === true;
  const chartCeiling = reachedCeiling(profilesResult);
  const revenueCeiling = reachedCeiling(subscriptionsResult);
  const storageCeiling = reachedCeiling(documentsResult);
  const readFailures = ([
    ['user count', userCountResult],
    ['family count', familyCountResult],
    ['new user count', newUsersResult],
    ['user count before the chart', chartBaseResult],
    ['profiles', profilesResult],
    ['subscriptions', subscriptionsResult],
    ['documents', documentsResult],
  ] as const)
    .filter(([, res]) => res.error)
    .filter(([, res]) => !reachedCeiling(res))
    .map(([label, res]) => `${label}: ${describeReadError(res.error)}`);
  const unavailable = t('strategyMetrics.unavailable');
  const figuresNotShown = [
    ...(revenueCeiling ? [t('adminSystem.monthlyRevenue')] : []),
    ...(storageCeiling ? [t('adminSystem.documentStorageUsedAcrossEveryFamily')] : []),
    ...(chartCeiling ? [t('adminSystem.userGrowth')] : []),
  ];
  if (figuresNotShown.length > 0) console.warn('[admin-system] a summed read reached its ceiling; not shown:', figuresNotShown.join(', '));
  const readError = readFailures.length > 0;
  if (readError) {
    // Degraded, not fatal: every consumer below defaults an absent read to an
    // empty list or zero, so one unavailable table costs its own tile rather
    // than the page. Production's migration ledger stops at 0001-0003, so a
    // later table being absent is the normal case there, not an anomaly.
    console.warn('[admin-system] usage read failed — rendering degraded', readError);
  }

  const { count: userCount } = userCountResult;
  const { count: familyCount } = familyCountResult;
  const { data: profiles } = profilesResult;
  const { data: subscriptions } = subscriptionsResult;
  const { data: documents } = documentsResult;

  const planById = (id: string) => PLANS.find((p) => p.id === id);
  const mrr = (subscriptions ?? [])
    .filter((s) => s.status === 'active')
    .reduce((sum, s) => sum + (planById(s.plan)?.priceMonthly ?? 0), 0);

  const storageBytes = (documents ?? []).reduce((sum, d) => sum + (d.size_bytes ?? 0), 0);
  const newUsers30d = newUsersResult.count ?? 0;

  const allHealthy = healthResults.every((h) => h.ok);
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
  const region = process.env.VERCEL_REGION ?? 'local';

  return (
    <div className="module-page">
      <PartialReadBanner title={"System overview is incomplete — some reads failed:"} failures={readFailures} hint={credentialHint(readFailures, describeConfiguredServiceKey())} />
      <PartialReadBanner title={t('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })} failures={figuresNotShown} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminSystem.systemOverview')}</h1>
          <p className="mt-1 text-sm text-muted">{t('adminSystem.liveConnectivityChecksAndRealUsage')}</p>
        </div>
        <span className="text-xs text-muted">{t('adminSystem.checked')} {fmtDate(new Date(), 'MMM d, yyyy h:mm:ss a z')}</span>
      </div>

      <div className="grid-stats">
        <StatCard icon={allHealthy ? CheckCircle2 : XCircle} label={t('adminSystem.overallStatus')} value={allHealthy ? 'All systems go' : 'Degraded'} tone={allHealthy ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'} />
        <StatCard icon={Users} label={t('adminSystem.totalUsers')} value={(userCount ?? 0).toLocaleString()} tone="bg-brand/10 text-brand-text" />
        <StatCard icon={Home} label={t('adminSystem.activeFamilies')} value={(familyCount ?? 0).toLocaleString()} tone="bg-accent/10 text-accent" />
        <StatCard icon={DollarSign} label={t('adminSystem.monthlyRevenue')} value={revenueCeiling ? unavailable : fmtMoney(mrr)} tone="bg-success/10 text-success" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <div className="mb-2 flex items-center gap-2">
            <Database className="h-4 w-4 text-muted" />
            <h2 className="text-base font-semibold">{t('adminSystem.systemHealth')}</h2>
          </div>
          <p className="mb-1 text-xs text-muted">Each row is a real request made when this page loaded — Database, Storage, and Auth via Supabase; Billing via a live Stripe balance check.</p>
          <div className="divide-y divide-border">
            {healthResults.map((h) => <HealthRow key={h.name} check={h} />)}
          </div>
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold">{t('adminSystem.usageOverview')}</h2>
            <RefreshCw className="h-4 w-4 text-muted" />
          </div>
          <div className="flex items-center gap-3">
            <FolderLock className="h-5 w-5 text-brand-text" />
            <div>
              <p className="text-xl font-bold leading-none">{storageCeiling ? unavailable : fmtBytes(storageBytes)}</p>
              <p className="text-xs text-muted">{t('adminSystem.documentStorageUsedAcrossEveryFamily')}</p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <Users className="h-5 w-5 text-accent" />
            <div>
              <p className="text-xl font-bold leading-none">{newUsers30d.toLocaleString()}</p>
              <p className="text-xs text-muted">{t('adminSystem.newUsersInTheLast30')}</p>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <h2 className="mb-4 text-base font-semibold">{t('adminSystem.userGrowth')} <span className="text-muted">{t('adminSystem.last30DaysCumulative')}</span></h2>
        {chartCeiling
          ? <p className="text-sm text-muted">{unavailable}</p>
          : <GrowthChart timestamps={(profiles ?? []).map((p) => p.created_at)} base={chartBaseResult.count ?? 0} />}
      </Card>

      <Card>
        <h2 className="mb-4 text-base font-semibold">{t('adminSystem.deploymentInformation')}</h2>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">{t('adminSystem.environment')}</dt>
            <dd className="mt-0.5"><Badge tone="brand">{environment}</Badge></dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('adminSystem.region')}</dt>
            <dd className="mt-0.5 font-medium">{region}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Node.js</dt>
            <dd className="mt-0.5 font-medium">{process.version}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t('adminSystem.database')}</dt>
            <dd className="mt-0.5 font-medium">{t('adminSystem.supabasePostgres')}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}

async function AdminSystemReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('system.systemOverview')}</h1>
        <p className="mt-1 text-sm text-muted">{t('system.liveConnectivityChecksAndReal')}</p>
      </div>
      <ErrorState message={t('system.couldNotLoadSystemUsage')} />
      <a href="/admin/system" className="text-sm font-medium text-brand-text underline">{t('system.refreshSystemOverview')}</a>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
