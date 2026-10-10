// The three server-action files no test named (SRV-001 / COVERAGE-001's census
// on main 36a516d7c: 131 'use server' files, these three named by none), driven
// through the action itself rather than only the service under it:
//
//  - dashboard/knowledge/actions.ts — the census's hand-checked high lead, "a
//    child can overwrite a sibling's memory" by re-typing its label. Closed by
//    `mayChangeFact` in `rememberConfirmed`; pinned here at the door a child
//    actually uses.
//  - dashboard/agents/actions.ts — resolves only the two statuses the roster
//    offers, only in the caller's family, and says so when nothing matched.
//  - dashboard/vacations/[id]/actions.ts — a reported delay tells the family
//    once; a duplicate report is refused and tells nobody again (see
//    tests/a-reported-flight-delay-moves-the-plans-once.test.ts for the rows).
//
// In-memory tables; ids synthetic; nothing leaves the process.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { at } from './helpers/source-order';

const env = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent' as string,
  memberId: 'mem-parent',
  userId: 'user-parent',
  notified: [] as { title: string; relatedId: string }[],
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: env.userId },
    active: { familyId: 'fam-1', role: env.role, member: { id: env.memberId }, family: { name: 'Synthetic family', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => env.db }));
vi.mock('@/lib/services/notifications', () => ({
  notify: async (_scope: unknown, input: { title: string; relatedId: string }) => {
    env.notified.push({ title: input.title, relatedId: input.relatedId });
    return { ok: true, data: { created: 2 } };
  },
}));

const { saveFactAction } = await import('@/app/(app)/dashboard/knowledge/actions');
const { resolveActivityAction } = await import('@/app/(app)/dashboard/agents/actions');
const { reportDisruptionAction } = await import('@/app/(app)/dashboard/vacations/[id]/actions');

const DAY = '2026-07-14';

function seed() {
  const db = createInMemorySupabase({
    defaults: {
      vacation_itinerary_items: { booked: false, sort_order: 0, member_ids: [], notes: null },
      vacation_itinerary_days: { title: null, summary: null },
    },
  });
  db.seed('family_facts', [{
    id: 'fact-household', family_id: 'fam-1', member_id: null, category: 'contact', label: 'Emergency contact',
    value: 'Grandma 555-0100', notes: null, is_pinned: false, source: 'user', created_by: 'user-parent', expires_at: null,
  }]);
  db.seed('agent_activity', [
    { id: 'act-1', family_id: 'fam-1', status: 'active', title: 'Drafted the grocery list' },
    { id: 'act-other', family_id: 'fam-2', status: 'active', title: 'Another family' },
  ]);
  db.seed('vacations', [{
    id: 'trip-1', family_id: 'fam-1', title: 'Barcelona', destination: 'Barcelona', kind: 'flight', status: 'booked',
    start_date: DAY, end_date: '2026-07-20', timezone: 'UTC', is_international: true,
  }]);
  db.seed('vacation_flights', [{
    id: 'flight-1', family_id: 'fam-1', vacation_id: 'trip-1', airline: 'BA', flight_number: '274',
    depart_airport: 'LHR', arrive_airport: 'BCN', depart_at: `${DAY}T11:00:00Z`, arrive_at: `${DAY}T14:00:00Z`, booked: true,
  }]);
  db.seed('vacation_itinerary_days', [{ id: 'day-1', family_id: 'fam-1', vacation_id: 'trip-1', day_date: DAY }]);
  db.seed('vacation_itinerary_items', [
    { id: 'item-tour', family_id: 'fam-1', vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'evening', title: 'Sagrada Familia', start_time: '16:00', end_time: '18:00', booked: true, sort_order: 1 },
  ]);
  return db;
}

let db = seed();
beforeEach(() => {
  db = seed();
  env.db = db;
  env.role = 'parent'; env.memberId = 'mem-parent'; env.userId = 'user-parent';
  env.notified = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const rows = (table: string) => db.table(table) as Record<string, unknown>[];

describe('knowledge: saveFactAction', () => {
  it('refuses a child re-typing the label of a household fact a parent wrote, and leaves it as it was', async () => {
    env.role = 'child'; env.memberId = 'mem-child'; env.userId = 'user-child';
    const res = await saveFactAction(null, { label: 'Emergency contact', value: 'Call me instead' });
    expect(res.ok).toBe(false);
    expect(rows('family_facts').find((r) => r.id === 'fact-household')!.value).toBe('Grandma 555-0100');
  });

  it('lets a parent restate it (control)', async () => {
    const res = await saveFactAction(null, { label: 'Emergency contact', value: 'Grandpa 555-0199' });
    expect(res).toEqual({ ok: true, id: 'fact-household' });
    expect(rows('family_facts').find((r) => r.id === 'fact-household')!.value).toBe('Grandpa 555-0199');
  });
});

describe('agents: resolveActivityAction', () => {
  it('stores only a status the roster offers, whatever the caller sends', async () => {
    const res = await resolveActivityAction('act-1', 'active' as unknown as 'done');
    expect(res).toEqual({ ok: true });
    expect(rows('agent_activity').find((r) => r.id === 'act-1')!.status).toBe('dismissed');
  });

  it('says it changed nothing for another family\'s entry, and changes nothing', async () => {
    const res = await resolveActivityAction('act-other', 'done');
    expect(res.ok).toBe(false);
    expect(rows('agent_activity').find((r) => r.id === 'act-other')!.status).toBe('active');
  });
});

describe('vacations: reportDisruptionAction', () => {
  const report = () => reportDisruptionAction({ vacationId: 'trip-1', kind: 'flight', bookingId: 'flight-1', outcome: 'delayed', delayMinutes: 120 });

  it('refuses a delay that is not a positive number of minutes before touching anything', async () => {
    const res = await reportDisruptionAction({ vacationId: 'trip-1', kind: 'flight', bookingId: 'flight-1', outcome: 'delayed', delayMinutes: 0 });
    expect(res).toEqual({ ok: false, error: 'vacationDisruption.enterADelayInMinutes' });
    expect(rows('vacation_itinerary_items').find((r) => r.id === 'item-tour')!.start_time).toBe('16:00');
  });

  it('tells the family once when the same delay is reported twice at once', async () => {
    const [a, b] = await Promise.all([report(), report()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(env.notified).toEqual([{ title: 'Travel update: BA 274', relatedId: 'trip-1' }]);
    expect(rows('vacation_itinerary_items').find((r) => r.id === 'item-tour')!.start_time).toBe('18:00');
  });

  it('clears the booking choice after a report, so pressing the button again is not a second delay', () => {
    const form = readFileSync('app/(app)/dashboard/vacations/[id]/travel/disruption-form.tsx', 'utf8');
    const success = form.slice(at(form, 'if (res.ok) {'));
    expect(at(success, "setChoice('');")).toBeLessThan(at(success, 'setIssue(res.error);'));
  });
});
