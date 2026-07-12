import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { WorkloadModule } from '@/components/modules/workload-module';
import type { Tables } from '@/lib/database.types';

export const metadata: Metadata = { title: 'Workload Balance' };
export const dynamic = 'force-dynamic';

/** Who is carrying the household — mental-load measurement + one-tap rebalance. */
export default async function WorkloadPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [membersQ, assignQ, choresQ, todosQ, eventsQ] = await Promise.all([
    supabase.from('family_members').select('id, display_name, role, color, user_id')
      .eq('family_id', familyId).eq('is_active', true),
    supabase.from('chore_assignments').select('id, chore_id, member_id, status, created_at')
      .eq('family_id', familyId).gte('created_at', weekAgo).limit(1000),
    supabase.from('chores').select('id, title, est_minutes, points').eq('family_id', familyId).limit(1000),
    supabase.from('todo_items').select('assigned_to_id, is_done, created_at')
      .eq('family_id', familyId).gte('created_at', weekAgo).limit(1000),
    supabase.from('calendar_events').select('created_by, starts_at')
      .eq('family_id', familyId).gte('starts_at', weekAgo).limit(1000),
  ]);

  // Snapshot history for trends — degrades safely before migration 0166.
  let snapshots: Tables<'workload_snapshots'>[] = [];
  try {
    const { data } = await supabase.from('workload_snapshots').select('*')
      .eq('family_id', familyId).order('week_start', { ascending: false }).limit(600);
    snapshots = (data ?? []) as Tables<'workload_snapshots'>[];
  } catch { /* table not applied yet */ }

  return (
    <WorkloadModule
      familyId={familyId}
      members={(membersQ.data ?? []) as { id: string; display_name: string; role: string; color: string | null; user_id: string | null }[]}
      assignments={(assignQ.data ?? []) as { id: string; chore_id: string; member_id: string; status: string; created_at: string }[]}
      chores={(choresQ.data ?? []) as { id: string; title: string; est_minutes: number | null; points: number }[]}
      todos={(todosQ.data ?? []) as { assigned_to_id: string | null; is_done: boolean; created_at: string }[]}
      events={(eventsQ.data ?? []) as { created_by: string | null; starts_at: string }[]}
      snapshots={snapshots}
    />
  );
}
