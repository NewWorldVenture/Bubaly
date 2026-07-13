import type { Metadata } from 'next';
import {
  Activity, ArrowRight, ClipboardList, KeyRound, Plus,
  Shield, ShieldCheck, UserCog, UserPlus, Users,
} from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { AdminRowActions } from '@/components/admin/admin-row-actions';
import { StatusDonut } from '@/components/admin/status-donut';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Admin Management', robots: { index: false } };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 12;

const TABS = [
  { key: 'users',    label: 'Admin Users' },
  { key: 'roles',    label: 'Roles & Permissions' },
  { key: 'requests', label: 'Access Requests' },
  { key: 'activity', label: 'Admin Activity' },
  { key: 'settings', label: 'Settings' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

const ROLE_META: Record<string, { label: string; color: string; donutColor: string; badge: 'brand' | 'success' | 'warning' | 'neutral' | 'danger' }> = {
  super_administrator: { label: 'Super Administrator', color: 'text-violet-400 bg-violet-500/15', donutColor: '#a78bfa', badge: 'brand' },
  administrator:       { label: 'Administrator',       color: 'text-blue-400   bg-blue-500/15',   donutColor: '#60a5fa', badge: 'brand' },
  content_manager:     { label: 'Content Manager',     color: 'text-emerald-400 bg-emerald-500/15', donutColor: '#34d399', badge: 'success' },
  billing_manager:     { label: 'Billing Manager',     color: 'text-yellow-400 bg-yellow-500/15', donutColor: '#fbbf24', badge: 'warning' },
  moderator:           { label: 'Moderator',           color: 'text-orange-400 bg-orange-500/15', donutColor: '#fb923c', badge: 'warning' },
  viewer:              { label: 'Viewer',              color: 'text-muted  bg-slate-500/15',  donutColor: '#94a3b8', badge: 'neutral' },
};

const ROLE_PERMISSIONS: Record<string, { resource: string; read: boolean; write: boolean; delete: boolean }[]> = {
  super_administrator: [
    { resource: 'Users',    read: true, write: true, delete: true },
    { resource: 'Content',  read: true, write: true, delete: true },
    { resource: 'Reports',  read: true, write: true, delete: true },
    { resource: 'Billing',  read: true, write: true, delete: true },
    { resource: 'Security', read: true, write: true, delete: true },
    { resource: 'Settings', read: true, write: true, delete: true },
  ],
  administrator: [
    { resource: 'Users',   read: true, write: true,  delete: false },
    { resource: 'Content', read: true, write: true,  delete: true },
    { resource: 'Reports', read: true, write: false, delete: false },
    { resource: 'Billing', read: true, write: false, delete: false },
  ],
  content_manager: [
    { resource: 'Content', read: true, write: true, delete: true },
    { resource: 'Reports', read: true, write: false, delete: false },
  ],
  billing_manager: [
    { resource: 'Billing', read: true, write: true,  delete: false },
    { resource: 'Reports', read: true, write: false, delete: false },
  ],
  moderator: [
    { resource: 'Users',   read: true, write: false, delete: false },
    { resource: 'Support', read: true, write: true,  delete: false },
  ],
  viewer: [
    { resource: 'Reports', read: true, write: false, delete: false },
  ],
};

type Params = {
  searchParams: Promise<{
    tab?: string; q?: string; role?: string; status?: string; page?: string;
  }>;
};

export default async function AdminManagementPage({ searchParams }: Params) {
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'users';
  const supabase = createServiceClient();

  const { data: allAdmins } = await supabase
    .from('admin_users')
    .select('*')
    .order('joined_at', { ascending: false });

  const admins = allAdmins ?? [];

  // ── Stats ──────────────────────────────────────────────────────────
  const total         = admins.length;
  const superAdmins   = admins.filter((a) => a.admin_role === 'super_administrator').length;
  const administrators = admins.filter((a) => a.admin_role === 'administrator').length;
  const pendingInvites = admins.filter((a) => a.status === 'pending').length;

  // Role distribution for donut
  const roleCounts = new Map<string, number>();
  for (const a of admins) roleCounts.set(a.admin_role, (roleCounts.get(a.admin_role) ?? 0) + 1);
  const donutSegments = Object.entries(ROLE_META).map(([role, meta]) => ({
    label: meta.label, count: roleCounts.get(role) ?? 0, color: meta.donutColor,
  })).filter((s) => s.count > 0);

  // Filters
  const q           = (sp.q ?? '').trim().toLowerCase();
  const roleFilter  = sp.role ?? '';
  const statusFilter = sp.status ?? '';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  let filtered = admins;
  if (q) filtered = filtered.filter((a) => {
    const hay = `${a.full_name ?? ''} ${a.email} ${a.admin_role}`.toLowerCase();
    return hay.includes(q);
  });
  if (roleFilter)   filtered = filtered.filter((a) => a.admin_role === roleFilter);
  if (statusFilter) filtered = filtered.filter((a) => a.status === statusFilter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe   = Math.min(page, totalPages);
  const pageRows   = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const hiddenParams = Object.fromEntries(
    Object.entries({ tab, q: sp.q, role: sp.role, status: sp.status })
      .filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  return (
    <div className="module-page">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Admin</h1>
          <p className="mt-1 text-sm text-muted">Manage administrators and system access.</p>
        </div>
        <button className="flex h-9 items-center gap-1.5 self-start rounded-lg bg-brand px-4 text-sm font-semibold text-brand-fg hover:brightness-110 sm:self-auto">
          <Plus className="h-4 w-4" /> Invite Admin
        </button>
      </div>

      {/* Tabs */}
      <div className="tab-bar border-b border-border pb-px">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/admins?tab=${t.key}`}
            className={`tab-item ${tab === t.key ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {t.label}
          </a>
        ))}
      </div>

      {/* Admin Users tab */}
      {tab === 'users' && (
        <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
          {/* Left */}
          <div className="space-y-5">
            {/* Stat cards */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <AdminStatCard icon={Users}     label="Total Admins"         sub="Active administrators"  value={total}          color="text-brand-text     bg-brand/10" />
              <AdminStatCard icon={ShieldCheck} label="Super Admins"       sub="Full system access"     value={superAdmins}    color="text-emerald-400 bg-emerald-500/10" />
              <AdminStatCard icon={UserCog}   label="Admins"               sub="Standard access"        value={administrators} color="text-blue-400  bg-blue-500/10" />
              <AdminStatCard icon={UserPlus}  label="Pending Invitations"  sub="Awaiting acceptance"    value={pendingInvites} color="text-yellow-400 bg-yellow-500/10" />
            </div>

            <Card>
              <FilterForm action="/admin/admins" hidden={{ tab: 'users' }}>
                <FilterSearchInput name="q" defaultValue={sp.q} placeholder="Search admins..." />
                <FilterSelect name="role" defaultValue={roleFilter} options={[
                  { value: '', label: 'All Roles' },
                  ...Object.entries(ROLE_META).map(([v, m]) => ({ value: v, label: m.label })),
                ]} />
                <FilterSelect name="status" defaultValue={statusFilter} options={[
                  { value: '', label: 'All Status' },
                  { value: 'active',   label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                  { value: 'pending',  label: 'Pending' },
                ]} />
              </FilterForm>

              {pageRows.length === 0 ? (
                <div className="mt-6"><EmptyState icon={UserCog} title="No admins match these filters" /></div>
              ) : (
                <div className="table-responsive mt-4">
                  <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="px-3 py-2 font-medium">Admin</th>
                        <th className="px-3 py-2 font-medium">Role</th>
                        <th className="px-3 py-2 font-medium">Permissions</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Last Active</th>
                        <th className="px-3 py-2 font-medium">Joined On</th>
                        <th className="px-3 py-2 font-medium">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {pageRows.map((admin) => {
                        const meta = ROLE_META[admin.admin_role];
                        const statusConfig = {
                          active:   { dot: 'bg-success', label: 'Active',   tone: 'success' as const },
                          inactive: { dot: 'bg-warning', label: 'Inactive', tone: 'warning' as const },
                          pending:  { dot: 'bg-warning', label: 'Pending',  tone: 'warning' as const },
                        }[admin.status] ?? { dot: 'bg-muted', label: admin.status, tone: 'neutral' as const };

                        return (
                          <tr key={admin.id} className="hover:bg-elevated/40 transition-colors">
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-2.5">
                                <AvatarInitials name={admin.full_name ?? admin.email} size={32} />
                                <div className="min-w-0">
                                  <p className="truncate font-medium">{admin.full_name ?? '—'}</p>
                                  <p className="truncate text-xs text-muted">{admin.email}</p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${meta?.color ?? 'text-muted bg-elevated'}`}>
                                {meta?.label ?? admin.admin_role}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted max-w-[180px]">
                              <p className="truncate">{admin.permissions.join(', ') || '—'}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="flex items-center gap-1.5 text-xs">
                                <span className={`h-2 w-2 rounded-full ${statusConfig.dot}`} />
                                {statusConfig.label}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">
                              {admin.last_active_at ? (
                                <>
                                  <p>{fmtDate(admin.last_active_at, 'MMM d, yyyy')}</p>
                                  <p>{fmtDate(admin.last_active_at, 'hh:mm a')}</p>
                                </>
                              ) : '—'}
                            </td>
                            <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">
                              <p>{fmtDate(admin.joined_at, 'MMM d, yyyy')}</p>
                              <p>{fmtDate(admin.joined_at, 'hh:mm a')}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              <AdminRowActions adminId={admin.id} status={admin.status} email={admin.email} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table></div>
                </div>
              )}

              {/* Pagination */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
                <span>Showing {filtered.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} admins</span>
                <div className="flex gap-1">
                  {pageSafe > 1 && (
                    <a href={`/admin/admins?${new URLSearchParams({ ...hiddenParams, page: String(pageSafe - 1) })}`}
                      className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">‹</a>
                  )}
                  {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((p) => (
                    <a key={p} href={`/admin/admins?${new URLSearchParams({ ...hiddenParams, page: String(p) })}`}
                      className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium ${p === pageSafe ? 'bg-brand text-brand-fg' : 'hover:bg-elevated'}`}>
                      {p}
                    </a>
                  ))}
                  {pageSafe < totalPages && (
                    <a href={`/admin/admins?${new URLSearchParams({ ...hiddenParams, page: String(pageSafe + 1) })}`}
                      className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">›</a>
                  )}
                </div>
              </div>
            </Card>
          </div>

          {/* Right sidebar */}
          <div className="space-y-5">
            {/* Role Distribution donut */}
            <Card>
              <h2 className="mb-4 text-base font-semibold">Role Distribution</h2>
              <StatusDonut segments={donutSegments} total={total} centerLabel="Total" />
            </Card>

            {/* Recent Admin Activity */}
            <Card>
              <h2 className="mb-3 text-base font-semibold">Recent Admin Activity</h2>
              <ul className="space-y-4">
                {[
                  { icon: UserPlus,    color: 'text-brand-text     bg-brand/10',   title: 'New admin invited',   sub: 'Brian White was invited',            date: 'May 14, 2024', time: '08:10 AM' },
                  { icon: KeyRound,    color: 'text-violet-400 bg-violet-500/10', title: 'Role updated',   sub: 'Kevin Patel role changed to Billing Manager', date: 'May 13, 2024', time: '11:25 AM' },
                  { icon: UserCog,     color: 'text-success   bg-success/10',  title: 'Admin activated',   sub: 'Amanda Clark activated their account', date: 'May 13, 2024', time: '03:35 PM' },
                  { icon: Shield,      color: 'text-warning   bg-warning/10',  title: 'Admin deactivated', sub: 'Robert Taylor was deactivated',        date: 'May 10, 2024', time: '10:15 AM' },
                ].map(({ icon: Icon, color, title, sub, date, time }) => {
                  const [iconC, bgC] = color.split(' ');
                  return (
                    <li key={title} className="flex gap-3">
                      <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${bgC}`}>
                        <Icon className={`h-4 w-4 ${iconC}`} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{title}</p>
                        <p className="text-xs text-muted">{sub}</p>
                      </div>
                      <div className="shrink-0 text-right text-xs text-muted">
                        <p>{date}</p>
                        <p>{time}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <a href="/admin/admins?tab=activity" className="mt-4 flex items-center gap-1 text-xs text-brand-text hover:underline">
                View all activity →
              </a>
            </Card>

            {/* Quick Actions */}
            <Card>
              <h2 className="mb-3 text-base font-semibold">Quick Actions</h2>
              <ul className="space-y-1">
                {[
                  [UserPlus,     'Invite New Admin',         '/admin/admins'],
                  [KeyRound,     'Manage Roles & Permissions', '/admin/admins?tab=roles'],
                  [ClipboardList, 'View Access Requests',    '/admin/admins?tab=requests'],
                  [Activity,     'Admin Settings',           '/admin/admins?tab=settings'],
                ].map(([Icon, label, href]) => (
                  <li key={label as string}>
                    <a href={href as string}
                      className="flex items-center justify-between rounded-lg px-2 py-2.5 text-sm hover:bg-elevated">
                      <span className="flex items-center gap-2 text-muted">
                        {/* @ts-expect-error dynamic icon */}
                        <Icon className="h-4 w-4" /> {label}
                      </span>
                      <ArrowRight className="h-4 w-4 text-muted/50" />
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}

      {/* Roles & Permissions tab */}
      {tab === 'roles' && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">Roles & Permissions</h2>
          <p className="mb-5 text-sm text-muted">Define what each admin role can access and modify in the system.</p>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(ROLE_META).map(([role, meta]) => {
              const perms = ROLE_PERMISSIONS[role] ?? [];
              return (
                <div key={role} className="rounded-xl border border-border bg-surface/40 p-4">
                  <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${meta.color}`}>
                    {meta.label}
                  </span>
                  <p className="mt-3 mb-2 text-xs font-medium text-muted">Permissions</p>
                  <ul className="space-y-1.5">
                    {perms.map(({ resource, read, write, delete: del }) => (
                      <li key={resource} className="flex items-center justify-between text-xs">
                        <span>{resource}</span>
                        <span className="font-mono text-muted">
                          {read ? 'R' : '-'}{write ? 'W' : '-'}{del ? 'D' : '-'}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-muted">
                    {admins.filter((a) => a.admin_role === role).length} user(s)
                  </p>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Access Requests tab */}
      {tab === 'requests' && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">Access Requests</h2>
          <EmptyState icon={ClipboardList} title="No pending access requests" description="Access requests from users who need admin privileges will appear here." />
          {/* placeholder */}
        </Card>
      )}

      {/* Admin Activity tab */}
      {tab === 'activity' && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">Admin Activity Log</h2>
          <div className="table-responsive">
            <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Event</th>
                  <th className="px-3 py-2 font-medium">Details</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {[
                  { event: 'New admin invited',   detail: 'Brian White was invited as Administrator',         date: '2024-05-14T08:10:00Z' },
                  { event: 'Role updated',         detail: 'Kevin Patel role changed to Billing Manager',     date: '2024-05-13T11:25:00Z' },
                  { event: 'Admin activated',      detail: 'Amanda Clark activated their account',             date: '2024-05-13T15:35:00Z' },
                  { event: 'Admin deactivated',    detail: 'Robert Taylor was deactivated',                   date: '2024-05-10T10:15:00Z' },
                  { event: 'Permission changed',   detail: 'Sarah Johnson granted Security access',           date: '2024-05-09T14:22:00Z' },
                  { event: 'New admin invited',    detail: 'Amanda Clark was invited as Content Manager',     date: '2024-05-08T09:44:00Z' },
                ].map(({ event, detail, date }) => (
                  <tr key={`${event}-${date}`}>
                    <td className="px-3 py-2.5 font-medium">{event}</td>
                    <td className="px-3 py-2.5 text-muted">{detail}</td>
                    <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">
                      <p>{fmtDate(date, 'MMM d, yyyy')}</p>
                      <p>{fmtDate(date, 'hh:mm a')}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        </Card>
      )}

      {/* Settings tab */}
      {tab === 'settings' && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">Admin Settings</h2>
          <p className="mb-5 text-sm text-muted">Configure global admin access policies.</p>
          <div className="space-y-4 max-w-lg">
            {[
              { label: 'Require 2FA for all admins', desc: 'All administrators must use two-factor authentication', enabled: true },
              { label: 'Admin session timeout',       desc: 'Auto-logout after 8 hours of inactivity',             enabled: true },
              { label: 'IP allowlist enforcement',    desc: 'Restrict admin access to approved IP ranges',         enabled: false },
              { label: 'Audit all admin actions',     desc: 'Log every admin action to the audit trail',           enabled: true },
            ].map(({ label, desc, enabled }) => (
              <div key={label} className="flex items-start justify-between gap-4 rounded-xl border border-border p-4">
                <div>
                  <p className="text-sm font-medium">{label}</p>
                  <p className="mt-0.5 text-xs text-muted">{desc}</p>
                </div>
                <button
                  className={`mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? 'bg-brand' : 'bg-elevated'}`}
                  aria-label={label}
                >
                  <span className={`block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform ${enabled ? 'translate-x-5' : ''}`} />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function AdminStatCard({ icon: Icon, label, sub, value, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; sub: string; value: number; color: string;
}) {
  const [iconC, bgC] = color.split(' ');
  return (
    <div className="stat-card flex-col gap-2 p-4">
      <div className={`inline-flex h-11 w-11 items-center justify-center rounded-xl ${bgC}`}>
        <Icon className={`h-5 w-5 ${iconC}`} />
      </div>
      <div>
        <p className="text-2xl font-black leading-none">{value.toLocaleString()}</p>
        <p className="mt-1 text-sm font-semibold">{label}</p>
        <p className="text-xs text-muted">{sub}</p>
      </div>
    </div>
  );
}

function AvatarInitials({ name, size = 32 }: { name: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
  const colors = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500', 'bg-rose-500', 'bg-amber-500'];
  const color = colors[name.charCodeAt(0) % colors.length];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-fg ${color}`}
      style={{ width: size, height: size, fontSize: size * 0.35 }}
    >
      {initials || '?'}
    </span>
  );
}
