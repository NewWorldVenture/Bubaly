import type { Metadata } from 'next';
import { ScrollText, ShieldAlert, Activity, Building2 } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { fmtDate } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Audit Logs', robots: { index: false } };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 40;
type Params = { searchParams: Promise<{ q?: string; action?: string; resource?: string; scope?: string; page?: string }> };

export default async function AdminAuditPage({ searchParams }: Params) {
  const sp = await searchParams;
  const supabase = createServiceClient();

  // Pull a bounded recent window; admin-scale auditing would page server-side,
  // flagged here rather than hidden.
  const [{ data: logs }, { data: families }] = await Promise.all([
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, metadata, created_at')
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

  const actionOptions = [...new Set(rows.map((l) => l.action))].sort();
  const resourceOptions = [...new Set(rows.map((l) => l.resource))].sort();

  const q = (sp.q ?? '').trim().toLowerCase();
  const actionFilter = sp.action ?? '';
  const resourceFilter = sp.resource ?? '';
  const scopeFilter = sp.scope ?? '';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  const filtered = rows.filter((l) => {
    const meta = l.metadata as Record<string, unknown> | null;
    const viaAdmin = meta?.via === 'site_admin';
    if (actionFilter && l.action !== actionFilter) return false;
    if (resourceFilter && l.resource !== resourceFilter) return false;
    if (scopeFilter === 'admin' && !viaAdmin) return false;
    if (scopeFilter === 'family' && viaAdmin) return false;
    if (q) {
      const actor = l.actor_id ? actorById.get(l.actor_id) : undefined;
      const hay = `${l.action} ${l.resource} ${familyNameById.get(l.family_id ?? '') ?? ''} ${actor?.full_name ?? ''} ${actor?.email ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const adminActions = rows.filter((l) => (l.metadata as Record<string, unknown> | null)?.via === 'site_admin').length;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const hidden = Object.fromEntries(Object.entries({ q: sp.q, action: sp.action, resource: sp.resource, scope: sp.scope }).filter(([, v]) => v)) as Record<string, string>;

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Audit Logs</h1>
        <p className="mt-1 text-sm text-muted">An append-only record of sensitive actions across every family and the site admin.</p>
      </div>

      <div className="grid-stats">
        <StatCard icon={ScrollText} label="Logged events" value={rows.length} tone="bg-brand/10 text-brand-text" />
        <StatCard icon={ShieldAlert} label="Site-admin actions" value={adminActions} tone="bg-danger/10 text-danger" />
        <StatCard icon={Activity} label="Action types" value={actionOptions.length} tone="bg-accent/10 text-accent" />
        <StatCard icon={Building2} label="Families touched" value={new Set(rows.map((l) => l.family_id).filter(Boolean)).size} tone="bg-success/10 text-success" />
      </div>

      <Card>
        <FilterForm action="/admin/audit">
          <FilterSearchInput name="q" defaultValue={sp.q} placeholder="Search by actor, family, action, or resource..." />
          <FilterSelect name="action" defaultValue={actionFilter} options={[{ value: '', label: 'All Actions' }, ...actionOptions.map((a) => ({ value: a, label: a }))]} />
          <FilterSelect name="resource" defaultValue={resourceFilter} options={[{ value: '', label: 'All Resources' }, ...resourceOptions.map((r) => ({ value: r, label: r }))]} />
          <FilterSelect name="scope" defaultValue={scopeFilter} options={[{ value: '', label: 'All Sources' }, { value: 'admin', label: 'Site admin only' }, { value: 'family', label: 'In-family only' }]} />
        </FilterForm>

        {pageRows.length === 0 ? (
          <EmptyState icon={ScrollText} title={rows.length === 0 ? 'No activity recorded yet' : 'No events match these filters'} />
        ) : (
          <div className="table-responsive mt-4">
            <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Resource</th>
                  <th className="px-3 py-2 font-medium">Family</th>
                  <th className="px-3 py-2 font-medium">Actor</th>
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pageRows.map((l) => {
                  const actor = l.actor_id ? actorById.get(l.actor_id) : undefined;
                  const viaAdmin = (l.metadata as Record<string, unknown> | null)?.via === 'site_admin';
                  return (
                    <tr key={l.id}>
                      <td className="px-3 py-2.5"><Badge tone={viaAdmin ? 'danger' : 'neutral'}>{l.action}</Badge></td>
                      <td className="px-3 py-2.5 font-medium">{l.resource}</td>
                      <td className="px-3 py-2.5 text-muted">{l.family_id ? familyNameById.get(l.family_id) ?? '—' : '—'}</td>
                      <td className="px-3 py-2.5">
                        {actor ? (
                          <div className="flex items-center gap-2">
                            <Avatar name={actor.full_name || actor.email || '?'} size={22} />
                            <span className="text-muted">{actor.full_name || actor.email}</span>
                          </div>
                        ) : <span className="text-muted">System</span>}
                      </td>
                      <td className="px-3 py-2.5">{viaAdmin ? <Badge tone="brand">Site Admin</Badge> : <span className="text-xs text-muted">In-family</span>}</td>
                      <td className="px-3 py-2.5 text-muted">{fmtDate(l.created_at, 'MMM d, h:mm a')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>Showing {pageRows.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} events</span>
          {totalPages > 1 && (
            <div className="flex gap-1">
              {Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 10).map((p) => (
                <a key={p} href={`/admin/audit?${new URLSearchParams({ ...hidden, page: String(p) }).toString()}`}
                  className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium ${p === pageSafe ? 'bg-brand text-brand-fg' : 'hover:bg-elevated'}`}>
                  {p}
                </a>
              ))}
            </div>
          )}
        </div>
      </Card>
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
