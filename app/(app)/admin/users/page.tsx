import type { Metadata } from 'next';
import { UsersRound, UserCheck, UserPlus, UserX, ShieldCheck } from 'lucide-react';
import { createServiceClient, describeConfiguredServiceKey } from '@/lib/supabase/server';
import { settleAll, describeReadError, credentialHint } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ROLE_LABELS, type MemberRole } from '@/lib/constants/roles';
import { PLANS } from '@/lib/constants/plans';
import { fmtDate } from '@/lib/utils/format';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { UsersToolbar } from '@/components/admin/users-toolbar';
import { InviteRowActions } from '@/components/admin/invite-row-actions';
import { MemberRowActions } from '@/components/admin/member-row-actions';
import { SetPlanControl } from '@/components/admin/set-plan-control';
import { SuperAdminToggle } from '@/components/admin/super-admin-toggle';
import { superAdminEmails } from '@/lib/constants/super-admins';
import { RoleDonut } from '@/components/admin/role-donut';
import { AlertTriangle } from 'lucide-react';
import type { Tables } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';

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

// A "person" in the admin console is a family member — the real population of
// the product. Members may be account-less (no login: `user_id` is null), so we
// build the list from `family_members` and enrich with the linked profile when
// one exists. Keying off `profiles` alone would hide everyone without a login.
type EnrichedUser = {
  member: Tables<'family_members'>;
  profile: Tables<'profiles'> | null;
  family: Tables<'families'> | null;
  role: MemberRole;
  plan: string | null;
  hasAccount: boolean;
  name: string;
  email: string | null;
  joinedAt: string;
};

