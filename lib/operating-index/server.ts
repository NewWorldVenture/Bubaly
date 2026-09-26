// lib/operating-index/server.ts — the Supabase-facing half of the Family
// Operating Index. Reads real family-scoped tables to build a normalized
// HouseholdSnapshot, runs the pure engine, and idempotently persists one
// snapshot per family per day (so the composite can trend and the Command
// Center can later say "what changed since yesterday").
//
// Everything here is honest: absent tables/rows contribute 0 (calm), never a
// fabricated penalty. Every input now reads real family-scoped data — including
// the financial signals (budget overspend, accounts below zero), low pantry
// inventory, events missing a location, and threads the family hasn't caught up
// on. Nothing is hardcoded to a stub.
import 'server-only';
import { settleAll } from '@/lib/supabase/settle';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json, TaskStatus, EventCategory } from '@/lib/database.types';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import { countOverspentBudgets, type BudgetRow, type ExpenseRow } from './inputs';
import {
  computeOperatingIndex, dimensionsToRecord, compositeTrend,
  type HouseholdSnapshot, type MemberLoad, type OperatingIndex,
} from './score';
import { summarizeChange, type SnapshotView, type ChangeSummary } from './summary';
import { orchestrate, type OrchestratorReport, type DayEvent, type OrchestratorItem } from './orchestrator';
import { readAllAsQuery } from '@/lib/supabase/read-all';
import { addDaysToDayKey, dayKeyInTz, zonedTimeMs } from '@/lib/services/scope';

type DB = SupabaseClient<Database>;

const DAY_MS = 86_400_000;
const OPEN_TASK: TaskStatus[] = ['todo', 'in_progress', 'submitted'];
const OPEN_MAINT: TaskStatus[] = ['todo', 'in_progress'];
const DONE_TASK: TaskStatus[] = ['done', 'approved'];
// Autopilot suggestions at/above this confidence are things it can auto-handle.
const AUTO_CONFIDENCE = 90;
// Event categories that imply a place you travel to (so a missing location matters).
const NEEDS_LOCATION_LIST: EventCategory[] = ['appointment', 'sports', 'school', 'medication'];
const NEEDS_LOCATION = new Set<string>(NEEDS_LOCATION_LIST);

/**
 * The FAMILY's calendar day (YYYY-MM-DD) this snapshot represents, which is
 * what `family_operating_index.as_of_date` — a DATE column (0125) — means.
 *
 * It used to be `now.toISOString().slice(0, 10)`: the day at Greenwich. For a
 * household in Los Angeles that is TOMORROW's key for the last seven hours of
 * every evening, and the damage was not cosmetic. The 18:30 visit wrote the
 * snapshot under tomorrow; the next morning found that row already present and
 * upserted the new reading over it, so one of the two days was lost; and the
 * "since yesterday" recap, anchored with `.lt('as_of_date', today)`, then
 * diffed against the day before last.
 *
 * `tz` is required rather than defaulted because every caller has the family in
 * hand. A silent 'UTC' default would put this straight back to answering
 * Greenwich's question while looking converted.
 */
export function asOfDate(now: Date, tz: string): string {
  return dayKeyInTz(now, tz);
}

/**
 * Build the normalized household snapshot from live family-scoped data.
 *
 * `tz` is the family's IANA zone — `ctx.active.family.timezone` on a page,
 * `scope.tz` in a service — and it is what separates the two kinds of window
 * below. Both kinds are here and they are NOT interchangeable:
 *
 *  - An INSTANT window bounds a timestamptz column. "Overdue" and "in the next
 *    seven days" are measured from this moment, in no zone at all, so `nowIso`
 *    and the rolling `in7`/`since7` bounds stay exactly as they were.
 *  - A DAY KEY bounds a DATE column. A DATE already holds the family's day, so
 *    the key it is compared against has to be the family's day as well —
 *    `.toISOString().slice(0, 10)` answered Greenwich's, which is a different
 *    day for 7 hours out of every 24 in Los Angeles and 10 in Tokyo.
 */
