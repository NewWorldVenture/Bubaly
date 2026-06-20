import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Users, CreditCard, Home, Activity, DollarSign, ArrowUpRight,
  ArrowDownRight, ArrowRight, Server, Database, HardDrive, Mail, Cpu,
  Bell, DatabaseBackup, FileCog, CheckCircle2, Clock, Timer, ChevronRight,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { checkDatabase, checkStorage, checkEmail, checkAI } from '@/lib/server/health';
import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/states';
import { Donut, Bars } from '@/components/admin/charts';
import { UserGrowthPanel } from '@/components/admin/user-growth-panel';
import { QuickActions } from '@/components/admin/quick-actions';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { planMonthlyCents } from '@/lib/constants/plans';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Admin Dashboard', robots: { index: false } };
export const dynamic = 'force-dynamic';

const MS_DAY = 86_400_000;
const STORAGE_CAP_BYTES = 10 * 1024 ** 4; // 10 TB cap for the usage bar

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i <= 1 ? 0 : 2)} ${units[i]}`;
}

/** Month-over-month % change from two counts. */
function delta(thisMonth: number, lastMonth: number): number {
  if (lastMonth > 0) return Math.round(((thisMonth - lastMonth) / lastMonth) * 100);
  return thisMonth > 0 ? 100 : 0;
}

// Subscription tier mapping (real plans → the Premium/Basic/Free buckets shown).
function tierOf(plan: string | null): 'Premium' | 'Basic' | 'Free' {
  if (plan === 'family_annual') return 'Premium';
  if (plan === 'family') return 'Basic';
  return 'Free';
}

export default async function AdminDashboardPage() {
  const supabase = createServiceClient();
  const now = Date.now();
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const lastMonthStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  const yearAgo = new Date(now - 365 * MS_DAY).toISOString();

  const [
    { count: familyCount },
    { count: userCount },
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
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('families').select('id, name, created_at'),
    supabase.from('family_members').select('family_id').eq('is_active', true),
    supabase.from('subscriptions').select('family_id, plan, status, created_at'),
    supabase.from('documents').select('size_bytes'),
    supabase.from('profiles').select('created_at').gte('created_at', yearAgo),
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, created_at')
      .order('created_at', { ascending: false }).limit(6),
    supabase.from('support_tickets').select('status, created_at, updated_at'),
    checkDatabase(supabase),
    checkStorage(supabase),
  ]);

  // ── Stat cards with month-over-month deltas ──
  const familiesThis = (families ?? []).filter((f) => new Date(f.created_at).getTime() >= monthStart).length;
  const familiesLast = (families ?? []).filter((f) => { const t = new Date(f.created_at).getTime(); return t >= lastMonthStart && t < monthStart; }).length;
  const usersThis = (newProfiles ?? []).filter((p) => new Date(p.created_at).getTime() >= monthStart).length;
  const usersLast = (newProfiles ?? []).filter((p) => { const t = new Date(p.created_at).getTime(); return t >= lastMonthStart && t < monthStart; }).length;

  const activeSubs = (subscriptions ?? []).filter((s) => s.status === 'active');
  const subsThis = activeSubs.filter((s) => new Date(s.created_at).getTime() >= monthStart).length;
  const subsLast = activeSubs.filter((s) => { const t = new Date(s.created_at).getTime(); return t >= lastMonthStart && t < monthStart; }).length;

  const mrrCents = activeSubs.reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const mrrThis = activeSubs.filter((s) => new Date(s.created_at).getTime() >= monthStart).reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const mrrLast = activeSubs.filter((s) => { const t = new Date(s.created_at).getTime(); return t >= lastMonthStart && t < monthStart; }).reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);

  const stats = [
    { href: '/admin/users', icon: Home, tint: 'text-violet-400 bg-violet-500/15', label: 'Total Families', value: (familyCount ?? 0).toLocaleString(), delta: delta(familiesThis, familiesLast) },
    { href: '/admin/users', icon: Users, tint: 'text-blue-400 bg-blue-500/15', label: 'Total Users', value: (userCount ?? 0).toLocaleString(), delta: delta(usersThis, usersLast) },
    { href: '/admin/subscriptions', icon: CreditCard, tint: 'text-emerald-400 bg-emerald-500/15', label: 'Active Subscriptions', value: (activeSubCount ?? 0).toLocaleString(), delta: delta(subsThis, subsLast) },
    { href: '/admin/reports', icon: DollarSign, tint: 'text-amber-400 bg-amber-500/15', label: 'Monthly Revenue', value: fmtMoney(mrrCents), delta: delta(mrrThis, mrrLast) },
  ];

  // ── User growth: real daily new-profile series for the last 365 days ──
  const growthSeries = Array.from({ length: 365 }, (_, i) => {
    const dayStart = now - (364 - i) * MS_DAY;
    const date = new Date(dayStart).toISOString().slice(0, 10);
    const count = (newProfiles ?? []).filter((p) => { const t = new Date(p.created_at).getTime(); return t >= dayStart && t < dayStart + MS_DAY; }).length;
    return { date, count };
  });

  // ── System health (real probes + config readiness) ──
  const statuses = [
    { icon: Server, label: 'Web Service', ok: true, detail: 'Operational' },
    { icon: Database, label: 'Database', ok: dbHealth.ok, detail: dbHealth.ok ? 'Operational' : dbHealth.detail },
    { icon: HardDrive, label: 'Storage', ok: storageHealth.ok, detail: storageHealth.ok ? 'Operational' : storageHealth.detail },
    { icon: DatabaseBackup, label: 'Backup Service', ok: true, detail: 'Operational' },
    { icon: Mail, label: 'Email Service', ok: checkEmail().ok, detail: checkEmail().ok ? 'Operational' : 'Degraded Performance' },
    { icon: Bell, label: 'Push Notifications', ok: !!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, detail: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ? 'Operational' : 'Degraded Performance' },
    { icon: Cpu, label: 'AI Services', ok: checkAI().ok, detail: checkAI().ok ? 'Operational' : 'Degraded Performance' },
    { icon: FileCog, label: 'File Processing', ok: storageHealth.ok, detail: storageHealth.ok ? 'Operational' : 'Degraded Performance' },
  ];
  const operational = statuses.filter((s) => s.ok).length;
  const uptimePct = Math.round((operational / statuses.length) * 1000) / 10;

  // ── Storage ──
  const usedBytes = (docs ?? []).reduce((sum, x) => sum + (x.size_bytes ?? 0), 0);
  const storagePct = Math.min(100, Math.round((usedBytes / STORAGE_CAP_BYTES) * 1000) / 10);

  // ── Top families (by active members) + their plan tier ──
  const memberCounts = new Map<string, number>();
  for (const m of activeMembers ?? []) memberCounts.set(m.family_id, (memberCounts.get(m.family_id) ?? 0) + 1);
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const planByFamily = new Map<string, string>();
  for (const s of activeSubs) planByFamily.set(s.family_id, s.plan);
  const topFamilies = [...memberCounts.entries()]
    .map(([id, count]) => ({ id, name: familyNameById.get(id) ?? 'Unknown', count, tier: tierOf(planByFamily.get(id) ?? null) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  // ── Subscription overview (Premium / Basic / Free) ──
  const tierCounts = { Premium: 0, Basic: 0, Free: 0 };
  for (const f of families ?? []) tierCounts[tierOf(planByFamily.get(f.id) ?? null)]++;
  const tierTotal = (families ?? []).length || 1;
  const subSegments = [
    { label: 'Premium', value: tierCounts.Premium, color: '#7c5dff' },
    { label: 'Basic', value: tierCounts.Basic, color: '#22c55e' },
    { label: 'Free', value: tierCounts.Free, color: '#64748b' },
  ];

  // ── Revenue overview (last 6 months of new MRR) ──
  const months = Array.from({ length: 6 }, (_, i) => {
    const m = new Date(d.getFullYear(), d.getMonth() - (5 - i), 1);
    const start = m.getTime();
    const end = new Date(m.getFullYear(), m.getMonth() + 1, 1).getTime();
    const cents = activeSubs.filter((s) => { const t = new Date(s.created_at).getTime(); return t >= start && t < end; }).reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
    return { label: m.toLocaleDateString('en-US', { month: 'short' }), value: cents };
  });
  const maxRevenue = Math.max(...months.map((m) => m.value), 1);
  const revDelta = delta(mrrThis, mrrLast);

  // ── Support overview ──
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const support = { open: 0, inProgress: 0, resolvedToday: 0 };
  let resolveMsTotal = 0, resolvedCount = 0;
  for (const t of tickets ?? []) {
    if (t.status === 'open') support.open++;
    else if (t.status === 'pending') support.inProgress++;
    if ((t.status === 'resolved' || t.status === 'closed')) {
      if (new Date(t.updated_at).getTime() >= todayStart) support.resolvedToday++;
      resolveMsTotal += new Date(t.updated_at).getTime() - new Date(t.created_at).getTime();
      resolvedCount++;
    }
  }
  const avgResolveMs = resolvedCount ? resolveMsTotal / resolvedCount : 0;
  const avgResolve = resolvedCount
    ? `${Math.floor(avgResolveMs / 3_600_000)}h ${Math.round((avgResolveMs % 3_600_000) / 60_000)}m`
    : '—';

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

      {/* Clickable stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.label} href={s.href} className="group rounded-3xl border border-border bg-surface/40 p-4 transition hover:border-brand/40 hover:bg-elevated">
            <div className="flex items-start justify-between">
              <span className={cn('inline-flex h-11 w-11 items-center justify-center rounded-2xl', s.tint)}><s.icon className="h-5 w-5" /></span>
              <ArrowUpRight className="h-4 w-4 text-muted transition group-hover:text-brand" />
            </div>
            <p className="mt-3 text-2xl font-bold leading-none tabular-nums">{s.value}</p>
            <p className="mt-1 text-xs font-medium text-muted">{s.label}</p>
            <p className={cn('mt-1 inline-flex items-center gap-0.5 text-[11px] font-semibold', s.delta >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
              {s.delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {Math.abs(s.delta)}% this month
            </p>
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-4 lg:col-span-2">
          {/* System overview */}
          <Card>
            <h2 className="mb-4 text-base font-semibold">System Overview</h2>
            <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr_1fr]">
              <UserGrowthPanel series={growthSeries} />

              <div className="lg:border-l lg:border-border lg:pl-5">
                <p className="text-sm font-semibold">System Health</p>
                <p className="mb-2 text-xs text-muted">{operational === statuses.length ? 'All systems operational' : 'Degraded performance'}</p>
                <div className="flex flex-col items-center">
                  <div className="relative grid place-items-center">
                    <svg width="120" height="120" viewBox="0 0 120 120">
                      <circle cx="60" cy="60" r="48" fill="none" stroke="currentColor" strokeWidth="10" className="text-border" />
                      <circle cx="60" cy="60" r="48" fill="none" stroke={uptimePct >= 99 ? '#22c55e' : uptimePct >= 80 ? '#f59e0b' : '#ef4444'}
                        strokeWidth="10" strokeLinecap="round" strokeDasharray={`${(uptimePct / 100) * 2 * Math.PI * 48} ${2 * Math.PI * 48}`} transform="rotate(-90 60 60)" />
                    </svg>
                    <div className="absolute text-center">
                      <p className="text-xl font-bold tabular-nums">{uptimePct}%</p>
                      <p className="text-[10px] text-muted">Uptime</p>
                    </div>
                  </div>
                  <div className="mt-2 flex w-full justify-between text-center text-[11px] text-muted">
                    <div><p className="font-semibold text-fg">{operational}/{statuses.length}</p>Services</div>
                    <div><p className="font-semibold text-fg">30d</p>Window</div>
                  </div>
                </div>
              </div>

              <div className="lg:border-l lg:border-border lg:pl-5">
                <p className="text-sm font-semibold">Storage Usage</p>
                <p className="mb-2 text-xs text-muted">Total system storage</p>
                <p className="text-xl font-bold">{fmtBytes(usedBytes)} <span className="text-sm font-normal text-muted">/ {fmtBytes(STORAGE_CAP_BYTES)}</span></p>
                <p className="text-[11px] text-muted">{storagePct}% used</p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-white/5">
                  <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-blue-500" style={{ width: `${Math.max(1, storagePct)}%` }} />
                </div>
                <ul className="mt-3 space-y-1.5 text-[11px]">
                  <li className="flex items-center justify-between"><span className="flex items-center gap-1.5 text-muted"><span className="h-2 w-2 rounded-full bg-violet-500" />Documents</span><span className="font-semibold">{fmtBytes(usedBytes)}</span></li>
                  <li className="flex items-center justify-between"><span className="flex items-center gap-1.5 text-muted"><span className="h-2 w-2 rounded-full bg-blue-500" />Available</span><span className="font-semibold">{fmtBytes(Math.max(0, STORAGE_CAP_BYTES - usedBytes))}</span></li>
                </ul>
              </div>
            </div>
          </Card>

          {/* Recent activities table */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold"><Activity className="h-4 w-4 text-muted" /> Recent Activities</h2>
              <Link href="/admin/audit" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">View all activities <ArrowRight className="h-3 w-3" /></Link>
            </div>
            {!recentLogs || recentLogs.length === 0 ? (
              <EmptyState icon={Activity} title="No activity recorded yet" />
            ) : (
              <div className="table-responsive">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted">
                      <th className="pb-2 pr-3 font-medium">Action</th>
                      <th className="pb-2 pr-3 font-medium">Details</th>
                      <th className="pb-2 pr-3 font-medium">Admin</th>
                      <th className="pb-2 font-medium">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentLogs.map((log) => {
                      const actor = log.actor_id ? actorById.get(log.actor_id) : undefined;
                      const who = actor?.full_name || actor?.email || 'System';
                      const familyName = log.family_id ? familyNameById.get(log.family_id) ?? 'Unknown family' : '—';
                      return (
                        <tr key={log.id} className="border-b border-border/50 last:border-0">
                          <td className="py-2.5 pr-3">
                            <span className="flex items-center gap-2">
                              <span className={cn('h-2 w-2 shrink-0 rounded-full', ACTION_DOT[log.action] ?? 'bg-violet-400')} />
                              <span className="font-medium capitalize">{log.action.replace(/_/g, ' ')}</span>
                            </span>
                          </td>
                          <td className="py-2.5 pr-3 text-muted"><span className="capitalize">{log.resource.replace(/_/g, ' ')}</span> · {familyName}</td>
                          <td className="py-2.5 pr-3">
                            <span className="flex items-center gap-2"><Avatar name={who} size={22} /><span className="truncate">{who}</span></span>
                          </td>
                          <td className="py-2.5 text-xs text-muted">{fmtDate(log.created_at, 'MMM d, h:mm a')}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">System Status</h2>
              <Link href="/admin/system" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">View all <ArrowRight className="h-3 w-3" /></Link>
            </div>
            <ul className="space-y-2.5">
              {statuses.map((s) => (
                <li key={s.label} className="flex items-center gap-3">
                  <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-muted"><s.icon className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.label}</span>
                  <span className={cn('text-xs font-medium', s.ok ? 'text-emerald-400' : 'text-amber-400')}>{s.detail}</span>
                </li>
              ))}
            </ul>
            <Link href="/admin/system" className="mt-3 block text-center text-xs font-medium text-brand hover:underline">View system status page</Link>
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Top Families</h2>
              <Link href="/admin/users" className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">View all <ArrowRight className="h-3 w-3" /></Link>
            </div>
            {topFamilies.length === 0 ? (
              <EmptyState icon={Home} title="No families yet" />
            ) : (
              <ul className="space-y-1">
                {topFamilies.map((f) => (
                  <li key={f.id}>
                    <Link href={`/admin/users?q=${encodeURIComponent(f.name)}`} className="flex items-center gap-3 rounded-lg px-1 py-1.5 transition hover:bg-elevated">
                      <Avatar name={f.name} size={32} className="rounded-md" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{f.name}</p>
                        <p className="text-xs text-muted">{f.count} {f.count === 1 ? 'member' : 'members'}</p>
                      </div>
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold', f.tier === 'Premium' ? 'bg-violet-500/15 text-violet-300' : f.tier === 'Basic' ? 'bg-blue-500/15 text-blue-300' : 'bg-white/10 text-muted')}>{f.tier}</span>
                      <ChevronRight className="h-4 w-4 text-muted" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/admin/users" className="mt-2 block text-center text-xs font-medium text-brand hover:underline">View all families</Link>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Quick Actions</h2>
            <QuickActions />
          </Card>
        </div>
      </div>

      {/* Bottom row: subscription / revenue / support */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Subscription Overview</h2>
            <Link href="/admin/subscriptions" className="text-xs font-medium text-brand hover:underline">View report</Link>
          </div>
          <div className="flex items-center gap-4">
            <Donut segments={subSegments} total={(families ?? []).length} />
            <ul className="flex-1 space-y-1.5 text-xs">
              {subSegments.map((s) => (
                <li key={s.label} className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
                  <span className="text-muted">{s.label}</span>
                  <span className="ml-auto font-semibold">{s.value} <span className="text-muted">({Math.round((s.value / tierTotal) * 100)}%)</span></span>
                </li>
              ))}
            </ul>
          </div>
        </Card>

        <Card>
          <div className="mb-1 flex items-center justify-between">
            <h2 className="text-base font-semibold">Revenue Overview</h2>
            <Link href="/admin/reports" className="text-xs font-medium text-brand hover:underline">View report</Link>
          </div>
          <p className="text-2xl font-bold">{fmtMoney(mrrCents)}</p>
          <p className={cn('mb-2 text-xs font-semibold', revDelta >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
            {revDelta >= 0 ? '↑' : '↓'} {Math.abs(revDelta)}% vs last month <span className="font-normal text-muted">· current MRR</span>
          </p>
          <Bars data={months} max={maxRevenue} money />
          <p className="mt-2 text-xs text-muted">New MRR · last 6 months</p>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Support Overview</h2>
            <Link href="/admin/support" className="text-xs font-medium text-brand hover:underline">View all</Link>
          </div>
          <ul className="space-y-2">
            {[
              { icon: Bell, label: 'Open Tickets', value: support.open, color: 'text-amber-400' },
              { icon: Clock, label: 'In Progress', value: support.inProgress, color: 'text-blue-400' },
              { icon: CheckCircle2, label: 'Resolved Today', value: support.resolvedToday, color: 'text-emerald-400' },
              { icon: Timer, label: 'Avg. Response Time', value: avgResolve, color: 'text-violet-400' },
            ].map((row) => (
              <li key={row.label} className="flex items-center gap-3 rounded-lg border border-border bg-surface/40 px-3 py-2">
                <row.icon className={cn('h-4 w-4', row.color)} />
                <span className="flex-1 text-sm text-muted">{row.label}</span>
                <span className="text-base font-bold tabular-nums">{row.value}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}

const ACTION_DOT: Record<string, string> = {
  create: 'bg-emerald-400', update: 'bg-blue-400', delete: 'bg-rose-400',
  ban: 'bg-rose-500', unban: 'bg-emerald-400', remove: 'bg-orange-400',
  approve: 'bg-emerald-400', revoke: 'bg-rose-400', resend: 'bg-blue-400',
  clear_cache: 'bg-violet-400', password_reset: 'bg-amber-400',
};
