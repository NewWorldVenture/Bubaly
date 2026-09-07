import type { Metadata } from 'next';
import { ShieldCheck, Mail, UserX, Clock, Activity, Lock, KeyRound, EyeOff, FileCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { UserSecurityActions } from '@/components/admin/user-security-actions';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Security', robots: { index: false } };
export const dynamic = 'force-dynamic';

const POSTURE = [
  { icon: ShieldCheck, title: 'Row-level security on every table', detail: 'Each family-scoped table is gated by is_family_member(family_id) — a row can never cross a family boundary.' },
  { icon: EyeOff, title: 'No cross-family leakage by construction', detail: 'Access is verified server-side on every read and write, not just hidden in the UI.' },
  { icon: Lock, title: 'Private document storage', detail: 'Files live in a private bucket and are only ever served through short-lived signed URLs.' },
  { icon: KeyRound, title: 'Invite-only family access', detail: 'Joining a family requires a tokenized invite issued to a specific email and verified server-side.' },
  { icon: FileCheck, title: 'Append-only audit log', detail: 'Sensitive actions are recorded permanently; only household managers and the super admin can read them.' },
  { icon: ShieldCheck, title: 'Super admin allowlist with zero read access', detail: 'The super_admins table has RLS enabled with no policies — not even the super admin’s own session can query it. Only a SECURITY DEFINER function may consult it.' },
];

export default async function AdminSecurityPage() {
  const tr = await getTranslations();
  const t = await getTranslations();
  const supabase = createServiceClient();

  const [invitesResult, authUsersResult, auditLogsResult, familiesResult] = await Promise.all([
    supabase.from('invites').select('status'),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, metadata, created_at').order('created_at', { ascending: false }).limit(25),
    supabase.from('families').select('id, name'),
  ]);

  const readError = invitesResult.error ?? authUsersResult.error ?? auditLogsResult.error ?? familiesResult.error;
  if (readError) {
    console.error('[admin-security] security read failed', readError);
    return (
      <div className="module-page space-y-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminSecurity.security')}</h1>
          <p className="mt-1 text-sm text-muted">{t('adminSecurity.liveAccessControlSignalsAcrossAccounts')}</p>
        </div>
        <ErrorState message="Could not load security data from Supabase. Refresh and try again." />
        <a href="/admin/security" className="text-sm font-medium text-brand-text underline">{t('adminSecurity.refreshSecurityOverview')}</a>
      </div>
    );
  }

  const { data: invites } = invitesResult;
  const { data: authUsers } = authUsersResult;
  const { data: auditLogs } = auditLogsResult;
  const { data: families } = familiesResult;

  const inviteCounts = { pending: 0, accepted: 0, expired: 0, revoked: 0, declined: 0 };
  for (const inv of invites ?? []) {
    if (inv.status in inviteCounts) inviteCounts[inv.status as keyof typeof inviteCounts]++;
  }
  const totalInvites = invites?.length ?? 0;
  const acceptRate = totalInvites > 0 ? (inviteCounts.accepted / totalInvites) * 100 : 0;

  const users = authUsers?.users ?? [];
  const confirmedCount = users.filter((u) => u.email_confirmed_at).length;
  const unconfirmedCount = users.length - confirmedCount;
  const neverSignedIn = users.filter((u) => !u.last_sign_in_at).length;
  const bannedCount = users.filter((u) => u.banned_until && new Date(u.banned_until) > new Date()).length;

  const now = new Date();
  const recentAccounts = [...users]
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 10)
    .map((u) => ({
      id: u.id,
      email: u.email ?? null,
      confirmed: Boolean(u.email_confirmed_at),
      lastSignIn: u.last_sign_in_at ?? null,
      banned: Boolean(u.banned_until && new Date(u.banned_until) > now),
      createdAt: u.created_at,
    }));

  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const actorIds = [...new Set((auditLogs ?? []).map((l) => l.actor_id).filter((x): x is string => !!x))];
  const actorsResult = actorIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', actorIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  if ('error' in actorsResult && actorsResult.error) {
    console.error('[admin-security] actor profile read failed', actorsResult.error);
    return (
      <div className="module-page space-y-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminSecurity.security')}</h1>
          <p className="mt-1 text-sm text-muted">{t('adminSecurity.liveAccessControlSignalsAcrossAccounts')}</p>
        </div>
        <ErrorState message="Could not load security activity details from Supabase. Refresh and try again." />
        <a href="/admin/security" className="text-sm font-medium text-brand-text underline">{t('adminSecurity.refreshSecurityOverview')}</a>
      </div>
    );
  }
  const { data: actors } = actorsResult;
  const actorById = new Map((actors ?? []).map((a) => [a.id, a]));

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminSecurity.security')}</h1>
        <p className="mt-1 text-sm text-muted">{t('adminSecurity.realAccessControlSignalsInvitesAccount')}</p>
      </div>

      <div className="grid-stats">
        <StatCard icon={Mail} label={t('adminSecurity.pendingInvites')} value={inviteCounts.pending} tone="bg-warning/10 text-warning" />
        <StatCard icon={ShieldCheck} label={t('adminSecurity.inviteAcceptRate')} value={`${acceptRate.toFixed(0)}%`} tone="bg-success/10 text-success" />
        <StatCard icon={UserX} label={t('adminSecurity.unconfirmedEmails')} value={unconfirmedCount} tone="bg-danger/10 text-danger" />
        <StatCard icon={Clock} label={t('adminSecurity.neverSignedIn')} value={neverSignedIn} tone="bg-accent/10 text-accent" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-base font-semibold">{t('adminSecurity.inviteFunnel')}</h2>
          <ul className="space-y-3">
            {Object.entries(inviteCounts).map(([status, count]) => {
              const pct = totalInvites > 0 ? (count / totalInvites) * 100 : 0;
              return (
                <li key={status}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="capitalize">{status}</span>
                    <span className="text-muted">{count}</span>
                  </div>
                  <div className="h-2 rounded-full bg-elevated">
                    <div className={`h-full rounded-full ${status === 'accepted' ? 'bg-success' : status === 'pending' ? 'bg-warning' : status === 'revoked' ? 'bg-danger' : 'bg-muted'}`} style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-4 text-base font-semibold">{t('adminSecurity.accountSecurity')}</h2>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('adminSecurity.emailConfirmed')}</span>
              <span className="font-medium">{confirmedCount} / {users.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('adminSecurity.currentlyBanned')}</span>
              <Badge tone={bannedCount > 0 ? 'danger' : 'success'}>{bannedCount}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">{t('adminSecurity.neverSignedInAccountExistsNo')}</span>
              <span className="font-medium">{neverSignedIn}</span>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <h2 className="mb-1 text-base font-semibold">{t('adminSecurity.accounts')}</h2>
        <p className="mb-4 text-sm text-muted">{t('adminSecurity.theMostRecentSignUpsReset')}</p>
        {recentAccounts.length === 0 ? (
          <EmptyState icon={UserX} title={t('adminSecurity.noAccountsYet')} />
        ) : (
          <div className="table-responsive">
            <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">{t('adminSecurity.account')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminSecurity.email')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminSecurity.lastSignIn')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminSecurity.status')}</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {recentAccounts.map((u) => (
                  <tr key={u.id}>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Avatar name={u.email || '?'} size={24} />
                        <span className="text-muted">{fmtDate(u.createdAt, 'MMM d, yyyy')}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-medium">{u.email ?? '—'}</td>
                    <td className="px-3 py-2.5 text-muted">{u.lastSignIn ? fmtDate(u.lastSignIn, 'MMM d, yyyy') : 'Never'}</td>
                    <td className="px-3 py-2.5">
                      {u.banned ? <Badge tone="danger">Banned</Badge> : u.confirmed ? <Badge tone="success">Confirmed</Badge> : <Badge tone="warning">Unconfirmed</Badge>}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <UserSecurityActions userId={u.id} email={u.email} banned={u.banned} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted" />
          <h2 className="text-base font-semibold">{t('adminSecurity.sensitiveActivityAcrossAllFamilies')}</h2>
        </div>
        {!auditLogs || auditLogs.length === 0 ? (
          <EmptyState icon={Activity} title={t('adminSecurity.noActivityRecordedYet')} />
        ) : (
          <ul className="space-y-2">
            {auditLogs.map((log) => {
              const actor = log.actor_id ? actorById.get(log.actor_id) : undefined;
              const meta = log.metadata as Record<string, unknown> | null;
              const viaAdmin = meta?.via === 'site_admin';
              return (
                <li key={log.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                  <Badge tone={viaAdmin ? 'danger' : 'neutral'}>{log.action}</Badge>
                  <span className="font-medium">{log.resource}</span>
                  {log.family_id && <span className="text-muted">in {familyNameById.get(log.family_id) ?? 'a family'}</span>}
                  {actor && <span className="text-muted">· by {actor.full_name || actor.email}</span>}
                  {viaAdmin && <Badge tone="brand">Site Admin</Badge>}
                  <span className="ml-auto text-xs text-muted">{fmtDate(log.created_at, 'MMM d, h:mm a')}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="mb-1 text-base font-semibold">{t('adminSecurity.securityPosture')}</h2>
        <p className="mb-4 text-sm text-muted">{tr('adminSecurity.whatsActuallyTrueAboutThisApplications')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {POSTURE.map((p) => (
            <div key={p.title} className="flex gap-3 rounded-xl border border-border bg-surface/40 p-3">
              <p.icon className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <div>
                <p className="text-sm font-medium">{p.title}</p>
                <p className="mt-0.5 text-xs text-muted">{p.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number | string; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{typeof value === 'number' ? value.toLocaleString() : value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