export default async function AdminUsersPage({ searchParams }: Params) {
  const tr = await getTranslations();
  const sp = await searchParams;
  const tab: TabKey = (TABS.find((t) => t.key === sp.tab)?.key as TabKey) ?? 'all';

  // Surface the most common production-config failure up front: without the
  // service-role key, every query below 401s and the page would otherwise show
  // a misleading wall of zeros instead of telling the admin what's wrong.
  const loadErrors: string[] = [];
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    loadErrors.push('SUPABASE_SERVICE_ROLE_KEY is not set on this deployment — the admin console can’t read from Supabase. Add it in your Vercel project’s Environment Variables and redeploy.');
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    loadErrors.push('NEXT_PUBLIC_SUPABASE_URL is not set on this deployment.');
  }

  const supabase = createServiceClient();

  // Admin-scale dataset: load everything once and enrich/filter/paginate in memory.
  // At real scale this would move to a dedicated aggregating view or RPC — flagged
  // here rather than hidden, since this is the one place in the app doing that.
  const [profilesRes, membersRes, familiesRes, subscriptionsRes, invitesRes, rolesRes, permissionsRes, superAdminsRes] =
    await settleAll([
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase.from('family_members').select('*').eq('is_active', true).order('created_at'),
      supabase.from('families').select('*'),
      supabase.from('subscriptions').select('family_id, plan, status'),
      supabase.from('invites').select('*').order('created_at', { ascending: false }),
      supabase.from('roles').select('*'),
      supabase.from('permissions').select('*'),
      supabase.from('super_admins').select('email'),
    ]);

  // Any query that errored (bad/missing key, unapplied migration, RLS) is reported
  // explicitly rather than silently collapsing to an empty result set.
  for (const [label, res] of [
    ['profiles', profilesRes], ['family_members', membersRes], ['families', familiesRes],
    ['subscriptions', subscriptionsRes], ['invites', invitesRes], ['roles', rolesRes], ['permissions', permissionsRes],
    ['super_admins', superAdminsRes],
  ] as const) {
    if (res.error) loadErrors.push(`Could not load “${label}”: ${describeReadError(res.error)}`);
  }

  // Only `family_members` is load-bearing here: `enriched` maps over it, so
  // without it there is genuinely nothing to render. Every other dataset is
  // enrichment and already carries a `?? []` / `?? null` / `?? 'free'` default
  // at its use site, so losing one costs a column, not the page.
  //
  // Bailing on ANY error made the in-page banner below unreachable and blanked
  // a working admin surface whenever a single optional table was unavailable.
  // That is not a hypothetical: production's migration ledger stops at 0001,
  // 0002, 0003, so `roles`, `permissions` and `super_admins` are exactly the
  // kind of later table that can be absent there — and the database is
  // currently reporting CONNECT_TIMEOUT, which makes any one of the eight fail
  // intermittently. One flaky read should not cost an administrator the user
  // list.
  if (membersRes.error) {
    console.error('[admin-users] users read failed', loadErrors.join('; '));
    return <AdminUsersReadError />;
  }
  if (loadErrors.length > 0) {
    console.warn('[admin-users] partial read — rendering degraded', loadErrors.join('; '));
  }

  const profiles = profilesRes.data;
  const members = membersRes.data;
  const families = familiesRes.data;
  const subscriptions = subscriptionsRes.data;
  const invites = invitesRes.data;
  const roles = rolesRes.data;
  const permissions = permissionsRes.data;

  const familyById = new Map((families ?? []).map((f) => [f.id, f]));
  const subByFamily = new Map((subscriptions ?? []).map((s) => [s.family_id, s]));
  const profileByUserId = new Map((profiles ?? []).map((p) => [p.id, p]));
  // Site super-admins: the DB-backed `super_admins` table (toggleable here) plus
  // the immutable code/env allowlist (shown locked).
  const superAdminDbEmails = new Set((superAdminsRes.data ?? []).map((r) => r.email.toLowerCase()));
  const codeAdminEmails = new Set(superAdminEmails());
  const memberCountByFamily = new Map<string, number>();
  for (const m of members ?? []) memberCountByFamily.set(m.family_id, (memberCountByFamily.get(m.family_id) ?? 0) + 1);

  // One row per family member (the real people). Members linked to a login
  // account are enriched with the profile's name/email/avatar; account-less
  // members fall back to their member record.
  const enriched: EnrichedUser[] = (members ?? []).map((member) => {
    const profile = member.user_id ? profileByUserId.get(member.user_id) ?? null : null;
    const family = familyById.get(member.family_id) ?? null;
    const sub = subByFamily.get(member.family_id);
    return {
      member,
      profile,
      family,
      role: member.role,
      plan: sub?.plan ?? 'free',
      hasAccount: !!profile,
      name: profile?.full_name || member.display_name,
      email: profile?.email ?? null,
      joinedAt: member.created_at,
    };
  });

  // Stats (computed over the full dataset, not the filtered/paginated view).
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const totalUsers = enriched.length;
  const activeUsers = enriched.filter((u) => u.hasAccount).length;
  const newThisMonth = enriched.filter((u) => new Date(u.joinedAt) >= monthStart).length;
  const noAccountUsers = enriched.filter((u) => !u.hasAccount).length;
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
      const hay = `${u.name} ${u.email ?? ''} ${u.member.display_name} ${u.family?.name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter === 'active' && !u.hasAccount) return false;
    if (statusFilter === 'no_account' && u.hasAccount) return false;
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
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminUsers.usersFamilies')}</h1>
          <p className="mt-1 text-sm text-muted">{tr('adminUsers.manageAllUsersFamiliesAndTheir')}</p>
        </div>
        <UsersToolbar families={(families ?? []).map((f) => ({ id: f.id, name: f.name }))} exportRows={pageRows.map((u) => ({
          name: u.name, email: u.email ?? '', family: u.family?.name ?? '',
          role: u.role ?? '', plan: u.plan ?? '', status: u.hasAccount ? 'active' : 'no_account', joined: u.joinedAt,
        }))} />
      </div>

      {loadErrors.length > 0 && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
            <div>
              <p className="text-sm font-semibold text-danger">{tr('adminUsers.someDataCouldntBeLoadedFrom')}</p>
              {credentialHint(loadErrors, describeConfiguredServiceKey()) ? (
                <p className="mt-1.5 text-xs font-medium text-danger">{credentialHint(loadErrors, describeConfiguredServiceKey())}</p>
              ) : null}
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-danger/90">
                {loadErrors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </div>
          </div>
        </div>
      )}

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
              <StatCard icon={UsersRound} label={tr('adminUsers.totalMembers')} value={totalUsers} tone="bg-brand/10 text-brand-text" />
              <StatCard icon={UserCheck} label={tr('adminUsers.withAccount')} value={activeUsers} tone="bg-success/10 text-success" />
              <StatCard icon={UserPlus} label={tr('adminUsers.newThisMonth')} value={newThisMonth} tone="bg-accent/10 text-accent" />
              <StatCard icon={UserX} label={tr('adminUsers.noAccount')} value={noAccountUsers} tone="bg-warning/10 text-warning" />
              <StatCard icon={ShieldCheck} label={tr('adminUsers.parents')} value={adminCount} tone="bg-danger/10 text-danger" />
            </div>

            <Card>
              <FilterForm action="/admin/users" hidden={{ tab: 'all' }}>
                <FilterSearchInput name="q" defaultValue={sp.q} placeholder={tr('adminUsers.searchUsersByNameEmailOr')} />
                <FilterSelect name="role" defaultValue={roleFilter} options={[
                  { value: '', label: 'All Roles' },
                  ...Object.entries(ROLE_LABELS).map(([v, label]) => ({ value: v, label })),
                ]} />
                <FilterSelect name="status" defaultValue={statusFilter} options={[
                  { value: '', label: 'All Statuses' },
                  { value: 'active', label: 'Has account' },
                  { value: 'no_account', label: 'No account' },
                ]} />
                <FilterSelect name="plan" defaultValue={planFilter} options={[
                  { value: '', label: 'All Plans' },
                  ...PLANS.map((p) => ({ value: p.id, label: p.name })),
                ]} />
              </FilterForm>

              {pageRows.length === 0 ? (
                totalUsers === 0 && loadErrors.length === 0 ? (
                  <EmptyState
                    icon={UsersRound}
                    title={tr('adminUsers.noMembersYet')}
                    description={tr('users.whenFamiliesAddMembersOr')}
                  />
                ) : (
                  <EmptyState icon={UsersRound} title={tr('adminUsers.noMembersMatchTheseFilters')} />
                )
              ) : (
                <div className="table-responsive mt-4">
                  <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted">
                        <th className="px-3 py-2 font-medium">{tr('adminUsers.user')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminUsers.family')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminUsers.role')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminUsers.plan')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminUsers.status')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminUsers.admin')}</th>
                        <th className="px-3 py-2 font-medium">{tr('adminUsers.joined')}</th>
                        <th className="px-3 py-2 font-medium" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/60">
                      {pageRows.map((u) => (
                        <tr key={u.member.id}>
                          <td className="px-3 py-2.5">
                            <p className="font-medium">{u.name || '—'}</p>
                            <p className="text-xs text-muted">{u.email ?? <span className="italic">{tr('users.noLoginAccount')}</span>}</p>
                          </td>
                          <td className="px-3 py-2.5 text-muted">{u.family ? u.family.name : '—'}</td>
                          <td className="px-3 py-2.5">{u.role ? <Badge tone="brand">{ROLE_LABELS[u.role]}</Badge> : '—'}</td>
                          <td className="px-3 py-2.5 text-muted">{u.plan ? PLANS.find((p) => p.id === u.plan)?.name ?? u.plan : '—'}</td>
                          <td className="px-3 py-2.5">
                            <Badge tone={u.hasAccount ? 'success' : 'neutral'}>{u.hasAccount ? 'Active' : 'No account'}</Badge>
                          </td>
                          <td className="px-3 py-2.5">
                            {u.email ? (
                              <SuperAdminToggle
                                email={u.email}
                                isAdmin={superAdminDbEmails.has(u.email.toLowerCase()) || codeAdminEmails.has(u.email.toLowerCase())}
                                locked={codeAdminEmails.has(u.email.toLowerCase())}
                              />
                            ) : '—'}
                          </td>
                          <td className="px-3 py-2.5 text-muted">{fmtDate(u.joinedAt, 'MMM d, yyyy')}</td>
                          <td className="px-3 py-2.5">
                            <MemberRowActions memberId={u.member.id} displayName={u.member.display_name} role={u.member.role} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
                <span>{tr('adminUsers.showing')} {pageRows.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} members</span>
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
              <h2 className="mb-3 text-base font-semibold">{tr('adminUsers.usersByRole')}</h2>
              <RoleDonut counts={roleCounts} total={totalUsers} />
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">{tr('adminUsers.recentInvites')}</h2>
              {!invites || invites.length === 0 ? (
                <p className="text-sm text-muted">{tr('adminUsers.noInvitesYet')}</p>
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
          <h2 className="mb-4 text-base font-semibold">{tr('adminUsers.allFamilies')} <span className="text-muted">({families?.length ?? 0})</span></h2>
          {!families || families.length === 0 ? (
            <EmptyState icon={UsersRound} title={tr('adminUsers.noFamiliesYet')} />
          ) : (
            <div className="table-responsive">
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.family')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.members')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.plan')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.status')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.created')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {families.map((f) => {
                    const sub = subByFamily.get(f.id);
                    return (
                      <tr key={f.id}>
                        <td className="px-3 py-2.5 font-medium">{f.name}</td>
                        <td className="px-3 py-2.5 text-muted">{memberCountByFamily.get(f.id) ?? 0}</td>
                        <td className="px-3 py-2.5"><SetPlanControl familyId={f.id} familyName={f.name} currentPlan={sub?.plan ?? 'free'} /></td>
                        <td className="px-3 py-2.5">{sub ? <Badge tone={sub.status === 'active' ? 'success' : 'neutral'}>{sub.status}</Badge> : '—'}</td>
                        <td className="px-3 py-2.5 text-muted">{fmtDate(f.created_at, 'MMM d, yyyy')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            </div>
          )}
        </Card>
      )}

      {tab === 'invitations' && (
        <Card>
          <h2 className="mb-4 text-base font-semibold">{tr('adminUsers.allInvitations')} <span className="text-muted">({invites?.length ?? 0})</span></h2>
          {!invites || invites.length === 0 ? (
            <EmptyState icon={UserPlus} title={tr('adminUsers.noInvitationsSentYet')} />
          ) : (
            <div className="table-responsive">
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.email')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.family')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.role')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.status')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.sent')}</th>
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.expires')}</th>
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
              </table></div>
            </div>
          )}
        </Card>
      )}

      {tab === 'roles' && (
        <Card>
          <h2 className="mb-1 text-base font-semibold">{tr('adminUsers.roleDefinitions')}</h2>
          <p className="mb-4 text-sm text-muted">{tr('adminUsers.theRealPermissionMatrixEnforcedBy')}</p>
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
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">{tr('adminUsers.resource')}</th>
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
              </table></div>
            </div>
          ) : (
            <EmptyState icon={ShieldCheck} title={tr('adminUsers.permissionMatrixNotSeeded')} description={tr('users.runSupabaseSeedSqlAgainst')} />
          )}
        </Card>
      )}
    </div>
  );
}

async function AdminUsersReadError() {
  const tr = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminUsers.usersFamilies')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('users.manageAllUsersFamiliesAnd')}</p>
      </div>
      <ErrorState message={tr('users.couldNotLoadUsersAnd')} />
      <a href="/admin/users" className="text-sm font-medium text-brand-text underline">{tr('users.refreshUsers')}</a>
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
