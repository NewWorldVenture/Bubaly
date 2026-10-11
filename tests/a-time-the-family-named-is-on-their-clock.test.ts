// A time the family named is on THEIR clock, whichever door it came through.
//
// The assistant is told to speak the family's clock — "ISO 8601 in the family
// time zone", with the example `2026-06-24T15:00:00` — and the planner seeds
// its steps with `localTime(...)`. So what reaches a write is a wall reading
// with no zone, and every reader of it read it as UTC:
//
//   - the chat toolbox inserted it raw into a `timestamptz`, which Postgres
//     reads in its own zone (UTC): a Los Angeles "remind me at 9am" rang at 2am;
//   - `reminders.snooze`, `reminders.listDue`, `notifications.notify` and
//     `home.*` ran `Date.parse` on the host, which on Vercel is UTC;
//   - `tasks.createChore` / `tasks.assignChore` wrote the raw string too.
//
// And because the chat write and its approval replay read the same string two
// different ways, a write approved by a parent landed seven hours from the one
// chat would have made.
//
// Driven through the surfaces themselves — the chat toolbox wrapped as POST
// /api/ai/chat wraps it, an approval decided by a parent, and `executeTool` as
// the run executor and the assistant engine call it — over an in-memory
// household, for a Los Angeles family and a Tokyo one, on both sides of the
// 1 November 2026 change back from daylight time. Two families on opposite sides
// of UTC means a host clock in either zone (or UTC) cannot mask the defect.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: vi.fn() }));

import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';
import { executeTool } from '@/lib/ai/tools/execute';
import { decide } from '@/lib/services/approvals';
import { dailyBriefTemplate } from '@/lib/ai/planner/templates/daily-brief';
import { templateContextFrom } from '@/lib/ai/planner/templates';

const FAMILY = '00000000-0000-4000-8000-0000000c1001';
const PARENT = { user: '00000000-0000-4000-8000-0000000c1002', member: '00000000-0000-4000-8000-0000000c1003' };
const KID = { user: '00000000-0000-4000-8000-0000000c1004', member: '00000000-0000-4000-8000-0000000c1005' };

type Zone = 'America/Los_Angeles' | 'Asia/Tokyo';
type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

/** The two households. Every expected instant is written out, not computed. */
const LA: Zone = 'America/Los_Angeles';
const TOKYO: Zone = 'Asia/Tokyo';

function household(tz: Zone, behavior: 'execute' | 'prepare' = 'execute'): void {
  db.reset();
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: tz }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: KID.member, family_id: FAMILY, user_id: KID.user, role: 'child', is_active: true, display_name: 'Maya' },
  ]);
  db.seed('family_ai_settings', [{
    family_id: FAMILY, enabled: true, behavior, category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true,
  }]);
}

