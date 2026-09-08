import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Users, UsersRound, CreditCard, Home, Activity, DollarSign, TrendingUp,
  HardDrive, Server, Database, Mail, Cloud, Cpu, LifeBuoy, ShieldCheck,
  BarChart3, Plug, ArrowUpRight, Bell,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll, describeReadError, credentialHint } from '@/lib/supabase/settle';
import { adminNoteKindMeta, type AdminNotificationRow } from '@/lib/admin/notifications';
import { checkDatabase, checkStorage, checkEmail, checkAI } from '@/lib/server/health';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { Sparkline, Gauge, Donut, Bars } from '@/components/admin/charts';
import { fmtMoney, fmtDate } from '@/lib/utils/format';
import { planMonthlyCents, planName } from '@/lib/constants/plans';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin Dashboard', robots: { index: false } };
// Live, cross-family data via the service-role client — always render fresh.
export const dynamic = 'force-dynamic';

const MS_DAY = 86_400_000;
const STORAGE_CAP_BYTES = 5 * 1024 ** 4; // 5 TB soft cap for the usage gauge

const planLabel = (plan: string | null): string => planName(plan);

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default async function AdminDashboardPage() {
  const tr = await getTranslations();
  // Service-role client: the one place that intentionally bypasses RLS, gated
  // entirely by the super-admin check in admin/layout.tsx.
  const supabase = createServiceClient();
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * MS_DAY).toISOString();

  // Lifted out of the settled batch because their SHAPE differs, not because
  // they are fragile: both already resolve { ok, latencyMs, detail } and catch
  // internally, and that is exactly what the status tiles render — a better
  // fallback than settleAll's { data, error }. The .catch below is belt and
  // braces for a client that fails to construct at all.
  const [dbHealth, storageHealth] = await Promise.all([
    checkDatabase(supabase).catch((cause) => ({ ok: false as const, detail: String(cause) })),
    checkStorage(supabase).catch((cause) => ({ ok: false as const, detail: String(cause) })),
  ]);

  const [
    familyCountResult,
    activeMemberCountResult,
    activeSubCountResult,
    familiesResult,
    activeMembersResult,
    subscriptionsResult,
    docsResult,
    newMembersResult,
    recentLogsResult,
    ticketsResult,
    adminNotesResult,
    unreadNoteCountResult,
  ] = await settleAll([
    supabase.from('families').select('id', { count: 'exact', head: true }),
    supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('families').select('id, name, created_at').order('created_at', { ascending: false }),
    supabase.from('family_members').select('family_id, created_at').eq('is_active', true),
    supabase.from('subscriptions').select('family_id, plan, status, created_at'),
    supabase.from('documents').select('size_bytes'),
    supabase.from('family_members').select('created_at').eq('is_active', true).gte('created_at', thirtyDaysAgo),
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, created_at')
      .order('created_at', { ascending: false }).limit(8),
    supabase.from('support_tickets').select('status'),
    supabase.from('admin_notifications').select('id, kind, title, body, url, is_read, created_at')
      .order('created_at', { ascending: false }).limit(5),
    supabase.from('admin_notifications').select('id', { count: 'exact', head: true }).eq('is_read', false),
  ]);

  // Degrade per dataset rather than blanking the page.
  //
  // This bailed when ANY of the twelve reads errored, and every consumer below
  // already defaults with `?? []` / `?? 0` — so the page was fully capable of
  // rendering without any one of them and simply was not allowed to. On
  // production that is not a rare case: the migration ledger stops at 0001-0003,
  // so later tables (admin_notifications, support_tickets, documents) can be
  // absent outright, and one absent table was costing an administrator the
  // entire dashboard.
  //
  // Nothing here is load-bearing: every tile and list has an empty state. So
  // there is no bail at all now — the failures are named in a banner instead,
  // which is more useful than an error page because it says WHICH read failed.
  const loadErrors = ([
    ['families (count)', familyCountResult],
    ['active members (count)', activeMemberCountResult],
    ['active subscriptions (count)', activeSubCountResult],
    ['families', familiesResult],
    ['active members', activeMembersResult],
    ['subscriptions', subscriptionsResult],
    ['documents', docsResult],
    ['new members', newMembersResult],
    ['recent audit logs', recentLogsResult],
    ['support tickets', ticketsResult],
    ['admin notifications', adminNotesResult],
    ['unread notifications (count)', unreadNoteCountResult],
  ] as const)
    .filter(([, res]) => res.error)
    .map(([label, res]) => `${label}: ${describeReadError(res.error)}`);
  if (loadErrors.length > 0) {
    console.error('[admin-dashboard] partial read — rendering degraded', loadErrors.join('; '));
  }

  const { count: familyCount } = familyCountResult;
  const { count: activeMemberCount } = activeMemberCountResult;
  const { count: activeSubCount } = activeSubCountResult;
  const { data: families } = familiesResult;
  const { data: activeMembers } = activeMembersResult;
  const { data: subscriptions } = subscriptionsResult;
  const { data: docs } = docsResult;
  const { data: newMembers } = newMembersResult;
  const { data: recentLogs } = recentLogsResult;
  const { data: tickets } = ticketsResult;
  const { data: adminNotes } = adminNotesResult;
  const { count: unreadNoteCount } = unreadNoteCountResult;

  const notifications = (adminNotes ?? []) as AdminNotificationRow[];
  const unreadNotes = unreadNoteCount ?? 0;

  // ── Stat cards ──
  // "Users" here means the real population of the product — family members,
  // including account-less ones — not just rows in `profiles` (people who've
  // created a login). Counting profiles alone understates active families.
  const userCount = activeMemberCount;
  const newFamiliesThisMonth = (families ?? []).filter((f) => f.created_at >= monthStart).length;
  const activeSubs = (subscriptions ?? []).filter((s) => s.status === 'active');
  const monthlyRevenueCents = activeSubs.reduce((sum, s) => sum + planMonthlyCents(s.plan), 0);
  const newUsersThisMonth = (newMembers ?? []).filter((p) => p.created_at >= monthStart).length;

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

  // ── User growth sparkline (last 30 days, daily new members) ──
  const growthByDay = Array.from({ length: 30 }, (_, i) => {
    const dayStart = now - (29 - i) * MS_DAY;
    return (newMembers ?? []).filter((p) => {
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

  // ── Plan distribution across every family (not just paid subscriptions) ──
  // Each family resolves to its active subscription's plan, defaulting to Free
  // when it has no subscription row — so the donut reflects the real install
  // base instead of collapsing to "no subscriptions" when nobody's paid yet.
  const planColors: Record<string, string> = {
    'Bubaly Free': '#64748b',
    Free: '#64748b',
    'Family Basic': '#7c5dff',
    'Family Basic (Annual)': '#6d28d9',
    'Family+': '#22c55e',
    'Family+ (Annual)': '#16a34a',
  };
  const activeSubByFamily = new Map(activeSubs.map((s) => [s.family_id, s.plan]));
  const planBuckets = new Map<string, number>();
  for (const f of families ?? []) {
    const label = planLabel(activeSubByFamily.get(f.id) ?? 'free');
    planBuckets.set(label, (planBuckets.get(label) ?? 0) + 1);
  }
  const subSegments = [...planBuckets.entries()].map(([label, value]) => ({ label, value, color: planColors[label] ?? '#64748b' }));
  const totalFamiliesForDonut = (families ?? []).length;

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
  const actorsResult = actorIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', actorIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  // A failed actor lookup costs the NAMES beside audit-log entries, nothing
  // more: actorById is consulted with `actorById.get(log.actor_id)` and the
  // render already handles a miss. Returning an error page for it meant the
  // dashboard vanished because it could not label a row.
  if ('error' in actorsResult && actorsResult.error) {
    console.warn('[admin-dashboard] actor profile read failed — activity rows lose their names', actorsResult.error);
  }

  const { data: actors } = actorsResult;
  const actorById = new Map((actors ?? []).map((a) => [a.id, a]));

  return (
    <div className="module-page space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('admin.adminDashboard')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('admin.manageAndMonitorYourBubalySystem')}</p>
      </div>

      {loadErrors.length > 0 && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-4">
          <p className="text-sm font-semibold text-danger">{tr('admin.someDataCouldNotBeLoaded')}</p>
          {credentialHint(loadErrors) ? (
            <p className="mt-1.5 text-xs font-medium text-danger">{credentialHint(loadErrors)}</p>
          ) : null}
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-danger/90">
            {loadErrors.map((err) => <li key={err}>{err}</li>)}
          </ul>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Main column */}
        <div className="space-y-4 lg:col-span-2">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard icon={Home} tint="text-violet-400 bg-violet-500/15" label={tr('admin.totalFamilies')} value={familyCount?.toLocaleString() ?? '0'} sub={`${newFamiliesThisMonth} new this month`} />
            <StatCard icon={Users} tint="text-blue-400 bg-blue-500/15" label={tr('admin.activeUsers')} value={userCount?.toLocaleString() ?? '0'} sub={`${newUsersThisMonth} new this month`} />
            <StatCard icon={CreditCard} tint="text-emerald-400 bg-emerald-500/15" label={tr('admin.subscriptions')} value={activeSubCount?.toLocaleString() ?? '0'} sub={`${activeMemberCount?.toLocaleString() ?? 0} active members`} />
            <StatCard icon={DollarSign} tint="text-amber-400 bg-amber-500/15" label={tr('admin.monthlyRevenue')} value={fmtMoney(monthlyRevenueCents)} sub={`from ${activeSubs.length} active plans`} />
          </div>

          {/* System overview */}
          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold">{tr('admin.userGrowth')}</p>
                <span className="inline-flex items-center gap-0.5 text-xs font-semibold text-emerald-400"><TrendingUp className="h-3.5 w-3.5" />+{newUsers30}</span>
              </div>
              <Sparkline data={growthByDay} />
              <p className="mt-2 text-xs text-muted">{tr('admin.newUsersLast30Days')}</p>
            </Card>
            <Card>
              <p className="mb-2 text-sm font-semibold">{tr('admin.systemHealth')}</p>
              <div className="flex items-center justify-center py-1">
                <Gauge pct={healthPct} color={healthPct >= 99 ? '#22c55e' : healthPct >= 80 ? '#f59e0b' : '#ef4444'} />
              </div>
              <p className="mt-1 text-center text-xs text-muted">{operational}/{statuses.length} {tr('admin.servicesOperational')}</p>
            </Card>
            <Card>
              <p className="mb-2 text-sm font-semibold">{tr('admin.storageUsage')}</p>
              <div className="flex items-center justify-center py-1">
                <Gauge pct={storagePct} color="#7c5dff" centerLabel={fmtBytes(usedBytes)} />
              </div>
              <p className="mt-1 text-center text-xs text-muted">of {fmtBytes(STORAGE_CAP_BYTES)} capacity</p>
            </Card>
          </div>

          {/* Recent activities */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-base font-semibold"><Activity className="h-4 w-4 text-muted" /> {tr('admin.recentActivities')}</h2>
              <Link href="/admin/audit" className="text-xs font-medium text-brand-text hover:underline">{tr('admin.viewAll')}</Link>
            </div>
            {!recentLogs || recentLogs.length === 0 ? (
              <EmptyState icon={Activity} title={tr('admin.noActivityRecordedYet')} />
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
              <h2 className="text-base font-semibold">{tr('admin.systemStatus')}</h2>
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
              <h2 className="flex items-center gap-2 text-base font-semibold">
                <Bell className="h-4 w-4 text-muted" /> {tr('admin.notifications')}
                {unreadNotes > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-danger px-1.5 text-[10px] font-bold text-white">
                    {unreadNotes > 99 ? '99+' : unreadNotes}
                  </span>
                )}
              </h2>
              <Link href="/admin/notifications" className="text-xs font-medium text-brand-text hover:underline">{tr('admin.seeAll')}</Link>
            </div>
            {notifications.length === 0 ? (
              <EmptyState icon={Bell} title={tr('admin.youreAllCaughtUp')} />
            ) : (
              <ul className="space-y-1.5">
                {notifications.map((n) => {
                  const meta = adminNoteKindMeta(n.kind);
                  const row = (
                    <>
                      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${n.is_read ? 'bg-transparent' : 'bg-brand'}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-[10px] font-bold uppercase tracking-wide ${meta.tone}`}>{meta.label}</span>
                          <span className="ml-auto shrink-0 text-[11px] text-muted">{fmtDate(n.created_at, 'MMM d')}</span>
                        </div>
                        <p className="truncate text-sm font-medium">{n.title}</p>
                      </div>
                    </>
                  );
                  const cls = `flex items-start gap-2 rounded-lg border border-border bg-surface/40 px-3 py-2 transition ${n.url ? 'hover:border-brand/40 hover:bg-elevated' : ''}`;
                  return n.url
                    ? <li key={n.id}><Link href={n.url} className={cls}>{row}</Link></li>
                    : <li key={n.id} className={cls}>{row}</li>;
                })}
              </ul>
            )}
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">{tr('admin.topFamilies')}</h2>
              <Link href="/admin/users" className="text-xs font-medium text-brand-text hover:underline">{tr('admin.viewAll')}</Link>
            </div>
            {topFamilies.length === 0 ? (
              <EmptyState icon={Home} title={tr('admin.noFamiliesYet')} />
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
          <h2 className="mb-3 text-base font-semibold">{tr('admin.planDistribution')}</h2>
          {subSegments.length === 0 ? (
            <EmptyState icon={CreditCard} title={tr('admin.noFamiliesYet')} />
          ) : (
            <div className="flex items-center gap-4">
              <Donut segments={subSegments} total={totalFamiliesForDonut} />
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
          <h2 className="mb-3 text-base font-semibold">{tr('admin.revenueOverview')}</h2>
          <Bars data={months.map((m) => ({ label: m.label, value: m.cents }))} max={maxRevenue} money />
          <p className="mt-2 text-xs text-muted">{tr('admin.newMrrLast6Months')}</p>
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold"><LifeBuoy className="h-4 w-4 text-muted" /> {tr('admin.supportOverview')}</h2>
            <Link href="/admin/support" className="text-xs font-medium text-brand-text hover:underline">{tr('admin.viewAll')}</Link>
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
          <h2 className="mb-3 text-base font-semibold">{tr('admin.quickActions')}</h2>
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
                <a.icon className="h-5 w-5 text-brand-text" />
                <span className="flex items-center gap-1 text-xs font-medium">{a.label}<ArrowUpRight className="h-3 w-3 text-muted transition group-hover:text-brand-text" /></span>
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
