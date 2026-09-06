import type { Metadata } from 'next';
import { CheckCircle2, XCircle, Users, Home, DollarSign, FolderLock, Database, RefreshCw } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { GrowthChart } from '@/components/admin/growth-chart';
import { checkDatabase, checkStorage, checkAuth, checkStripe, checkEmail, type HealthCheck } from '@/lib/server/health';
import { PLANS } from '@/lib/constants/plans';
import { fmtMoney } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'System Overview', robots: { index: false } };
export const dynamic = 'force-dynamic';

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
  const supabase = createServiceClient();

  const [
    healthResults,
    userCountResult,
    familyCountResult,
    profilesResult,
    subscriptionsResult,
    documentsResult,
  ] = await Promise.all([
    Promise.all([checkDatabase(supabase), checkStorage(supabase), checkAuth(supabase), checkStripe(), Promise.resolve(checkEmail())]),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('families').select('id', { count: 'exact', head: true }),
    supabase.from('profiles').select('created_at').order('created_at', { ascending: false }).limit(2000),
    supabase.from('subscriptions').select('plan, status'),
    supabase.from('documents').select('size_bytes'),
  ]);

  const readError = [
    userCountResult.error,
    familyCountResult.error,
    profilesResult.error,
    subscriptionsResult.error,
    documentsResult.error,
  ].find(Boolean);
  if (readError) {
    console.error('[admin-system] usage read failed', readError);
    return <AdminSystemReadError />;
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
  const newUsers30d = (profiles ?? []).filter((p) => new Date(p.created_at) >= new Date(Date.now() - 30 * 86400000)).length;

  const allHealthy = healthResults.every((h) => h.ok);
  const environment = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'development';
  const region = process.env.VERCEL_REGION ?? 'local';

  return (
    <div className="module-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminSystem.systemOverview')}</h1>
          <p className="mt-1 text-sm text-muted">{t('adminSystem.liveConnectivityChecksAndRealUsage')}</p>
        </div>
        <span className="text-xs text-muted">{t('adminSystem.checked')} {new Date().toLocaleString()}</span>
      </div>

      <div className="grid-stats">
        <StatCard icon={allHealthy ? CheckCircle2 : XCircle} label={t('adminSystem.overallStatus')} value={allHealthy ? 'All systems go' : 'Degraded'} tone={allHealthy ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger'} />
        <StatCard icon={Users} label={t('adminSystem.totalUsers')} value={(userCount ?? 0).toLocaleString()} tone="bg-brand/10 text-brand-text" />
        <StatCard icon={Home} label={t('adminSystem.activeFamilies')} value={(familyCount ?? 0).toLocaleString()} tone="bg-accent/10 text-accent" />
        <StatCard icon={DollarSign} label={t('adminSystem.monthlyRevenue')} value={fmtMoney(mrr)} tone="bg-success/10 text-success" />
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
              <p className="text-xl font-bold leading-none">{fmtBytes(storageBytes)}</p>
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
        <GrowthChart timestamps={(profiles ?? []).map((p) => p.created_at)} />
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

function AdminSystemReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">System Overview</h1>
        <p className="mt-1 text-sm text-muted">Live connectivity checks and real usage measured just now.</p>
      </div>
      <ErrorState message="Could not load system usage from Supabase. Refresh and try again." />
      <a href="/admin/system" className="text-sm font-medium text-brand-text underline">Refresh system overview</a>
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
