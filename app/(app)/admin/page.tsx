import type { Metadata } from 'next';
import { Users, UsersRound, CreditCard, Home, Activity } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Site Admin', robots: { index: false } };

function StatCard({ icon: Icon, label, value }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: number;
}) {
  return (
    <Card className="flex items-center gap-4">
      <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
        <Icon className="h-6 w-6" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-none">{value.toLocaleString()}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </Card>
  );
}

export default async function SiteAdminPage() {
  // Service-role client: this page is the one place in the app that intentionally
  // bypasses RLS, gated entirely by the super-admin check in admin/layout.tsx.
  const supabase = createServiceClient();

  const [
    { count: familyCount },
    { count: userCount },
    { count: memberCount },
    { count: activeSubCount },
    { data: families },
    { data: subscriptions },
    { data: members },
    { data: recentLogs },
  ] = await Promise.all([
    supabase.from('families').select('id', { count: 'exact', head: true }),
    supabase.from('profiles').select('id', { count: 'exact', head: true }),
    supabase.from('family_members').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('status', 'active'),
    supabase.from('families').select('id, name, created_at').order('created_at', { ascending: false }).limit(12),
    supabase.from('subscriptions').select('family_id, plan, status'),
    supabase.from('family_members').select('family_id').eq('is_active', true),
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, metadata, created_at')
      .order('created_at', { ascending: false }).limit(20),
  ]);

  const subByFamily = new Map((subscriptions ?? []).map((s) => [s.family_id, s]));
  const memberCounts = new Map<string, number>();
  for (const m of members ?? []) memberCounts.set(m.family_id, (memberCounts.get(m.family_id) ?? 0) + 1);

  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const actorIds = [...new Set((recentLogs ?? []).map((l) => l.actor_id).filter((x): x is string => !!x))];
  const { data: actors } = actorIds.length
    ? await supabase.from('profiles').select('id, full_name, email').in('id', actorIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const actorById = new Map((actors ?? []).map((a) => [a.id, a]));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Site Admin</h1>
        <p className="mt-1 text-sm text-muted">Cross-family oversight — every family on FamilyOS, in one place.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Home} label="Total families" value={familyCount ?? 0} />
        <StatCard icon={Users} label="Total users" value={userCount ?? 0} />
        <StatCard icon={UsersRound} label="Active members" value={memberCount ?? 0} />
        <StatCard icon={CreditCard} label="Active subscriptions" value={activeSubCount ?? 0} />
      </div>

      <Card>
        <h2 className="mb-4 text-base font-semibold">Recent families</h2>
        {!families || families.length === 0 ? (
          <EmptyState icon={Home} title="No families yet" />
        ) : (
          <div className="overflow-x-auto">
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
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={f.name} size={28} className="rounded-md" />
                          <span className="font-medium">{f.name}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-muted">{memberCounts.get(f.id) ?? 0}</td>
                      <td className="px-3 py-2.5 text-muted">{sub?.plan ?? '—'}</td>
                      <td className="px-3 py-2.5">
                        {sub ? (
                          <Badge tone={sub.status === 'active' ? 'success' : sub.status === 'past_due' ? 'danger' : 'neutral'}>
                            {sub.status}
                          </Badge>
                        ) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-muted">{fmtDate(f.created_at, 'MMM d, yyyy')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted" />
          <h2 className="text-base font-semibold">Recent activity, across all families</h2>
        </div>
        {!recentLogs || recentLogs.length === 0 ? (
          <EmptyState icon={Activity} title="No activity recorded yet" />
        ) : (
          <ul className="space-y-2">
            {recentLogs.map((log) => {
              const actor = log.actor_id ? actorById.get(log.actor_id) : undefined;
              const familyName = log.family_id ? familyNameById.get(log.family_id) ?? 'Unknown family' : '—';
              return (
                <li key={log.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                  <Badge tone="neutral">{log.action}</Badge>
                  <span className="font-medium">{log.resource}</span>
                  <span className="text-muted">in {familyName}</span>
                  {actor && <span className="text-muted">· by {actor.full_name || actor.email}</span>}
                  <span className="ml-auto text-xs text-muted">{fmtDate(log.created_at, 'MMM d, h:mm a')}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
