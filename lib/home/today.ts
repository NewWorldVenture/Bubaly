// lib/home/today.ts — the pure read models behind the Command Center's
// "Today", "Bubaly Is Working On" and "Completed By Bubaly" sections (§16).
//
// PURE on purpose: Home and the dashboard both render these sections from
// rows they have already fetched, and the "Working on" card refreshes them in
// the browser from Realtime. One mapper shared by the server page and the
// client fetcher is what keeps the N/M progress the page painted and the N/M
// the browser repaints thirty seconds later identical. No Supabase, no clock
// reads — the caller passes `now` and the family's timezone — so the ranking
// is unit-tested for determinism rather than inferred from a screenshot.

import { rankNextActions, type ActionInput, type ActionPriority, type NextAction } from '@/lib/opportunities/next-actions';
import { RUN_STATE_LABELS, summarizeSteps, type RunState, type StepState } from '@/lib/ai/runs/states';
import { runPagePath } from '@/lib/ai/chat-request';
import { topInsight, type ScheduleInsight } from '@/lib/schedule/intelligence';

// ─── Today ───────────────────────────────────────────────────────────────────

export type TodayEventRow = { id: string; title: string; starts_at: string; all_day: boolean; location?: string | null; assignee_id?: string | null };
export type TodayTodoRow = { id: string; title: string; due_date: string | null; priority?: string | null; assigned_to_id?: string | null };
export type TodayChoreRow = { id: string; chore_id: string; member_id: string; status: string; due_at: string | null };
export type TodayReminderRow = { id: string; title: string; remind_at: string | null; member_id?: string | null; priority?: string | null };

export type TodayKind = 'event' | 'todo' | 'chore' | 'reminder';

/** One line on the Today strip: something scheduled (a time) or something owed (a due bucket). */
export type TodayItem = {
  key: string;
  kind: TodayKind;
  id: string;
  title: string;
  href: string;
  /** ISO instant for scheduled items; null for date-only tasks. */
  at: string | null;
  allDay: boolean;
  /** `family_members.id` the item is about, when the row carries one. */
  memberId: string | null;
  /** "Due today" / "Overdue by 2 days" — from `rankNextActions`, so the copy is the same everywhere.
   *  For an event with a schedule insight, the insight's reason ("Leave by 5:25 PM…"). */
  reason: string;
  bucket: NextAction['bucket'];
  /** The most pressing schedule insight for an event (lib/schedule/intelligence), when there is one. */
  insight?: ScheduleInsight;
};

export type TodayView = {
  /** Time-ordered: all-day first, then by start time. */
  schedule: TodayItem[];
  /** Overdue and due-today tasks, most urgent first. */
  tasks: TodayItem[];
  overdue: number;
};

export type TodayInput = {
  events: TodayEventRow[];
  todos: TodayTodoRow[];
  chores: TodayChoreRow[];
  reminders: TodayReminderRow[];
  /** `chores.id` → title, resolved by the caller in one query. */
  choreTitles: Record<string, string>;
  /** The family-local day, YYYY-MM-DD. */
  todayKey: string;
  /** IANA zone the day keys are resolved in. */
  tz: string;
  now: Date;
  /** Cap on the task list; the schedule is never capped because a day is a day. */
  taskLimit?: number;
  /**
   * Schedule insights by event id (lib/schedule/intelligence). An event that
   * has one gets the insight's reason instead of the bare "Today", and carries
   * the insight so the strip can colour it by severity and link to the fix.
   */
  insights?: Record<string, ScheduleInsight[]>;
};

/**
 * YYYY-MM-DD for an instant in a zone. Kept here (rather than importing the
 * server-only helper in lib/services/scope.ts) so the browser fetcher and the
 * unit tests can call it; the arithmetic is the same `Intl` resolution.
 */
