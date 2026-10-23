// A caregiver reads every medicine and schedule in the household (the held
// 0511 rule, lib/medications/readers.ts) but 0481 keeps medication_doses a
// manager's or the member's own. So the Medicines page listed the child's
// "Amoxicillin 08:00 Every day" under a Today's Doses panel that said "No
// doses scheduled for today.", beside an adherence ring of "—" and "0 taken /
// 0 skipped / 0 missed": a babysitter told nothing was due about rows they are
// not given. The panels now say whose doses those are.
//
// Driven through the REAL MedicationsModule, rendered on the server twice: the
// first pass hands back each list's query, the module's OWN fetcher is then
// run against the in-memory database, and the second pass renders what it
// returned. So the caregiver's dose read is pinned to their own member row, as
// RLS pins it, and comes back empty. (The hook-slot harness cannot drive this
// module: its readback guard is a no-dependency layout effect, which that
// harness re-runs for ever.)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type Query = { table: string; fetcher: (sb: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
const h = await vi.hoisted(async () => ({
  ...(await import('./helpers/module-state')).createModuleState(),
  queries: [] as Query[],
  answered: {} as Record<string, unknown[]>,
}));

vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: (query: Query) => {
    h.queries.push(query);
    const data = h.answered[query.table];
    return { data: data ?? [], loading: !data, error: null, stale: false, updatedAt: 0, refresh: async () => {}, refreshAndConfirm: async () => ({ ok: true }), setData: () => {} };
  },
}));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { MedicationsModule } = await import('@/components/modules/medications-module');
const { clientFor } = await import('./helpers/module-harness');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const MEMBERS = [
  { id: 'm-parent', family_id: FAMILY, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
  { id: 'm-sitter', family_id: FAMILY, display_name: 'Sitter', role: 'caregiver', is_active: true, color: null, birthday: null },
  { id: 'm-kid', family_id: FAMILY, display_name: 'Kid', role: 'child', is_active: true, color: null, birthday: null },
];
const NOTE = () => t('medicationsModule.otherMembersDosesAreKeptByManagers');

function as(memberId: string) {
  const self = MEMBERS.find((m) => m.id === memberId)!;
  h.app = { ...h.app, familyId: FAMILY, userId: `u-${memberId}`, members: MEMBERS, selfMember: self, family: { id: FAMILY, name: 'Fixture', timezone: 'UTC' } };
  (h.app as unknown as { role: string }).role = self.role;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
  const db = createInMemorySupabase();
  h.db = db;
  h.queries = []; h.answered = {}; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  db.seed('medications', [{ id: 'med-kid', family_id: FAMILY, member_id: 'm-kid', name: 'Amoxicillin', dosage: '5 ml', instructions: null, is_active: true, refill_on: null, refill_reminder_days: 7, created_by: 'u-m-parent' }]);
  db.seed('medication_schedules', [{ id: 'sch-kid', family_id: FAMILY, medication_id: 'med-kid', time_of_day: '08:00:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-10-01', ends_on: null }]);
  // The parent already gave today's dose.
  db.seed('medication_doses', [{ id: 'dose-1', family_id: FAMILY, medication_id: 'med-kid', schedule_id: 'sch-kid', member_id: 'm-kid', scheduled_for: '2026-10-21T08:00:00.000Z', status: 'taken', taken_at: '2026-10-21T08:05:00.000Z', logged_by: 'u-m-parent', notes: null }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** The page's words once the module's own reads have answered. */
async function mounted(): Promise<string> {
  renderToStaticMarkup(createElement(MedicationsModule));
  const client = clientFor(h);
  for (const query of h.queries) {
    const { data, error } = await query.fetcher(client);
    if (error) throw new Error(`${query.table}: ${error.message}`);
    h.answered[query.table] = data ?? [];
  }
  return renderToStaticMarkup(createElement(MedicationsModule))
    .replace(/<[^>]*>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}
const has = (page: string, words: string) => page.includes(words);

describe('a caregiver on the Medicines page', () => {
  it('sees the child\'s medicine, and is told whose its doses are rather than that none is due', async () => {
    as('m-sitter');
    const page = await mounted();

    expect(has(page, 'Amoxicillin')).toBe(true);
    expect(has(page, t('medications.noDosesScheduledForToday'))).toBe(false);
    expect(has(page, NOTE())).toBe(true);
    // No adherence summary about doses this viewer is not given.
    expect(page).not.toMatch(/\d+ missed/);
    expect(page).not.toMatch(/\d+ taken/);
  });

  it('keeps their own medicine\'s doses and ring, with the note beside them', async () => {
    as('m-sitter');
    const db = h.db as InMemorySupabase;
    db.seed('medications', [{ id: 'med-own', family_id: FAMILY, member_id: 'm-sitter', name: 'Cetirizine', dosage: null, instructions: null, is_active: true, refill_on: null, refill_reminder_days: 7, created_by: 'u-m-parent' }]);
    db.seed('medication_schedules', [{ id: 'sch-own', family_id: FAMILY, medication_id: 'med-own', time_of_day: '09:00:00', days_of_week: [0, 1, 2, 3, 4, 5, 6], starts_on: '2026-10-01', ends_on: null }]);
    const page = await mounted();

    expect(has(page, '09:00')).toBe(true);
    expect(has(page, NOTE())).toBe(true);
    expect(page).toMatch(/0 missed/);
  });
});

describe('control: a parent', () => {
  it('reads every dose, sees the given dose and the adherence, and no caregiver note', async () => {
    as('m-parent');
    const page = await mounted();

    expect(has(page, '08:00')).toBe(true);
    expect(page).toMatch(/1 taken/);
    expect(has(page, NOTE())).toBe(false);
    expect(has(page, t('medications.noDosesScheduledForToday'))).toBe(false);
  });
});
