import type { Metadata } from 'next';
import { UsersRound, UserCheck, UserPlus, UserX, ShieldCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { ROLE_LABELS, type MemberRole } from '@/lib/constants/roles';
import { PLANS } from '@/lib/constants/plans';
import { fmtDate } from '@/lib/utils/format';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { UsersToolbar } from '@/components/admin/users-toolbar';
import { InviteRowActions } from '@/components/admin/invite-row-actions';
import { MemberRowActions } from '@/components/admin/member-row-actions';
import { RoleDonut } from '@/components/admin/role-donut';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'Users & Families', robots: { index: false } };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;
const TABS = [
  { key: 'all', label: 'All Users' },
  { key: 'families', label: 'Families' },
  { key: 'invitations', label: 'Invitations' },
  { key: 'roles', label: 'Roles & Permissions' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

type Params = {
  searchParams: Promise<{
    tab?: string; q?: string; role?: string; status?: string; plan?: string; page?: string;
  }>;
};

type EnrichedUser = {
  profile: Tables<'profiles'>;
  primaryFamily: Tables<'families'> | null;
  role: MemberRole | null;
  plan: string | null;
  status: 'active' | 'inactive' | 'no_family';
  membershipCount: number;
};

export default async function AdminUsersPage({ searchParams }: Params) {
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'all';
  const supabase = createServiceClient();

  // Admin-scale dataset: load everything once and enrich/filter/paginate in memory.
  // At real scale this would move to a dedicated aggregating view or RPC — flagged
  // here rather than hidden, since this is the one place in the app doing that.
  const [{ data: profiles }, { data: members }, { data: families }, { data: subscriptions }, { data: invites }, { data: roles }, { data: permissions }] =
    await Promise.all([
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase.from('family_members').select('*').eq('is_active', true).order('created_at'),
      supabase.from('families').select('*'),
      supabase.from('subscriptions').select('family_id, plan, status'),
      supabase.from('invites').select('*').order('created_at', { ascending: false }),
      supabase.from('roles').select('*'),
      supabase.from('permissions').select('*'),
    ]);

  const familyById = new Map((families ?? []).map((f) => [f.id, f]));
  const subByFamily = new Map((subscriptions ?? []).map((s) => [s.family_id, s]));
  const memberCountByFamily = new Map<string, number>();
  for (const m of members ?? []) memberCountByFamily.set(m.family_id, (memberCountByFamily.get(m.family_id) ?? 0) + 1);

  const membershipsByUser = new Map<string, Tables<'family_members'>[]>();
  for (const m of members ?? []) {
    if (!m.user_id) continue;
    if (!membershipsByUser.has(m.user_id)) membershipsByUser.set(m.user_id, []);
    membershipsByUser.get(m.user_id)!.push(m);
  }

  const enriched: EnrichedUser[] = (profiles ?? []).map((profile) => {
    const memberships = membershipsByUser.get(profile.id) ?? [];
    const primary = memberships[0] ?? null;
    const primaryFamily = primary ? familyById.get(primary.family_id) ?? null : null;
    const plan = primary ? subByFamily.get(primary.family_id)?.plan ?? 'free' : null;
    return {
      profile,
      primaryFamily,
      role: (primary?.role as MemberRole) ?? null,
      plan,
      status: memberships.length === 0 ? 'no_family' : 'active',
      membershipCount: memberships.length,
    };
  });

  // Stats (computed over the full dataset, not the filtered/paginated view).
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const totalUsers = enriched.length;
  const activeUsers = enriched.filter((u) => u.status === 'active').length;
  const newThisMonth = enriched.filter((u) => new Date(u.profile.created_at) >= monthStart).length;
  const noFamilyUsers = enriched.filter((u) => u.status === 'no_family').length;
  const adminCount = enriched.filter((u) => u.role === 'parent').length;

  const roleCounts = new Map<MemberRole, number>();
  for (const u of enriched) if (u.role) roleCounts.set(u.role, (roleCounts.get(u.role) ?? 0) + 1);

  // Filters (applied in-memory; q/role/status/plan all derived from joined data).
  const q = (sp.q ?? '').trim().toLowerCase();
  const roleFilter = sp.role ?? '';
  const statusFilter = sp.status ?? '';
  const planFilter = sp.plan ?? '';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  const filtered = enriched.filter((u) => {
    if (q) {
      const hay = `${u.profile.full_name ?? ''} ${u.profile.email ?? ''} ${u.primaryFamily?.name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter && u.status !== statusFilter) return false;
    if (planFilter && u.plan !== planFilter) return false;
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const hidden = { tab, q: sp.q, role: sp.role, status: sp.status, plan: sp.plan };
  const hiddenDefined = Object.fromEntries(Object.entries(hidden).filter(([, v]) => v !== undefined)) as Record<string, string>;

  return (
    <div className="module-page">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Users & Families</h1>
          <p className="mt-1 text-sm text-muted">Manage all users, families, and their access levels.</p>
        </div>
        <UsersToolbar families={(families ?? []).map((f) => ({ id: f.id, name: f.name }))} exportRows={pageRows.map((u) => ({
          name: u.profile.full_name ?? '', email: u.profile.email ?? '', family: u.primaryFamily?.name ?? '',
          role: u.role ?? '', plan: u.plan ?? '', status: u.status, joined: u.profile.created_at,
        }))} />
      </div>

      <div className="tab-bar border-b border-border pb-px">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/users?tab=${t.key}`} className={`tab-item ${tab === t.key ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {t.label}
          </a>
        ))}
      </div>

      {tab === 'all' && (
        <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
          <div className="space-y-5">
            <div className="grid-stats">
              <StatCard icon={UsersRound} label="Total Users" value={totalUsers} tone="bg-brand/10 text-brand" />
              <StatCard icon={UserCheck} label="Active Users" value={activeUsers} tone="bg-success/10 text-success" />
              <StatCard icon={UserPlus} label="New This Month" value={newThisMonth} tone="bg-accent/10 text-accent" />
              <StatCard icon={UserX} label="No Family" value={noFamilyUsers} tone="bg-warning/10 text-warning" />
              <StatCard icon={ShieldCheck} label="Admins" value={adminCount} tone="bg-danger/10 text-danger" />
            </div>

            <Card>
              <FilterForm action="/admin/users" hidden={{ tab: 'all' }}>
                <FilterSearchInput name="q" defaultValue={sp.q} placeholder="Search users by name, email, or family..." />
                <FilterSelect name="role" defaultValue={roleFilter} options={[
                  { value: '', label: 'All Roles' },
                  ...Object.entries(ROLE_LABELS).map(([v, label]) => ({ value: v, label })),
                ]} />
                <FilterSelect name="status" defaultValue={statusFilter} options={[
                  { value: '', label: 'All Statuses' },
                  { value: 'active', label: 'Active' },
                  { value: 'no_family', label: 'No family' },
                ]} />
                <FilterSelect name="plan" defaultValue={planFilter} options={[
                  { value: '', label: 'All Plans' },
                  ...PLANS.map((p) => ({ value: p.id, label: p.name })),
                ]} />
              </FilterForm>

              {pageRows.length === 0 ? (
                <EmptyState icon={UsersRound} title="No users match these filters" />
              ) : (
                <div className="table-responsive mt-4">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="px-3 py-2 font-medium">User</th>
                        <th className="px-3 py-2 font-medium">Family</th>
                        <th className="px-3 py-2 font-medium">Role</th>
                        <th className="px-3 py-2 font-medium">Plan</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Joined</th>
                        <th className="px-3 py-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {pageRows.map((u) => (
                        <tr key={u.profile.id}>
                          <td className="px-3 py-2.5">
                            <p className="font-medium">{u.profile.full_name || '—'}</p>
                            <p className="text-xs text-muted">{u.profile.email}</p>
                          </td>
                          <td className="px-3 py-2.5 text-muted">
                            {u.primaryFamily ? u.primaryFamily.name : '—'}
                            {u.membershipCount > 1 && <span className="ml-1 text-xs">+{u.membershipCount - 1} more</span>}
                          </td>
                          <td className="px-3 py-2.5">{u.role ? <Badge tone="brand">{ROLE_LABELS[u.role]}</Badge> : '—'}</td>
                          <td className="px-3 py-2.5 text-muted">{u.plan ? PLANS.find((p) => p.id === u.plan)?.name ?? u.plan : '—'}</td>
                          <td className="px-3 py-2.5">
                            <Badge tone={u.status === 'active' ? 'success' : 'neutral'}>{u.status === 'active' ? 'Active' : 'No family'}</Badge>
                          </td>
                          <td className="px-3 py-2.5 text-muted">{fmtDate(u.profile.created_at, 'MMM d, yyyy')}</td>
                          <td className="px-3 py-2.5">
                            {membershipsByUser.get(u.profile.id)?.[0] && (
                              <MemberRowActions memberId={membershipsByUser.get(u.profile.id)![0].id} />
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
                <span>Showing {pageRows.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} users</span>
                <div className="flex gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 7).map((p) => (
                    <a key={p} href={`/admin/users?${new URLSearchParams({ ...hiddenDefined, page: String(p) }).toString()}`}
                      className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium ${p === pageSafe ? 'bg-brand text-brand-fg' : 'hover:bg-elevated'}`}>
                      {p}
                    </a>
                  ))}
                </div>
              </div>
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <h2 className="mb-3 text-base font-semibold">Users by Role</h2>
              <RoleDonut counts={roleCounts} total={totalUsers} />
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">Recent Invites</h2>
              {!invites || invites.length === 0 ? (
                <p className="text-sm text-muted">No invites yet.</p>
              ) : (
                <ul className="space-y-2.5">
                  {invites.slice(0, 5).map((inv) => (
                    <li key={inv.id} className="text-sm">
                      <p className="truncate font-medium">{inv.email}</p>
                      <p className="text-xs text-muted">
                        Invited to {familyById.get(inv.family_id)?.name ?? 'a family'} · {fmtDate(inv.created_at, 'MMM d')}
                      </p>
                      <Badge tone={inv.status === 'pending' ? 'warning' : inv.status === 'accepted' ? 'success' : 'neutral'}>{inv.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      )}

      {tab === 'families' && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">All families <span className="text-muted">({families?.length ?? 0})</span></h2>
          {!families || families.length === 0 ? (
            <EmptyState icon={UsersRound} title="No families yet" />
          ) : (
            <div className="table-responsive">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">Family</th>
                    <th className="px-3 py-2 font-medium">Members</th>
                    <th className="px-3 py-2 font-medium">Plan</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {families.map((f) => {
                    const sub = subByFamily.get(f.id);
                    return (
                      <tr key={f.id}>
                        <td className="px-3 py-2.5 font-medium">{f.name}</td>
                        <td className="px-3 py-2.5 text-muted">{memberCountByFamily.get(f.id) ?? 0}</td>
                        <td className="px-3 py-2.5 text-muted">{sub ? PLANS.find((p) => p.id === sub.plan)?.name ?? sub.plan : '—'}</td>
                        <td className="px-3 py-2.5">{sub ? <Badge tone={sub.status === 'active' ? 'success' : 'neutral'}>{sub.status}</Badge> : '—'}</td>
                        <td className="px-3 py-2.5 text-muted">{fmtDate(f.created_at, 'MMM d, yyyy')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'invitations' && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">All invitations <span className="text-muted">({invites?.length ?? 0})</span></h2>
          {!invites || invites.length === 0 ? (
            <EmptyState icon={UserPlus} title="No invitations sent yet" />
          ) : (
            <div className="table-responsive">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Family</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Sent</th>
                    <th className="px-3 py-2 font-medium">Expires</th>
                    <th className="px-3 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {invites.map((inv) => (
                    <tr key={inv.id}>
                      <td className="px-3 py-2.5 font-medium">{inv.email}</td>
                      <td className="px-3 py-2.5 text-muted">{familyById.get(inv.family_id)?.name ?? '—'}</td>
                      <td className="px-3 py-2.5"><Badge tone="brand">{ROLE_LABELS[inv.role as MemberRole]}</Badge></td>
                      <td className="px-3 py-2.5">
                        <Badge tone={inv.status === 'pending' ? 'warning' : inv.status === 'accepted' ? 'success' : inv.status === 'revoked' ? 'danger' : 'neutral'}>
                          {inv.status}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 text-muted">{fmtDate(inv.created_at, 'MMM d, yyyy')}</td>
                      <td className="px-3 py-2.5 text-muted">{fmtDate(inv.expires_at, 'MMM d, yyyy')}</td>
                      <td className="px-3 py-2.5">{inv.status === 'pending' && <InviteRowActions inviteId={inv.id} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'roles' && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">Role definitions</h2>
          <p className="mb-4 text-sm text-muted">The real permission matrix enforced by every family-scoped table’s RLS policy.</p>
          <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(roles ?? []).map((r) => (
              <div key={r.role} className="rounded-xl border border-border bg-surface/40 p-3">
                <Badge tone="brand">{r.label}</Badge>
                <p className="mt-2 text-xs text-muted">{r.description}</p>
              </div>
            ))}
          </div>
          {permissions && permissions.length > 0 ? (
            <div className="table-responsive">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">Resource</th>
                    {(roles ?? []).map((r) => <th key={r.role} className="px-3 py-2 text-center font-medium">{r.label.split(' / ')[0]}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {[...new Set(permissions.map((p) => p.resource))].map((resource) => (
                    <tr key={resource}>
                      <td className="px-3 py-2.5 font-medium">{resource}</td>
                      {(roles ?? []).map((r) => {
                        const perm = permissions.find((p) => p.resource === resource && p.role === r.role);
                        const letters = [perm?.can_create && 'C', perm?.can_read && 'R', perm?.can_update && 'U', perm?.can_delete && 'D'].filter(Boolean);
                        return (
                          <td key={r.role} className="px-3 py-2.5 text-center text-xs text-muted">
                            {letters.length ? letters.join('') : '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={ShieldCheck} title="Permission matrix not seeded" description="Run supabase/seed.sql against this project to populate roles & permissions." />
          )}
        </Card>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{value.toLocaleString()}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