export function dayKeyInZone(iso: string, tz: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const key = `${get('year')}-${get('month')}-${get('day')}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

function priorityOf(raw: string | null | undefined): ActionPriority {
  return raw === 'high' || raw === 'urgent' ? 'high' : raw === 'low' ? 'low' : 'medium';
}

/**
 * The unified day: the family's schedule (events plus timed reminders for
 * today) and the tasks that are owed by today (overdue first). Tasks are
 * ranked through `rankNextActions` so the order and the "Due today" copy match
 * the Next Best Actions page; ties break on source then title, which is what
 * makes two renders of the same rows come out identical.
 */
export function buildToday(input: TodayInput): TodayView {
  const { todayKey, tz } = input;
  const nowMs = input.now.getTime();

  const schedule: TodayItem[] = [];
  for (const e of input.events) {
    if (dayKeyInZone(e.starts_at, tz) !== todayKey) continue;
    const insight = e.all_day ? null : topInsight(input.insights?.[e.id]);
    schedule.push({
      key: `event:${e.id}`, kind: 'event', id: e.id, title: e.title, href: '/dashboard/calendar',
      at: e.starts_at, allDay: e.all_day, memberId: e.assignee_id ?? null,
      reason: insight ? insight.reason : e.all_day ? 'All day' : 'Today', bucket: 'today',
      ...(insight ? { insight } : {}),
    });
  }

  const owed: ActionInput[] = [];
  const byKey = new Map<string, Omit<TodayItem, 'reason' | 'bucket'>>();
  const remember = (item: Omit<TodayItem, 'reason' | 'bucket'>, whenKey: string | null, priority: ActionPriority, source: ActionInput['source']) => {
    byKey.set(item.key, item);
    owed.push({ id: item.key, source, title: item.title, whenKey, priority, href: item.href });
  };

  for (const t of input.todos) {
    if (!t.due_date) continue;
    const whenKey = t.due_date.slice(0, 10);
    if (whenKey > todayKey) continue;
    remember({
      key: `todo:${t.id}`, kind: 'todo', id: t.id, title: t.title, href: '/dashboard/todos',
      at: null, allDay: false, memberId: t.assigned_to_id ?? null,
    }, whenKey, priorityOf(t.priority), 'task');
  }

  for (const c of input.chores) {
    if (c.status !== 'todo' && c.status !== 'in_progress') continue;
    if (!c.due_at) continue;
    const whenKey = dayKeyInZone(c.due_at, tz);
    if (!whenKey || whenKey > todayKey) continue;
    remember({
      key: `chore:${c.id}`, kind: 'chore', id: c.id, title: input.choreTitles[c.chore_id] ?? 'Chore', href: '/dashboard/chores',
      at: c.due_at, allDay: false, memberId: c.member_id,
    }, whenKey, 'medium', 'task');
  }

  for (const r of input.reminders) {
    if (!r.remind_at) continue;
    const ms = Date.parse(r.remind_at);
    if (!Number.isFinite(ms)) continue;
    const whenKey = dayKeyInZone(r.remind_at, tz);
    if (!whenKey || whenKey > todayKey) continue;
    // A reminder still ahead of us today belongs on the schedule; one already
    // past is something owed, so it ranks with the tasks.
    if (whenKey === todayKey && ms >= nowMs) {
      schedule.push({
        key: `reminder:${r.id}`, kind: 'reminder', id: r.id, title: r.title, href: '/dashboard/reminders',
        at: r.remind_at, allDay: false, memberId: r.member_id ?? null, reason: 'Today', bucket: 'today',
      });
      continue;
    }
    remember({
      key: `reminder:${r.id}`, kind: 'reminder', id: r.id, title: r.title, href: '/dashboard/reminders',
      at: r.remind_at, allDay: false, memberId: r.member_id ?? null,
    }, whenKey, priorityOf(r.priority), 'event');
  }

  schedule.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const t = Date.parse(a.at ?? '') - Date.parse(b.at ?? '');
    if (t !== 0 && Number.isFinite(t)) return t;
    return a.key.localeCompare(b.key);
  });

  // `rankNextActions` is a stable sort that breaks ties on source then title;
  // two tasks that tie on all three would come out in fetch order, so the
  // input is put in id order first and the result never depends on the query.
  owed.sort((a, b) => a.id.localeCompare(b.id));
  const ranked = rankNextActions(owed, todayKey).filter((a) => a.bucket === 'overdue' || a.bucket === 'today');
  const limit = input.taskLimit ?? 6;
  const tasks: TodayItem[] = ranked.slice(0, limit).map((a) => ({ ...byKey.get(a.id)!, reason: a.reason, bucket: a.bucket }));

  return { schedule, tasks, overdue: ranked.filter((a) => a.bucket === 'overdue').length };
}

// ─── Bubaly Is Working On ────────────────────────────────────────────────────

/** Run states the "Working on" card lists: anything not finished, including runs waiting on a person. */
export const WORKING_RUN_STATES: readonly RunState[] = [
  'queued', 'planning', 'awaiting_context', 'awaiting_approval', 'ready', 'executing', 'verifying', 'scheduled_followup', 'paused',
] as const;

export type WorkingRunRow = {
  id: string;
  summary: string | null;
  state: string;
  plan_id: string | null;
  updated_at: string;
  created_at: string;
};
export type WorkingStepRow = { plan_id: string; status: string };

export type WorkingRun = {
  id: string;
  title: string;
  state: RunState;
  href: string;
  done: number;
  total: number;
  /** "7 of 9 steps complete" / "waiting for your OK" — the §16 example lines. */
  detail: string;
  /** What the run is waiting on, when it is waiting on a person. */
  waitingOn: 'approval' | 'answer' | null;
  updatedAt: string;
};

function isRunState(value: string): value is RunState {
  return Object.prototype.hasOwnProperty.call(RUN_STATE_LABELS, value);
}

/**
 * "Planning next week's meals — 7/9 steps complete". Steps are counted from
 * their live rows rather than the run's `progress` snapshot, because the
 * executor only writes that snapshot when it parks or finishes a run; a card
 * that said 2/9 for the whole of a 9-step run would be lying by omission.
 */
export function workingRunsFrom(runs: WorkingRunRow[], steps: WorkingStepRow[]): WorkingRun[] {
  const byPlan = new Map<string, WorkingStepRow[]>();
  for (const s of steps) {
    const list = byPlan.get(s.plan_id) ?? [];
    list.push(s);
    byPlan.set(s.plan_id, list);
  }
  return runs
    .filter((r) => isRunState(r.state) && (WORKING_RUN_STATES as readonly string[]).includes(r.state))
    .map((r) => {
      const state = r.state as RunState;
      const planSteps = (r.plan_id ? byPlan.get(r.plan_id) : undefined) ?? [];
      const counts = summarizeSteps(planSteps.map((s, i) => ({ id: String(i), status: s.status as StepState, dependency_ids: [] })));
      const done = counts.completed + counts.skipped;
      const waitingOn: WorkingRun['waitingOn'] = state === 'awaiting_approval' ? 'approval' : state === 'awaiting_context' ? 'answer' : null;
      let detail: string;
      if (waitingOn === 'approval') detail = 'waiting for your OK';
      else if (waitingOn === 'answer') detail = 'waiting for your answer';
      else if (state === 'paused') detail = counts.total ? `paused at ${done} of ${counts.total} steps` : 'paused';
      else if (counts.total) detail = `${done} of ${counts.total} step${counts.total === 1 ? '' : 's'} complete`;
      else detail = RUN_STATE_LABELS[state].toLowerCase();
      return {
        id: r.id,
        title: r.summary?.trim() || 'Working on your request',
        state,
        href: runPagePath(r.id),
        done,
        total: counts.total,
        detail,
        waitingOn,
        updatedAt: r.updated_at,
      };
    })
    .sort((a, b) => {
      // Something waiting on a person outranks something Bubaly is still doing.
      const wa = a.waitingOn ? 0 : 1;
      const wb = b.waitingOn ? 0 : 1;
      if (wa !== wb) return wa - wb;
      const t = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
      if (t !== 0 && Number.isFinite(t)) return t;
      return a.id.localeCompare(b.id);
    });
}

// ─── Completed By Bubaly ─────────────────────────────────────────────────────

export type CompletedRunRow = {
  id: string;
  summary: string | null;
  state: string;
  progress: unknown;
  completed_at: string | null;
  updated_at: string;
};
export type AiActivityRow = { id: string; title: string; detail: string | null; href: string | null; created_at: string };

export type CompletedItem = {
  key: string;
  kind: 'run' | 'activity';
  title: string;
  /** "6 of 8 steps completed." for a run; the activity detail otherwise. */
  detail: string | null;
  href: string;
  at: string;
  partial: boolean;
};

function progressSummary(progress: unknown): string | null {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) return null;
  const summary = (progress as Record<string, unknown>).summary;
  return typeof summary === 'string' && summary.trim() ? summary : null;
}

/**
 * Recent outcomes: finished runs and the specialist agents' completed actions,
 * newest first. A partially completed run is listed honestly as partial (§29)
 * rather than hidden or rounded up to "done".
 */
export function mergeCompletedByBubaly(runs: CompletedRunRow[], activity: AiActivityRow[], limit = 6): CompletedItem[] {
  const items: CompletedItem[] = [];
  for (const r of runs) {
    if (r.state !== 'completed' && r.state !== 'partially_completed') continue;
    items.push({
      key: `run:${r.id}`, kind: 'run', title: r.summary?.trim() || 'A request from your family',
      detail: progressSummary(r.progress), href: runPagePath(r.id), at: r.completed_at ?? r.updated_at,
      partial: r.state === 'partially_completed',
    });
  }
  for (const a of activity) {
    items.push({ key: `activity:${a.id}`, kind: 'activity', title: a.title, detail: a.detail, href: a.href ?? '/dashboard/agents', at: a.created_at, partial: false });
  }
  return items
    .sort((a, b) => {
      const t = Date.parse(b.at) - Date.parse(a.at);
      if (t !== 0 && Number.isFinite(t)) return t;
      return a.key.localeCompare(b.key);
    })
    .slice(0, limit);
}
