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
