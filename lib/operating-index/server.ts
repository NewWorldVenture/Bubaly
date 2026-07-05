// lib/operating-index/server.ts — the Supabase-facing half of the Family
// Operating Index. Reads real family-scoped tables to build a normalized
// HouseholdSnapshot, runs the pure engine, and idempotently persists one
// snapshot per family per day (so the composite can trend and the Command
// Center can later say "what changed since yesterday").
//
// Everything here is honest: absent tables/rows contribute 0 (calm), never a
// fabricated penalty. Two financial inputs (budget overspend, negative ledger
// balances) are intentionally left at 0 in this first slice — they need an
// expenses join / ledger sum and are tracked as follow-ups; the engine treats
// unset inputs as "not flagged", which is the truthful default.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json, TaskStatus } from '@/lib/database.types';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import {
  computeOperatingIndex, dimensionsToRecord, compositeTrend,
  type HouseholdSnapshot, type MemberLoad, type OperatingIndex,
} from './score';

type DB = SupabaseClient<Database>;

const DAY_MS = 86_400_000;
const OPEN_TASK: TaskStatus[] = ['todo', 'in_progress', 'submitted'];
const OPEN_MAINT: TaskStatus[] = ['todo', 'in_progress'];
const DONE_TASK: TaskStatus[] = ['done', 'approved'];

/** UTC calendar day (YYYY-MM-DD) this snapshot represents. */
export function asOfDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Build the normalized household snapshot from live family-scoped data. */
export async function buildSnapshot(supabase: DB, familyId: string, now: Date = new Date()): Promise<HouseholdSnapshot> {
  const nowIso = now.toISOString();
  const in7 = new Date(now.getTime() + 7 * DAY_MS).toISOString();
  const in14 = new Date(now.getTime() + 14 * DAY_MS).toISOString();
  const in30 = new Date(now.getTime() + 30 * DAY_MS).toISOString();
  const in14date = in14.slice(0, 10);
  const in30date = in30.slice(0, 10);
  const since7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();

  const [
    membersRes, eventsRes, remindersRes, recentChoresRes, openChoresRes,
    docsRes, maintRes, billsRes, approvalsRes, mealVotesRes, pollsRes, goalsRes,
  ] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id')
      .eq('family_id', familyId).gte('starts_at', nowIso).lte('starts_at', in7).order('starts_at').limit(400),
    supabase.from('family_reminders').select('id, remind_at, status')
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null).lt('remind_at', nowIso).limit(200),
    supabase.from('chore_assignments').select('id, status').eq('family_id', familyId).gte('created_at', since7).limit(500),
    supabase.from('chore_assignments').select('id, member_id, status, due_at')
      .eq('family_id', familyId).in('status', OPEN_TASK).limit(500),
    supabase.from('documents').select('id').eq('family_id', familyId).not('expires_at', 'is', null).lte('expires_at', in30date).limit(200),
    supabase.from('maintenance_tasks').select('id, status, due_at').eq('family_id', familyId).in('status', OPEN_MAINT).not('due_at', 'is', null).lt('due_at', nowIso).limit(200),
    supabase.from('bills').select('id, status, autopay, due_date').eq('family_id', familyId).neq('status', 'paid').lte('due_date', in14date).limit(200),
    supabase.from('approval_requests').select('id').eq('family_id', familyId).eq('status', 'pending').limit(200),
    supabase.from('meal_votes').select('id').eq('family_id', familyId).eq('status', 'open').limit(100),
    supabase.from('family_polls').select('id, status').eq('family_id', familyId).eq('status', 'open').limit(100),
    supabase.from('goals').select('id, progress, target_date').eq('family_id', familyId).eq('is_complete', false).limit(200),
  ]);

  const members = membersRes.data ?? [];
  const events = eventsRes.data ?? [];
  const openChores = openChoresRes.data ?? [];
  const recentChores = recentChoresRes.data ?? [];

  // Planning
  const upcomingEvents = events.length;
  const upcomingEventsOwned = events.filter((e) => e.assignee_id).length;

  // Schedule stability — reuse the shared conflict detector.
  const conflicts = detectConflicts(events as ConflictEvent[]).length;

  // Financial (slice 1: bills only; overspend + negative balances deferred → 0).
  const billsDueSoon = billsRes.data?.length ?? 0;
  const billsCovered = (billsRes.data ?? []).filter((b) => b.autopay).length;

  // Household readiness
  const expiringDocs = docsRes.data?.length ?? 0;
  const overdueMaintenance = maintRes.data?.length ?? 0;

  // Communication
  const pendingApprovals = approvalsRes.data?.length ?? 0;
  const openVotes = (mealVotesRes.data?.length ?? 0) + (pollsRes.data?.length ?? 0);

  // Routine
  const choresAssignedRecently = recentChores.length;
  const choresCompletedRecently = recentChores.filter((c) => DONE_TASK.includes(c.status)).length;
  const overdueTasks = openChores.filter((c) => c.due_at && c.due_at < nowIso).length;

  // Goals — "on track" heuristic without a start date: complete-enough, no
  // deadline, or a deadline still comfortably away.
  const goals = goalsRes.data ?? [];
  const goalsOnTrack = goals.filter((g) => {
    if (!g.target_date) return true;
    if ((g.progress ?? 0) >= 50) return true;
    return g.target_date > in30date; // deadline more than 30 days out
  }).length;

  // Per-member load for overload detection.
  const loadByMember = new Map<string, MemberLoad>();
  for (const m of members) loadByMember.set(m.id, { memberId: m.id, name: m.display_name, upcoming: 0, openTasks: 0 });
  for (const e of events) if (e.assignee_id && loadByMember.has(e.assignee_id)) loadByMember.get(e.assignee_id)!.upcoming++;
  for (const c of openChores) if (c.member_id && loadByMember.has(c.member_id)) loadByMember.get(c.member_id)!.openTasks++;

  return {
    memberCount: members.length,
    upcomingEvents, upcomingEventsOwned, eventsMissingInfo: 0,
    overdueReminders: remindersRes.data?.length ?? 0,
    conflicts,
    billsDueSoon, billsCovered, overspentBudgets: 0, negativeBalances: 0,
    expiringDocs, overdueMaintenance, lowInventory: 0,
    pendingApprovals, openVotes, unreadThreads: 0,
    choresAssignedRecently, choresCompletedRecently, overdueTasks,
    activeGoals: goals.length, goalsOnTrack,
    memberLoads: [...loadByMember.values()],
  };
}

