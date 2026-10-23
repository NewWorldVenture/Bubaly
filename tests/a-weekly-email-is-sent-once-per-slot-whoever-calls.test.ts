// A weekly email is sent once per slot, whichever scheduler calls.
//
// vercel.json and scripts/cron-dispatch.mjs both fire /api/cron/weekly-digest
// at '0 8 * * 1' and /api/cron/chore-reminders at '0 18 * * 0'; a GitHub tick
// landing inside the five-minute window calls the route beside Vercel's, and a
// 502 invites a replay by hand. Both routes derived their week from the clock
// and sent through sendReactEmail with no idempotency key and no receipt, so
// every tick rendered its own bytes and nothing folded them: every family's
// admin got two digests, every member with open chores two reminders.
//
// Every tick for one slot now reads the same week (lib/server/cron-slot.ts)
// and sends each recipient under one key per occurrence, which the provider
// folds — the dedupe admin-digest already carries.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCHEDULES } from '../scripts/cron-dispatch.mjs';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CHORE_REMINDER_SLOT, lastWeeklySlot, WEEKLY_DIGEST_SLOT, weeklySlotCron, weeklyWindow } from '@/lib/server/cron-slot';

const h = vi.hoisted(() => ({
  db: null as unknown,
  sends: [] as { to: string; idempotencyKey?: string; subject: string }[],
  windows: [] as { from: string; to: string }[],
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/list-all-auth-users', () => ({
  listAllAuthUsers: async () => ({ users: [{ id: 'u-1', email: 'parent@synthetic.invalid' }], error: null }),
}));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async (input: { to: string; idempotencyKey?: string; subject: string }) => {
    h.sends.push({ to: input.to, idempotencyKey: input.idempotencyKey, subject: input.subject });
    return { ok: true };
  },
}));
vi.mock('@/lib/emails/weekly-digest', () => ({ WeeklyDigestEmail: () => null }));
vi.mock('@/lib/emails/chore-reminder', () => ({ ChoreReminderEmail: () => null }));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/network/compare-line', () => ({ renderCompareLine: () => null }));
vi.mock('@/lib/notifications/child-channels', () => ({ childrenBlockedOn: async () => new Set<string>() }));
vi.mock('@/lib/services/calendar/search-occurrences', () => ({
  readCompleteCalendarOccurrences: async (_scope: unknown, window: { from: string; to: string }) => {
    h.windows.push(window);
    return { ok: true, data: { occurrences: [] } };
  },
}));

const { GET: weeklyDigest } = await import('@/app/api/cron/weekly-digest/route');
const { GET: choreReminders } = await import('@/app/api/cron/chore-reminders/route');

let db: InMemorySupabase;
const req = (path: string) => new Request(`https://bubaly.test${path}`) as never;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.sends = []; h.windows = [];
  db = createInMemorySupabase();
  h.db = db;
  db.seed('families', [{ id: 'fam', name: 'Synthetic', timezone: 'UTC', closed_at: null }]);
  db.seed('family_members', [{ id: 'm-1', family_id: 'fam', user_id: 'u-1', display_name: 'Sam', role: 'parent', is_active: true }]);
  db.seed('chores', [{ id: 'ch-1', family_id: 'fam', title: 'Dishes', points: 5 }]);
  db.seed('chore_assignments', [{
    id: 'ca-1', family_id: 'fam', chore_id: 'ch-1', member_id: 'm-1', status: 'todo', due_at: '2026-10-21T12:00:00.000Z',
    // The fake resolves an embed by `<table>_id`, not the `!member_id` hint.
    family_member_id: 'm-1',
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the slot', () => {
  it('is the schedule both lists carry', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    for (const [path, slot] of [['/api/cron/weekly-digest', WEEKLY_DIGEST_SLOT], ['/api/cron/chore-reminders', CHORE_REMINDER_SLOT]] as const) {
      expect(vercel.crons.find((c) => c.path === path)?.schedule, path).toBe(weeklySlotCron(slot));
      expect((SCHEDULES as Record<string, string>)[path], path).toBe(weeklySlotCron(slot));
    }
  });

  it('is the most recent fire at or before now', () => {
    const monday = '2026-10-05T08:00:00.000Z';
    expect(lastWeeklySlot(new Date('2026-10-05T08:00:00.000Z'), WEEKLY_DIGEST_SLOT).toISOString()).toBe(monday);
    expect(lastWeeklySlot(new Date('2026-10-05T08:03:30.000Z'), WEEKLY_DIGEST_SLOT).toISOString()).toBe(monday);
    expect(lastWeeklySlot(new Date('2026-10-11T23:59:59.000Z'), WEEKLY_DIGEST_SLOT).toISOString()).toBe(monday);
    // The hour has not come yet on the slot's own weekday: last week's.
    expect(lastWeeklySlot(new Date('2026-10-12T07:59:59.000Z'), WEEKLY_DIGEST_SLOT).toISOString()).toBe(monday);
    expect(lastWeeklySlot(new Date('2026-10-12T08:00:00.000Z'), WEEKLY_DIGEST_SLOT).toISOString()).toBe('2026-10-12T08:00:00.000Z');
    expect(lastWeeklySlot(new Date('2026-10-18T18:04:00.000Z'), CHORE_REMINDER_SLOT).toISOString()).toBe('2026-10-18T18:00:00.000Z');
    expect(lastWeeklySlot(new Date('2026-10-18T17:59:00.000Z'), CHORE_REMINDER_SLOT).toISOString()).toBe('2026-10-11T18:00:00.000Z');
    expect(weeklyWindow(new Date(monday))).toEqual({ start: monday, end: '2026-10-12T08:00:00.000Z' });
  });
});

