// The family dashboard's "Due Today" tile counted chore assignments with an
// EQUALITY on the bare date, `due_at = '2026-09-26'` — which Postgres reads as
// UTC midnight. A date-only chore from the board's Add is due at the FAMILY's
// midnight (`choreDueAt`): 07:00Z in Los Angeles, 15:00Z the evening before in
// Tokyo. So no chore created on the board was ever counted outside UTC, and the
// tile read 0 on a day with work due.
//
// It now counts the family's day as a range, as the home page does. Driven by
// the real `createChore` the board's Add calls, and the dashboard rendered over
// the rows it wrote.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import type { ServiceScope } from '@/lib/services/types';
import { getMessages } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { localeOrDefault } from '@/lib/i18n/locales';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
// The calendar half of the dashboard has its own tests
// (tests/family-dashboard-calendar-boundary.test.ts); it is switched to its
// archive path here so this file reads only the chore rows.
vi.mock('@/lib/calendar/source-capability', () => ({ CALENDAR_SOURCE_ARCHIVE_ENABLED: true }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault('en-US') }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/dashboard/dashboard-weather', () => ({ DashboardWeather: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

const { createChore } = await import('@/lib/services/tasks');
const { FamilyDashboard } = await import('@/components/dashboard/family-dashboard');

const FAMILY = '00000000-0000-4000-8000-00000000a901';
const PARENT = { member: '00000000-0000-4000-8000-00000000a902', user: '00000000-0000-4000-8000-00000000a903' };
const KID = { member: '00000000-0000-4000-8000-00000000a904', user: '00000000-0000-4000-8000-00000000a905' };
const DUE_TODAY = translate(getMessages('en-US'), 'familyDashboard.dueToday');

let db: InMemorySupabase;

function household(tz: string): void {
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: tz }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana', created_at: '2026-01-01T00:00:00Z' },
    { id: KID.member, family_id: FAMILY, user_id: KID.user, role: 'child', is_active: true, display_name: 'Maya', created_at: '2026-01-02T00:00:00Z' },
  ]);
}

/** The board's date-only Add, as `createChoreAction` calls it. */
async function addOnTheBoard(tz: string, title: string, dueAt: string): Promise<void> {
  const scope: ServiceScope = {
    db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member,
    role: 'parent', actorKind: 'member', tz, idempotencyKey: `board-add:${title}`,
  };
  const created = await createChore(scope, { title, dueAt, assigneeId: KID.member }, { rejectChangedRetry: true });
  expect(created.ok, created.ok ? '' : created.error).toBe(true);
}

async function dueTodayTile(tz: string): Promise<number> {
  const ctx = {
    user: { id: PARENT.user, email: null },
    memberships: [],
    active: {
      familyId: FAMILY,
      family: { id: FAMILY, name: 'The Hughens', timezone: tz },
      role: 'parent',
      member: { id: PARENT.member, user_id: PARENT.user, display_name: 'Dana' },
    },
  };
  const html = renderToStaticMarkup(await FamilyDashboard({ ctx: ctx as unknown as UserContext }));
  const tile = new RegExp(`text-2xl font-bold leading-none">(\\d+)</p><p class="mt-0.5 text-xs text-muted">${DUE_TODAY}<`).exec(html);
  expect(tile, 'the Due Today tile did not render').toBeTruthy();
  return Number(tile![1]);
}

beforeEach(() => {
  db = createInMemorySupabase({
    defaults: {
      chores: { description: null, points: 10, priority: 'medium', recurrence: 'none', requires_approval: true, icon: null, is_active: true },
      chore_assignments: { idempotency_key: null },
    },
  });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.useRealTimers());

describe('the family dashboard’s Due Today tile counts the chores the board made for today', () => {
  it.each([
    // Noon on Saturday 26 September 2026 in each family.
    ['America/Los_Angeles', '2026-09-26T19:00:00Z'],
    ['Asia/Tokyo', '2026-09-26T03:00:00Z'],
  ])('in %s', async (tz, now) => {
    household(tz);
    await addOnTheBoard(tz, 'Bins', '2026-09-26');
    await addOnTheBoard(tz, 'Recycling', '2026-09-25');
    await addOnTheBoard(tz, 'Lawn', '2026-09-27');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));

    expect(await dueTodayTile(tz)).toBe(1);
  });
});