/** The chat toolbox exactly as POST /api/ai/chat builds it for the parent. */
function chatTool(name: string, tz: Zone) {
  const ctx = {
    familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent',
    members: [{ id: PARENT.member, display_name: 'Dana' }, { id: KID.member, display_name: 'Maya' }], tz,
  };
  const tool = wrapToolsWithTrust(buildAssistantTools(db, ctx), db, FAMILY, 'parent', PARENT.member).find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not in the chat toolbox`);
  return tool;
}

/** The scope the assistant engine and the run executor give `executeTool` for the parent. */
function aiScope(tz: Zone, now: string): ServiceScope {
  return { db, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'ai', tz, now: new Date(now) };
}

/** The parent who decides an approval card, as the dashboard's approval action scopes them. */
function parentScope(tz: Zone): ServiceScope {
  return { db, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'member', tz };
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      approval_requests: { status: 'pending', approvals: [], edited_payload: null, plan_step_ids: [], run_id: null, request_id: null, plan_step_id: null, payload_kind: null, expires_at: null },
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      family_reminders: { status: 'active', snoozed_until: null, member_id: null, idempotency_key: null, priority: 'medium', recurrence: 'none', kind: 'time' },
      chores: { description: null, points: 10, priority: 'medium', recurrence: 'none', due_at: null, requires_approval: true, icon: null, is_active: true },
      chore_assignments: { status: 'todo', due_at: null, idempotency_key: null },
      maintenance_tasks: { status: 'open', due_at: null, asset_id: null, assignee_id: null, priority: 'medium' },
      notifications: { is_read: false, body: null, link: null },
    },
  }) as DB;
  holder.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const reminders = () => db.table('family_reminders').filter((r) => r.family_id === FAMILY);

describe('chat: what the toolbox writes is the instant the family meant (AI18)', () => {
  it.each([
    [LA, '2026-10-12T16:00:00.000Z'],
    [TOKYO, '2026-10-12T00:00:00.000Z'],
  ] as const)('"remind me at 9am" in %s is stored as 9am there, not 09:00 UTC', async (tz, expected) => {
    household(tz);
    const res = await chatTool('add_reminder', tz).execute({ title: 'Call the dentist', remind_at: '2026-10-12T09:00:00' });
    expect(res).toMatchObject({ ok: true });
    expect(reminders().map((r) => r.remind_at)).toEqual([expected]);
  });

  it.each([
    // 1 November 2026 is the day Los Angeles leaves daylight time: 3pm is 22:00Z
    // the day before and 23:00Z the day after. Tokyo keeps no daylight time.
    [LA, '2026-10-31T15:00:00', '2026-10-31T22:00:00.000Z'],
    [LA, '2026-11-02T15:00:00', '2026-11-02T23:00:00.000Z'],
    [TOKYO, '2026-11-02T15:00:00', '2026-11-02T06:00:00.000Z'],
  ] as const)('an event at %s %s starts at that wall-clock time', async (tz, startsAt, expected) => {
    household(tz);
    const res = await chatTool('create_calendar_event', tz).execute({ title: 'Swim', starts_at: startsAt });
    expect(res).toMatchObject({ ok: true });
    expect(db.table('calendar_events').map((e) => e.starts_at)).toEqual([expected]);
  });

  it('refuses an all-day event that is not whole days, instead of storing a row that breaks every calendar read', async () => {
    household(LA);
    const event = chatTool('create_calendar_event', LA);
    // Local midnight with an offset, and an inclusive 23:59:59 end: neither is
    // a DATE label, and `qualifyNativeRow` / `nativeInterval` throw on such a row.
    expect(await event.execute({ title: 'Fair', starts_at: '2026-10-15T00:00:00-07:00', all_day: true })).toMatchObject({ ok: false });
    expect(await event.execute({ title: 'Fair', starts_at: '2026-10-15', ends_at: '2026-10-15T23:59:59', all_day: true })).toMatchObject({ ok: false });
    expect(db.table('calendar_events')).toEqual([]);

    // The shape the calendar stores and reads still lands, exactly.
    expect(await event.execute({ title: 'Fair', starts_at: '2026-10-15', ends_at: '2026-10-17', all_day: true })).toMatchObject({ ok: true });
    expect(db.table('calendar_events').map((e) => [e.starts_at, e.ends_at, e.all_day])).toEqual([['2026-10-15T00:00:00.000Z', '2026-10-17T00:00:00.000Z', true]]);
  });

  it.each([
    [LA, '2026-10-17T00:00:00.000Z'],
    [TOKYO, '2026-10-16T08:00:00.000Z'],
  ] as const)('a chore "due Friday 5pm" in %s is due at 5pm there, on the chore and its assignment', async (tz, expected) => {
    household(tz);
    const res = await chatTool('add_chore', tz).execute({ title: 'Take the bins out', due_at: '2026-10-16T17:00:00', assignee: 'Maya' });
    expect(res).toMatchObject({ ok: true });
    expect(db.table('chores').map((c) => c.due_at)).toEqual([expected]);
    expect(db.table('chore_assignments').map((a) => a.due_at)).toEqual([expected]);
  });

  it.each([
    [LA, '2026-10-13T16:00:00.000Z'],
    [TOKYO, '2026-10-13T00:00:00.000Z'],
  ] as const)('"move the dentist reminder to tomorrow 9am" in %s moves it to 9am there', async (tz, expected) => {
    household(tz);
    db.seed('family_reminders', [{ id: 'r-1', family_id: FAMILY, title: 'Call the dentist', remind_at: '2026-10-12T16:00:00.000Z', status: 'active', recurrence: 'none' }]);
    const res = await chatTool('snooze_reminder', tz).execute({ title: 'dentist', remind_at: '2026-10-13T09:00:00' });
    expect(res).toMatchObject({ ok: true });
    expect(reminders().map((r) => r.remind_at)).toEqual([expected]);
  });

  it('refuses a time it cannot read rather than writing it raw', async () => {
    household(LA);
    expect(await chatTool('add_reminder', LA).execute({ title: 'Call the dentist', remind_at: 'next tuesday-ish' })).toMatchObject({ ok: false });
    expect(await chatTool('add_chore', LA).execute({ title: 'Bins', due_at: '2026-02-30T09:00:00' })).toMatchObject({ ok: false });
    expect(reminders()).toEqual([]);
    expect(db.table('chores')).toEqual([]);
  });
});

describe('approval replay: a parent approves exactly the instant chat would have written (AI18, AI22)', () => {
  /** File the chat write under "prepare", then have the parent approve the card. */
  async function approveChatWrite(tz: Zone, name: string, args: Record<string, unknown>) {
    household(tz, 'prepare');
    const filed = await chatTool(name, tz).execute(args);
    expect(filed).toMatchObject({ ok: true, pending_approval: true });
    const [card] = db.table('approval_requests');
    expect(card, 'chat filed no approval').toBeTruthy();
    return decide(parentScope(tz), String(card.id), 'approved');
  }

  it.each([
    [LA, '2026-10-12T16:00:00.000Z'],
    [TOKYO, '2026-10-12T00:00:00.000Z'],
  ] as const)('an approved "remind me at 9am" in %s rings at 9am there', async (tz, expected) => {
    const decided = await approveChatWrite(tz, 'add_reminder', { title: 'Call the dentist', remind_at: '2026-10-12T09:00:00' });
    expect(decided).toMatchObject({ ok: true, data: { executed: true } });
    expect(reminders().map((r) => r.remind_at)).toEqual([expected]);
  });

  it.each([
    // Approved at 07:00 local, for 9am local today: still ahead, so it moves.
    [LA, '2026-10-12T14:00:00Z', '2026-10-12T16:00:00.000Z'],
    [TOKYO, '2026-10-11T22:00:00Z', '2026-10-12T00:00:00.000Z'],
  ] as const)('an approved "push the dentist reminder to 9am" in %s snoozes it to 9am there', async (tz, now, expected) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    try {
      household(tz, 'prepare');
      db.seed('family_reminders', [{ id: 'r-1', family_id: FAMILY, title: 'Call the dentist', remind_at: '2026-10-12T13:00:00.000Z', status: 'active', recurrence: 'none' }]);
      const filed = await chatTool('snooze_reminder', tz).execute({ title: 'dentist', remind_at: '2026-10-12T09:00:00' });
      expect(filed).toMatchObject({ ok: true, pending_approval: true });
      const decided = await decide(parentScope(tz), String(db.table('approval_requests')[0].id), 'approved');
      expect(decided).toMatchObject({ ok: true, data: { executed: true } });
      expect(reminders()[0]).toMatchObject({ status: 'snoozed', snoozed_until: expected });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the executor: reminders.snooze and reminders.listDue read the family clock (AI22)', () => {
  it.each([
    [LA, '2026-10-12T14:00:00Z', '2026-10-12T16:00:00.000Z'],
    [TOKYO, '2026-10-11T22:00:00Z', '2026-10-12T00:00:00.000Z'],
  ] as const)('a planned snooze to 9am in %s, asked at 7am, moves the reminder to 9am there', async (tz, now, expected) => {
    household(tz);
    db.seed('family_reminders', [{ id: 'r-1', family_id: FAMILY, title: 'Call the dentist', remind_at: '2026-10-12T13:00:00.000Z', status: 'active', recurrence: 'none' }]);
    const out = await executeTool(aiScope(tz, now), 'reminders.snooze', { title: 'dentist', remind_at: '2026-10-12T09:00:00' });
    expect(out).toMatchObject({ status: 'ok' });
    expect(reminders()[0]).toMatchObject({ status: 'snoozed', snoozed_until: expected });
  });

  it.each([
    // "Today" for the daily brief, asked at 8am local on 12 October.
    // Los Angeles: a 6pm reminder (01:00Z on the 13th) is today's; Date.parse
    // ended the day at 23:59Z, 4:59pm local, and dropped it.
    [LA, '2026-10-12T15:00:00Z', ['today-evening']],
    // Tokyo: tomorrow 8am (23:00Z on the 12th) is NOT today's; Date.parse ran
    // the day to 23:59Z, 8:59am the next morning, and included it.
    [TOKYO, '2026-10-11T23:00:00Z', ['today-evening']],
  ] as const)('the daily brief\'s "what reminders cover today" in %s is the family\'s today', async (tz, now, expected) => {
    household(tz);
    const evening = tz === LA ? '2026-10-13T01:00:00.000Z' : '2026-10-12T09:00:00.000Z';
    const tomorrowMorning = tz === LA ? '2026-10-13T15:00:00.000Z' : '2026-10-12T23:00:00.000Z';
    db.seed('family_reminders', [
      { id: 'today-evening', family_id: FAMILY, title: 'Evening meds', remind_at: evening, status: 'active', recurrence: 'none' },
      { id: 'tomorrow-morning', family_id: FAMILY, title: 'Bins', remind_at: tomorrowMorning, status: 'active', recurrence: 'none' },
    ]);
    const step = dailyBriefTemplate.steps.find((s) => s.key === 'reminders')!;
    const ctx = templateContextFrom({ tz, nowIso: now, todayKey: '2026-10-12', requestText: 'brief me' });
    const out = await executeTool(aiScope(tz, now), step.toolName!, step.input!(ctx));
    expect(out).toMatchObject({ status: 'ok' });
    if (out.status !== 'ok') return;
    expect((out.data as { reminders: { id: string }[] }).reminders.map((r) => r.id)).toEqual(expected);
  });
});

describe('the executor: notifications.notify lands at the named time (AI23)', () => {
  it.each([
    // "Remind everyone at 10:30pm to put the bins out": 05:30Z on the 13th in
    // Los Angeles, not 22:30Z — 3:30pm, seven hours early.
    [LA, '2026-10-13T05:30:00.000Z'],
    [TOKYO, '2026-10-12T13:30:00.000Z'],
  ] as const)('a notice for 10:30pm in %s is sent at 10:30pm there', async (tz, expected) => {
    household(tz);
    const out = await executeTool(aiScope(tz, '2026-10-12T12:00:00Z'), 'notifications.notify', { title: 'Bins out tonight', send_at: '2026-10-12T22:30:00' });
    expect(out).toMatchObject({ status: 'ok' });
    const sent = db.table('notifications').filter((n) => n.family_id === FAMILY);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((n) => n.send_at))).toEqual(new Set([expected]));
  });

  it('refuses a time it cannot read instead of sending at once', async () => {
    household(LA);
    const out = await executeTool(aiScope(LA, '2026-10-12T12:00:00Z'), 'notifications.notify', { title: 'Bins out tonight', send_at: 'tonight at half ten' });
    expect(out.status).not.toBe('ok');
    expect(db.table('notifications')).toEqual([]);
  });
});

describe('the executor: chore and maintenance due times are the family\'s (AI24)', () => {
  it.each([
    [LA, '2026-10-17T00:00:00.000Z'],
    [TOKYO, '2026-10-16T08:00:00.000Z'],
  ] as const)('tasks.createChore due Friday 5pm in %s is due at 5pm there', async (tz, expected) => {
    household(tz);
    const out = await executeTool(aiScope(tz, '2026-10-12T12:00:00Z'), 'tasks.createChore', { title: 'Take the bins out', due_at: '2026-10-16T17:00:00', assignee_id: KID.member });
    expect(out).toMatchObject({ status: 'ok' });
    expect(db.table('chores').map((c) => c.due_at)).toEqual([expected]);
    expect(db.table('chore_assignments').map((a) => a.due_at)).toEqual([expected]);
  });

  it.each([
    // Either side of the change back from daylight time in Los Angeles.
    [LA, '2026-10-31T18:00:00', '2026-11-01T01:00:00.000Z'],
    [LA, '2026-11-02T18:00:00', '2026-11-03T02:00:00.000Z'],
    [TOKYO, '2026-11-02T18:00:00', '2026-11-02T09:00:00.000Z'],
  ] as const)('tasks.assignChore due %s %s is due then', async (tz, dueAt, expected) => {
    household(tz);
    db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Feed the cat', due_at: null }]);
    const out = await executeTool(aiScope(tz, '2026-10-12T12:00:00Z'), 'tasks.assignChore', { chore_id: 'chore-1', assignee_id: KID.member, due_at: dueAt });
    expect(out).toMatchObject({ status: 'ok' });
    expect(db.table('chore_assignments').map((a) => a.due_at)).toEqual([expected]);
  });

  it.each([
    // A date-only due date is that day's first moment there, not UTC midnight —
    // which is the evening BEFORE in Los Angeles.
    [LA, '2026-10-20', '2026-10-20T07:00:00.000Z'],
    [TOKYO, '2026-10-20', '2026-10-19T15:00:00.000Z'],
    [LA, '2026-11-03T08:00:00', '2026-11-03T16:00:00.000Z'],
  ] as const)('home.createMaintenanceTask due %s %s is due then', async (tz, dueAt, expected) => {
    household(tz);
    const out = await executeTool(aiScope(tz, '2026-10-12T12:00:00Z'), 'home.createMaintenanceTask', { title: 'Replace the furnace filter', due_at: dueAt });
    expect(out).toMatchObject({ status: 'ok' });
    expect(db.table('maintenance_tasks').map((t) => t.due_at)).toEqual([expected]);
  });

  it.each([LA, TOKYO] as const)('home.listOpenMaintenance "due by the 20th" in %s draws the line at the family\'s midnight', async (tz) => {
    household(tz);
    // One second either side of the family's midnight starting the 20th.
    const midnight = tz === LA ? Date.parse('2026-10-20T07:00:00Z') : Date.parse('2026-10-19T15:00:00Z');
    db.seed('maintenance_tasks', [
      { id: 'before', family_id: FAMILY, title: 'Gutters', status: 'open', due_at: new Date(midnight - 1000).toISOString() },
      { id: 'after', family_id: FAMILY, title: 'Smoke alarms', status: 'open', due_at: new Date(midnight + 1000).toISOString() },
    ]);
    const out = await executeTool(aiScope(tz, '2026-10-12T12:00:00Z'), 'home.listOpenMaintenance', { due_before: '2026-10-20' });
    expect(out).toMatchObject({ status: 'ok' });
    if (out.status !== 'ok') return;
    expect((out.data as { tasks: { id: string }[] }).tasks.map((t) => t.id)).toEqual(['before']);
  });
});