export async function buildSnapshot(supabase: DB, familyId: string, tz: string, now: Date = new Date()): Promise<HouseholdSnapshot> {
  const nowIso = now.toISOString();
  const in7 = new Date(now.getTime() + 7 * DAY_MS).toISOString();
  const since7 = new Date(now.getTime() - 7 * DAY_MS).toISOString();

  // The DATE columns bounded below: `bills.due_date` (0006_..._school_sports.sql:98),
  // `documents.expires_at` (0002_tables.sql:349) and `goals.target_date`
  // (0002_tables.sql:375) are all declared `date`, not timestamptz.
  //
  // The horizons advance the KEY rather than the instant. `new Date(now + 30 *
  // DAY_MS).toISOString().slice(0, 10)` is wrong twice over: it is Greenwich's
  // day, and it is fixed-millisecond arithmetic across a local day that is 23
  // or 25 hours long, so a 30-day horizon spanning a fall-back lands a day out.
  // `addDaysToDayKey` never touches an instant, so no DST transition can move
  // it.
  const todayKey = asOfDate(now, tz);
  const in14date = addDaysToDayKey(todayKey, 14);
  const in30date = addDaysToDayKey(todayKey, 30);

  // Financial window: fetch this-year expenses so weekly/monthly/yearly budgets
  // can all be evaluated; bounded by the row limit.
  //
  // This one bound stays UTC ON PURPOSE. It is the fetch floor for the budget
  // periods `countOverspentBudgets` evaluates, and those period starts come
  // from `lib/operating-index/inputs.ts`, which resolves them in UTC. The floor
  // must never be later than the window it feeds, so the two have to move
  // together or not at all — converting this half alone would make the fetch
  // narrower than the window on the hours when the UTC year differs from the
  // family's, and silently undercount a yearly budget. inputs.ts is its own
  // conversion (it has a second caller, lib/intelligence/hard-signals.ts).
  const yearStart = `${now.getUTCFullYear()}-01-01`;

  const [
    membersRes, eventsRes, remindersRes, recentChoresRes, openChoresRes,
    docsRes, maintRes, billsRes, approvalsRes, mealVotesRes, pollsRes, goalsRes,
    budgetsRes, expensesRes, accountsRes, pantryRes, messagesRes,
  ] = await settleAll([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id, location, category')
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
    supabase.from('budgets').select('category, amount, period').eq('family_id', familyId).limit(200),
    readAllAsQuery((from, to) => supabase.from('transactions').select('category, amount, date').eq('family_id', familyId).eq('type', 'expense').gte('date', yearStart).order('id').range(from, to), { max: 5000 }),
    // Only spendable accounts count as "below zero" — a credit card carrying a
    // negative (owed) balance is expected, not a preparedness problem.
    supabase.from('financial_accounts').select('id, balance').eq('family_id', familyId).lt('balance', 0).neq('type', 'credit').limit(100),
    supabase.from('pantry_items').select('id, quantity, low_threshold').eq('family_id', familyId).not('low_threshold', 'is', null).limit(500),
    supabase.from('family_messages').select('conversation_id, read_by').eq('family_id', familyId).is('deleted_at', null).gte('created_at', since7).limit(1000),
  ]);

  const readError = [
    membersRes.error, eventsRes.error, remindersRes.error, recentChoresRes.error,
    openChoresRes.error, docsRes.error, maintRes.error, billsRes.error,
    approvalsRes.error, mealVotesRes.error, pollsRes.error, goalsRes.error,
    budgetsRes.error, expensesRes.error, accountsRes.error, pantryRes.error,
    messagesRes.error,
  ].find(Boolean);
  if (readError) {
    console.error('[operating-index] snapshot input read failed', readError);
    throw readError;
  }

  const members = membersRes.data ?? [];
  const events = eventsRes.data ?? [];
  const openChores = openChoresRes.data ?? [];
  const recentChores = recentChoresRes.data ?? [];

  // Planning
  const upcomingEvents = events.length;
  const upcomingEventsOwned = events.filter((e) => e.assignee_id).length;
  // Events that imply a destination but have no location yet (info missing).
  const eventsMissingInfo = events.filter((e) => NEEDS_LOCATION.has(e.category) && !e.location).length;

  // Schedule stability — reuse the shared conflict detector.
  const conflicts = detectConflicts(events as ConflictEvent[]).length;

  // Financial — bills due, budget overspend (real budgets vs this-period
  // expenses), and spendable accounts below zero.
  const billsDueSoon = billsRes.data?.length ?? 0;
  const billsCovered = (billsRes.data ?? []).filter((b) => b.autopay).length;
  const overspentBudgets = countOverspentBudgets(
    (budgetsRes.data ?? []) as BudgetRow[],
    (expensesRes.data ?? []) as ExpenseRow[],
    now,
  );
  const negativeBalances = accountsRes.data?.length ?? 0;

  // Household readiness
  const expiringDocs = docsRes.data?.length ?? 0;
  const overdueMaintenance = maintRes.data?.length ?? 0;
  // Pantry items at/below their low-stock threshold.
  const lowInventory = (pantryRes.data ?? []).filter(
    (p) => p.low_threshold != null && Number(p.quantity) <= Number(p.low_threshold),
  ).length;

  // Communication
  const pendingApprovals = approvalsRes.data?.length ?? 0;
  const openVotes = (mealVotesRes.data?.length ?? 0) + (pollsRes.data?.length ?? 0);
  // Threads the family hasn't collectively caught up on: conversations with a
  // recent message not yet read by every active member.
  const memberCount = members.length;
  const unreadConversations = new Set<string>();
  for (const m of messagesRes.data ?? []) {
    if (memberCount > 0 && (m.read_by?.length ?? 0) < memberCount) unreadConversations.add(m.conversation_id);
  }
  const unreadThreads = unreadConversations.size;

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
    memberCount,
    upcomingEvents, upcomingEventsOwned, eventsMissingInfo,
    overdueReminders: remindersRes.data?.length ?? 0,
    conflicts,
    billsDueSoon, billsCovered, overspentBudgets, negativeBalances,
    expiringDocs, overdueMaintenance, lowInventory,
    pendingApprovals, openVotes, unreadThreads,
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
  /** Evening "what changed since yesterday" recap (pillar #5). */
  change: ChangeSummary;
  /** The five orchestrator answers (pillar #1). */
  orchestrator: OrchestratorReport;
}

