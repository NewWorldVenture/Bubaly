// `refreshPlaybookAction` mines five family-scoped tables and then WRITES what
// it concluded into family_playbook_suggestions. Every one of those reads can
// come back `{ data: null, error }` (PostgREST resolves, it does not throw), and
// `readAll` has a third answer the plain client does not: rows that are a PREFIX
// of the set, carrying the ceiling error at lib/supabase/read-all.ts:107-116.
//
// Dropping any of them turns a read that FAILED into a read that found nothing,
// and the action publishes that as a verdict: "No new patterns yet — check back
// after more activity" (components/modules/playbook-module.tsx:65). A family
// whose calendar has crossed the 4,000-row ceiling is told their household has
// no traditions, when what actually happened is that Bubaly read part of their
// calendar.
//
// The guard is the one the file's own WRITE already has (`if (error) return
// { ok: false, error: error.message }`) and the one the sibling importer
// app/(app)/dashboard/migrate/actions.ts:106-126 applies to exactly this
// `readAll` shape. Read the error, FAIL CLOSED, learn nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
  getTranslations: async () => (key: string) => key,
}));

const { refreshPlaybookAction } = await import('@/app/(app)/dashboard/playbook/playbook-actions');

type Row = Record<string, unknown>;
type TableReply = { rows?: Row[]; error?: { code: string; message: string } | null };

let tables: Record<string, TableReply>;
let upserts: { rows: Row[]; options: unknown }[];

/**
 * A PostgREST-shaped builder: every filter returns itself, `range` narrows the
 * slice `readAll` pages through, and awaiting it resolves `{ data, error }` —
 * never rejects, exactly like the real client.
 */
function from(table: string) {
  let from_ = 0;
  let to = Number.MAX_SAFE_INTEGER;
  const query: Record<string, unknown> = {};
  const self = () => query;
  Object.assign(query, {
    select: self, eq: self, gte: self, lte: self, in: self, order: self, limit: self,
    range: (a: number, b: number) => { from_ = a; to = b; return query; },
    upsert: async (rows: Row[], options: unknown) => {
      upserts.push({ rows, options });
      return { data: null, error: null };
    },
    then: (resolve: (r: { data: Row[] | null; error: unknown; count: null }) => unknown) => {
      const reply = tables[table] ?? { rows: [] };
      if (reply.error) return resolve({ data: null, error: reply.error, count: null });
      return resolve({ data: (reply.rows ?? []).slice(from_, to === Number.MAX_SAFE_INTEGER ? undefined : to + 1), count: null, error: null });
    },
  });
  return query;
}

/** 12 taco dinners on the plan — comfortably over the `meal` threshold of 3. */
const TACO_PLANS: Row[] = Array.from({ length: 12 }, () => ({ meal_id: 'meal-taco' }));
const TACO_MEALS: Row[] = [{ id: 'meal-taco', name: 'Taco night' }];

/**
 * A calendar that has crossed readAll's 4,000-row ceiling — 4,400 unique
 * synced events, and only THEN the three Christmas Eve Dinners that prove the
 * tradition. The prefix contains no tradition; the whole table does.
 */
function calendarPastTheCeiling(): Row[] {
  const filler: Row[] = Array.from({ length: 4_400 }, (_, i) => ({
    title: `Synced event ${i}`, starts_at: `2025-01-01T09:00:00.000Z`, recurrence: null,
  }));
  const tradition: Row[] = ['2023', '2024', '2025'].map((y) => ({
    title: 'Christmas Eve Dinner', starts_at: `${y}-12-24T18:00:00.000Z`, recurrence: null,
  }));
  return [...filler, ...tradition];
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  upserts = [];
  tables = {
    meal_plans: { rows: TACO_PLANS },
    meals: { rows: TACO_MEALS },
    grocery_items: { rows: [] },
    family_favorites: { rows: [] },
    calendar_events: { rows: [] },
    vacations: { rows: [] },
  };
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'fam-1' } });
  mocks.createServer.mockResolvedValue({ from });
});

describe('learning the family playbook from a read that did not finish', () => {
  it('refuses to conclude anything when the calendar came back as a PREFIX', async () => {
    tables.calendar_events = { rows: calendarPastTheCeiling() };

    const result = await refreshPlaybookAction();

    // The whole point: the family is NOT told what their household looks like
    // on the strength of the first 4,000 rows of it.
    expect(result.ok, 'a conclusion drawn from a prefix is not ok').toBe(false);
    expect(result.error, 'the caller is told the rows were a prefix').toContain('PREFIX');
    expect(upserts, 'nothing is written from a truncated read').toEqual([]);
  });

  it('writes nothing when the meal-plan read is refused', async () => {
    tables.meal_plans = { error: { code: '57014', message: 'canceling statement due to statement timeout' } };

    const result = await refreshPlaybookAction();

    expect(result).toMatchObject({ ok: false, error: 'canceling statement due to statement timeout' });
    expect(upserts).toEqual([]);
  });

  it.each([
    ['meals', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['grocery_items', { code: 'PGRST301', message: 'JWT expired' }],
    ['family_favorites', { code: '08006', message: 'connection failure' }],
    ['calendar_events', { code: '57014', message: 'canceling statement due to statement timeout' }],
    ['vacations', { code: '42501', message: 'permission denied for table vacations' }],
  ])('writes nothing when the %s read is refused', async (table, error) => {
    tables[table] = { error };

    const result = await refreshPlaybookAction();

    expect(result.ok, `a refused ${table} read must not become an empty ${table}`).toBe(false);
    expect(result.error).toBe(error.message);
    expect(upserts).toEqual([]);
  });

  it('still learns, and still writes, when every read succeeds', async () => {
    tables.calendar_events = {
      rows: ['2023', '2024', '2025'].map((y) => ({
        title: 'Christmas Eve Dinner', starts_at: `${y}-12-24T18:00:00.000Z`, recurrence: null,
      })),
    };

    const result = await refreshPlaybookAction();

    expect(result).toEqual({ ok: true, added: 2 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].rows.map((r) => r.signature).sort())
      .toEqual(['meal:taco-night', 'tradition:christmas-eve-dinner']);
  });

  it('treats a family with nothing on record as empty, not as a failure', async () => {
    tables.meal_plans = { rows: [] };
    tables.meals = { rows: [] };

    const result = await refreshPlaybookAction();

    expect(result).toEqual({ ok: true, added: 0 });
    expect(upserts).toEqual([]);
  });
});
