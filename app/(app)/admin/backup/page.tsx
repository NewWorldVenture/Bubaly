import type { Metadata } from 'next';
import { Database, HardDrive, Shield, Info } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Admin · Data & Storage', robots: { index: false } };
export const dynamic = 'force-dynamic';

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
  const supabase = createServiceClient();

  const counts = await Promise.all(
    TABLES.map(async (t) => {
      const { count, error } = await supabase.from(t.table as 'families').select('id', { count: 'exact', head: true });
      return { ...t, count: count ?? 0, error };
    }),
  );

  const { data: docs, error: docsError } = await supabase.from('documents').select('size_bytes');
  const readError = counts.find((c) => c.error)?.error ?? docsError;
  if (readError) {
    console.error('[admin-backup] data read failed', readError);
    return (
      <div className="module-page">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Data &amp; Storage</h1>
          <p className="mt-1 text-sm text-muted">Live row counts and document storage across the platform.</p>
        </div>
        <ErrorState message="Could not load data and storage metrics from Supabase. Refresh and try again." />
        <a href="/admin/backup" className="text-sm font-medium text-brand-text underline">Refresh data overview</a>
      </div>
    );
  }
  const usedBytes = (docs ?? []).reduce((sum, d) => sum + (d.size_bytes ?? 0), 0);
  const totalRows = counts.reduce((sum, c) => sum + c.count, 0);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Data &amp; Storage</h1>
        <p className="mt-1 text-sm text-muted">Live row counts and document storage across the platform.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Card className="flex flex-col gap-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/15 text-violet-400"><Database className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{totalRows.toLocaleString()}</p><p className="mt-1 text-xs text-muted">Total rows (tracked tables)</p></div>
        </Card>
        <Card className="flex flex-col gap-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400"><HardDrive className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{fmtBytes(usedBytes)}</p><p className="mt-1 text-xs text-muted">Document storage used</p></div>
        </Card>
        <Card className="flex flex-col gap-3">
          <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400"><Shield className="h-5 w-5" /></div>
          <div><p className="text-xl font-bold leading-none">{(docs ?? []).length.toLocaleString()}</p><p className="mt-1 text-xs text-muted">Stored documents</p></div>
        </Card>
      </div>

      <Card className="p-0">
        <h2 className="px-4 pt-4 text-base font-semibold">Table Sizes</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-border text-left text-xs text-muted">
                <th className="px-4 py-2.5 font-medium">Table</th>
                <th className="px-4 py-2.5 font-medium">Rows</th>
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
          <p className="font-medium text-fg">Backups</p>
          <p className="mt-1">
            Database backups are handled automatically by Supabase (daily point-in-time recovery on supported plans).
            Manage retention and restore points from your Supabase project dashboard → Database → Backups.
            Documents live in a private Storage bucket and are covered by Supabase storage redundancy.
          </p>
        </div>
      </Card>
    </div>
  );
}
