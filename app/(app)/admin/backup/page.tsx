import type { Metadata } from 'next';
import { Database, HardDrive, Shield, Info } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Admin · Data & Storage', robots: { index: false } };
export const dynamic = 'force-dynamic';

/** Documents the storage figure may page through before it is reported as not shown (one round trip per 1,000). */
const SUM_ROW_CEILING = 25_000;

const TABLES: { table: string; label: string }[] = [
  { table: 'families', label: 'Families' },
  { table: 'profiles', label: 'User profiles' },
  { table: 'family_members', label: 'Family members' },
  { table: 'calendar_events', label: 'Calendar events' },
  { table: 'chore_assignments', label: 'Chore assignments' },
  { table: 'meals', label: 'Meals' },
  { table: 'grocery_items', label: 'Grocery items' },
  { table: 'documents', label: 'Documents' },
  { table: 'reminders', label: 'Reminders' },
  { table: 'notifications', label: 'Notifications' },
  { table: 'subscriptions', label: 'Subscriptions' },
  { table: 'audit_logs', label: 'Audit log entries' },
];

function fmtBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export default async function AdminDataPage() {
  const tr = await getTranslations();
  const supabase = createServiceClient();

  // Settled, each count: a transport failure REJECTS the query rather than
  // resolving { data, error }, and inside a bare Promise.all one unreachable
  // table took the route's error boundary in place of the read-error state.
  const countResults = await settleAll(TABLES.map((t) =>
    supabase.from(t.table as 'families').select('id', { count: 'exact', head: true })));
  const counts = TABLES.map((t, i) => ({ ...t, count: countResults[i].count ?? 0, error: countResults[i].error }));

  // The row counts above are `head: true` and exact. This one reads ROWS to sum
  // their bytes, and an unbounded select is answered with at most `db-max-rows`
  // (1,000) and no signal — so on a project past a thousand documents the
  // storage figure on a page whose title is "Data & Storage" was the size of
  // the first thousand, reported as the total. `readAllByIdAsQuery` pages to a real
  // ceiling and reports reaching it as an error, which this page already
  // renders rather than showing a number it cannot stand behind. It pages on
  // the id, not on offsets: an upload landing between two pages shifted every
  // later offset by one, and one document's bytes were added twice.
  //
  // Reaching that ceiling costs the storage figure, not the page: it says it
  // is not shown and the ceiling banner names it, while the table counts —
  // exact, and the rest of what this page is for — stay. Stored documents is
  // the documents table's own count. Any failure is still the read-error state.
  const { data: docs, error: docsError, truncated: storageCeiling } = await readAllByIdAsQuery<{ id: string; size_bytes: number | null }>((after, limit) => {
    let query = supabase.from('documents').select('id, size_bytes');
    if (after) query = query.gt('id', after);
    return query.order('id').limit(limit);
  }, { max: SUM_ROW_CEILING });
  const readError = counts.find((c) => c.error)?.error ?? (storageCeiling ? null : docsError);
  if (readError) {
    console.error('[admin-backup] data read failed', readError);
    return (
      <div className="module-page">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminBackup.dataAmpStorage')}</h1>
          <p className="mt-1 text-sm text-muted">{tr('adminBackup.liveRowCountsAndDocumentStorage')}</p>
        </div>
        <ErrorState message={tr('backup.couldNotLoadDataAnd')} />
        <a href="/admin/backup" className="text-sm font-medium text-brand-text underline">{tr('adminBackup.refreshDataOverview')}</a>
      </div>
    );
  }
  if (storageCeiling) console.warn('[admin-backup] the storage read reached its ceiling; storage is not shown');
  const usedBytes = (docs ?? []).reduce((sum, d) => sum + (d.size_bytes ?? 0), 0);
  const totalRows = counts.reduce((sum, c) => sum + c.count, 0);
  const storedDocuments = counts.find((c) => c.table === 'documents')?.count ?? 0;

  return (
    <div className="space-y-5">
      <PartialReadBanner
        title={tr('adminCeiling.figuresNotShown', { n: SUM_ROW_CEILING.toLocaleString() })}
        failures={storageCeiling ? [tr('adminBackup.documentStorageUsed')] : []}
      />
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{tr('adminBackup.dataAmpStorage')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('adminBackup.liveRowCountsAndDocumentStorage')}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card className="flex flex-col gap-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-400"><Database className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{totalRows.toLocaleString()}</p><p className="mt-1 text-xs text-muted">{tr('adminBackup.totalRowsTrackedTables')}</p></div>
        </Card>
        <Card className="flex flex-col gap-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400"><HardDrive className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{storageCeiling ? tr('strategyMetrics.unavailable') : fmtBytes(usedBytes)}</p><p className="mt-1 text-xs text-muted">{tr('adminBackup.documentStorageUsed')}</p></div>
        </Card>
        <Card className="flex flex-col gap-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400"><Shield className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{storedDocuments.toLocaleString()}</p><p className="mt-1 text-xs text-muted">{tr('adminBackup.storedDocuments')}</p></div>
        </Card>
      </div>

      <Card className="p-0">
        <h2 className="px-4 pt-4 text-base font-semibold">{tr('adminBackup.tableSizes')}</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-border text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-medium">{tr('adminBackup.table')}</th>
                <th className="px-4 py-2.5 font-medium">{tr('adminBackup.rows')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {counts.map((c) => (
                <tr key={c.table} className="hover:bg-surface/30">
                  <td className="px-4 py-2.5">{c.label} <span className="text-xs text-muted">({c.table})</span></td>
                  <td className="px-4 py-2.5 font-semibold tabular-nums">{c.count.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="flex items-start gap-3">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-brand-text" />
        <div className="text-sm text-muted">
          <p className="font-medium text-fg">{tr('adminBackup.backups')}</p>
          <p className="mt-1">{tr('backup.databaseBackupsAreHandledAutomatically')}</p>
        </div>
      </Card>
    </div>
  );
}
