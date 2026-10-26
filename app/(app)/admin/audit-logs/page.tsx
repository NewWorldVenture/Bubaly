import type { Metadata } from 'next';
import { ClipboardList, Shield, User, Folder, Calendar, Settings } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('auditLogs.auditLogs'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;
/** The newest logs the list holds. */
const LISTED = 500;

const ACTION_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'brand'> = {
  create: 'success', insert: 'success',
  delete: 'danger', remove: 'danger',
  update: 'warning', change: 'warning',
  login: 'brand', auth: 'brand',
};

type Params = { searchParams: Promise<{ q?: string; action?: string; page?: string }> };

export default async function AuditLogsPage({ searchParams }: Params) {
  const t = await getTranslations();
  const sp = await searchParams;
  const supabase = createServiceClient();

  // The list is the newest 500, and "of N logs" counted them, so past 500 the
  // "complete audit trail" read 500 logs with nothing to say so (coverage
  // sweep round 9, class B). The log is counted now, and the list says when it
  // holds only part of it.
  const [{ data: logs, error: logsError }, totalResult] = await settleAll([
    supabase
      .from('audit_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(LISTED),
    supabase.from('audit_logs').select('id', { count: 'exact', head: true }),
  ]);
  if (logsError) {
    console.error('[admin-audit-logs] audit read failed', logsError);
    return <AdminAuditLogsReadError />;
  }
  if (totalResult.error) {
    console.error('[admin-audit-logs] audit count read failed', totalResult.error);
    return <AdminAuditLogsReadError />;
  }
  const totalLogs = totalResult.count ?? 0;

  const allLogs = logs ?? [];
  const actions = [...new Set(allLogs.map((l) => l.action))].sort();

  const q = (sp.q ?? '').trim().toLowerCase();
  const actionFilter = sp.action ?? '';
  const page = Math.max(1, Number(sp.page ?? '1') || 1);

  let filtered = allLogs;
  if (q) filtered = filtered.filter((l) => {
    const hay = `${l.action} ${l.resource} ${l.resource_id ?? ''} ${l.actor_id ?? ''}`.toLowerCase();
    return hay.includes(q);
  });
  if (actionFilter) filtered = filtered.filter((l) => l.action === actionFilter);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = filtered.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const hiddenParams = Object.fromEntries(
    Object.entries({ q: sp.q, action: sp.action }).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminAuditLogs.auditLogs')}</h1>
        <p className="mt-1 text-sm text-muted">{t('adminAuditLogs.completeAuditTrailOfAllSystem')}</p>
      </div>

      <Card>
        <FilterForm action="/admin/audit-logs">
          <FilterSearchInput name="q" defaultValue={sp.q} placeholder={t('adminAuditLogs.searchLogsByActionResourceActor')} />
          <FilterSelect name="action" label={t('adminAuditLogs.action')} defaultValue={actionFilter} options={[
            { value: '', label: 'All Actions' },
            ...actions.map((a) => ({ value: a, label: a })),
          ]} />
        </FilterForm>
        {totalLogs > allLogs.length && (
          <p className="mt-3 text-xs text-muted">{t('adminCeiling.listAndFiltersShowTheNewest', { shown: allLogs.length.toLocaleString(), total: totalLogs.toLocaleString() })}</p>
        )}

        {pageRows.length === 0 ? (
          <div className="mt-6"><EmptyState icon={ClipboardList} title={t('adminAuditLogs.noAuditLogsFound')} /></div>
        ) : (
          <div className="table-responsive mt-4">
            <div role="region" tabIndex={0} aria-label={t('adminAuditLogs.auditLogs')} className="focus-ring overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">{t('adminAuditLogs.action')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAuditLogs.resource')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAuditLogs.actor')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAuditLogs.family')}</th>
                  <th className="px-3 py-2 font-medium">{t('adminAuditLogs.timestamp')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pageRows.map((log) => {
                  const toneKey = Object.keys(ACTION_TONE).find((k) => log.action.toLowerCase().includes(k));
                  const tone = toneKey ? ACTION_TONE[toneKey] : 'neutral';
                  return (
                    <tr key={log.id} className="hover:bg-elevated/40 transition-colors">
                      <td className="px-3 py-2.5">
                        <Badge tone={tone}>{log.action}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="font-medium">{log.resource}</p>
                        {log.resource_id && (
                          <p className="font-mono text-[10px] text-muted truncate max-w-[120px]">{log.resource_id}</p>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-muted truncate max-w-[120px]">
                        {log.actor_id ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-muted truncate max-w-[120px]">
                        {log.family_id ?? '—'}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted whitespace-nowrap">
                        <p>{fmtDate(log.created_at, 'MMM d, yyyy')}</p>
                        <p>{fmtDate(log.created_at, 'hh:mm:ss a')}</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>{t('adminAuditLogs.showing')} {filtered.length === 0 ? 0 : (pageSafe - 1) * PAGE_SIZE + 1} to {(pageSafe - 1) * PAGE_SIZE + pageRows.length} of {filtered.length} logs</span>
          <div className="flex gap-1">
            {pageSafe > 1 && (
              <a href={`/admin/audit-logs?${new URLSearchParams({ ...hiddenParams, page: String(pageSafe - 1) })}`}
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">‹</a>
            )}
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => i + 1).map((p) => (
              <a key={p} href={`/admin/audit-logs?${new URLSearchParams({ ...hiddenParams, page: String(p) })}`}
                className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium ${p === pageSafe ? 'bg-brand text-brand-fg' : 'hover:bg-elevated'}`}>
                {p}
              </a>
            ))}
            {pageSafe < totalPages && (
              <a href={`/admin/audit-logs?${new URLSearchParams({ ...hiddenParams, page: String(pageSafe + 1) })}`}
                className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">›</a>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

async function AdminAuditLogsReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('auditLogs.auditLogs')}</h1>
        <p className="mt-1 text-sm text-muted">{t('auditLogs.completeAuditTrailOfAll')}</p>
      </div>
      <ErrorState message={t('auditLogs.couldNotLoadAuditLogs')} />
      <a href="/admin/audit-logs" className="text-sm font-medium text-brand-text underline">{t('auditLogs.refreshAuditLogs')}</a>
    </div>
  );
}
