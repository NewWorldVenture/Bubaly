import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Users, UsersRound, CreditCard, Home, Activity, DollarSign, TrendingUp,
  HardDrive, Server, Database, Mail, Cloud, Cpu, LifeBuoy, ShieldCheck,
  BarChart3, Plug, ArrowUpRight,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { checkDatabase, checkStorage, checkEmail, checkAI } from '@/lib/server/health';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/states';
import { Sparkline, Gauge, Donut, Bars } from '@/components/admin/charts';
import { fmtMoney, fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Admin Dashboard', robots: { index: false } };
// Live, cross-family data via the service-role client — always render fresh.
export const dynamic = 'force-dynamic';

const MS_DAY = 86_400_000;
const STORAGE_CAP_BYTES = 5 * 1024 ** 4; // 5 TB soft cap for the usage gauge

/** Normalize a stored plan slug to monthly cents. */
function planMonthlyCents(plan: string | null): number {
  const p = (plan ?? '').toLowerCase();
  if (p.includes('plus')) return 1900;
  if (p.startsWith('family')) return 900;
  return 0;
}

function planLabel(plan: string | null): string {
  const p = (plan ?? '').toLowerCase();
  if (p.includes('plus')) return 'Family Plus';
  if (p.startsWith('family')) return 'Family';
  return 'Starter';
}

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default async function AdminDashboardPage() {
  // Service-role client: the one place that intentionally bypasses RLS, gated
  // entirely by the super-admin check in admin/layout.tsx.
  const supabase = createServiceClient();
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * MS_DAY).toISOString();

  const [
    { count: familyCount },
    { count: userCount },
    { count: activeMemberCount },
    { count: activeSubCount },
    { data: families },
    { data: activeMembers },
    { data: subscriptions },
    { data: docs },
    { data: newProfiles },
    { data: recentLogs },
    { data: tickets },
    dbHealth,
    storageHealth,
  ] = await Promise.all([
    supabase.from('families').select('id', { count: 'exact', head: true }),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('families').select('id, name, created_at').order('created_at', { ascending: false }),
    supabase.from('family_members').select('family_id').eq('is_active', true),
    supabase.from('subscriptions').select('plan, status, created_at'),
    supabase.from('documents').select('size_bytes'),
    supabase.from('profiles').select('created_at').gte('created_at', thirtyDaysAgo),
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, created_at')
      .order('created_at', { ascending: false }).limit(8),
    supabase.from('support_tickets').select('status'),
    checkDatabase(supabase),
    checkStorage(supabase),
  ]);

  // ── Stat cards ──
  const newFamiliesThisMonth = (families ?? []).filter((f) => f.created_at >= monthStart).length;
  const activeSubs = (subscriptions ?? []).filter((s) => s.status === 'active');
  const monthlyRevenueCents = activeSubs.reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const newUsersThisMonth = (newProfiles ?? []).filter((p) => p.created_at >= monthStart).length;

  // ── System status (real probes + configuration readiness) ──
  const statuses = [
    { icon: Server, label: 'Web Server', ok: true, detail: 'Operational' },
    { icon: Cloud, label: 'API Server', ok: true, detail: 'Operational' },
    { icon: Database, label: 'Database', ok: dbHealth.ok, detail: dbHealth.ok ? `${dbHealth.latencyMs ?? 0} ms` : dbHealth.detail },
    { icon: Mail, label: 'Email Service', ...statusFrom(checkEmail()) },
    { icon: HardDrive, label: 'Storage', ok: storageHealth.ok, detail: storageHealth.ok ? `${storageHealth.latencyMs ?? 0} ms` : storageHealth.detail },
    { icon: Cpu, label: 'AI Processing', ...statusFrom(checkAI()) },
  ];
  const operational = statuses.filter((s) => s.ok).length;
  const healthPct = Math.round((operational / statuses.length) * 100);

  // ── User growth sparkline (last 30 days, daily new profiles) ──
  const growthByDay = Array.from({ length: 30 }, (_, i) => {
    const dayStart = now - (29 - i) * MS_DAY;
    return (newProfiles ?? []).filter((p) => {
      const t = new Date(p.created_at).getTime();
      return t >= dayStart && t < dayStart + MS_DAY;
    }).length;
  });
  const newUsers30 = growthByDay.reduce((a, b) => a + b, 0);

  // ── Storage usage ──
  const usedBytes = (docs ?? []).reduce((sum, d) => sum + (d.size_bytes ?? 0), 0);
  const storagePct = Math.min(100, Math.round((usedBytes / STORAGE_CAP_BYTES) * 100));

  // ── Top families by active members ──
  const memberCounts = new Map<string, number>();
  for (const m of activeMembers ?? []) memberCounts.set(m.family_id, (memberCounts.get(m.family_id) ?? 0) + 1);
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const topFamilies = [...memberCounts.entries()]
    .map(([id, count]) => ({ id, name: familyNameById.get(id) ?? 'Unknown', count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ── Subscription overview (by plan) ──
  const planColors: Record<string, string> = { Family: '#7c5dff', 'Family Plus': '#22c55e', Starter: '#64748b' };
  const planBuckets = new Map<string, number>();
  for (const s of activeSubs) planBuckets.set(planLabel(s.plan), (planBuckets.get(planLabel(s.plan)) ?? 0) + 1);
  const subSegments = [...planBuckets.entries()].map(([label, value]) => ({ label, value, color: planColors[label] ?? '#64748b' }));

  // ── Revenue overview (last 6 months of new MRR) ──
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - (5 - i), 1);
    const start = d.getTime();
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    const cents = (subscriptions ?? [])
      .filter((s) => { const t = new Date(s.created_at).getTime(); return t >= start && t < end; })
      .reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
    return { label: d.toLocaleDateString('en-US', { month: 'short' }), cents };
  });
  const maxRevenue = Math.max(...months.map((m) => m.cents), 1);

  // ── Support overview ──
  const ticketCounts = { open: 0, pending: 0, resolved: 0 };
  for (const t of tickets ?? []) {
    if (t.status === 'open') ticketCounts.open++;
    else if (t.status === 'pending') ticketCounts.pending++;
    else if (t.status === 'resolved' || t.status === 'closed') ticketCounts.resolved++;
  }

  // ── Recent activity actors ──
  const actorIds = [...new Set((recentLogs ?? []).map((l) => l.actor_id).filter((x): x is string => !!x))];
  const { data: actors } = actorIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', actorIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const actorById = new Map((actors ?? []).map((a) => [a.id, a]));

  return (
    <div className="module-page space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Admin Dashboard</h1>
        <p className="mt-1 text-sm text-muted">Manage and monitor your FamilyOS system, users, and services.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-4 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={Home} tint="text-violet-400 bg-violet-500/15" label="Total Families" value={familyCount?.toLocaleString() ?? '0'} sub={`${newFamiliesThisMonth} new this month`} />
            <StatCard icon={Users} tint="text-blue-400 bg-blue-500/15" label="Active Users" value={userCount?.toLocaleString() ?? '0'} sub={`${newUsersThisMonth} new this month`} />
            <StatCard icon={CreditCard} tint="text-emerald-400 bg-emerald-500/15" label="Subscriptions" value={activeSubCount?.toLocaleString() ?? '0'} sub={`${activeMemberCount?.toLocaleString() ?? 0} active members`} />
            <StatCard icon={DollarSign} tint="text-amber-400 bg-amber-500/15" label="Monthly Revenue" value={fmtMoney(monthlyRevenueCents)} sub={`from ${activeSubs.length} active plans`} />
          </div>

          {/* System overview */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">User Growth</p>
                <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-emerald-400"><TrendingUp className="h-3.5 w-3.5" />+{newUsers30}</span>
              </div>
              <Sparkline data={growthByDay} />
              <p className="mt-2 text-xs text-muted">New users · last 30 days</p>
            </Card>
            <Card>
              <p className="mb-2 text-sm font-semibold">System Health</p>
              <div className="flex items-center justify-center py-1">
                <Gauge pct={healthPct} color={healthPct >= 99 ? '#22c55e' : healthPct >= 80 ? '#f59e0b' : '#ef4444'} />
              </div>
              <p className="mt-1 text-center text-xs text-muted">{operational}/{statuses.length} services operational</p>
            </Card>
            <Card>
              <p className="mb-2 text-sm font-semibold">Storage Usage</p>
              <div className="flex items-center justify-center py-1">
                <Gauge pct={storagePct} color="#7c5dff" centerLabel={fmtBytes(usedBytes)} />
              </div>
              <p className="mt-1 text-center text-xs text-muted">of {fmtBytes(STORAGE_CAP_BYTES)} capacity</p>
            </Card>
          </div>

          {/* Recent activities */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold"><Activity className="h-4 w-4 text-muted" /> Recent Activities</h2>
              <Link href="/admin/audit" className="text-xs font-medium text-brand hover:underline">View all</Link>
            </div>
            {!recentLogs || recentLogs.length === 0 ? (
              <EmptyState icon={Activity} title="No activity recorded yet" />
            ) : (
              <ul className="space-y-1.5">
                {recentLogs.map((log) => {
                  const actor = log.actor_id ? actorById.get(log.actor_id) : undefined;
                  const who = actor?.full_name || actor?.email || 'System';
                  const familyName = log.family_id ? familyNameById.get(log.family_id) ?? 'Unknown family' : '—';
                  return (
                    <li key={log.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                      <Avatar name={who} size={28} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate"><span className="font-medium">{who}</span> <span className="text-muted">· {log.action} {log.resource}</span></p>
                        <p className="truncate text-xs text-muted">{familyName}</p>
                      </div>
                      <span className="shrink-0 text-xs text-muted">{fmtDate(log.created_at, 'MMM d, h:mm a')}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">System Status</h2>
              <Badge tone={operational === statuses.length ? 'success' : 'danger'}>{operational === statuses.length ? 'All systems go' : 'Degraded'}</Badge>
            </div>
            <ul className="space-y-2.5">
              {statuses.map((s) => (
                <li key={s.label} className="flex items-center gap-3">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-muted"><s.icon className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="truncate text-xs text-muted">{s.detail}</p>
                  </div>
                  <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Top Families</h2>
              <Link href="/admin/users" className="text-xs font-medium text-brand hover:underline">View all</Link>
            </div>
            {topFamilies.length === 0 ? (
              <EmptyState icon={Home} title="No families yet" />
            ) : (
              <ul className="space-y-2.5">
                {topFamilies.map((f, i) => (
                  <li key={f.id} className="flex items-center gap-3">
                    <span className="w-4 shrink-0 text-center text-xs font-semibold text-muted">{i + 1}</span>
                    <Avatar name={f.name} size={30} className="rounded-md" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
                    <span className="shrink-0 text-xs text-muted">{f.count} {f.count === 1 ? 'member' : 'members'}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {/* Bottom row: overviews + quick actions */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <h2 className="mb-3 text-base font-semibold">Subscription Overview</h2>
          {subSegments.length === 0 ? (
            <EmptyState icon={CreditCard} title="No active subscriptions" />
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

        <Card>
          <h2 className="mb-3 text-base font-semibold">Revenue Overview</h2>
          <Bars data={months.map((m) => ({ label: m.label, value: m.cents }))} max={maxRevenue} money />
          <p className="mt-2 text-xs text-muted">New MRR · last 6 months</p>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold"><LifeBuoy className="h-4 w-4 text-muted" /> Support Overview</h2>
            <Link href="/admin/support" className="text-xs font-medium text-brand hover:underline">View all</Link>
          </div>
          <ul className="space-y-2.5">
            {[
              { label: 'Open', value: ticketCounts.open, color: 'text-amber-400' },
              { label: 'Pending', value: ticketCounts.pending, color: 'text-blue-400' },
              { label: 'Resolved', value: ticketCounts.resolved, color: 'text-emerald-400' },
            ].map((row) => (
              <li key={row.label} className="flex items-center justify-between rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                <span className="text-muted">{row.label}</span>
                <span className={`text-lg font-bold ${row.color}`}>{row.value}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold">Quick Actions</h2>
          <div className="grid grid-cols-2 gap-2">
            {[
              { href: '/admin/users', label: 'Users', icon: UsersRound },
              { href: '/admin/subscriptions', label: 'Billing', icon: CreditCard },
              { href: '/admin/system', label: 'System', icon: Activity },
              { href: '/admin/security', label: 'Security', icon: ShieldCheck },
              { href: '/admin/content', label: 'Content', icon: BarChart3 },
              { href: '/admin/integrations', label: 'Integrations', icon: Plug },
            ].map((a) => (
              <Link key={a.href} href={a.href} className="group flex flex-col items-start gap-2 rounded-xl border border-border bg-surface/40 p-3 transition hover:border-brand/40 hover:bg-elevated">
                <a.icon className="h-5 w-5 text-brand" />
                <span className="flex items-center gap-1 text-xs font-medium">{a.label}<ArrowUpRight className="h-3 w-3 text-muted transition group-hover:text-brand" /></span>
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function statusFrom(h: { ok: boolean; detail: string }) {
  return { ok: h.ok, detail: h.ok ? 'Operational' : h.detail };
}

function StatCard({ icon: Icon, tint, label, value, sub }: {
  icon: React.ComponentType<{ className?: string }>; tint: string; label: string; value: string; sub: string;
}) {
  return (
    <Card className="flex flex-col gap-3">
      <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${tint}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-xs font-medium text-muted">{label}</p>
        <p className="mt-0.5 text-[11px] text-muted">{sub}</p>
      </div>
    </Card>
  );
}