/**
 * Build the orchestrator's inputs from live data: tomorrow's events, the
 * auto-handleable Autopilot suggestions, decisions awaiting the family, and
 * upcoming events missing a location. Reuses the FOI snapshot's overloaded
 * member + open-vote count (passed in) so nothing is recomputed.
 */
async function buildOrchestratorReport(
  supabase: DB, familyId: string, index: OperatingIndex, openVotes: number, tz: string, now: Date,
): Promise<OrchestratorReport> {
  // Tomorrow on the FAMILY's wall clock. This was `setUTCHours(0, 0, 0, 0)`
  // plus a day — Greenwich's tomorrow — so in Los Angeles the question "what's
  // most likely to go wrong tomorrow?" was answered over a window running from
  // 17:00 tomorrow to 17:00 the day after: it missed tomorrow's whole morning
  // and school run, and reported the following evening's events as tomorrow's.
  //
  // Both bounds are resolved as real local midnights instead of one midnight
  // plus DAY_MS, because the spring-forward day is 23 hours long and the
  // fall-back day 25: adding a fixed day to a local midnight lands at 23:00 or
  // 01:00, which either drops an hour of tomorrow or borrows one from the day
  // after.
  const tomorrowKey = addDaysToDayKey(asOfDate(now, tz), 1);
  const startOfTomorrow = new Date(zonedTimeMs(tomorrowKey, 0, 0, tz));
  const startOfDayAfter = new Date(zonedTimeMs(addDaysToDayKey(tomorrowKey, 1), 0, 0, tz));
  const nowIso = now.toISOString();
  const in14 = new Date(now.getTime() + 14 * DAY_MS).toISOString();

  const [tomorrowRes, autoRes, approvalsRes, missingRes] = await settleAll([
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id, location, category')
      .eq('family_id', familyId).gte('starts_at', startOfTomorrow.toISOString()).lt('starts_at', startOfDayAfter.toISOString()).order('starts_at').limit(200),
    supabase.from('autopilot_suggestions').select('id, title, action_label')
      .eq('family_id', familyId).eq('status', 'open').gte('confidence', AUTO_CONFIDENCE).order('urgency', { ascending: false }).limit(10),
    supabase.from('approval_requests').select('id, title').eq('family_id', familyId).eq('status', 'pending').order('created_at').limit(10),
    supabase.from('calendar_events').select('id, title, starts_at, location, category')
      .eq('family_id', familyId).is('location', null).gte('starts_at', nowIso).lte('starts_at', in14)
      .in('category', NEEDS_LOCATION_LIST).order('starts_at').limit(10),
  ]);

  const readError = [tomorrowRes.error, autoRes.error, approvalsRes.error, missingRes.error].find(Boolean);
  if (readError) {
    console.error('[operating-index] orchestrator input read failed', readError);
    throw readError;
  }

  const tomorrowEvents: DayEvent[] = (tomorrowRes.data ?? []).map((e) => ({
    id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
    assigneeId: e.assignee_id, location: e.location, needsLocation: NEEDS_LOCATION.has(e.category),
  }));
  const autoCompletable: OrchestratorItem[] = (autoRes.data ?? []).map((s) => ({
    label: s.action_label || s.title, href: '/dashboard/autopilot',
  }));
  const pendingApprovals: OrchestratorItem[] = (approvalsRes.data ?? []).map((a) => ({
    label: a.title, href: '/dashboard/trust',
  }));
  const missingInfo: OrchestratorItem[] = (missingRes.data ?? []).map((e) => ({
    label: `“${e.title}” — no location`, href: '/dashboard/calendar',
  }));

  return orchestrate({
    tomorrowEvents, autoCompletable, overloaded: index.overloaded, pendingApprovals, openVotes, missingInfo,
  }, now);
}

