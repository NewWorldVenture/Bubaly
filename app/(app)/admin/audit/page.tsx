import type { Metadata } from 'next';
import { ScrollText, ShieldAlert, Activity, Building2 } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('audit.auditLogs'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 40;
/** The newest events the list holds. */
const LISTED = 1000;
/** Events the distinct tallies may page through before they say they are not shown (one round trip per 1,000). */
const TALLY_ROW_CEILING = 25_000;
type Params = { searchParams: Promise<{ q?: string; action?: string; resource?: string; scope?: string; page?: string }> };

export default async function AdminAuditPage({ searchParams }: Params) {
  const t = await getTranslations();
  const sp = await searchParams;
  const supabase = createServiceClient();

  // Pull a bounded recent window; admin-scale auditing would page server-side,
  // flagged here rather than hidden. Settled: a transport failure REJECTS
  // rather than resolving { error }, and unsettled it skipped the read-error
  // state below for the route's error boundary.
  //
  // The four tiles were tallied from that window, so past 1,000 events
  // "Logged events" read 1,000 and the rest counted the newest thousand, as if
  // that were the whole log (coverage sweep round 9, class B). The two that
  // are counts are head:true counts now; the two that are distinct (action
  // types, families touched) page every event on the id to a ceiling, past
  // which they say they are not shown. The list is as it was, and says so
  // when it holds only part of the log.
  const [{ data: logs, error: logsError }, totalResult, adminActionsResult, tallyResult] = await settleAll([
    supabase.from('audit_logs').select('id, family_id, actor_id, action, resource, metadata, created_at')
      .order('created_at', { ascending: false }).limit(LISTED),
    supabase.from('audit_logs').select('id', { count: 'exact', head: true }),
    supabase.from('audit_logs').select('id', { count: 'exact', head: true }).eq('metadata->>via', 'site_admin'),
    readAllByIdAsQuery((after, limit) => {
      let query = supabase.from('audit_logs').select('id, action, family_id');
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    }, { max: TALLY_ROW_CEILING }),
  ]);
  const tallyCeiling = 'truncated' in tallyResult && tallyResult.truncated;

  const rows = logs ?? [];
  // Name only the families and actors these rows name, a hundred ids a
  // request. An unbounded families select answered with the first 1,000
  // families and no error, so a row from any family past them had no name to
  // show or search by; one `.in()` over every actor of a thousand rows built a
  // request line past the gateway's limit.
  const familyIds = [...new Set(rows.map((l) => l.family_id).filter((x): x is string => !!x))];
  const actorIds = [...new Set(rows.map((l) => l.actor_id).filter((x): x is string => !!x))];
  const [{ data: families, error: familiesError }, { data: actors, error: actorsError }] = await settleAll([
    readInChunks(familyIds, (chunk) => supabase.from('families').select('id, name').in('id', chunk)),
    readInChunks(actorIds, (chunk) => supabase.from('profiles').select('id, full_name, email').in('id', chunk)),
  ]);
  const familyNameById = new Map((families ?? []).map((f) => [f.id, f.name]));
  const readError = logsError ?? familiesError ?? actorsError ?? totalResult.error ?? adminActionsResult.error
    ?? (tallyCeiling ? null : tallyResult.error);
  if (readError) {
    console.error('[admin-audit] audit read failed', readError);
    return <AdminAuditReadError />;
  }
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

  const totalEvents = totalResult.count ?? 0;
  const tallied = tallyResult.data ?? [];
  const unavailable = t('strategyMetrics.unavailable');
  const actionTypes = tallyCeiling ? unavailable : new Set(tallied.map((l) => l.action)).size.toLocaleString();
  const familiesTouched = tallyCeiling ? unavailable : new Set(tallied.map((l) => l.family_id).filter(Boolean)).size.toLocaleString();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);
  const hidden = Object.fromEntries(Object.entries({ q: sp.q, action: sp.action, resource: sp.resource, scope: sp.scope }).filter(([, v]) => v)) as Record<string, string>;

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminAudit.auditLogs')}</h1>
        <p className="mt-1 text-sm text-muted">{t('adminAudit.anAppendOnlyRecordOfSensitive')}</p>
      </div>

      <PartialReadBanner
        title={t('adminCeiling.figuresNotShown', { n: TALLY_ROW_CEILING.toLocaleString() })}
        failures={tallyCeiling ? [t('adminAudit.actionTypes'), t('adminAudit.familiesTouched')] : []}
      />

      <div className="grid-stats">
        <StatCard icon={ScrollText} label={t('adminAudit.loggedEvents')} value={totalEvents.toLocaleString()} tone="bg-brand/10 text-brand-text" />
        <StatCard icon={ShieldAlert} label={t('adminAudit.siteAdminActions')} value={(adminActionsResult.count ?? 0).toLocaleString()} tone="bg-danger/10 text-danger" />
        <StatCard icon={Activity} label={t('adminAudit.actionTypes')} value={actionTypes} tone="bg-accent/10 text-accent" />
        <StatCard icon={Building2} label={t('adminAudit.familiesTouched')} value={familiesTouched} tone="bg-success/10 text-success" />
      </div>

      <Card>
        <FilterForm action="/admin/audit">
          <FilterSearchInput name="q" defaultValue={sp.q} placeholder={t('adminAudit.searchByActorFamilyActionOr')} />
          <FilterSelect name="action" label={t('adminAudit.action')} defaultValue={actionFilter} options={[{ value: '', label: 'All Actions' }, ...actionOptions.map((a) => ({ value: a, label: a }))]} />
          <FilterSelect name="resource" label={t('adminAudit.resource')} defaultValue={resourceFilter} options={[{ value: '', label: 'All Resources' }, ...resourceOptions.map((r) => ({ value: r, label: r }))]} />
          <FilterSelect name="scope" label={t('adminAudit.source')} defaultValue={scopeFilter} options={[{ value: '', label: 'All Sources' }, { value: 'admin', label: 'Site admin only' }, { value: 'family', label: 'In-family only' }]} />
        </FilterForm>

        {totalEvents > rows.length && (
          <p className="mt-3 text-xs text-muted">{t('adminCeiling.listAndFiltersShowTheNewest', { shown: rows.length.toLocaleString(), total: totalEvents.toLocaleString() })}</p>
        )}

        {pageRows.length === 0 ? (
          <EmptyState icon={ScrollText} title={rows.length === 0 ? 'No activity recorded yet' : 'No events match these filters'} />
        ) : (
          <div className="table-responsive mt-4">
            <div role="region" tabIndex={0} aria-label={t('adminAudit.loggedEvents')} className="focus-ring overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">{t('adminAudit.action')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAudit.resource')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAudit.family')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAudit.actor')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAudit.source')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAudit.when')}</th>
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
                        ) : <span className="text-muted">{t('audit.system')}</span>}
                      </td>
                      <td className="px-3 py-2.5">{viaAdmin ? <Badge tone="brand">{t('audit.siteAdmin')}</Badge> : <span className="text-xs text-muted">In-family</span>}</td>
                      <td className="px-3 py-2.5 text-muted">{fmtDate(l.created_at, 'MMM d, h:mm a')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>{t('adminAudit.showing')} {pageRows.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} events</span>
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

async function AdminAuditReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('audit.auditLogs')}</h1>
        <p className="mt-1 text-sm text-muted">{t('audit.anAppendOnlyRecordOf')}</p>
      </div>
      <ErrorState message={t('audit.couldNotLoadAuditLogs')} />
      <a href="/admin/audit" className="text-sm font-medium text-brand-text underline">{t('audit.refreshAuditLogs')}</a>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, tone }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; tone: string;
}) {
  return (
    <div className="stat-card">
      <div className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-xl font-bold leading-none">{value}</p>
        <p className="mt-1 text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}
