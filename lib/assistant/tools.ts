// lib/assistant/tools.ts — the AI Assistant's action toolbox. Each tool the
// model can call maps to a real, RLS-scoped Supabase write so the assistant can
// actually DO things (schedule events, add chores, build lists) — not just talk.
import 'server-only';
import { settleAll } from '@/lib/supabase/settle';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ToolSpec } from '@/lib/ai/provider';
import { buildHomeNeeds } from '@/lib/home/needs-build';
import { rankNeedsAttention } from '@/lib/home/needs-attention';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import { readCalendarBusySource, readCalendarOccurrences } from '@/lib/calendar/occurrences';
import { readCalendarAvailability } from '@/lib/calendar/availability';
import { addExactMilliseconds, compareExactInstants, exactIntervalOf, formatExactInstant, parseExactInstant } from '@/lib/calendar/exact-instant';
import { isValidTimezone } from '@/lib/time/zoned';
import { briefingCalendarBounds, instantCalendarBounds } from '@/lib/briefing/calendar-window';
import type { ParentApprovalRow, RenewalRow, DocumentRow, NeedsReader } from '@/lib/home/needs-sources';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { reminderAttention } from '@/lib/dashboard/reminder-attention';
import { dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';
import { nextRemindAt } from '@/lib/reminders/details';
import { escapeLike } from '@/lib/supabase/escape-like';
import { wroteNoRows } from '@/lib/supabase/errors';
import { ensureDefaultGroceryListId } from '@/lib/services/groceries';
import { ensureTodoListId } from '@/lib/services/tasks';
import { createGoal } from '@/lib/services/goals';
import { SERVICE_CODES } from '@/lib/services/types';
import { ROLE_ORDER, isManager, type MemberRole } from '@/lib/constants/roles';

type DB = SupabaseClient<Database>;

/**
 * The reader of this file's tool results is the MODEL, not a family member: it
 * reads `{ title, urgency }` and writes the reply the family actually reads, in
 * their language. So the "needs you" titles it is handed are worded in the
 * source locale, explicitly — 'en-US' amounts, English catalogue words — the
 * same rule the hardcoded-locale ratchet records for this file's other
 * model-read formatter. Not a default: the family-facing callers of
 * buildHomeNeeds pass their request's locale.
 */
const MODEL_READER: NeedsReader = {
  locale: 'en-US',
  t: (key, params) => translate(SOURCE_MESSAGES, key, params),
};

export type AssistantCtx = {
  familyId: string;
  userId: string;
  /**
   * The acting person's `family_members.id` — NOT their auth user id.
   *
   * The two are different keys and this file writes both. Most tables here
   * reference `auth.users(id)` for `created_by`, so `userId` is right for them.
   * `todo_lists` and `todo_items` are the exception: `0015_todos.sql` points
   * their `created_by` at `public.family_members(id)`, so writing `userId`
   * there is a foreign-key violation and every chat "add a to-do" failed.
   *
   * Null when the roster and the session disagree. The to-do writes then record
   * no creator, which the column already allows (`on delete set null`) — an
   * unattributed task is a far better outcome than a refusal.
   */
  memberId: string | null;
  members: { id: string; display_name: string }[];
  /**
   * The caller's `family_members.role` (or null when it is not known).
   *
   * Required, not optional, so a new call site cannot forget it: the goals
   * service decides who may write `goals` from this (a guest or a caregiver
   * may not), and RLS on `goals` admits every member. An unknown role is
   * refused for those writes rather than waved through. It is also what
   * keeps a manager's decisions out of a child's "what needs me?"
   * (`list_pending_decisions`): a null role is never a manager.
   */
  role: string | null;
  /** Family time zone (IANA), used to format times for availability answers. */
  tz?: string;
};

function knownRole(role: string | null | undefined): MemberRole | null {
  return role && (ROLE_ORDER as string[]).includes(role) ? (role as MemberRole) : null;
}

const EVENT_CATEGORIES = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'];

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function optStr(v: unknown): string | null { const s = str(v); return s || null; }

function toolFailure(operation: string, error: unknown): { ok: false; error: string } {
  console.error(`[assistant] ${operation} failed:`, error);
  return { ok: false, error: `Could not ${operation}.` };
}

type ListResult = { id: string | null; error?: unknown };

/** Resolve a member name (case-insensitive, prefix-friendly) to its id. */
function resolveMember(ctx: AssistantCtx, name: unknown): string | null {
  const q = str(name).toLowerCase();
  if (!q) return null;
  const exact = ctx.members.find((m) => m.display_name.toLowerCase() === q);
  if (exact) return exact.id;
  const partial = ctx.members.find((m) => m.display_name.toLowerCase().startsWith(q) || m.display_name.toLowerCase().includes(q));
  return partial?.id ?? null;
}

/**
 * Get-or-create the family's default grocery list — through the one serialised
 * get-or-create (0443, DATA-007) the rest of the product uses, so two first
 * captures at once, one from the assistant and one from the app, cannot give a
 * family two lists. The name stays what the assistant always used.
 */
async function ensureGroceryList(supabase: DB, familyId: string, userId: string): Promise<ListResult> {
  const list = await ensureDefaultGroceryListId(supabase, familyId, userId, 'Groceries');
  return list.id ? { id: list.id } : { id: null, error: list.error };
}

/** Get-or-create the family's default to-do list. `memberId` is a family_members id (0015). */
async function ensureTodoList(supabase: DB, familyId: string, memberId: string | null): Promise<ListResult> {
  const list = await ensureTodoListId(supabase, familyId, memberId, 'Tasks', false);
  return list.id ? { id: list.id } : { id: null, error: list.error };
}

export function buildAssistantTools(supabase: DB, ctx: AssistantCtx): ToolSpec[] {
  const memberNames = ctx.members.map((m) => m.display_name).join(', ') || 'none';

  return [
    {
      name: 'create_calendar_event',
      description: 'Add an event to the family calendar. Use the family time zone; provide ISO 8601 datetimes.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          starts_at: { type: 'string', description: 'ISO 8601 start datetime, e.g. 2026-06-24T15:00:00' },
          ends_at: { type: 'string', description: 'ISO 8601 end datetime (optional)' },
          all_day: { type: 'boolean' },
          category: { type: 'string', enum: EVENT_CATEGORIES },
          location: { type: 'string' },
          description: { type: 'string' },
          assignee: { type: 'string', description: `Family member name (one of: ${memberNames})` },
        },
        required: ['title', 'starts_at'],
      },
      execute: async (a) => {
        const title = str(a.title);
        const starts_at = str(a.starts_at);
        if (!title || !starts_at) return { ok: false, error: 'title and starts_at are required' };
        const category = EVENT_CATEGORIES.includes(str(a.category)) ? (str(a.category) as Database['public']['Tables']['calendar_events']['Insert']['category']) : 'general';
        const { data, error } = await supabase.from('calendar_events').insert({
          family_id: ctx.familyId, title, starts_at,
          ends_at: optStr(a.ends_at), all_day: Boolean(a.all_day), category,
          location: optStr(a.location), description: optStr(a.description),
          assignee_id: resolveMember(ctx, a.assignee), created_by: ctx.userId,
        }).select('id').single();
        if (error) return toolFailure('add the calendar event', error);
        return { ok: true, id: data.id, summary: `Added “${title}” to the calendar.` };
      },
    },
    {
      name: 'add_chore',
      description: 'Create a chore, optionally assigned to a family member and worth points.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          points: { type: 'number' },
          due_at: { type: 'string', description: 'ISO 8601 datetime (optional)' },
          assignee: { type: 'string', description: `Family member name (one of: ${memberNames})` },
        },
        required: ['title'],
      },
      execute: async (a) => {
        const title = str(a.title);
        if (!title) return { ok: false, error: 'title is required' };
        const points = Number.isFinite(a.points) ? Math.max(0, Math.round(a.points as number)) : 10;
        const { data: chore, error } = await supabase.from('chores').insert({
          family_id: ctx.familyId, title, points, due_at: optStr(a.due_at), created_by: ctx.userId,
        }).select('id').single();
        if (error) return toolFailure('create the chore', error);
        const memberId = resolveMember(ctx, a.assignee);
        if (memberId) {
          const { error: assignmentError } = await supabase.from('chore_assignments').insert({ family_id: ctx.familyId, chore_id: chore.id, member_id: memberId, due_at: optStr(a.due_at) });
          if (assignmentError) {
            // A chore this call just created, so zero rows removed is a failed
            // rollback, not an absence. Logged; the failure is already being
            // returned. Audit C1-S9-69.
            const { data: rolledBack, error: rollbackError } = await supabase.from('chores').delete().eq('id', chore.id).select('id');
            if (rollbackError || wroteNoRows(rolledBack)) console.error('[assistant] chore rollback failed:', rollbackError ?? 'no rows deleted');
            return toolFailure('save the chore assignment', assignmentError);
          }
        }
        return { ok: true, id: chore.id, summary: `Created chore “${title}”${memberId ? ` for ${str(a.assignee)}` : ''} (${points} pts).` };
      },
    },
    {
      name: 'add_grocery_item',
      description: 'Add an item to the family grocery list.',
      input_schema: {
        type: 'object',
        properties: { item: { type: 'string' }, quantity: { type: 'string' } },
        required: ['item'],
      },
      execute: async (a) => {
        const name = str(a.item);
        if (!name) return { ok: false, error: 'item is required' };
        const list = await ensureGroceryList(supabase, ctx.familyId, ctx.userId);
        if (list.error) return toolFailure('open a grocery list', list.error);
        if (!list.id) return { ok: false, error: 'Could not open a grocery list' };
        const { error } = await supabase.from('grocery_items').insert({
          family_id: ctx.familyId, list_id: list.id, name, quantity: optStr(a.quantity), created_by: ctx.userId,
        });
        if (error) return toolFailure('add the grocery item', error);
        return { ok: true, summary: `Added ${name} to the grocery list.` };
      },
    },
    {
      name: 'add_todo',
      description: 'Add a task to the family to-do list.',
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string' }, notes: { type: 'string' },
          due_date: { type: 'string', description: 'ISO date YYYY-MM-DD (optional)' },
          assignee: { type: 'string', description: `Family member name (one of: ${memberNames})` },
        },
        required: ['task'],
      },
      execute: async (a) => {
        const title = str(a.task);
        if (!title) return { ok: false, error: 'task is required' };
        const list = await ensureTodoList(supabase, ctx.familyId, ctx.memberId);
        if (list.error) return toolFailure('open a to-do list', list.error);
        if (!list.id) return { ok: false, error: 'Could not open a to-do list' };
        const { error } = await supabase.from('todo_items').insert({
          family_id: ctx.familyId, list_id: list.id, title, notes: optStr(a.notes),
          // family_members.id here, not the auth user id: 0015 points this FK at
          // the roster, unlike every other created_by in this file.
          due_date: optStr(a.due_date), assigned_to_id: resolveMember(ctx, a.assignee), created_by: ctx.memberId,
        });
        if (error) return toolFailure('add the task', error);
        return { ok: true, summary: `Added “${title}” to the to-do list.` };
      },
    },
    {
      name: 'add_reminder',
      description: 'Create a reminder that alerts the family at a specific time. Use for "remind me/us to…" requests. Supports priority, an optional assignee, and repeating reminders.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          remind_at: { type: 'string', description: 'ISO 8601 datetime to remind at' },
          notes: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Defaults to medium' },
          recurrence: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'], description: 'Repeat cadence; defaults to none' },
          assignee: { type: 'string', description: `Optional family member this reminder is for (one of: ${memberNames})` },
        },
        required: ['title', 'remind_at'],
      },
      execute: async (a) => {
        const title = str(a.title); const remind_at = str(a.remind_at);
        if (!title || !remind_at) return { ok: false, error: 'title and remind_at are required' };
        const priority = (['low', 'medium', 'high', 'urgent'].includes(str(a.priority)) ? str(a.priority) : 'medium') as Database['public']['Tables']['family_reminders']['Insert']['priority'];
        const recurrence = (['none', 'daily', 'weekdays', 'weekly', 'biweekly', 'monthly', 'yearly'].includes(str(a.recurrence)) ? str(a.recurrence) : 'none') as Database['public']['Tables']['family_reminders']['Insert']['recurrence'];
        const memberId = resolveMember(ctx, a.assignee);
        // Writes to family_reminders — the same service shown at /dashboard/reminders,
        // so AI-created reminders appear in the module, notifications, and home dashboard.
        const { error } = await supabase.from('family_reminders').insert({
          family_id: ctx.familyId, created_by: ctx.userId, title, remind_at, notes: optStr(a.notes),
          kind: recurrence === 'none' ? 'time' : 'recurring', priority, recurrence,
          member_id: memberId, ai_suggested: true,
        });
        if (error) return toolFailure('set the reminder', error);
        const forWhom = memberId ? ` for ${str(a.assignee)}` : '';
        const repeats = recurrence !== 'none' ? ` (repeats ${recurrence})` : '';
        return { ok: true, summary: `Reminder set${forWhom}: “${title}”${repeats}.` };
      },
    },
    {
      name: 'complete_reminder',
      description: 'Mark a family reminder as done, found by (partial) title. If it repeats, the next occurrence is scheduled automatically. Use for "mark X done", "I finished X", "check off X".',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string', description: 'Title or part of the reminder to complete' } },
        required: ['title'],
      },
      execute: async (a) => {
        const q = str(a.title);
        if (!q) return { ok: false, error: 'title is required' };
        const { data: rows, error: lookupError } = await supabase.from('family_reminders')
          .select('id, title, notes, kind, priority, recurrence, remind_at, member_id, location_name')
          .eq('family_id', ctx.familyId).eq('status', 'active').ilike('title', `%${escapeLike(q)}%`)
          .order('remind_at', { ascending: true, nullsFirst: false }).limit(1);
        if (lookupError) return toolFailure('find the reminder', lookupError);
        const r = rows?.[0];
        if (!r) return { ok: false, error: `No active reminder matching “${q}”.` };
        // The assistant SPEAKS the answer — "Completed …" — and a completion that
        // matched nothing said it over a reminder still active. Worse, the next
        // occurrence of a recurring reminder is inserted below, so two concurrent
        // completions each scheduled one: two future reminders for one. The
        // `status = 'active'` predicate lets exactly one completion win, and
        // `.select()` is what tells the loser it lost. Audit C1-S9-69.
        const { data: completed, error } = await supabase.from('family_reminders')
          .update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', r.id).eq('status', 'active').select('id');
        if (error) return toolFailure('complete the reminder', error);
        if (wroteNoRows(completed)) return toolFailure('complete the reminder', 'no rows updated');
        // Recurring → schedule the next occurrence (core columns only, so it's
        // safe regardless of the 0100 detail-columns migration state).
        const next = r.remind_at && r.recurrence !== 'none' ? nextRemindAt(r.remind_at, r.recurrence) : null;
        if (next) {
          const { error: nextError } = await supabase.from('family_reminders').insert({
            family_id: ctx.familyId, created_by: ctx.userId, title: r.title, notes: r.notes,
            kind: r.kind, priority: r.priority, recurrence: r.recurrence, location_name: r.location_name,
            member_id: r.member_id, remind_at: next, status: 'active',
          });
          if (nextError) {
            // Restoring the reminder this call just completed; zero rows is a
            // failed restore. Logged. Audit C1-S9-69.
            const { data: restored, error: rollbackError } = await supabase.from('family_reminders')
              .update({ status: 'active', completed_at: null }).eq('id', r.id).select('id');
            if (rollbackError || wroteNoRows(restored)) console.error('[assistant] reminder rollback failed:', rollbackError ?? 'no rows updated');
            return toolFailure('schedule the next reminder', nextError);
          }
        }
        return { ok: true, summary: `Completed “${r.title}”${next ? ' — next one scheduled' : ''}.` };
      },
    },
    {
      name: 'snooze_reminder',
      description: 'Move a family reminder to a new time, found by (partial) title. Use for "remind me about X later/tomorrow instead", "push X to Friday".',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title or part of the reminder to reschedule' },
          remind_at: { type: 'string', description: 'New ISO 8601 datetime' },
        },
        required: ['title', 'remind_at'],
      },
      execute: async (a) => {
        const q = str(a.title); const remind_at = str(a.remind_at);
        if (!q || !remind_at) return { ok: false, error: 'title and remind_at are required' };
        const { data: rows, error: lookupError } = await supabase.from('family_reminders')
          .select('id, title').eq('family_id', ctx.familyId).eq('status', 'active').ilike('title', `%${escapeLike(q)}%`)
          .order('remind_at', { ascending: true, nullsFirst: false }).limit(1);
        if (lookupError) return toolFailure('find the reminder', lookupError);
        const r = rows?.[0];
        if (!r) return { ok: false, error: `No active reminder matching “${q}”.` };
        // "Moved … to a new time" is spoken back; zero rows is the same failure.
        // Audit C1-S9-69.
        const { data: moved, error } = await supabase.from('family_reminders').update({ remind_at }).eq('id', r.id).select('id');
        if (error) return toolFailure('reschedule the reminder', error);
        if (wroteNoRows(moved)) return toolFailure('reschedule the reminder', 'no rows updated');
        return { ok: true, summary: `Moved “${r.title}” to a new time.` };
      },
    },
    {
      name: 'add_note',
      description: 'Save a shared family note.',
      input_schema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' } },
        required: ['body'],
      },
      execute: async (a) => {
        const body = str(a.body);
        if (!body) return { ok: false, error: 'body is required' };
        const { error } = await supabase.from('notes').insert({
          family_id: ctx.familyId, title: optStr(a.title), body, created_by: ctx.userId,
        });
        if (error) return toolFailure('save the family note', error);
        return { ok: true, summary: 'Saved a family note.' };
      },
    },
    {
      name: 'add_goal',
      description: 'Create a family goal with an optional target date.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' }, description: { type: 'string' },
          target_date: { type: 'string', description: 'ISO date YYYY-MM-DD (optional)' },
        },
        required: ['title'],
      },
      execute: async (a) => {
        const title = str(a.title);
        if (!title) return { ok: false, error: 'title is required' };
        // Through the goals service, not a direct insert: that is where the
        // role rule (no guest or caregiver), the date check and the
        // `is_complete` invariant live — RLS on `goals` admits every member.
        const role = knownRole(ctx.role);
        if (!role) return { ok: false, error: 'Only a member of the household can change its goals.' };
        const res = await createGoal(
          { db: supabase, familyId: ctx.familyId, userId: ctx.userId, memberId: ctx.memberId, role, actorKind: 'ai', tz: ctx.tz || 'UTC' },
          { title, description: optStr(a.description), targetDate: optStr(a.target_date) },
        );
        if (!res.ok) {
          if (res.code === SERVICE_CODES.db) return toolFailure('create the family goal', res.error);
          return { ok: false, error: res.error };
        }
        return { ok: true, summary: `Created the goal “${res.data.title}”.` };
      },
    },

    // ── Read tools (answer questions precisely from live family data) ──────────
    {
      name: 'list_upcoming_events',
      description: 'List the family’s upcoming calendar events. Use this to answer "what’s on our schedule" questions accurately.',
      input_schema: {
        type: 'object',
        properties: { days: { type: 'number', description: 'Look-ahead window in days (default 7)' } },
      },
      execute: async (a) => {
        const days = Number.isFinite(a.days) ? Math.max(1, Math.min(90, Math.round(a.days as number))) : 7;
        const now = new Date();
        const until = new Date(now.getTime() + days * 86400000).toISOString();
        // The shared read (lib/calendar/occurrences.ts): every week of a series,
        // not only the week it was created; today's all-day rows by their own
        // date; timed rows from now, on the family's clock.
        const tz = ctx.tz || 'UTC';
        const { data, error } = await readCalendarOccurrences(supabase, ctx.familyId, instantCalendarBounds(now.toISOString(), until, tz), tz, {
          columns: ['title', 'starts_at', 'ends_at', 'all_day', 'location', 'assignee_id'],
          limit: 50,
        });
        if (error) return toolFailure('load upcoming events', error);
        const byId = new Map(ctx.members.map((m) => [m.id, m.display_name]));
        return { ok: true, events: (data ?? []).map((e) => ({ title: e.title, starts_at: e.starts_at, all_day: e.all_day, location: e.location, who: e.assignee_id ? byId.get(e.assignee_id) ?? null : null })) };
      },
    },
    {
      name: 'list_open_chores',
      description: 'List open (not-yet-approved) chores, optionally filtered to one family member.',
      input_schema: {
        type: 'object',
        properties: { assignee: { type: 'string', description: `Family member name (one of: ${memberNames})` } },
      },
      execute: async (a) => {
        const memberId = resolveMember(ctx, a.assignee);
        let q = supabase.from('chore_assignments')
          .select('chore_id, member_id, status, due_at')
          .eq('family_id', ctx.familyId).in('status', ['todo', 'in_progress', 'submitted', 'rejected']).limit(50);
        if (memberId) q = q.eq('member_id', memberId);
        const { data: assigns, error } = await q;
        if (error) return toolFailure('load open chores', error);
        const choreIds = [...new Set((assigns ?? []).map((x) => x.chore_id))];
        const { data: chores, error: choresError } = choreIds.length
          ? await supabase.from('chores').select('id, title, points').in('id', choreIds)
          : { data: [] as { id: string; title: string; points: number }[], error: null };
        if (choresError) return toolFailure('load chore details', choresError);
        const titleById = new Map((chores ?? []).map((c) => [c.id, c.title]));
        const nameById = new Map(ctx.members.map((m) => [m.id, m.display_name]));
        return { ok: true, chores: (assigns ?? []).map((x) => ({ title: titleById.get(x.chore_id) ?? 'Chore', who: nameById.get(x.member_id) ?? null, status: x.status, due_at: x.due_at })) };
      },
    },
    {
      name: 'get_grocery_list',
      description: 'Get the items currently on the family grocery list (unchecked items).',
      input_schema: { type: 'object', properties: {} },
      execute: async () => {
        const list = await ensureGroceryList(supabase, ctx.familyId, ctx.userId);
        if (list.error) return toolFailure('open a grocery list', list.error);
        if (!list.id) return { ok: true, items: [] };
        const { data, error } = await supabase.from('grocery_items')
          .select('name, quantity').eq('list_id', list.id).eq('is_checked', false).order('created_at').limit(100);
        if (error) return toolFailure('load the grocery list', error);
        return { ok: true, items: (data ?? []).map((i) => ({ name: i.name, quantity: i.quantity })) };
      },
    },
    {
      name: 'list_pending_decisions',
      description: "List everything currently needing the family's attention or a decision — pending money approvals, renewals & documents about to expire, schedule conflicts (double-bookings), reminders due, and chores awaiting sign-off. Use for \"what needs me\", \"what's on my plate\", \"anything I'm missing\", \"what should I deal with today\" questions.",
      input_schema: { type: 'object', properties: {} },
      execute: async () => {
        const now = new Date();
        // The FAMILY's day end, not the server's. `setHours(23, 59, 59, 999)`
        // ends the day in whatever zone this process runs in, which on Vercel
        // is UTC — so "due today" for a family in Tokyo ran nine hours into
        // their tomorrow, and for one in Los Angeles stopped seven hours before
        // their midnight. The bound is used TWICE below (the reminder query and
        // reminderAttention), and both had to move together: changing one and
        // not the other is how a day key ends up meaning two things in one
        // function, which is the defect this replaces.
        const tz = ctx.tz || 'UTC';
        const dayEndExclusiveMs = zonedDayBoundsMs(dayKeyInTz(now, tz), tz).end;
        const todayEnd = new Date(dayEndExclusiveMs - 1);
        const in14 = new Date(now.getTime() + 14 * 86400000).toISOString();
        const in30 = new Date(now.getTime() + 30 * 86400000).toISOString();
        const in45 = new Date(now.getTime() + 45 * 86400000).toISOString();
        // Money approvals and chores awaiting sign-off are a MANAGER's — the
        // same rule Home, Needs You and the briefing apply. Row-level security
        // lets any member read `parent_approvals` (0251), so this is the line:
        // a child asking "what needs me?" is not told a sibling's request, nor
        // asked to sign off chores they cannot sign off (AI-001). Renewals and
        // expiring documents are adults-only for the same reason the prompt's
        // money and documents slices are (lib/ai/context/policy.ts, §4).
        const manager = isManager(ctx.role);
        const [appr, ren, docs, dueRem, convEvents, signoff, grocery, todos] = await settleAll([
          manager
            ? supabase.from('parent_approvals').select('id, kind, amount_cents, created_at').eq('family_id', ctx.familyId).eq('status', 'pending').limit(50)
            : Promise.resolve({ data: [] as ParentApprovalRow[], error: null }),
          manager
            ? supabase.from('renewals').select('id, title, expires_at, reminder_days, status, created_at').eq('family_id', ctx.familyId).in('status', ['active', 'expired']).lte('expires_at', in45).limit(50)
            : Promise.resolve({ data: [] as RenewalRow[], error: null }),
          manager
            ? supabase.from('documents').select('id, title, expires_at').eq('family_id', ctx.familyId).not('expires_at', 'is', null).lte('expires_at', in30).limit(50)
            : Promise.resolve({ data: [] as DocumentRow[], error: null }),
          supabase.from('family_reminders').select('id, remind_at, status').eq('family_id', ctx.familyId).eq('status', 'active').not('remind_at', 'is', null).lte('remind_at', todayEnd.toISOString()).limit(100),
          // Series included: a one-off booked over a weekly practice clashes in
          // the week it is booked, which is almost never the practice's first.
          readCalendarOccurrences(supabase, ctx.familyId, instantCalendarBounds(now.toISOString(), in14, tz), tz, {
            columns: ['id', 'title', 'starts_at', 'ends_at', 'all_day', 'assignee_id'],
            refine: (query) => query.not('assignee_id', 'is', null),
            limit: 200,
          }),
          manager
            ? supabase.from('chore_assignments').select('id', { count: 'exact', head: true }).eq('family_id', ctx.familyId).eq('status', 'submitted')
            : Promise.resolve({ count: 0, error: null }),
          supabase.from('grocery_items').select('id', { count: 'exact', head: true }).eq('family_id', ctx.familyId).eq('is_checked', false),
          supabase.from('todo_items').select('id', { count: 'exact', head: true }).eq('family_id', ctx.familyId).eq('is_done', false),
        ]);
        const pendingError = [appr, ren, docs, dueRem, convEvents, signoff, grocery, todos].find((result) => result.error)?.error;
        if (pendingError) return toolFailure('load pending decisions', pendingError);
        const { overdue, dueToday } = reminderAttention((dueRem.data ?? []) as { remind_at: string | null; status: string }[], now, dayEndExclusiveMs);
        const nameByMember = new Map(ctx.members.map((m) => [m.id, m.display_name]));
        const conflicts = detectConflicts((convEvents.data ?? []) as ConflictEvent[])
          .map((c) => ({ id: c.eventIds[0], assigneeName: nameByMember.get(c.assigneeId) ?? null, count: c.eventIds.length, startsAt: c.startsAt }));
        const needs = rankNeedsAttention(buildHomeNeeds({
          approvals: (appr.data ?? []) as ParentApprovalRow[],
          renewals: (ren.data ?? []) as RenewalRow[],
          documents: (docs.data ?? []) as DocumentRow[],
          conflicts,
          pendingApprovals: signoff.count ?? 0,
          overdueMeds: false,
          overdueReminders: overdue,
          dueTodayReminders: dueToday,
          pendingChores: 0,
          lowGrocery: (grocery.count ?? 0) > 0,
          openTodos: todos.count ?? 0,
          now,
          reader: MODEL_READER,
        }));
        return { ok: true, count: needs.length, items: needs.map((n) => ({ title: n.title, urgency: n.urgency })) };
      },
    },
    {
      name: 'find_free_time',
      description: 'Find when the family is free on a given day. Returns that day’s busy time blocks (in the family time zone); reason over the gaps to suggest open slots.',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'The day to check, as YYYY-MM-DD' },
          assignee: { type: 'string', description: `Optional: only this member’s events (one of: ${memberNames})` },
        },
        required: ['date'],
      },
      execute: async (a) => {
        const date = str(a.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date must be YYYY-MM-DD' };
        const tz = ctx.tz;
        if (typeof tz !== 'string' || !tz.trim() || !isValidTimezone(tz)) return toolFailure('find free time', { message: 'Invalid calendar scope' });
        // The family's day: timed rows between its midnights, all-day rows
        // dated that day, every series stepped onto it (the complete qualified
        // availability domain, including ongoing overlaps). A ±14-hour UTC window around the date
        // read rows by their first start only, so a weekly practice was busy on
        // the day it was created and free every week after.
        let bounds: ReturnType<typeof briefingCalendarBounds>;
        try { bounds = briefingCalendarBounds(date, tz, 0, 1); } catch { return { ok: false, error: 'date must be a real calendar date' }; }
        let memberId: string | null = null;
        if (a.assignee != null) {
          const query = str(a.assignee).toLowerCase();
          if (!query) return { ok: false, error: 'Choose a family member by name.' };
          const exact = ctx.members.filter(member => member.display_name.toLowerCase() === query);
          const matches = exact.length ? exact : ctx.members.filter(member => member.display_name.toLowerCase().includes(query));
          if (matches.length !== 1) return { ok: false, error: matches.length ? 'That name matches more than one family member. Use their full name.' : 'That family member could not be found.' };
          memberId = matches[0].id;
        }
        const [calendar, school, sports] = await settleAll([
          readCalendarAvailability(supabase, ctx.familyId, bounds, tz),
          readCalendarBusySource(supabase, ctx.familyId, 'school_events', bounds.timedFrom, bounds.timedTo, tz),
          readCalendarBusySource(supabase, ctx.familyId, 'sports_events', bounds.timedFrom, bounds.timedTo, tz),
        ]);
        for (const result of [calendar, school, sports]) if (result.error) return toolFailure('find free time', result.error);
        // Unassigned commitments belong to the whole family, including a
        // named member's availability. Filter only after complete scoped reads.
        const selected = (assignee: string | null) => !memberId || !assignee || assignee === memberId;
        const from = parseExactInstant(bounds.timedFrom), to = parseExactInstant(bounds.timedTo);
        const otherBlocks = (rows: NonNullable<typeof school.data>, title: string, namespace: string) => rows
          .filter(event => selected(event.member_id))
          .map(event => {
            const start = parseExactInstant(event.starts_at);
            const end = parseExactInstant(event.ends_at ?? addExactMilliseconds(event.starts_at,3_600_000));
            return { title, all_day:false, start:formatExactInstant(start>from?start:from), end:formatExactInstant(end<to?end:to), key:JSON.stringify([namespace,event.id,event.starts_at]) };
          }).filter(event => compareExactInstants(event.end,event.start)>0);
        const data = [
          ...(calendar.data ?? []).filter(event => event.occupied && (event.attribution.kind === 'family' || selected(event.attribution.memberId)))
            .map(event => ({title:event.title,all_day:event.all_day,...exactIntervalOf(event),key:event.occurrenceKey})),
          ...otherBlocks(school.data ?? [], 'School event', 'school'),
          ...otherBlocks(sports.data ?? [], 'Sports event', 'sports'),
        ].sort((a, b) => compareExactInstants(a.start,b.start) || a.key.localeCompare(b.key));
        const fmt = (iso: string | null) => {
          if (!iso) return null;
          try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
          catch { return iso.slice(0, 16); }
        };
        // An all-day row is a DATE stored at its UTC midnight: it is on its own
        // date, and has no clock time to give (read in the family's zone, a
        // Saturday all-day row in Los Angeles is "Fri 5:00 PM").
        const fmtDay = (iso: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
        const busy = (data ?? []).map((e) => {
          if (e.all_day) return {
            title: e.title, start: fmtDay(`${date}T00:00:00Z`), end: null, all_day: true,
            starts_at: bounds.allDayFromDay, ends_at: bounds.allDayToDay,
          };
          const startsAt = e.start;
          const endsAt = e.end;
          return { title: e.title, start: fmt(startsAt), end: fmt(endsAt), all_day: false, starts_at: startsAt, ends_at: endsAt };
        });
        return { ok: true, date, time_zone: tz, busy, note: busy.length ? 'These are the busy blocks; open time is the gaps between them.' : 'No busy blocks that day — the whole day is free.' };
      },
    },

    // ── RSVP tools ──────────────────────────────────────────────────────────
    {
      name: 'get_event_rsvps',
      description: 'Get RSVP responses for a calendar event. Use this to answer "who\'s going to…" questions.',
      input_schema: {
        type: 'object',
        properties: {
          event_title: { type: 'string', description: 'Title (or partial title) of the event to look up' },
        },
        required: ['event_title'],
      },
      execute: async (a) => {
        const title = str(a.event_title);
        if (!title) return { ok: false, error: 'event_title is required' };
        const { data: events, error: eventError } = await supabase.from('calendar_events')
          .select('id, title, starts_at')
          .eq('family_id', ctx.familyId).ilike('title', `%${escapeLike(title)}%`)
          .order('starts_at', { ascending: false }).limit(1);
        if (eventError) return toolFailure('find the event', eventError);
        if (!events?.length) return { ok: false, error: `No event matching "${title}" found.` };
        const event = events[0];
        const { data: rsvps, error: rsvpError } = await supabase.from('event_rsvps')
          .select('member_id, status').eq('event_id', event.id);
        if (rsvpError) return toolFailure('load event RSVPs', rsvpError);
        const byId = new Map(ctx.members.map((m) => [m.id, m.display_name]));
        const grouped: Record<string, string[]> = { accepted: [], maybe: [], declined: [] };
        for (const r of rsvps ?? []) {
          (grouped[r.status] ??= []).push(byId.get(r.member_id) ?? 'Unknown');
        }
        const noResponse = ctx.members.filter((m) => !(rsvps ?? []).some((r) => r.member_id === m.id)).map((m) => m.display_name);
        return { ok: true, event: event.title, starts_at: event.starts_at, going: grouped.accepted, maybe: grouped.maybe, declined: grouped.declined, no_response: noResponse };
      },
    },
    {
      name: 'rsvp_to_event',
      description: 'RSVP to a calendar event on behalf of the current user.',
      input_schema: {
        type: 'object',
        properties: {
          event_title: { type: 'string', description: 'Title (or partial title) of the event' },
          status: { type: 'string', enum: ['accepted', 'maybe', 'declined'], description: 'RSVP status' },
        },
        required: ['event_title', 'status'],
      },
      execute: async (a) => {
        const title = str(a.event_title);
        const status = str(a.status);
        if (!title || !['accepted', 'maybe', 'declined'].includes(status)) return { ok: false, error: 'event_title and valid status required' };
        const { data: events, error: eventError } = await supabase.from('calendar_events')
          .select('id, title')
          .eq('family_id', ctx.familyId).ilike('title', `%${escapeLike(title)}%`)
          .order('starts_at', { ascending: false }).limit(1);
        if (eventError) return toolFailure('find the event', eventError);
        if (!events?.length) return { ok: false, error: `No event matching "${title}" found.` };
        // Was `ctx.members.find((m) => true)` — members[0] written to look like a
        // lookup, so a teen saying "I'm going" RSVP'd as whoever sorts first in
        // the roster, usually a parent. An RSVP is a statement about a person;
        // making it about the wrong one is worse than not making it.
        if (!ctx.memberId) return { ok: false, error: 'Could not determine your member profile.' };
        const { error } = await supabase.from('event_rsvps').upsert(
          { event_id: events[0].id, family_id: ctx.familyId, member_id: ctx.memberId, status: status as 'accepted' | 'maybe' | 'declined' },
          { onConflict: 'event_id,member_id' },
        );
        if (error) return toolFailure('save the RSVP', error);
        const labels: Record<string, string> = { accepted: 'Going', maybe: 'Maybe', declined: "Can't make it" };
        return { ok: true, summary: `RSVP'd "${labels[status]}" to "${events[0].title}".` };
      },
    },

    // ── Announcement tools ──────────────────────────────────────────────────
    {
      name: 'create_announcement',
      description: 'Post a family announcement visible to all members. Use for important family-wide messages.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Announcement title/headline' },
          body: { type: 'string', description: 'Announcement details (optional)' },
          pinned: { type: 'boolean', description: 'Pin to top of announcements (default false)' },
        },
        required: ['title'],
      },
      execute: async (a) => {
        const title = str(a.title);
        if (!title) return { ok: false, error: 'title is required' };
        // Same members[0] bug: every announcement was signed by the first person
        // in the roster, whoever actually wrote it.
        if (!ctx.memberId) return { ok: false, error: 'Could not determine your member profile.' };
        const { error } = await supabase.from('family_announcements').insert({
          family_id: ctx.familyId,
          title,
          body: optStr(a.body),
          is_pinned: Boolean(a.pinned),
          author_member_id: ctx.memberId,
        });
        if (error) return toolFailure('post the announcement', error);
        return { ok: true, summary: `Posted announcement: "${title}".` };
      },
    },
    {
      name: 'list_announcements',
      description: 'Get recent family announcements. Use to answer "what announcements are there" or "what did the family post".',
      input_schema: {
        type: 'object',
        properties: { limit: { type: 'number', description: 'Max announcements to return (default 10)' } },
      },
      execute: async (a) => {
        const lim = Number.isFinite(a.limit) ? Math.max(1, Math.min(20, Math.round(a.limit as number))) : 10;
        const { data, error } = await supabase.from('family_announcements')
          .select('title, body, is_pinned, created_at, author_member_id')
          .eq('family_id', ctx.familyId)
          .order('is_pinned', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(lim);
        if (error) return toolFailure('load announcements', error);
        const byId = new Map(ctx.members.map((m) => [m.id, m.display_name]));
        return {
          ok: true,
          announcements: (data ?? []).map((a) => ({
            title: a.title, body: a.body, pinned: a.is_pinned,
            posted_at: a.created_at,
            author: a.author_member_id ? byId.get(a.author_member_id) ?? null : null,
          })),
        };
      },
    },
  ];
}
