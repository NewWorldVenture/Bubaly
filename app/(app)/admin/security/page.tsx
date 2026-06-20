import type { Metadata } from 'next';
import { ShieldCheck, Mail, UserX, Clock, Activity, Lock, KeyRound, EyeOff, FileCheck } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/states';
import { UserSecurityActions } from '@/components/admin/user-security-actions';
import { fmtDate } from '@/lib/utils/format';

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
  const supabase = createServiceClient();

  const [{ data: invites }, { data: authUsers }, { data: auditLogs }, { data: families }] = await Promise.all([
    supabase.from('invites').select('status'),
    supabase.auth.admin.listUsers({ perPage: 1000 }),
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, metadata, created_at').order('created_at', { ascending: false }).limit(25),
    supabase.from('families').select('id, name'),
  ]);

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
  const { data: actors } = actorIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', actorIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const actorById = new Map((actors ?? []).map((a) => [a.id, a]));

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Security</h1>
        <p className="mt-1 text-sm text-muted">Real access-control signals — invites, account security, and sensitive activity across every family.</p>
      </div>

      <div className="grid-stats">
        <StatCard icon={Mail} label="Pending invites" value={inviteCounts.pending} tone="bg-warning/10 text-warning" />
        <StatCard icon={ShieldCheck} label="Invite accept rate" value={`${acceptRate.toFixed(0)}%`} tone="bg-success/10 text-success" />
        <StatCard icon={UserX} label="Unconfirmed emails" value={unconfirmedCount} tone="bg-danger/10 text-danger" />
        <StatCard icon={Clock} label="Never signed in" value={neverSignedIn} tone="bg-accent/10 text-accent" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-base font-semibold">Invite funnel</h2>
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
          <h2 className="mb-4 text-base font-semibold">Account security</h2>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted">Email confirmed</span>
              <span className="font-medium">{confirmedCount} / {users.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Currently banned</span>
              <Badge tone={bannedCount > 0 ? 'danger' : 'success'}>{bannedCount}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Never signed in (account exists, no login yet)</span>
              <span className="font-medium">{neverSignedIn}</span>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <h2 className="mb-1 text-base font-semibold">Accounts</h2>
        <p className="mb-4 text-sm text-muted">The most recent sign-ups — reset a password or ban an account that needs intervention.</p>
        {recentAccounts.length === 0 ? (
          <EmptyState icon={UserX} title="No accounts yet" />
        ) : (
          <div className="table-responsive">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Last sign-in</th>
                  <th className="px-3 py-2 font-medium">Status</th>
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
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted" />
          <h2 className="text-base font-semibold">Sensitive activity, across all families</h2>
        </div>
        {!auditLogs || auditLogs.length === 0 ? (
          <EmptyState icon={Activity} title="No activity recorded yet" />
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
        <h2 className="mb-1 text-base font-semibold">Security posture</h2>
        <p className="mb-4 text-sm text-muted">What&rsquo;s actually true about this application&rsquo;s architecture — not a live scan, a description of how it&rsquo;s built.</p>
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
