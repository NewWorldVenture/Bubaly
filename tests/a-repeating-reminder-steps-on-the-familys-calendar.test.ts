// A repeating reminder or chore steps on the FAMILY's calendar.
//
// `nextRemindAt` moved a recurrence with `setDate` / `getDay` / `setMonth` — the
// runtime's own clock, which on a server is UTC. So:
//
//   - a 'weekdays' reminder at 6pm in Los Angeles is 01:00Z the NEXT day, and
//     its weekdays were UTC's: completing Thursday's skipped Friday and set
//     Sunday; in Tokyo an 8am one (23:00Z the day before) ran Tuesday–Saturday;
//   - a daily 9am kept its UTC instant across 1 November 2026, the day Los
//     Angeles leaves daylight time, and rang at 8am;
//   - a daily chore due 6pm drifted to 5pm the same way, and a monthly one due
//     at 8am on the 1st in Tokyo (23:00Z on the 30th) came back on the 31st.
//
// Driven through the surfaces that roll one forward: `reminders.complete` and
// `tasks.completeChore` through `executeTool` (the assistant engine, the run
// executor and approval replay all call it), and the chat toolbox's
// `complete_reminder` wrapped as POST /api/ai/chat wraps it. Each case pairs a
// zone west of UTC with one east of it, so no host clock hides the defect.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));

import { executeTool } from '@/lib/ai/tools/execute';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';

const FAMILY = '00000000-0000-4000-8000-0000000c1901';
const PARENT = { user: '00000000-0000-4000-8000-0000000c1902', member: '00000000-0000-4000-8000-0000000c1903' };
const KID = { user: '00000000-0000-4000-8000-0000000c1904', member: '00000000-0000-4000-8000-0000000c1905' };

type Zone = 'America/Los_Angeles' | 'Asia/Tokyo';
const LA: Zone = 'America/Los_Angeles';
const TOKYO: Zone = 'Asia/Tokyo';

type DB = InMemorySupabase & SupabaseClient<Database>;
let db: DB;

function household(tz: Zone): void {
  db.reset();
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: tz }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: KID.member, family_id: FAMILY, user_id: KID.user, role: 'child', is_active: true, display_name: 'Maya' },
  ]);
  db.seed('family_ai_settings', [{
    family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true,
  }]);
}

function aiScope(tz: Zone, now: string): ServiceScope {
  return { db, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'ai', tz, now: new Date(now) };
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']], chore_assignments: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      family_reminders: { status: 'active', snoozed_until: null, member_id: null, priority: 'medium', kind: 'recurring', notes: null, location_name: null, autopilot_origin: false, autopilot_card_id: null },
      reminders: { autopilot_origin: false, autopilot_card_id: null },
      chores: { description: null, points: 10, priority: 'medium', due_at: null, icon: null, is_active: true },
      chore_assignments: { status: 'todo', due_at: null, idempotency_key: null, submitted_at: null, approved_at: null },
    },
  }) as DB;
  holder.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** Each case: the zone, the cadence, the occurrence being completed, and the next one the family expects. */
const REMINDER_CASES = [
  // Thursday 15 October, 6pm PDT → Friday 16 October, 6pm PDT. UTC stepping gave Sunday.
  [LA, 'weekdays', '2026-10-16T01:00:00.000Z', '2026-10-17T01:00:00.000Z'],
  // Friday 16 October, 8am JST → Monday 19 October, 8am JST. UTC stepping gave Saturday.
  [TOKYO, 'weekdays', '2026-10-15T23:00:00.000Z', '2026-10-18T23:00:00.000Z'],
  // Saturday 31 October, 9am PDT → Sunday 1 November, 9am PST (an hour later in UTC).
  [LA, 'daily', '2026-10-31T16:00:00.000Z', '2026-11-01T17:00:00.000Z'],
  // Thursday 1 October, 8am JST → Sunday 1 November, 8am JST. UTC stepping gave the 31st.
  [TOKYO, 'monthly', '2026-09-30T23:00:00.000Z', '2026-10-31T23:00:00.000Z'],
] as const;

describe('reminders.complete rolls a repeating reminder on the family calendar', () => {
  it.each(REMINDER_CASES)('%s %s: completing %s sets the next one for %s', async (tz, recurrence, remindAt, next) => {
    household(tz);
    db.seed('family_reminders', [{ id: 'r-1', family_id: FAMILY, title: 'Evening meds', recurrence, remind_at: remindAt, status: 'active' }]);
    const out = await executeTool(aiScope(tz, remindAt), 'reminders.complete', { reminder_id: 'r-1' });
    expect(out).toMatchObject({ status: 'ok' });
    expect(db.table('family_reminders').find((r) => r.id === 'r-1')).toMatchObject({ status: 'active', remind_at: next });
  });
});

describe("chat's complete_reminder schedules the next one on the family calendar", () => {
  it.each(REMINDER_CASES)('%s %s: completing %s schedules %s', async (tz, recurrence, remindAt, next) => {
    household(tz);
    db.seed('family_reminders', [{ id: 'r-1', family_id: FAMILY, title: 'Evening meds', recurrence, remind_at: remindAt, status: 'active' }]);
    const ctx = { familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', members: [{ id: PARENT.member, display_name: 'Dana' }], tz };
    const tool = wrapToolsWithTrust(buildAssistantTools(db, ctx), db, FAMILY, 'parent', PARENT.member).find((t) => t.name === 'complete_reminder')!;
    expect(await tool.execute({ title: 'meds' })).toMatchObject({ ok: true });
    const scheduled = db.table('family_reminders').filter((r) => r.id !== 'r-1');
    expect(scheduled.map((r) => [r.status, r.remind_at])).toEqual([['active', next]]);
  });
});

describe('tasks.completeChore brings a repeating chore back on the family calendar', () => {
  it.each([
    // Due Saturday 31 October, 6pm PDT; done that afternoon → due Sunday 6pm PST.
    [LA, 'daily', '2026-11-01T01:00:00.000Z', '2026-10-31T20:00:00Z', '2026-11-02T02:00:00.000Z'],
    // Due Thursday 1 October, 8am JST; done that morning → due Sunday 1 November, 8am JST.
    [TOKYO, 'monthly', '2026-09-30T23:00:00.000Z', '2026-09-30T23:30:00Z', '2026-10-31T23:00:00.000Z'],
  ] as const)('%s %s: an assignment due %s, done at %s, comes back due %s', async (tz, recurrence, dueAt, now, next) => {
    household(tz);
    db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Feed the cat', recurrence, requires_approval: false }]);
    db.seed('chore_assignments', [{ id: 'asg-1', family_id: FAMILY, chore_id: 'chore-1', member_id: KID.member, status: 'todo', due_at: dueAt }]);
    const out = await executeTool(aiScope(tz, now), 'tasks.completeChore', { assignment_id: 'asg-1' });
    expect(out).toMatchObject({ status: 'ok' });
    const successor = db.table('chore_assignments').filter((a) => a.id !== 'asg-1');
    expect(successor.map((a) => [a.member_id, a.status, a.due_at])).toEqual([[KID.member, 'todo', next]]);
  });
});
