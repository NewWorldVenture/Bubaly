import type { Metadata } from 'next';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ErrorState } from '@/components/ui/states';
import { PROVIDER_LABELS, type SyncProvider } from '@/lib/sync/capabilities';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Sync conflicts' };
export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  both_edited: 'Edited in both places',
  deleted_vs_edited: 'Deleted on one side, edited on the other',
  time_changed: 'Time changed in both places',
  completed_vs_edited: 'Completed on one side, edited on the other',
};

export default async function SyncConflictsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: conflicts, error } = await supabase
    .from('sync_conflicts')
    .select('id, provider, item_type, conflict_kind, status, created_at')
    .eq('family_id', ctx.active.familyId)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('[sync-conflicts] family conflict read failed', error);
    return (
      <div className="module-page">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboardSyncConflicts.conflicts')}</h1>
        <ErrorState message="Could not load your sync conflicts from Supabase. Refresh and try again." />
        <a href="/dashboard/sync/conflicts" className="text-sm font-medium text-brand-text underline">{t('dashboardSyncConflicts.refreshConflicts')}</a>
      </div>
    );
  }

  const rows = conflicts ?? [];

  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboardSyncConflicts.conflicts')}</h1>
        <p className="mt-1 text-sm text-muted">{t('dashboardSyncConflicts.whenTheSameItemChangesIn')}</p>
      </div>

      {rows.length === 0 ? (
        <Card>
          <div className="flex items-center gap-3 py-6">
            <CheckCircle2 className="h-6 w-6 text-success" />
            <div>
              <p className="font-medium">{t('dashboardSyncConflicts.noOpenConflicts')}</p>
              <p className="text-sm text-muted">{t('dashboardSyncConflicts.everythingIsInSyncConflictsWill')}</p>
            </div>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <Card key={c.id}>
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium capitalize">{c.item_type}</p>
                    <Badge tone="neutral">{PROVIDER_LABELS[(c.provider as SyncProvider)] ?? c.provider}</Badge>
                    <Badge tone="warning">{c.status}</Badge>
                  </div>
                  <p className="mt-0.5 text-sm text-muted">{KIND_LABEL[c.conflict_kind] ?? c.conflict_kind}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5">
                  <Badge tone="brand">Keep ours</Badge>
                  <Badge tone="accent">Keep theirs</Badge>
                  <Badge tone="neutral">Keep both</Badge>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
