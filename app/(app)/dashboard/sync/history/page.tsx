import type { Metadata } from 'next';
import { RefreshCw } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { PROVIDER_LABELS, type SyncProvider } from '@/lib/sync/capabilities';

export const metadata: Metadata = { title: 'Sync history' };
export const dynamic = 'force-dynamic';

export default async function SyncHistoryPage() {
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

  const runs = runsRes.data ?? [];
  const audit = auditRes.data ?? [];

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Sync history</h1>
        <p className="mt-1 text-sm text-muted">Every sync run and account action, kept for audit. No sync silently fails — failures are recorded here.</p>
      </div>

      <Card>
        <h2 className="mb-3 text-base font-semibold">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-muted">No sync runs recorded yet.</p>
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
        <h2 className="mb-3 text-base font-semibold">Account activity</h2>
        {audit.length === 0 ? (
          <p className="text-sm text-muted">No account activity recorded yet.</p>
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
