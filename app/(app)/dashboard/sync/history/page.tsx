import type { Metadata } from 'next';
import { RefreshCw } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { PROVIDER_LABELS, type SyncProvider } from '@/lib/sync/capabilities';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Sync history' };
export const dynamic = 'force-dynamic';

export default async function SyncHistoryPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const [runsRes, auditRes] = await Promise.all([
    supabase.from('sync_job_runs')
      .select('id, provider, status, items_imported, items_exported, items_skipped, conflicts_found, started_at, finished_at, error')
      .eq('family_id', ctx.active.familyId).order('started_at', { ascending: false }).limit(50),
    supabase.from('sync_audit_logs')
      .select('id, provider, action, item_type, created_at')
      .eq('family_id', ctx.active.familyId).order('created_at', { ascending: false }).limit(50),
  ]);

  const readError = runsRes.error ?? auditRes.error;
  if (readError) {
    console.error('[sync-history] family sync history read failed', readError);
    return (
      <div className="module-page">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboardSyncHistory.syncHistory')}</h1>
        <ErrorState message={t('history.couldNotLoadYourSync')} />
        <a href="/dashboard/sync/history" className="text-sm font-medium text-brand-text underline">{t('dashboardSyncHistory.refreshSyncHistory')}</a>
      </div>
    );
  }

  const runs = runsRes.data ?? [];
  const audit = auditRes.data ?? [];

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboardSyncHistory.syncHistory')}</h1>
        <p className="mt-1 text-sm text-muted">{t('dashboardSyncHistory.everySyncRunAndAccountAction')}</p>
      </div>

      <Card>
        <h2 className="mb-3 text-base font-semibold">{t('dashboardSyncHistory.recentRuns')}</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">{t('dashboardSyncHistory.noSyncRunsRecordedYet')}</p>
        ) : (
          <div className="space-y-2">
            {runs.map((r) => (
              <div key={r.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3 text-sm">
                <RefreshCw className="h-4 w-4 shrink-0 text-muted" />
                <span className="font-medium">{PROVIDER_LABELS[(r.provider as SyncProvider)] ?? r.provider}</span>
                <span className="text-xs text-muted">↓{r.items_imported} ↑{r.items_exported} ⏭{r.items_skipped}{r.conflicts_found ? ` · ${r.conflicts_found} conflicts` : ''}</span>
                {r.error && <span className="truncate text-xs text-danger">{r.error}</span>}
                <Badge tone={r.status === 'succeeded' ? 'success' : r.status === 'failed' ? 'danger' : 'neutral'} className="ml-auto shrink-0">{r.status}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-base font-semibold">{t('dashboardSyncHistory.accountActivity')}</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-muted">{t('dashboardSyncHistory.noAccountActivityRecordedYet')}</p>
        ) : (
          <div className="space-y-1.5">
            {audit.map((a) => (
              <div key={a.id} className="flex items-center gap-3 text-sm">
                <Badge tone="neutral" className="shrink-0">{a.action}</Badge>
                <span className="text-muted">
                  {a.provider ? `${PROVIDER_LABELS[(a.provider as SyncProvider)] ?? a.provider}` : '—'}
                  {a.item_type ? ` · ${a.item_type}` : ''}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted">{new Date(a.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
