import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ScrollText, ShieldAlert, Activity, Eye, CheckCircle2, AlertTriangle, XCircle,
  Info, Download, KeyRound, Settings, ArrowRight, Plus, Pencil, Trash2, LogIn,
  UserCog, RefreshCw,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { AuditExportButton, type AuditRow } from '@/components/admin/audit-export';
import { BigDonut, AreaChartSVG } from '@/components/admin/charts';
import { superAdminEmails } from '@/lib/constants/super-admins';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Audit Logs', robots: { index: false } };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 15;
const MS_DAY = 86_400_000;
const TABS = ['All Logs', 'Admin Actions', 'User Management', 'Security Events', 'System Changes', 'Data Changes', 'Login Activity'] as const;
const slug = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

type Severity = 'success' | 'warning' | 'failed' | 'info';
function severityOf(action: string): Severity {
  if (/fail|error|reject|deny/i.test(action)) return 'failed';
  if (/delete|ban|revoke|remove|reset/i.test(action)) return 'warning';
  if (/read|view|export|clear_cache|login/i.test(action)) return 'info';
  return 'success';
}
const ACTION_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  create: Plus, update: Pencil, delete: Trash2, ban: ShieldAlert, unban: ShieldAlert,
  revoke: XCircle, resend: RefreshCw, approve: CheckCircle2, login: LogIn,
  password_reset: KeyRound, clear_cache: RefreshCw, reset: RefreshCw, remove: Trash2,
};

type Params = { searchParams: Promise<{ q?: string; action?: string; resource?: string; status?: string; page?: string; tab?: string }> };