// These cases exercise the retained first-fold policy without changing the
// recurrence's separate first-existing-minute policy for a spring gap.
import { nextRemindAt } from '@/lib/reminders/details';
import { familyInstant } from '@/lib/time/civil';
import { dayKeysBetween, zonedDayBoundsMs } from '@/lib/services/scope';
import { executeTool } from '@/lib/ai/tools/execute';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { wrapToolsWithTrust } from '@/lib/assistant/trust-wrapper';

const FOLD_CASES = [
  ['Europe/Berlin', 'daily', '2026-10-24T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00'],
  ['Europe/Berlin', 'weekly', '2026-10-18T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00'],
  ['Europe/Berlin', 'biweekly', '2026-10-11T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00'],
  ['Europe/Berlin', 'monthly', '2026-09-25T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00'],
  ['Europe/Berlin', 'yearly', '2025-10-25T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T02:30:00'],
  ['Europe/London', 'daily', '2026-10-24T00:30:00.000Z', '2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00'],
  ['Australia/Lord_Howe', 'daily', '2026-04-03T14:45:00.000Z', '2026-04-04T14:45:00.000Z', '2026-04-05T01:45:00'],
  ['America/Los_Angeles', 'daily', '2026-10-31T08:30:00.000Z', '2026-11-01T08:30:00.000Z', '2026-11-01T01:30:00'],
] as const;
describe('a recurring reminder uses the calendar’s first repeated reading', () => {
  it.each(FOLD_CASES)('%s %s from %s matches the calendar first fold %s', (zone, recurrence, from, expected, reading) => {
    expect(familyInstant(reading, zone)?.toISOString()).toBe(expected);
    expect(nextRemindAt(from, recurrence, zone)).toBe(expected);
  });
  it('keeps seconds and milliseconds on the first occurrence', () => {
    expect(nextRemindAt('2026-10-24T00:30:23.987Z', 'daily', 'Europe/Berlin')).toBe('2026-10-25T00:30:23.987Z');
  });
  it.each([
    ['America/Los_Angeles', '2026-03-07T10:30:00Z', '2026-03-08T10:00:00.000Z'],
    ['Europe/Berlin', '2026-03-28T01:30:00Z', '2026-03-29T01:00:00.000Z'],
    ['America/Santiago', '2026-09-05T04:30:00Z', '2026-09-06T04:00:00.000Z'],
  ])('retains the first-existing-minute gap policy in %s', (zone, from, expected) => {
    expect(nextRemindAt(from, 'daily', zone)).toBe(expected);
  });
  it('does not replay a fold when stepping from its second occurrence to the next day', () => {
    expect(nextRemindAt('2026-10-25T01:30:00Z', 'daily', 'Europe/Berlin')).toBe('2026-10-26T01:30:00.000Z');
  });
  it('retains one-off and malformed-time refusal', () => {
    expect(nextRemindAt('not-a-time', 'daily', 'Europe/Berlin')).toBeNull();
    expect(nextRemindAt('2026-10-24T00:30:00Z', 'none', 'Europe/Berlin')).toBeNull();
  });
});

