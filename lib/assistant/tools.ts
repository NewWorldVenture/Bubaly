// lib/assistant/tools.ts — the AI Assistant's action toolbox. Each tool the
// model can call maps to a real, RLS-scoped Supabase write so the assistant can
// actually DO things (schedule events, add chores, build lists) — not just talk.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ToolSpec } from '@/lib/ai/provider';
import { buildConciergeDigest, digestToPromptLines, type ConciergeSnapshot } from '@/lib/concierge/digest';

type DB = SupabaseClient<Database>;

export type AssistantCtx = {
  familyId: string;
  userId: string;
  members: { id: string; display_name: string }[];
  /** Family time zone (IANA), used to format times for availability answers. */
  tz?: string;
};

const EVENT_CATEGORIES = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'];

function str(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }
function optStr(v: unknown): string | null { const s = str(v); return s || null; }

/** Resolve a member name (case-insensitive, prefix-friendly) to its id. */
function resolveMember(ctx: AssistantCtx, name: unknown): string | null {
  const q = str(name).toLowerCase();
  if (!q) return null;
  const exact = ctx.members.find((m) => m.display_name.toLowerCase() === q);
  if (exact) return exact.id;
  const partial = ctx.members.find((m) => m.display_name.toLowerCase().startsWith(q) || m.display_name.toLowerCase().includes(q));
  return partial?.id ?? null;
}

/** Get-or-create the family's default grocery list. */
async function ensureGroceryList(supabase: DB, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('is_archived', false).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing?.id) return existing.id;
  const { data } = await supabase.from('grocery_lists').insert({ family_id: familyId, name: 'Groceries', created_by: userId }).select('id').single();
  return data?.id ?? null;
}