export default async function AdminAuditPage({ searchParams }: Params) {
  const sp = await searchParams;
  const activeTab = TABS.find((t) => slug(t) === sp.tab) ?? 'All Logs';
  const supabase = createServiceClient();

  const [{ data: logs }, { data: families }] = await Promise.all([
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, resource_id, metadata, created_at')
      .order('created_at', { ascending: false }).limit(1000),
    supabase.from('families').select('id, name'),
  ]);
  const rows = logs ?? [];
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const actorIds = [...new Set(rows.map((l) => l.actor_id).filter((x): x is string => !!x))];
  const { data: actors } = actorIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', actorIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const actorById = new Map((actors ?? []).map((a) => [a.id, a]));
  const adminEmails = new Set(superAdminEmails());
  const roleOf = (id: string | null, viaAdmin: boolean) => {
    const a = id ? actorById.get(id) : null;
    if (a?.email && adminEmails.has(a.email.toLowerCase())) return 'Super Administrator';
    return viaAdmin ? 'Administrator' : a ? 'User' : 'System';
  };
  const isAdmin = (l: { metadata: unknown }) => (l.metadata as Record<string, unknown> | null)?.via === 'site_admin';

  // Tab filter
  const USER_RES = new Set(['users', 'family_members', 'invites', 'profiles']);
  const SYS_RES = new Set(['app_settings', 'system', 'system_backups', 'admin_integrations']);
  const tabPass = (l: typeof rows[number]) => {
    switch (activeTab) {
      case 'Admin Actions': return isAdmin(l);
      case 'User Management': return USER_RES.has(l.resource);
      case 'Security Events': return /ban|revoke|password_reset|clear_cache/.test(l.action) || l.resource === 'security';
      case 'System Changes': return SYS_RES.has(l.resource);
      case 'Data Changes': return /create|update|delete/.test(l.action) && !USER_RES.has(l.resource) && !SYS_RES.has(l.resource);
      case 'Login Activity': return /login/.test(l.action) || l.resource === 'auth';
      default: return true;
    }
  };

  const q = (sp.q ?? '').trim().toLowerCase();
  const actionFilter = sp.action ?? '';
  const resourceFilter = sp.resource ?? '';
  const statusFilter = sp.status ?? '';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  const filtered = rows.filter((l) => {
    if (!tabPass(l)) return false;
    if (actionFilter && l.action !== actionFilter) return false;
    if (resourceFilter && l.resource !== resourceFilter) return false;
    if (statusFilter && severityOf(l.action) !== statusFilter) return false;
    if (q) {
      const a = l.actor_id ? actorById.get(l.actor_id) : undefined;
      const hay = `${l.action} ${l.resource} ${familyNameById.get(l.family_id ?? '') ?? ''} ${a?.full_name ?? ''} ${a?.email ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Overview severity counts (over all rows)
  const sev = { success: 0, warning: 0, failed: 0, info: 0 } as Record<Severity, number>;
  for (const l of rows) sev[severityOf(l.action)]++;
  const total = rows.length || 1;

  // Activity over last 7 days
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const activity = Array.from({ length: 7 }, (_, i) => {
    const start = today.getTime() - (6 - i) * MS_DAY;
    const count = rows.filter((l) => { const t = new Date(l.created_at).getTime(); return t >= start && t < start + MS_DAY; }).length;
    return { label: new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), value: count };
  });

  // Top users by activity
  const byUser = new Map<string, number>();
  for (const l of rows) if (l.actor_id) byUser.set(l.actor_id, (byUser.get(l.actor_id) ?? 0) + 1);
  const topUsers = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, count]) => {
    const a = actorById.get(id);
    return { id, name: a?.full_name || a?.email || 'Unknown', role: roleOf(id, true), count };
  });

  const actionOptions = [...new Set(rows.map((l) => l.action))].sort();
  const resourceOptions = [...new Set(rows.map((l) => l.resource))].sort();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const hidden = Object.fromEntries(Object.entries({ q: sp.q, action: sp.action, resource: sp.resource, status: sp.status, tab: sp.tab }).filter(([, v]) => v)) as Record<string, string>;

  const SEV_META: Record<Severity, { label: string; tone: string; dot: string }> = {
    success: { label: 'Success', tone: 'text-emerald-400', dot: 'bg-emerald-400' },
    warning: { label: 'Warning', tone: 'text-amber-400', dot: 'bg-amber-400' },
    failed: { label: 'Failed', tone: 'text-rose-400', dot: 'bg-rose-400' },
    info: { label: 'Info', tone: 'text-muted', dot: 'bg-white/40' },
  };

  const exportRows: AuditRow[] = filtered.map((l) => {
    const a = l.actor_id ? actorById.get(l.actor_id) : undefined;
    return { date: fmtDate(l.created_at, 'MMM d, yyyy h:mm a'), user: a?.full_name || a?.email || 'System', action: l.action, resource: l.resource, status: SEV_META[severityOf(l.action)].label };
  });

  return (
    <div className="module-page space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Audit Logs</h1>
          <p className="mt-1 text-sm text-muted">Track and review all system activities and administrative actions.</p>
        </div>
      </div>

      <div className="tab-bar border-b border-border">
        {TABS.map((t) => (
          <Link key={t} href={`/admin/audit?tab=${slug(t)}`} className={cn('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition', activeTab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-fg')}>{t}</Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
              <FilterForm action="/admin/audit">
                <FilterSearchInput name="q" defaultValue={sp.q} placeholder="Search logs..." />
                <FilterSelect name="action" defaultValue={actionFilter} options={[{ value: '', label: 'All Actions' }, ...actionOptions.map((a) => ({ value: a, label: a }))]} />
                <FilterSelect name="resource" defaultValue={resourceFilter} options={[{ value: '', label: 'All Resources' }, ...resourceOptions.map((r) => ({ value: r, label: r }))]} />
                <FilterSelect name="status" defaultValue={statusFilter} options={[{ value: '', label: 'All Status' }, { value: 'success', label: 'Success' }, { value: 'warning', label: 'Warning' }, { value: 'failed', label: 'Failed' }, { value: 'info', label: 'Info' }]} />
              </FilterForm>
              <AuditExportButton rows={exportRows} />
            </div>

            {pageRows.length === 0 ? (
              <EmptyState icon={ScrollText} title={rows.length === 0 ? 'No activity recorded yet' : 'No events match these filters'} />
            ) : (
              <div className="table-responsive">
                <table className="w-full min-w-[720px] text-sm">
                  <thead><tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-2 py-2 font-medium">Date &amp; Time</th><th className="px-2 py-2 font-medium">User</th>
                    <th className="px-2 py-2 font-medium">Action</th><th className="px-2 py-2 font-medium">Resource</th>
                    <th className="px-2 py-2 font-medium">IP Address</th><th className="px-2 py-2 font-medium">Status</th><th className="px-2 py-2 font-medium">Details</th>
                  </tr></thead>
                  <tbody className="divide-y divide-border/60">
                    {pageRows.map((l) => {
                      const a = l.actor_id ? actorById.get(l.actor_id) : undefined;
                      const who = a?.full_name || a?.email || 'System';
                      const sevr = severityOf(l.action);
                      const m = SEV_META[sevr];
                      const Icon = ACTION_ICON[l.action] ?? Activity;
                      const ip = ((l.metadata as Record<string, unknown> | null)?.ip as string) ?? '—';
                      const fam = l.family_id ? familyNameById.get(l.family_id) : null;
                      return (
                        <tr key={l.id}>
                          <td className="px-2 py-2.5 text-xs text-muted">{fmtDate(l.created_at, 'MMM d, yyyy h:mm a')}</td>
                          <td className="px-2 py-2.5"><span className="flex items-center gap-2"><Avatar name={who} size={26} /><span><span className="block font-medium leading-tight">{who.split('@')[0]}</span><span className="block text-[11px] text-muted">{roleOf(l.actor_id, isAdmin(l))}</span></span></span></td>
                          <td className="px-2 py-2.5"><span className="flex items-center gap-1.5"><Icon className="h-4 w-4 text-muted" /><span className="capitalize">{l.action.replace(/_/g, ' ')}</span></span></td>
                          <td className="px-2 py-2.5"><span className="capitalize">{l.resource.replace(/_/g, ' ')}</span>{fam && <span className="block text-[11px] text-muted">{fam}</span>}</td>
                          <td className="px-2 py-2.5 font-mono text-xs text-muted">{ip}</td>
                          <td className="px-2 py-2.5"><span className={cn('inline-flex items-center gap-1 text-xs font-medium', m.tone)}><span className={cn('h-2 w-2 rounded-full', m.dot)} />{m.label}</span></td>
                          <td className="px-2 py-2.5"><Eye className="h-4 w-4 text-muted" /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
              <span>Showing {pageRows.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} logs</span>
              {totalPages > 1 && (
                <div className="flex gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 8).map((p) => (
                    <Link key={p} href={`/admin/audit?${new URLSearchParams({ ...hidden, page: String(p) }).toString()}`}
                      className={cn('flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium', p === pageSafe ? 'bg-brand text-brand-fg' : 'hover:bg-elevated')}>{p}</Link>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Right rail */}
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-base font-semibold">Audit Log Overview</h2>
            <div className="flex items-center gap-3">
              <BigDonut
                segments={[{ value: sev.success, color: '#22c55e' }, { value: sev.warning, color: '#f59e0b' }, { value: sev.failed, color: '#ef4444' }, { value: sev.info, color: '#64748b' }]}
                centerTop={rows.length.toLocaleString()} centerBottom="Total Logs" size={140}
              />
              <ul className="flex-1 space-y-1.5 text-xs">
                {(['success', 'warning', 'failed', 'info'] as Severity[]).map((k) => (
                  <li key={k} className="flex items-center gap-1.5"><span className={cn('h-2.5 w-2.5 rounded-full', SEV_META[k].dot)} /><span className="text-muted">{SEV_META[k].label}</span><span className="ml-auto font-semibold">{sev[k]} ({Math.round((sev[k] / total) * 100)}%)</span></li>
                ))}
              </ul>
            </div>
          </Card>

          <Card>
            <h2 className="mb-1 text-base font-semibold">Log Activity Over Time</h2>
            <p className="mb-2 text-xs text-muted">This Week</p>
            <AreaChartSVG points={activity} height={140} />
          </Card>

          <Card>
            <div className="mb-3 flex items-center justify-between"><h2 className="text-base font-semibold">Top Users by Activity</h2><span className="text-xs text-muted">Total Actions</span></div>
            {topUsers.length === 0 ? <EmptyState icon={UserCog} title="No activity yet" /> : (
              <ul className="space-y-2.5">
                {topUsers.map((u) => (
                  <li key={u.id} className="flex items-center gap-3">
                    <Avatar name={u.name} size={30} />
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{u.name.split('@')[0]}</p><p className="text-[11px] text-muted">{u.role}</p></div>
                    <span className="text-sm font-bold tabular-nums">{u.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">Quick Actions</h2>
            <ul className="space-y-1">
              <li><span className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm"><Download className="h-4 w-4 text-brand" /><span className="flex-1">Export Audit Logs</span><AuditExportButton rows={exportRows} /></span></li>
              <li><Link href="/admin/audit?tab=security-events" className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-elevated"><ShieldAlert className="h-4 w-4 text-brand" /><span className="flex-1">View Security Events</span><ArrowRight className="h-4 w-4 text-muted" /></Link></li>
              <li><Link href="/admin/settings" className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition hover:bg-elevated"><Settings className="h-4 w-4 text-brand" /><span className="flex-1">Audit Log Settings</span><ArrowRight className="h-4 w-4 text-muted" /></Link></li>
            </ul>
          </Card>

          <Card>
            <h2 className="mb-3 text-base font-semibold">At a glance</h2>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2"><ScrollText className="h-4 w-4 text-muted" /><span className="flex-1 text-muted">Logged events</span><span className="font-semibold">{rows.length.toLocaleString()}</span></li>
              <li className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-muted" /><span className="flex-1 text-muted">Admin actions</span><span className="font-semibold">{rows.filter(isAdmin).length}</span></li>
              <li className="flex items-center gap-2"><Info className="h-4 w-4 text-muted" /><span className="flex-1 text-muted">Action types</span><span className="font-semibold">{actionOptions.length}</span></li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