describe('the genuine reminder completion callers keep that first fold', () => {
  it.each(['engine', 'chat'] as const)('%s schedules the first Berlin 02:30', async (caller) => {
    db = createInMemorySupabase({
      uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
      defaults: { ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null } },
    });
    h.db = db;
    household('Europe/Berlin');
    db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute', category_behavior: {}, risk_overrides: {}, child_channels: {}, memory_enabled: true }]);
    db.seed('family_reminders', [{ id: 'fold-reminder', family_id: FAMILY, title: 'Synthetic fold meds', recurrence: 'daily', remind_at: '2026-10-24T00:30:00Z', status: 'active', member_id: null, priority: 'medium' }]);
    const client = db as unknown as SupabaseClient<Database>;
    if (caller === 'engine') {
      const scope: ServiceScope = { db: client, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'ai', tz: 'Europe/Berlin', now: new Date('2026-10-24T00:30:00Z') };
      const result = await executeTool(scope, 'reminders.complete', { reminder_id: 'fold-reminder' });
      expect(result, JSON.stringify(result)).toMatchObject({ status: 'ok' });
      expect(db.table('family_reminders').find((r) => r.id === 'fold-reminder')?.remind_at).toBe('2026-10-25T00:30:00.000Z');
    } else {
      const context = { familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', members: [{ id: PARENT.member, display_name: 'Synthetic' }], tz: 'Europe/Berlin' };
      const tool = wrapToolsWithTrust(buildAssistantTools(client, context), client, FAMILY, 'parent', PARENT.member).find((t) => t.name === 'complete_reminder')!;
      expect(await tool.execute({ title: 'fold meds' })).toMatchObject({ ok: true });
      expect(db.table('family_reminders').filter((r) => r.id !== 'fold-reminder').map((r) => r.remind_at)).toEqual(['2026-10-25T00:30:00.000Z']);
    }
  });
});

describe('a civil-day boundary excludes the previous evening during midnight DST', () => {
  it.each([
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T03:00:00.000Z'],
    ['America/New_York', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z'],
    ['Europe/Berlin', '2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    ['Asia/Tokyo', '2026-09-06', '2026-09-05T15:00:00.000Z', '2026-09-06T15:00:00.000Z'],
    ['UTC', '2026-09-06', '2026-09-06T00:00:00.000Z', '2026-09-07T00:00:00.000Z'],
  ])('%s %s uses the calendar’s exact start and next start', (zone, day, start, end) => {
    const bounds = zonedDayBoundsMs(day, zone);
    expect(new Date(bounds.start).toISOString()).toBe(start);
    expect(new Date(bounds.end).toISOString()).toBe(end);
    expect(familyInstant(day, zone)?.getTime()).toBe(bounds.start);
    expect(bounds.end).toBeGreaterThan(bounds.start);
  });
  it('lists the two Santiago days across the shortened midnight-gap day without duplicates', () => {
    expect(dayKeysBetween(Date.parse('2026-09-06T03:30:00Z'), Date.parse('2026-09-06T04:30:00Z'), 'America/Santiago')).toEqual(['2026-09-05', '2026-09-06']);
  });
  it('keeps invalid-zone fallback as UTC instead of throwing', () => {
    const bounds = zonedDayBoundsMs('2026-09-06', 'Not/AZone');
    expect(bounds).toEqual({ start: Date.parse('2026-09-06T00:00:00Z'), end: Date.parse('2026-09-07T00:00:00Z') });
  });
  it.each(['previous evening only', 'paired previous evening and new day'] as const)('the rendered Due Today tile excludes %s', async (which) => {
    household('America/Santiago');
    await addOnTheBoard('America/Santiago', 'Synthetic previous evening', '2026-09-06T03:30:00Z');
    // The actual timestamp is 23:30 local on the 5th, not a date-only row.
    if (which === 'paired previous evening and new day') await addOnTheBoard('America/Santiago', 'Synthetic today', '2026-09-06');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-06T16:00:00Z'));
    expect(await dueTodayTile('America/Santiago')).toBe(which === 'previous evening only' ? 0 : 1);
  });
});

describe('first-fold recurrence preserves the resolver’s supported AD-year boundary', () => {
  it.each(['daily', 'yearly'])('refuses %s overflow beyond AD9999', (recurrence) => {
    expect(nextRemindAt('9999-12-31T12:30:00Z', recurrence, 'UTC')).toBeNull();
  });
  it('retains AD1 without JavaScript’s implicit 1900-year offset', () => {
    expect(nextRemindAt('0001-01-01T12:30:00Z', 'daily', 'UTC')).toBe('0001-01-02T12:30:00.000Z');
  });
  it('retains the existing host-calendar fallback only when no usable family zone is supplied', () => {
    const from = '2026-10-24T00:30:00Z';
    expect(nextRemindAt(from, 'daily', 'Not/AZone')).toBe(nextRemindAt(from, 'daily'));
  });
});