/** Get-or-create the family's default to-do list. */
async function ensureTodoList(supabase: DB, familyId: string, userId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('todo_lists').select('id')
    .eq('family_id', familyId).is('archived_at', null).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (existing?.id) return existing.id;
  const { data } = await supabase.from('todo_lists').insert({ family_id: familyId, name: 'Tasks', created_by: userId }).select('id').single();
  return data?.id ?? null;
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
        if (error) return { ok: false, error: error.message };
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
        if (error) return { ok: false, error: error.message };
        const memberId = resolveMember(ctx, a.assignee);
        if (memberId) {
          await supabase.from('chore_assignments').insert({ family_id: ctx.familyId, chore_id: chore.id, member_id: memberId, due_at: optStr(a.due_at) });
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
        const listId = await ensureGroceryList(supabase, ctx.familyId, ctx.userId);
        if (!listId) return { ok: false, error: 'Could not open a grocery list' };
        const { error } = await supabase.from('grocery_items').insert({
          family_id: ctx.familyId, list_id: listId, name, quantity: optStr(a.quantity), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
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
        const listId = await ensureTodoList(supabase, ctx.familyId, ctx.userId);
        if (!listId) return { ok: false, error: 'Could not open a to-do list' };
        const { error } = await supabase.from('todo_items').insert({
          family_id: ctx.familyId, list_id: listId, title, notes: optStr(a.notes),
          due_date: optStr(a.due_date), assigned_to_id: resolveMember(ctx, a.assignee), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: `Added “${title}” to the to-do list.` };
      },
    },
    {
      name: 'add_reminder',
      description: 'Create a reminder that alerts the family at a specific time.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          remind_at: { type: 'string', description: 'ISO 8601 datetime to remind at' },
          notes: { type: 'string' },
        },
        required: ['title', 'remind_at'],
      },
      execute: async (a) => {
        const title = str(a.title); const remind_at = str(a.remind_at);
        if (!title || !remind_at) return { ok: false, error: 'title and remind_at are required' };
        const { error } = await supabase.from('reminders').insert({
          family_id: ctx.familyId, title, remind_at, notes: optStr(a.notes), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: `Reminder set: “${title}”.` };
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
        if (error) return { ok: false, error: error.message };
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
        const { error } = await supabase.from('goals').insert({
          family_id: ctx.familyId, title, description: optStr(a.description), target_date: optStr(a.target_date), created_by: ctx.userId,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true, summary: `Created the goal “${title}”.` };
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
        const { data, error } = await supabase.from('calendar_events')
          .select('title, starts_at, ends_at, all_day, location, assignee_id')
          .eq('family_id', ctx.familyId).gte('starts_at', now.toISOString()).lte('starts_at', until)
          .order('starts_at').limit(50);
        if (error) return { ok: false, error: error.message };
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
        if (error) return { ok: false, error: error.message };
        const choreIds = [...new Set((assigns ?? []).map((x) => x.chore_id))];
        const { data: chores } = choreIds.length
          ? await supabase.from('chores').select('id, title, points').in('id', choreIds)
          : { data: [] as { id: string; title: string; points: number }[] };
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
        const listId = await ensureGroceryList(supabase, ctx.familyId, ctx.userId);
        if (!listId) return { ok: true, items: [] };
        const { data, error } = await supabase.from('grocery_items')
          .select('name, quantity').eq('list_id', listId).eq('is_checked', false).order('created_at').limit(100);
        if (error) return { ok: false, error: error.message };
        return { ok: true, items: (data ?? []).map((i) => ({ name: i.name, quantity: i.quantity })) };
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
        // Pull a generous UTC window so the local day is fully covered across offsets.
        const from = new Date(`${date}T00:00:00Z`); from.setUTCHours(from.getUTCHours() - 14);
        const to = new Date(`${date}T23:59:59Z`); to.setUTCHours(to.getUTCHours() + 14);
        const memberId = resolveMember(ctx, a.assignee);
        let q = supabase.from('calendar_events')
          .select('title, starts_at, ends_at, all_day, assignee_id')
          .eq('family_id', ctx.familyId).gte('starts_at', from.toISOString()).lte('starts_at', to.toISOString())
          .order('starts_at').limit(50);
        if (memberId) q = q.eq('assignee_id', memberId);
        const { data, error } = await q;
        if (error) return { ok: false, error: error.message };
        const tz = ctx.tz || 'America/New_York';
        const fmt = (iso: string | null) => {
          if (!iso) return null;
          try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
          catch { return iso.slice(0, 16); }
        };
        const onDay = (iso: string) => {
          try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) === date; }
          catch { return iso.slice(0, 10) === date; }
        };
        const busy = (data ?? []).filter((e) => onDay(e.starts_at)).map((e) => ({ title: e.title, start: fmt(e.starts_at), end: fmt(e.ends_at), all_day: e.all_day }));
        return { ok: true, date, time_zone: tz, busy, note: busy.length ? 'These are the busy blocks; open time is the gaps between them.' : 'No events that day — the whole day is free.' };
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
        const { data: events } = await supabase.from('calendar_events')
          .select('id, title, starts_at')
          .eq('family_id', ctx.familyId).ilike('title', `%${title}%`)
          .order('starts_at', { ascending: false }).limit(1);
        if (!events?.length) return { ok: false, error: `No event matching "${title}" found.` };
        const event = events[0];
        const { data: rsvps } = await supabase.from('event_rsvps')
          .select('member_id, status').eq('event_id', event.id);
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
        const { data: events } = await supabase.from('calendar_events')
          .select('id, title')
          .eq('family_id', ctx.familyId).ilike('title', `%${title}%`)
          .order('starts_at', { ascending: false }).limit(1);
        if (!events?.length) return { ok: false, error: `No event matching "${title}" found.` };
        const selfMember = ctx.members.find((m) => true);
        if (!selfMember) return { ok: false, error: 'Could not determine your member profile.' };
        const { error } = await supabase.from('event_rsvps').upsert(
          { event_id: events[0].id, family_id: ctx.familyId, member_id: selfMember.id, status: status as 'accepted' | 'maybe' | 'declined' },
          { onConflict: 'event_id,member_id' },
        );
        if (error) return { ok: false, error: error.message };
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
        const selfMember = ctx.members.find((m) => true);
        if (!selfMember) return { ok: false, error: 'Could not determine your member profile.' };
        const { error } = await supabase.from('family_announcements').insert({
          family_id: ctx.familyId,
          title,
          body: optStr(a.body),
          is_pinned: Boolean(a.pinned),
          author_member_id: selfMember.id,
        });
        if (error) return { ok: false, error: error.message };
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
        if (error) return { ok: false, error: error.message };
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

    // ── Cross-domain digest (concierge) ────────────────────────────────────
    {
      name: 'get_family_digest',
      description: 'Get a cross-domain digest of everything the family needs to attend to: overdue bills, medications due today, upcoming maintenance, expiring warranties/pantry, trips, signups, screen time limits exceeded, and behavior incidents. Use this to answer "what needs attention", "what\'s due today", or "give me a family status update".',
      input_schema: { type: 'object', properties: {} },
      execute: async () => {
        const now = new Date();
        const nowIso = now.toISOString();
        const in30 = new Date(now.getTime() + 30 * 86400000).toISOString();
        const todayKey = nowIso.slice(0, 10);
        const dayOfWeek = now.getDay();

        const [
          { data: bills },
          { data: meds },
          { data: medScheds },
          { data: maint },
          { data: warranties },
          { data: trips },
          { data: pantry },
          { data: signups },
          { data: stEntries },
          { data: stLimits },
          { data: behavior },
        ] = await Promise.all([
          supabase.from('bills').select('name, amount, due_date, status').eq('family_id', ctx.familyId).neq('status', 'paid').lte('due_date', in30.slice(0, 10)),
          supabase.from('medications').select('id, name, member_id, is_active').eq('family_id', ctx.familyId).eq('is_active', true),
          supabase.from('medication_schedules').select('medication_id, time_of_day, days_of_week, ends_on').eq('family_id', ctx.familyId),
          supabase.from('maintenance_tasks').select('title, due_at, status').eq('family_id', ctx.familyId).in('status', ['todo', 'in_progress']).not('due_at', 'is', null),
          supabase.from('home_warranties').select('name, expires_on').eq('family_id', ctx.familyId).not('expires_on', 'is', null),
          supabase.from('vacations').select('title, start_date, end_date, destination, status').eq('family_id', ctx.familyId).not('status', 'in', '("completed","cancelled")'),
          supabase.from('pantry_items').select('name, expires_at').eq('family_id', ctx.familyId).not('expires_at', 'is', null),
          supabase.from('opportunities').select('title, deadline, status').eq('family_id', ctx.familyId).not('status', 'in', '("passed","missed")').not('deadline', 'is', null),
          supabase.from('screen_time_entries').select('member_id, minutes').eq('family_id', ctx.familyId).eq('entry_date', todayKey),
          supabase.from('screen_time_limits').select('member_id, daily_minutes').eq('family_id', ctx.familyId),
          supabase.from('behavior_logs').select('member_id, kind').eq('family_id', ctx.familyId).gte('occurred_at', `${todayKey}T00:00:00Z`),
        ]);

        const memberById = new Map(ctx.members.map((m) => [m.id, m.display_name]));

        const todayMeds = (meds ?? []).filter((med) => {
          const sched = (medScheds ?? []).find((s) => s.medication_id === med.id);
          if (!sched) return false;
          if (sched.ends_on && sched.ends_on < todayKey) return false;
          if (sched.days_of_week?.length && !sched.days_of_week.includes(dayOfWeek)) return false;
          return true;
        });

        const stUsage = new Map<string, number>();
        for (const e of stEntries ?? []) {
          if (!e.member_id) continue;
          stUsage.set(e.member_id, (stUsage.get(e.member_id) ?? 0) + e.minutes);
        }
        const stLimitMap = new Map((stLimits ?? []).map((l) => [l.member_id, l.daily_minutes]));
        const screenTime = [...stUsage.entries()]
          .filter(([mid]) => stLimitMap.has(mid))
          .map(([mid, used]) => ({ member: memberById.get(mid) ?? mid, usedMinutes: used, limitMinutes: stLimitMap.get(mid)! }));

        const behaviorCounts = new Map<string, { count: number; latestKind: string | null }>();
        for (const b of behavior ?? []) {
          if (!b.member_id) continue;
          const existing = behaviorCounts.get(b.member_id);
          if (existing) { existing.count++; existing.latestKind = b.kind ?? existing.latestKind; }
          else behaviorCounts.set(b.member_id, { count: 1, latestKind: b.kind ?? null });
        }

        const snap: ConciergeSnapshot = {
          now: nowIso,
          bills: (bills ?? []).map((b) => ({ name: b.name, amount: b.amount, dueDate: b.due_date, status: b.status })),
          medications: todayMeds.map((m) => {
            const sched = (medScheds ?? []).find((s) => s.medication_id === m.id);
            return { name: m.name, member: m.member_id ? memberById.get(m.member_id) : undefined, timeOfDay: sched?.time_of_day };
          }),
          maintenance: (maint ?? []).map((t) => ({ title: t.title, dueAt: t.due_at })),
          warranties: (warranties ?? []).map((w) => ({ name: w.name, expiresOn: w.expires_on })),
          trips: (trips ?? []).map((t) => ({ title: t.title, startDate: t.start_date, endDate: t.end_date, destination: t.destination })),
          pantry: (pantry ?? []).map((p) => ({ name: p.name, expiresAt: p.expires_at })),
          signups: (signups ?? []).map((s) => ({ title: s.title, deadline: s.deadline, status: s.status })),
          screenTime,
          behaviorIncidents: [...behaviorCounts.entries()].map(([mid, d]) => ({ member: memberById.get(mid) ?? mid, count: d.count, latestKind: d.latestKind })),
        };

        const digest = buildConciergeDigest(snap);
        return {
          ok: true,
          headline: digest.headline,
          counts: digest.counts,
          lines: digestToPromptLines(digest),
          items: digest.items.slice(0, 20).map((it) => ({ domain: it.domain, urgency: it.urgency, title: it.title, detail: it.detail })),
        };
      },
    },
  ];
}
