import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { WorkloadModule } from '@/components/modules/workload-module';
import type { Tables } from '@/lib/database.types';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Workload Balance' };
export const dynamic = 'force-dynamic';

/** Who is carrying the household — mental-load measurement + one-tap rebalance. */
export default async function WorkloadPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [membersQ, assignQ, choresQ, todosQ, eventsQ, snapshotsQ] = await Promise.all([
    supabase.from('family_members').select('id, display_name, role, color, user_id')
      .eq('family_id', familyId).eq('is_active', true),
    supabase.from('chore_assignments').select('id, chore_id, member_id, status, created_at')
      .eq('family_id', familyId).gte('created_at', weekAgo).limit(1000),
    supabase.from('chores').select('id, title, est_minutes, points').eq('family_id', familyId).limit(1000),
    supabase.from('todo_items').select('assigned_to_id, is_done, created_at')
      .eq('family_id', familyId).gte('created_at', weekAgo).limit(1000),
    supabase.from('calendar_events').select('created_by, starts_at')
      .eq('family_id', familyId).gte('starts_at', weekAgo).limit(1000),
    supabase.from('workload_snapshots').select('*')
      .eq('family_id', familyId).order('week_start', { ascending: false }).limit(600),
  ]);

  // Snapshot history for trends — degrades safely before migration 0174.
  const queries = [membersQ, assignQ, choresQ, todosQ, eventsQ, snapshotsQ];
  const failedQuery = queries.find((query) => query.error);
  if (failedQuery?.error) {
    console.error('[workload] page data read failed', failedQuery.error);
    return (
      <div className="module-page">
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('dashboardWorkload.workloadBalance')}</h1>
        <ErrorState message="Could not load workload data from Supabase. Refresh and try again." />
        <a href="/dashboard/workload" className="text-sm font-medium text-brand-text underline">{t('dashboardWorkload.refreshWorkloadData')}</a>
      </div>
    );
  }

  return (
    <WorkloadModule
      familyId={familyId}
      members={(membersQ.data ?? []) as { id: string; display_name: string; role: string; color: string | null; user_id: string | null }[]}
      assignments={(assignQ.data ?? []) as { id: string; chore_id: string; member_id: string; status: string; created_at: string }[]}
      chores={(choresQ.data ?? []) as { id: string; title: string; est_minutes: number | null; points: number }[]}
      todos={(todosQ.data ?? []) as { assigned_to_id: string | null; is_done: boolean; created_at: string }[]}
      events={(eventsQ.data ?? []) as { created_by: string | null; starts_at: string }[]}
      snapshots={(snapshotsQ.data ?? []) as Tables<'workload_snapshots'>[]}
    />
  );
}
