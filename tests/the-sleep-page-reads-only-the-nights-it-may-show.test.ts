import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY, HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { render, settle } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// N4-R1 — the Sleep page, the REAL module and its own reads, against an
// in-memory database (RLS is not modelled: the held 0506 leaves it
// family-wide, which is exactly the case).
//
// The page read EVERY member's nights and check-ins (the newest 600 and 400)
// and filtered them only for display (lib/health/record-scope.ts), so a
// child's browser held their siblings' and parents' sleep, and everyone
// else's could crowd the child's own out of the read. A parent or adult reads
// the household's; anyone else is read, before the limit, their own record and
// the entries they logged — as the Family Map's history is (N6).

const h = await vi.hoisted(async () => ({ ...(await import('./helpers/module-state')).createModuleState(), role: 'parent' }));
vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).fetchedQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ ...h.app, role: h.role }) }));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
const { SleepModule } = await import('@/components/modules/sleep-module');

const kid = { id: 'member-kid', display_name: 'Kid', user_id: 'user-kid', birthday: '2014-03-01', is_active: true };
const sib = { id: 'member-sib', display_name: 'Sib', user_id: null, birthday: '2017-06-01', is_active: true };
const parent = { id: 'member-parent', display_name: 'Pat', user_id: 'user-parent', birthday: '1985-01-01', is_active: true };
let db: InMemorySupabase;

const night = (id: string, memberId: string, day: string, createdBy: string) => ({
  id, family_id: FAMILY, member_id: memberId, sleep_date: day, bedtime: `${day}T01:30:00.000Z`, wake_time: `${day}T11:00:00.000Z`,
  duration_min: 570, quality: 4, awakenings: 0, source: 'manual', notes: null, created_by: createdBy,
});
const checkin = (id: string, memberId: string, day: string, createdBy: string) => ({
  id, family_id: FAMILY, member_id: memberId, checkin_date: day, energy: 3, mood: 3,
  caffeine_after_2pm: false, screens_in_bed: false, exercised: true, created_by: createdBy,
});

/** Mount the page and let its reads land; what each read handed the browser. */
async function received() {
  render(h.hooks, createElement(SleepModule));
  for (let i = 0; i < 6; i++) { await settle(); render(h.hooks, createElement(SleepModule)); }
  const rowsOf = (table: string) => Object.entries(h.rows)
    .filter(([key]) => key.startsWith(`${table}:`)).flatMap(([, rows]) => rows.map((row) => String(row.id))).sort();
  return { nights: rowsOf('sleep_logs'), checkins: rowsOf('sleep_checkins') };
}

function asChild() {
  h.role = 'child';
  Object.assign(h.app, { userId: 'user-kid', selfMember: kid });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T13:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  Object.assign(h.app, { familyId: FAMILY, userId: 'user-parent', members: [kid, sib, parent], selfMember: parent });
  h.role = 'parent';
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null; h.realtime = {}; h.confirmAnswer = true;
  h.timeZone = 'America/New_York';
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('sleep_logs', [
    night('sib-by-parent', sib.id, '2026-10-13', 'user-parent'),
    night('parent-own', parent.id, '2026-10-13', 'user-parent'),
    night('kid-by-parent', kid.id, '2026-10-12', 'user-parent'),
    night('kid-own', kid.id, '2026-10-13', 'user-kid'),
    night('sib-by-kid', sib.id, '2026-10-12', 'user-kid'),
  ]);
  db.seed('sleep_checkins', [
    checkin('c-sib-by-parent', sib.id, '2026-10-13', 'user-parent'),
    checkin('c-parent-own', parent.id, '2026-10-13', 'user-parent'),
    checkin('c-kid-by-parent', kid.id, '2026-10-12', 'user-parent'),
    checkin('c-sib-by-kid', sib.id, '2026-10-12', 'user-kid'),
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Sleep page reads only the nights it may show', () => {
  it('a child\'s browser is handed their own record and what they logged, not the household\'s', async () => {
    asChild();
    const { nights, checkins } = await received();
    expect(nights).toEqual(['kid-by-parent', 'kid-own', 'sib-by-kid']);
    expect(checkins).toEqual(['c-kid-by-parent', 'c-sib-by-kid']);
  });

  it('narrowed before the limit: the household\'s newest 600 nights do not crowd out the child\'s own', async () => {
    asChild();
    // Twenty months of a sibling's nights, every one newer than the child's.
    db.seed('sleep_logs', Array.from({ length: 600 }, (_, i) => night(
      `sib-${String(i).padStart(3, '0')}`, sib.id,
      new Date(Date.parse('2026-10-11T12:00:00Z') - i * 86_400_000).toISOString().slice(0, 10), 'user-parent',
    )));
    db.seed('sleep_logs', [night('kid-2024', kid.id, '2024-01-15', 'user-kid')]);
    const { nights } = await received();
    expect(nights).toContain('kid-2024');
    expect(nights.some((id) => id.startsWith('sib-') && id !== 'sib-by-kid')).toBe(false);
  });

  it('a parent still reads every member\'s', async () => {
    const { nights, checkins } = await received();
    expect(nights).toEqual(['kid-by-parent', 'kid-own', 'parent-own', 'sib-by-kid', 'sib-by-parent']);
    expect(checkins).toHaveLength(4);
  });
});