/** Coerce a persisted snapshot's jsonb suggestions into {id,title} pairs. */
function suggestionPairs(raw: unknown): { id: string; title: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is { id: string; title: string } => !!s && typeof s === 'object' && 'id' in s)
    .map((s) => ({ id: String(s.id), title: String((s as { title?: unknown }).title ?? '') }));
}

/**
 * Compute today's index and persist it idempotently (one row per family per
 * day, upserted on re-render). Returns the index plus the prior snapshot's
 * composite for the trend arrow. Persistence failures never block the read.
 */
export async function loadOperatingIndex(supabase: DB, familyId: string, tz: string, now: Date = new Date()): Promise<OperatingIndexResult> {
  const snapshot = await buildSnapshot(supabase, familyId, tz, now);
  const index = computeOperatingIndex(snapshot, now);
  // One key, used three ways: the anchor for the prior read, the upsert key,
  // and the `asOf` this returns. They have to be the same string, which is why
  // it is computed once here rather than at each site.
  const today = asOfDate(now, tz);

  // Prior snapshot (most recent day before today) for the trend + evening recap.
  const { data: recent, error: recentError } = await supabase
    .from('family_operating_index')
    .select('as_of_date, composite, dimensions, suggestions')
    .eq('family_id', familyId)
    .lt('as_of_date', today)
    .order('as_of_date', { ascending: false })
    .limit(1);
  if (recentError) {
    console.error('[operating-index] prior snapshot read failed', recentError);
    throw recentError;
  }
  const priorRow = recent && recent.length ? recent[0] : null;
  const priorComposite = priorRow ? priorRow.composite : null;

  const currentView: SnapshotView = {
    composite: index.composite,
    dimensions: dimensionsToRecord(index.dimensions),
    suggestions: index.suggestions.map((s) => ({ id: s.id, title: s.title })),
  };
  const priorView: SnapshotView | null = priorRow ? {
    composite: priorRow.composite,
    dimensions: (priorRow.dimensions as Record<string, number>) ?? {},
    suggestions: suggestionPairs(priorRow.suggestions),
  } : null;
  const change = summarizeChange(currentView, priorView);

  // The five orchestrator questions (pillar #1), reusing the snapshot's signals.
  const orchestrator = await buildOrchestratorReport(supabase, familyId, index, snapshot.openVotes, tz, now);

  // Idempotent upsert of today's snapshot — one row per family per FAMILY day.
  // The key moving is the point: an evening visit west of Greenwich used to
  // write tomorrow's row and then be overwritten by the morning's, so a family
  // in Los Angeles could never accumulate two consecutive days to trend.
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

  return { index, asOf: today, priorComposite, trend: compositeTrend(index.composite, priorComposite), change, orchestrator };
}