export interface OperatingIndexResult {
  index: OperatingIndex;
  asOf: string;
  /** Composite from the most recent PRIOR day's snapshot, if any. */
  priorComposite: number | null;
  /** current − prior, or null when there's no prior snapshot. */
  trend: number | null;
}

/**
 * Compute today's index and persist it idempotently (one row per family per
 * day, upserted on re-render). Returns the index plus the prior snapshot's
 * composite for the trend arrow. Persistence failures never block the read.
 */
export async function loadOperatingIndex(supabase: DB, familyId: string, now: Date = new Date()): Promise<OperatingIndexResult> {
  const snapshot = await buildSnapshot(supabase, familyId, now);
  const index = computeOperatingIndex(snapshot, now);
  const today = asOfDate(now);

  // Prior snapshot (most recent day before today) for the trend.
  const { data: recent } = await supabase
    .from('family_operating_index')
    .select('as_of_date, composite')
    .eq('family_id', familyId)
    .lt('as_of_date', today)
    .order('as_of_date', { ascending: false })
    .limit(1);
  const priorComposite = recent && recent.length ? recent[0].composite : null;

  // Idempotent upsert of today's snapshot.
  try {
    await supabase.from('family_operating_index').upsert({
      family_id: familyId,
      as_of_date: today,
      composite: index.composite,
      band: index.band,
      dimensions: dimensionsToRecord(index.dimensions) as unknown as Json,
      suggestions: index.suggestions as unknown as Json,
    }, { onConflict: 'family_id,as_of_date' });
  } catch {
    // Persisting is best-effort; the live index still renders.
  }

  return { index, asOf: today, priorComposite, trend: compositeTrend(index.composite, priorComposite) };
}
