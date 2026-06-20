'use server';

import { revalidatePath } from 'next/cache';
import { isSuperAdmin, getUser } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import type { Json } from '@/lib/database.types';

type Result = { ok: true } | { ok: false; error: string };

// Tables whose row counts are captured in each backup checkpoint.
const TRACKED = [
  'families', 'family_members', 'profiles', 'calendar_events', 'chores',
  'chore_assignments', 'documents', 'subscriptions', 'notes', 'reminders',
  'transactions', 'health_metrics', 'audit_logs',
] as const;

/**
 * Records a backup checkpoint: captures the live row counts across core tables
 * and current document-storage size into system_backups. (Encrypted full-data
 * backups are performed continuously by Supabase's managed PITR; this logs an
 * application-level checkpoint + metrics that the console reports against.)
 */
export async function createBackupNow(kind: 'full' | 'incremental' = 'full'): Promise<Result> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = createServiceClient();
  const user = await getUser();

  const counts = await Promise.all(
    TRACKED.map((t) => supabase.from(t).select('id', { count: 'exact', head: true }).then((r) => [t, r.count ?? 0] as const)),
  );
  const { data: docs } = await supabase.from('documents').select('size_bytes');
  const sizeBytes = (docs ?? []).reduce((s, d) => s + (d.size_bytes ?? 0), 0);
  const rowCounts = Object.fromEntries(counts);
  const totalRows = counts.reduce((s, [, c]) => s + c, 0);

  const { error } = await supabase.from('system_backups').insert({
    label: kind === 'full' ? 'Manual Full Backup' : 'Incremental Backup',
    kind,
    status: 'completed',
    size_bytes: sizeBytes,
    location: 'Supabase (managed)',
    row_counts: rowCounts as unknown as Json,
    created_by: user?.id ?? null,
    metadata: { total_rows: totalRows, source: 'admin_console' } as unknown as Json,
  });
  if (error) return { ok: false, error: error.message };

  await logAudit(supabase, { familyId: null, actorId: user?.id ?? null, action: 'create', resource: 'system_backups', metadata: { via: 'site_admin', total_rows: totalRows } });
  revalidatePath('/admin/backup');
  return { ok: true };
}

export async function deleteBackup(id: string): Promise<Result> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized' };
  const supabase = createServiceClient();
  const user = await getUser();
  const { error } = await supabase.from('system_backups').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  await logAudit(supabase, { familyId: null, actorId: user?.id ?? null, action: 'delete', resource: 'system_backups', resourceId: id, metadata: { via: 'site_admin' } });
  revalidatePath('/admin/backup');
  return { ok: true };
}