describe('the weekly digest', () => {
  it('sends each admin under one key per slot, and reads the slot\'s week on every tick', async () => {
    vi.setSystemTime(new Date('2026-10-05T08:00:00.000Z')); // Vercel's tick
    expect((await weeklyDigest(req('/api/cron/weekly-digest'))).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-05T08:03:30.000Z')); // the dispatcher's, inside its five-minute window
    expect((await weeklyDigest(req('/api/cron/weekly-digest'))).status).toBe(200);
    vi.setSystemTime(new Date('2026-10-07T15:00:00.000Z')); // a replay by hand, two days late
    expect((await weeklyDigest(req('/api/cron/weekly-digest'))).status).toBe(200);

    expect(h.sends).toHaveLength(3);
    const keys = h.sends.map((s) => s.idempotencyKey);
    expect(keys[0], 'sent with no key: nothing folds the mirrored tick').toMatch(/^weekly-digest\/[a-f0-9]{64}$/);
    expect(new Set(keys).size, 'the ticks sent under different keys').toBe(1);
    // The same bytes: every tick asked the calendar for the slot's week, which
    // is the family's Monday-to-Sunday (this family keeps UTC): from its Monday
    // midnight to the next one, not from the 08:00 UTC instant.
    expect(new Set(h.windows.map((w) => `${w.from}|${w.to}`)).size).toBe(1);
    expect(h.windows[0]).toEqual({ from: '2026-10-05T00:00:00.000Z', to: '2026-10-12T00:00:00.000Z' });
  });

  it('keys the next slot apart', async () => {
    vi.setSystemTime(new Date('2026-10-05T08:00:00.000Z'));
    await weeklyDigest(req('/api/cron/weekly-digest'));
    vi.setSystemTime(new Date('2026-10-12T08:00:00.000Z'));
    await weeklyDigest(req('/api/cron/weekly-digest'));
    expect(h.sends[0].idempotencyKey).not.toBe(h.sends[1].idempotencyKey);
  });
});

describe('the chore reminders', () => {
  it('send each member under one key per slot on every tick of the slot', async () => {
    vi.setSystemTime(new Date('2026-10-18T18:00:00.000Z'));
    expect(await (await choreReminders(req('/api/cron/chore-reminders'))).json()).toMatchObject({ sent: 1, failed: 0 });
    vi.setSystemTime(new Date('2026-10-18T18:04:00.000Z'));
    expect(await (await choreReminders(req('/api/cron/chore-reminders'))).json()).toMatchObject({ sent: 1, failed: 0 });

    expect(h.sends).toHaveLength(2);
    expect(h.sends[0].idempotencyKey, 'sent with no key: nothing folds the mirrored tick').toMatch(/^chore-reminders\/[a-f0-9]{64}$/);
    expect(h.sends[1].idempotencyKey).toBe(h.sends[0].idempotencyKey);
  });

  it('reads the slot\'s week, not the seven days from the tick', async () => {
    // Due four minutes past the slot's week: inside a clock-derived week on
    // the late tick, outside the slot's. Both ticks must agree.
    db.table('chore_assignments')[0].due_at = '2026-10-25T18:02:00.000Z';
    vi.setSystemTime(new Date('2026-10-18T18:00:00.000Z'));
    expect(await (await choreReminders(req('/api/cron/chore-reminders'))).json()).toMatchObject({ sent: 0 });
    vi.setSystemTime(new Date('2026-10-18T18:04:00.000Z'));
    expect(await (await choreReminders(req('/api/cron/chore-reminders'))).json()).toMatchObject({ sent: 0 });
    expect(h.sends).toEqual([]);
  });
});
