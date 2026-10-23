import type { Metadata } from 'next';
import { UsersRound, UserCheck, UserPlus, UserX, ShieldCheck } from 'lucide-react';
import { createServiceClient, describeConfiguredServiceKey } from '@/lib/supabase/server';
import { settleAll, describeReadError, credentialHint } from '@/lib/supabase/settle';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { ROLE_LABEL_KEYS, ROLE_ORDER, roleLabel, type MemberRole } from '@/lib/constants/roles';
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
import { utcMonthStartIso } from '@/lib/admin/clock';

export const metadata: Metadata = { title: 'Users & Families', robots: { index: false } };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 10;
/** Rows a paged read may go through before it is reported as a prefix (one round trip per 1,000). */
const ROW_CEILING = 25_000;
/** The All tab's rail shows this many of the newest invites. */
const RECENT_INVITES = 5;
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
  //
  // "Everything" has to mean everything. These used to be plain unbounded
  // selects, which PostgREST answers with at most `db-max-rows` (1,000) and no
  // error, so past a thousand members the tiles froze, members beyond the cap
  // never reached the list, and a member whose profile was not among the
  // thousand NEWEST profiles was labelled "No account" and counted as one. So:
  //
  //   - the tiles and the role donut are `head: true` counts — exact, uncapped,
  //     one per figure (a paged read answers no count, and a count that can
  //     be asked for is cheaper than rows that must be read);
  //   - the row sets page through readAllByIdAsQuery to a real ceiling; reaching
  //     it is an error, which joins loadErrors and the banner below instead of
  //     rendering a prefix. They page on the id, not on offsets, because they
  //     are counted (members per family, the Families and Invitations totals)
  //     and people join and are invited while this reads: a row written ahead
  //     of the next offset pushed one already read onto the next page, and it
  //     was listed and counted twice;
  //   - profiles are joined by the members' user ids rather than read whole.
  //
  // Each tab reads what it lists, and a ceiling costs only what needs those
  // rows (review R5-SIB-USERS-FAMILIES-LABEL-CEILING). Every family, every
  // subscription and every invite used to be read on every tab, each paged to
  // the ceiling with reaching it an error, so past 25,000 families the Add-user
  // family picker was empty and every member's Family column, the search by
  // family name and the invitations' families were lost; past 25,000
  // subscriptions every member read Free; past 25,000 invites the All tab said
  // "No invites yet"; past 25,000 members every tab was the read-error state:
  //   - members (every tab: the toolbar's Export holds their first page on
  //     each, review R6-USERS-EXPORT-EMPTY-OFF-MEMBER-TABS): the All tab's
  //     listed rows, so past the ceiling that list is its own error state, and
  //     the Families tab's member counts say they are not shown; the tiles, the
  //     donut and the other tabs stay. A failed read is the read-error state
  //     where members are listed (All, Families) and a banner line elsewhere;
  //   - families: the Families tab's listed rows and the picker's options, read
  //     once to the ceiling as a prefix (failOnMax: false). Past it the picker
  //     offers the first families by id and says so, and the Families tab is
  //     its own error state;
  //   - every member's family and each listed invite's family, and the plan of
  //     every member's family (filtered on and exported from every tab) and of
  //     each family the Families tab lists, are read by those ids
  //     (readInChunks), not from a sweep. A failed plan read is no plan, not
  //     Free: the plan reads Unavailable and the Families tab offers no
  //     SetPlanControl to change it from (review R7A-USERS-FAILED-SUBSCRIPTIONS-READ-READS-FREE);
  //   - invites: the All tab's rail is the five newest; the Invitations tab
  //     lists every invite, so its ceiling is that tab's own error state. A
  //     failed read is the rail's, and the Invitations tab's, error state, as a
  //     failed roles or permissions read is the Roles tab's.
  //
  // The counts and the paged reads settle in two batches so each keeps its own
  // tuple type. "This month" starts in the admin zone, not the host's
  // (lib/admin/clock.ts).
  const monthStart = new Date(utcMonthStartIso());
  const listsMembers = tab === 'all' || tab === 'families';
  const notRead = Promise.resolve({ data: null, count: null, error: null, truncated: false } as const);
  const [
    [membersRes, familiesRes, invitesRes, recentInvitesRes, rolesRes, permissionsRes, superAdminsRes, memberCountRes, withAccountCountRes, newThisMonthCountRes],
    roleCountResults,
  ] = await Promise.all([
    settleAll([
      readAllByIdAsQuery((after, limit) => {
        let query = supabase.from('family_members').select('*').eq('is_active', true);
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: ROW_CEILING }),
      readAllByIdAsQuery((after, limit) => {
        let query = supabase.from('families').select('*');
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: ROW_CEILING, failOnMax: false }),
      tab === 'invitations' ? readAllByIdAsQuery((after, limit) => {
        let query = supabase.from('invites').select('*');
        if (after) query = query.gt('id', after);
        return query.order('id').limit(limit);
      }, { max: ROW_CEILING }) : notRead,
      tab === 'all'
        ? supabase.from('invites').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).limit(RECENT_INVITES)
        : notRead,
      supabase.from('roles').select('*'),
      supabase.from('permissions').select('*'),
      supabase.from('super_admins').select('email'),
      supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true),
      supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true).not('user_id', 'is', null),
      supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true).gte('created_at', monthStart.toISOString()),
    ]),
    settleAll(ROLE_ORDER.map((role) =>
      supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true).eq('role', role))),
  ]);
  const membersCeiling = 'truncated' in membersRes && membersRes.truncated;
  const familiesCeiling = 'truncated' in familiesRes && familiesRes.truncated;
  if (membersCeiling) console.warn('[admin-users] the member read reached its ceiling; the member list and the member counts are not shown');
  if (familiesCeiling) console.warn('[admin-users] the family read reached its ceiling; the picker offers the first families only');
  const memberRows = membersRes.data ?? [];
  const inviteRows = (tab === 'all' ? recentInvitesRes.data : invitesRes.data) ?? [];
  // The families each listed row names, and the plan of each listed family and
  // of each member's family (a member's plan is filtered on and exported from every tab).
  const labelledFamilyIds = [...new Set([...memberRows.map((m) => m.family_id), ...inviteRows.map((inv) => inv.family_id)])];
  const planFamilyIds = [...new Set([
    ...memberRows.map((m) => m.family_id),
    ...(tab === 'families' && !familiesCeiling ? (familiesRes.data ?? []).map((f) => f.id) : []),
  ])];
  const userIds = [...new Set(memberRows.map((m) => m.user_id).filter((id): id is string => !!id))];
  const [profilesRes, familyLabelsRes, subscriptionsRes] = await Promise.all([
    readInChunks(userIds, (chunk) => supabase.from('profiles').select('*').in('id', chunk)),
    readInChunks(labelledFamilyIds, (chunk) => supabase.from('families').select('*').in('id', chunk)),
    readInChunks(planFamilyIds, (chunk) =>
      supabase.from('subscriptions').select('id, family_id, plan, status').in('family_id', chunk).order('id')),
  ]);

  // Any query that errored (bad/missing key, unapplied migration, RLS) is reported
  // explicitly rather than silently collapsing to an empty result set.
  for (const [label, res] of [
    ['profiles', profilesRes], ['family_members', membersRes], ['families', familiesRes], ['families (names)', familyLabelsRes],
    ['subscriptions', subscriptionsRes], ['invites', invitesRes], ['invites (recent)', recentInvitesRes], ['roles', rolesRes], ['permissions', permissionsRes],
    ['super_admins', superAdminsRes],
    ['family_members (count)', memberCountRes], ['family_members with an account (count)', withAccountCountRes],
    ['family_members new this month (count)', newThisMonthCountRes],
    ...ROLE_ORDER.map((role, i) => [`family_members (${role} count)`, roleCountResults[i]] as const),
  ] as const) {
    if (res.error) loadErrors.push(`Could not load “${label}”: ${describeReadError(res.error)}`);
  }

  // Only `family_members` is load-bearing here: `enriched` maps over it, so
  // without it there is genuinely nothing to render. Every other dataset is
  // enrichment and already carries a `?? []` / `?? null` default, or its own
  // error state, at its use site, so losing one costs a column or a list, not
  // the page.
  //
  // Bailing on ANY error made the in-page banner below unreachable and blanked
  // a working admin surface whenever a single optional table was unavailable.
  // That is not a hypothetical: production's migration ledger stops at 0001,
  // 0002, 0003, so `roles`, `permissions` and `super_admins` are exactly the
  // kind of later table that can be absent there — and the database is
  // currently reporting CONNECT_TIMEOUT, which makes any one of the eight fail
  // intermittently. One flaky read should not cost an administrator the user
  // list.
  // Past its ceiling the member read costs the member list and the member
  // counts (below), not the page; a member read that fails is still the
  // read-error state on the tabs that list members. On the others it costs
  // the Export alone, and the banner names it.
  if (listsMembers && membersRes.error && !membersCeiling) {
    console.error('[admin-users] users read failed', loadErrors.join('; '));
    return <AdminUsersReadError />;
  }
  if (familiesCeiling && tab === 'families') {
    loadErrors.push(`Could not list “families”: there are more than ${ROW_CEILING.toLocaleString()}, and the Families tab lists none rather than part of them.`);
  }
  if (loadErrors.length > 0) {
    console.warn('[admin-users] partial read — rendering degraded', loadErrors.join('; '));
  }

  const profiles = profilesRes.data;
  // Members oldest first and invites newest first, as the page has always listed
  // them; the paged reads were ordered by id.
  const members = [...memberRows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  // The Families tab's rows and the picker's options: the first families by id past the ceiling.
  const families = familiesRes.data;
  const invites = [...inviteRows].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const roles = rolesRes.data;
  const permissions = permissionsRes.data;

  const familyById = new Map(familyLabelsRes.data.map((f) => [f.id, f]));
  // In id order the last subscription a family has wins, as it did when every subscription was read by id.
  const subByFamily = new Map([...subscriptionsRes.data].sort((a, b) => a.id.localeCompare(b.id)).map((s) => [s.family_id, s]));
  // A failed plan read leaves every plan unknown, not Free: which families'
  // chunk failed is not known, and a family absent from the rows is Free only
  // when the read succeeded.
  const plansUnread = !!subscriptionsRes.error;
  const unavailable = tr('strategyMetrics.unavailable');
  const profileByUserId = new Map(profiles.map((p) => [p.id, p]));
  // Site super-admins: the DB-backed `super_admins` table (toggleable here) plus
  // the immutable code/env allowlist (shown locked).
  const superAdminDbEmails = new Set((superAdminsRes.data ?? []).map((r) => r.email.toLowerCase()));
  const codeAdminEmails = new Set(superAdminEmails());
  const memberCountByFamily = new Map<string, number>();
  for (const m of members) memberCountByFamily.set(m.family_id, (memberCountByFamily.get(m.family_id) ?? 0) + 1);

  // One row per family member (the real people). Members linked to a login
  // account are enriched with the profile's name/email/avatar; account-less
  // members fall back to their member record.
  const enriched: EnrichedUser[] = members.map((member) => {
    const profile = member.user_id ? profileByUserId.get(member.user_id) ?? null : null;
    const family = familyById.get(member.family_id) ?? null;
    const sub = subByFamily.get(member.family_id);
    return {
      member,
      profile,
      family,
      role: member.role,
      plan: plansUnread ? null : sub?.plan ?? 'free',
      hasAccount: !!profile,
      name: profile?.full_name || member.display_name,
      email: profile?.email ?? null,
      joinedAt: member.created_at,
    };
  });

  // Stats: exact counts over the whole table, not over the rows in hand and not
  // over the filtered/paginated view. "With account" is a member with a login
  // (`user_id` set); "No account" is the remainder.
  const totalUsers = memberCountRes.count ?? 0;
  const activeUsers = withAccountCountRes.count ?? 0;
  const newThisMonth = newThisMonthCountRes.count ?? 0;
  const noAccountUsers = Math.max(0, totalUsers - activeUsers);

  const roleCounts = new Map<MemberRole, number>();
  ROLE_ORDER.forEach((role, i) => {
    const count = roleCountResults[i].count ?? 0;
    if (count > 0) roleCounts.set(role, count);
  });
  const adminCount = roleCounts.get('parent') ?? 0;

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
      <PartialReadBanner
        title={tr('adminCeiling.offeredInPart', { n: ROW_CEILING.toLocaleString() })}
        failures={familiesCeiling ? [tr('adminUsers.addUserFamilyPicker')] : []}
      />
      <PartialReadBanner
        title={tr('adminCeiling.figuresNotShown', { n: ROW_CEILING.toLocaleString() })}
        failures={membersCeiling && tab === 'families' ? [tr('adminUsers.members')] : []}
      />

      <div className="tab-bar border-b border-border pb-px">
        {TABS.map((t) => (
          <a key={t.key} href={`/admin/users?tab=${t.key}`} className={`tab-item ${tab === t.key ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {t.label}
          </a>
        ))}
      </div>

      {tab === 'all' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
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
                <FilterSelect name="role" label={tr('adminUsers.role')} defaultValue={roleFilter} options={[
                  { value: '', label: 'All Roles' },
                  ...ROLE_ORDER.map((v) => ({ value: v, label: tr(ROLE_LABEL_KEYS[v]) })),
                ]} />
                <FilterSelect name="status" label={tr('adminUsers.status')} defaultValue={statusFilter} options={[
                  { value: '', label: 'All Statuses' },
                  { value: 'active', label: 'Has account' },
                  { value: 'no_account', label: 'No account' },
                ]} />
                <FilterSelect name="plan" label={tr('adminUsers.plan')} defaultValue={planFilter} options={[
                  { value: '', label: 'All Plans' },
                  ...PLANS.map((p) => ({ value: p.id, label: p.name })),
                ]} />
              </FilterForm>

              {membersCeiling ? (
                // Past the ceiling the list is its own read-error state, not a
                // prefix: it is searched, filtered and paged in memory, and the
                // first members by id are no useful part of it.
                <div className="mt-4"><ErrorState message={tr('users.couldNotLoadUsersAnd')} /></div>
              ) : pageRows.length === 0 ? (
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
                          <td className="px-3 py-2.5">{u.role ? <Badge tone="brand">{roleLabel(tr, u.role)}</Badge> : '—'}</td>
                          <td className="px-3 py-2.5 text-muted">{plansUnread ? unavailable : u.plan ? PLANS.find((p) => p.id === u.plan)?.name ?? u.plan : '—'}</td>
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

              {!membersCeiling && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
                <span>{tr('adminUsers.showing')} {pageRows.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} members</span>
                <div className="flex gap-1">
                  {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 7).map((p) => (
                    <a key={p} href={`/admin/users?${new URLSearchParams({ ...hiddenDefined, page: String(p) }).toString()}`}
                      className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium ${p === pageSafe ? 'bg-brand text-brand-fg' : 'hover:bg-elevated'}`}>
                      {p}
                    </a>
                  ))}
                </div>
              </div>}
            </Card>
          </div>

          <div className="space-y-5">
            <Card>
              <h2 className="mb-3 text-base font-semibold">{tr('adminUsers.usersByRole')}</h2>
              <RoleDonut counts={roleCounts} total={totalUsers} />
            </Card>
            <Card>
              <h2 className="mb-3 text-base font-semibold">{tr('adminUsers.recentInvites')}</h2>
              {recentInvitesRes.error ? (
                // A failed read is not "No invites yet".
                <ErrorState message={tr('users.couldNotLoadUsersAnd')} />
              ) : !invites || invites.length === 0 ? (
                <p className="text-sm text-muted">{tr('adminUsers.noInvitesYet')}</p>
              ) : (
                <ul className="space-y-2.5">
                  {invites.slice(0, RECENT_INVITES).map((inv) => (
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
          <h2 className="mb-4 text-base font-semibold">{tr('adminUsers.allFamilies')} {!familiesCeiling && !familiesRes.error && <span className="text-muted">({families?.length ?? 0})</span>}</h2>
          {familiesCeiling || familiesRes.error ? (
            // Every family or none: past the ceiling, or failed, this tab is its own read-error state.
            <ErrorState message={tr('users.couldNotLoadUsersAnd')} />
          ) : !families || families.length === 0 ? (
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
                        <td className="px-3 py-2.5 text-muted">{membersCeiling ? tr('strategyMetrics.unavailable') : memberCountByFamily.get(f.id) ?? 0}</td>
                        <td className="px-3 py-2.5">{plansUnread
                          ? <span className="text-xs text-muted">{unavailable}</span>
                          : <SetPlanControl familyId={f.id} familyName={f.name} currentPlan={sub?.plan ?? 'free'} />}</td>
                        <td className="px-3 py-2.5">{plansUnread
                          ? <span className="text-xs text-muted">{unavailable}</span>
                          : sub ? <Badge tone={sub.status === 'active' ? 'success' : 'neutral'}>{sub.status}</Badge> : '—'}</td>
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
          <h2 className="mb-4 text-base font-semibold">{tr('adminUsers.allInvitations')} {!invitesRes.error && <span className="text-muted">({invites?.length ?? 0})</span>}</h2>
          {invitesRes.error ? (
            // Every invite or none: past the ceiling, or failed, this tab is its own read-error state.
            <ErrorState message={tr('users.couldNotLoadUsersAnd')} />
          ) : !invites || invites.length === 0 ? (
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
                      <td className="px-3 py-2.5"><Badge tone="brand">{roleLabel(tr, inv.role)}</Badge></td>
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
          {rolesRes.error || permissionsRes.error ? (
            // The matrix's columns are the roles: a failed read of either is this
            // tab's read-error state, not half a grid or "not seeded".
            <ErrorState message={tr('users.couldNotLoadUsersAnd')} />
          ) : (<>
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
          </>)}
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
