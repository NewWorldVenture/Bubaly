// S5 — the kid dashboard said "You have N points to spend" without subtracting
// what the child had already spent.
//
// components/dashboard/personal-dashboard.tsx summed points_awarded over the
// member's 'approved' AND 'done' assignments, capped at 500 rows, and never read
// reward_redemptions — so a child who had just spent 100 points on an approved
// reward was told they still had 100, and every reward up to that price showed
// as affordable. lib/rewards/points computeBalances, the rewards page and 0439's
// guard all say 0. This renders the REAL server component against an in-memory
// database capped at PostgREST's db-max-rows.
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { UserContext } from '@/lib/supabase/auth';
import { getMessages } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { localeOrDefault } from '@/lib/i18n/locales';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
// The calendar half of this page has its own suite
// (tests/personal-dashboard-calendar-boundary.test.ts); here it is switched off.
vi.mock('@/lib/calendar/source-capability', () => ({ CALENDAR_SOURCE_ARCHIVE_ENABLED: true }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault('en-US') }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/dashboard/dashboard-weather', () => ({ DashboardWeather: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));

const { PersonalDashboard } = await import('@/components/dashboard/personal-dashboard');

const FAMILY = '10000000-0000-4000-8000-000000000001';
const KID = '20000000-0000-4000-8000-000000000002';
const SIBLING = '20000000-0000-4000-8000-000000000003';
let base: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T15:00:00Z'));
  base = createInMemorySupabase<SupabaseClient<Database>>({ maxRows: 1000 });
  h.db = base;
  base.seed('family_members', [
    { id: KID, family_id: FAMILY, display_name: 'Bo', color: null, role: 'child', is_active: true, created_at: '2026-01-01T00:00:00Z' },
    { id: SIBLING, family_id: FAMILY, display_name: 'Cy', color: null, role: 'teen', is_active: true, created_at: '2026-01-02T00:00:00Z' },
  ]);
  base.seed('rewards', [
    { id: 'rw-1', family_id: FAMILY, title: 'Ice cream trip', cost_points: 50, redeemed_by: null },
    { id: 'rw-2', family_id: FAMILY, title: 'Movie night pick', cost_points: 1000, redeemed_by: null },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function dashboard(): Promise<string> {
  const ctx = {
    user: { id: '30000000-0000-4000-8000-000000000002', email: null },
    memberships: [],
    active: {
      familyId: FAMILY, family: { id: FAMILY, timezone: 'America/New_York' }, role: 'child',
      member: { id: KID, user_id: '30000000-0000-4000-8000-000000000002', display_name: 'Bo', color: null },
    },
  };
  return renderToStaticMarkup(await PersonalDashboard({ ctx: ctx as unknown as UserContext }));
}
const toSpend = (html: string) => /You have <span class="font-bold text-amber-400">([^<]*)<\/span> points to spend/.exec(html)?.[1];
/** The point price of each reward shown as affordable (green). */
const affordable = (html: string) => [...html.matchAll(/bg-emerald-500\/15 text-emerald-400">(\d+) pts/g)].map((m) => Number(m[1]));
const assignment = (i: number, patch: Record<string, unknown>) => ({
  id: `as-${String(i).padStart(5, '0')}`, family_id: FAMILY, chore_id: 'chore-1', due_at: null, ...patch,
});

describe('a kid is told the points they can spend', () => {
  it('spent points are taken off, and a reward the balance does not cover is not shown as affordable', async () => {
    base.seed('chore_assignments', [
      ...Array.from({ length: 10 }, (_, i) => assignment(i, { member_id: KID, status: 'approved', points_awarded: 10 })),
      // 'done' is not in the ledger (lib/rewards/points, 0439).
      assignment(100, { member_id: KID, status: 'done', points_awarded: 40 }),
      // Somebody else's points are not mine.
      assignment(200, { member_id: SIBLING, status: 'approved', points_awarded: 500 }),
    ]);
    base.seed('reward_redemptions', [
      { id: 'red-1', family_id: FAMILY, member_id: KID, cost_points: 70, status: 'approved' },
      { id: 'red-2', family_id: FAMILY, member_id: KID, cost_points: 20, status: 'fulfilled' },
      // Not spent: still waiting, or turned down.
      { id: 'red-3', family_id: FAMILY, member_id: KID, cost_points: 5, status: 'requested' },
      { id: 'red-4', family_id: FAMILY, member_id: KID, cost_points: 5, status: 'rejected' },
    ]);
    const html = await dashboard();

    // 100 earned - 90 spent.
    expect(toSpend(html)).toBe('10');
    expect(affordable(html)).toEqual([]);
  });

  it('every approved chore counts, past the 500 and 1,000 row caps', async () => {
    base.seed('chore_assignments', Array.from({ length: 1200 }, (_, i) => assignment(i, { member_id: KID, status: 'approved', points_awarded: 1 })));
    const html = await dashboard();

    expect(html).toContain('<p class="text-2xl font-bold leading-none">1200</p><p class="mt-0.5 truncate text-xs text-muted">Points Earned</p>');
    expect(toSpend(html)).toBe('1200');
    expect(affordable(html)).toEqual([50, 1000]);
  });

  // AUD-1040-LEDGER-PAGING: the ledger is summed while it is written to. A chore
  // approved between two pages of an offset read pushed the last row of page
  // one onto page two, and it was counted twice.
  it('a chore approved between two pages of the ledger does not count an old one twice', async () => {
    base.seed('chore_assignments', Array.from({ length: 1200 }, (_, i) => assignment(i, { member_id: KID, status: 'approved', points_awarded: i === 999 ? 100 : 1 })));
    let pages = 0;
    h.db = withFaults(base, (table, calls) => {
      const ledgerRead = calls.some((c) => c.method === 'select' && c.args[0] === 'id, member_id, status, points_awarded');
      if (table === 'chore_assignments' && ledgerRead && ++pages === 2) {
        base.seed('chore_assignments', [{ ...assignment(0, { member_id: KID, status: 'approved', points_awarded: 1 }), id: 'as-00000a' }]);
      }
      return null;
    });
    const html = await dashboard();

    // 1,199 chores at 1 and one at 100, each once; the chore approved mid-read
    // landed below the cursor and is read next time.
    expect(toSpend(html)).toBe('1299');
  });

  it('a ledger that could not be read is not shown as a balance, and nothing reads as affordable', async () => {
    base.seed('chore_assignments', Array.from({ length: 10 }, (_, i) => assignment(i, { member_id: KID, status: 'approved', points_awarded: 10 })));
    h.db = withFaults(base, (table) => (table === 'reward_redemptions' ? { message: 'Fixture read refused' } : null));
    const html = await dashboard();

    expect(toSpend(html)).toBe('—');
    expect(affordable(html)).toEqual([]);
  });
});
