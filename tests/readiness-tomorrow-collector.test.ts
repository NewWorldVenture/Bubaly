import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { CalendarReadinessEvent } from '@/lib/readiness/calendar-source';
import { assessReadiness, EMPTY_READINESS_SIGNALS } from '@/lib/readiness/assess';
import { collectTomorrowReadiness, type TomorrowReadiness } from '@/lib/readiness/collect-tomorrow';

vi.mock('server-only', () => ({}));

type Table = 'calendar_events' | 'meal_plans';
type Filter = { method: 'eq' | 'gte' | 'lt'; key: string; value: unknown };
type Query = {
  table: Table;
  selection?: string;
  options?: { count?: string; head?: boolean };
  filters: Filter[];
};
type Outcome = {
  count?: number | null;
  error?: unknown;
  nullData?: boolean;
  rowLimit?: number;
  reject?: boolean;
};
type Event = CalendarReadinessEvent & { family_id: string };
type Meal = { family_id: string; plan_date: string; meal_type: string };
type Result = { data: Record<string, unknown>[] | null; count: number | null; error: unknown };

const NOW = new Date('2026-09-06T12:00:00.000Z');
const event = (
  id: string,
  starts_at: string,
  family_id = 'family-1',
  assignee_id: string | null = null,
): Event => ({ id, starts_at, ends_at: null, all_day: false, assignee_id, family_id });
const dinner = (plan_date = '2026-09-07', family_id = 'family-1'): Meal => ({
  family_id, plan_date, meal_type: 'dinner',
});

/**
 * A bounded query fake that applies the recorded family/date filters. It
 * exercises collection semantics, not Supabase RLS or live database behavior.
 */
function harness({
  events = [],
  meals = [],
  outcomes = {},
}: {
  events?: Event[];
  meals?: Meal[];
  outcomes?: Partial<Record<Table, Outcome>>;
} = {}) {
  const queries: Query[] = [];
  const from = (table: Table) => {
    const record: Query = { table, filters: [] };
    queries.push(record);
    const query: Record<string, unknown> = {};
    Object.assign(query, {
      select: (selection: string, options?: Query['options']) => {
        record.selection = selection;
        record.options = options;
        return query;
      },
      order: () => query,
      then: (
        resolve: (value: Result) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => {
        const outcome = outcomes[table] ?? {};
        if (outcome.reject) return Promise.reject(new Error('Read unavailable')).then(resolve, reject);
        const source: Record<string, unknown>[] = table === 'calendar_events' ? events : meals;
        const visible = source.filter((row) => record.filters.every((filter) => {
          if (filter.method === 'eq') return row[filter.key] === filter.value;
          if (filter.method === 'gte') return String(row[filter.key]) >= String(filter.value);
          return String(row[filter.key]) < String(filter.value);
        }));
        return Promise.resolve({
          data: record.options?.head || outcome.nullData
            ? null : visible.slice(0, outcome.rowLimit ?? visible.length),
          count: 'count' in outcome ? outcome.count ?? null : visible.length,
          error: outcome.error ?? null,
        }).then(resolve, reject);
      },
    });
    for (const method of ['eq', 'gte', 'lt'] as const) {
      query[method] = (key: string, value: unknown) => {
        record.filters.push({ method, key, value });
        return query;
      };
    }
    return query;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, queries };
}

const tomorrowCard = (signals: TomorrowReadiness) =>
  assessReadiness({ ...EMPTY_READINESS_SIGNALS, ...signals })[0];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Live fetch is forbidden'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('family-local tomorrow window', () => {
  it.each([
    {
      name: 'New York while UTC is already the following date',
      timezone: 'America/New_York', now: '2026-09-07T02:30:00.000Z', day: '2026-09-07',
      start: '2026-09-07T04:00:00.000Z', end: '2026-09-08T04:00:00.000Z', hours: 24,
    },
    {
      name: 'Tokyo while UTC is still the previous date',
      timezone: 'Asia/Tokyo', now: '2026-09-06T23:30:00.000Z', day: '2026-09-08',
      start: '2026-09-07T15:00:00.000Z', end: '2026-09-08T15:00:00.000Z', hours: 24,
    },
    {
      name: 'the 23-hour spring-forward day',
      timezone: 'America/New_York', now: '2026-03-07T17:00:00.000Z', day: '2026-03-08',
      start: '2026-03-08T05:00:00.000Z', end: '2026-03-09T04:00:00.000Z', hours: 23,
    },
    {
      name: 'the 25-hour fall-back day',
      timezone: 'America/New_York', now: '2026-10-31T16:00:00.000Z', day: '2026-11-01',
      start: '2026-11-01T04:00:00.000Z', end: '2026-11-02T05:00:00.000Z', hours: 25,
    },
    {
      name: 'the next calendar year',
      timezone: 'UTC', now: '2026-12-31T23:30:00.000Z', day: '2027-01-01',
      start: '2027-01-01T00:00:00.000Z', end: '2027-01-02T00:00:00.000Z', hours: 24,
    },
  ])('queries exactly $name', async ({ timezone, now, day, start, end, hours }) => {
    const { db, queries } = harness();
    await collectTomorrowReadiness(db, 'family-1', timezone, new Date(now));
    expect(queries).toHaveLength(2);
    const calendar = queries.find((query) => query.table === 'calendar_events')!;
    const meal = queries.find((query) => query.table === 'meal_plans')!;
    expect(calendar.selection).toBe('id, starts_at, ends_at, all_day, assignee_id');
    expect(calendar.options).toEqual({ count: 'exact' });
    expect(calendar.filters).toEqual([
      { method: 'eq', key: 'family_id', value: 'family-1' },
      { method: 'gte', key: 'starts_at', value: start },
      { method: 'lt', key: 'starts_at', value: end },
    ]);
    expect(meal.options).toEqual({ count: 'exact', head: true });
    expect(meal.filters).toEqual([
      { method: 'eq', key: 'family_id', value: 'family-1' },
      { method: 'eq', key: 'plan_date', value: day },
      { method: 'eq', key: 'meal_type', value: 'dinner' },
    ]);
    expect(Date.parse(end) - Date.parse(start)).toBe(hours * 3_600_000);
  });

  it('includes local midnight and the final millisecond, but not either adjacent day or another household', async () => {
    const { db } = harness({
      events: [
        event('previous', '2026-09-07T03:59:59.999Z'),
        event('first', '2026-09-07T04:00:00.000Z'),
        event('last', '2026-09-08T03:59:59.999Z'),
        event('following', '2026-09-08T04:00:00.000Z'),
        event('private', '2026-09-07T12:00:00.000Z', 'family-2'),
      ],
      meals: [
        dinner('2026-09-07', 'family-2'),
        { ...dinner(), meal_type: 'breakfast' },
        dinner('2026-09-08'),
      ],
    });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    expect(signals).toMatchObject({
      tomorrowUnassigned: 2,
      tomorrowCalendarCoverage: 'complete',
      dinnerPlannedTomorrow: false,
      coverage: { meals_tomorrow: 'complete' },
    });
    expect(JSON.stringify(signals)).not.toContain('private');
  });

  it('uses the existing missing-timezone default without requiring new page fixture data', async () => {
    const { db, queries } = harness();
    await collectTomorrowReadiness(db, 'family-1', undefined, NOW);
    expect(queries[0].filters).toContainEqual({
      method: 'gte', key: 'starts_at', value: '2026-09-07T04:00:00.000Z',
    });
  });

  it('uses UTC for an invalid timezone, matching the existing briefing convention', async () => {
    const { db, queries } = harness();
    await collectTomorrowReadiness(db, 'family-1', 'Invalid/Timezone', NOW);
    expect(queries[0].filters).toContainEqual({
      method: 'gte', key: 'starts_at', value: '2026-09-07T00:00:00.000Z',
    });
  });
});

describe('tomorrow evidence coverage', () => {
  it('allows a ready assessment only with complete calendar and dinner evidence', async () => {
    const { db } = harness({ meals: [dinner()] });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    expect(signals).toMatchObject({
      tomorrowConflicts: 0, tomorrowUnassigned: 0,
      tomorrowCalendarCoverage: 'complete', dinnerPlannedTomorrow: true,
      coverage: { meals_tomorrow: 'complete' },
    });
    expect(tomorrowCard(signals).status).toBe('ready');
  });

  it('keeps a confirmed missing dinner as an actionable gap, not an unknown read', async () => {
    const { db } = harness();
    const card = tomorrowCard(await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW));
    expect(card.status).toBe('at_risk');
    expect(card.gaps.map((gap) => gap.label)).toEqual(["Tomorrow's dinner isn't planned"]);
  });

  it.each(['calendar_events', 'meal_plans'] as const)('keeps a returned %s error unknown despite other successful reads', async (table) => {
    const { db } = harness({ meals: [dinner()], outcomes: { [table]: { error: new Error('Unavailable') } } });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    const card = tomorrowCard(signals);
    expect(card.status).not.toBe('ready');
    expect(card.gaps.some((gap) => gap.label.includes('could not be read'))).toBe(true);
    if (table === 'calendar_events') {
      expect(signals.tomorrowCalendarCoverage).toBe('unknown');
      expect(signals.tomorrowConflicts).toBeNull();
      expect(signals.tomorrowUnassigned).toBeNull();
      expect(card.ready.map((check) => check.label)).not.toContain('Calendar is clear');
      expect(signals.coverage.meals_tomorrow).toBe('complete');
    } else {
      expect(signals.coverage.meals_tomorrow).toBe('unknown');
      expect(card.ready.map((check) => check.label)).not.toContain("Tomorrow's dinner is planned");
      expect(signals.tomorrowCalendarCoverage).toBe('complete');
    }
  });

  it.each(['calendar_events', 'meal_plans'] as const)('keeps a rejected %s query unknown without losing the other source', async (table) => {
    const { db } = harness({ meals: [dinner()], outcomes: { [table]: { reject: true } } });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    expect(tomorrowCard(signals).status).not.toBe('ready');
    if (table === 'calendar_events') {
      expect(signals.tomorrowCalendarCoverage).toBe('unknown');
      expect(signals.coverage.meals_tomorrow).toBe('complete');
    } else {
      expect(signals.coverage.meals_tomorrow).toBe('unknown');
      expect(signals.tomorrowCalendarCoverage).toBe('complete');
    }
  });

  it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 1])('does not certify an empty calendar with invalid or mismatched count %s', async (count) => {
    const { db } = harness({ meals: [dinner()], outcomes: { calendar_events: { count } } });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    expect(signals.tomorrowCalendarCoverage).toBe('partial');
    expect(tomorrowCard(signals).status).not.toBe('ready');
    expect(tomorrowCard(signals).ready.map((check) => check.label)).not.toContain('Calendar is clear');
  });

  it.each([null, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])('keeps an invalid dinner count %s unknown', async (count) => {
    const { db } = harness({ outcomes: { meal_plans: { count } } });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    expect(signals.coverage.meals_tomorrow).toBe('unknown');
    const card = tomorrowCard(signals);
    expect(card.status).not.toBe('ready');
    expect(card.gaps.map((gap) => gap.label)).toContain("Tomorrow's meal plan could not be read");
    expect(card.gaps.map((gap) => gap.label)).not.toContain("Tomorrow's dinner isn't planned");
  });

  it('keeps absent calendar rows unknown even when the count claims zero', async () => {
    const { db } = harness({ meals: [dinner()], outcomes: { calendar_events: { nullData: true, count: 0 } } });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    expect(signals.tomorrowCalendarCoverage).toBe('unknown');
    expect(signals.tomorrowConflicts).toBeNull();
    expect(tomorrowCard(signals).status).not.toBe('ready');
  });

  it('retains observed conflicts as a lower bound when accessible rows are truncated', async () => {
    const { db } = harness({
      meals: [dinner()],
      events: [
        event('one', '2026-09-07T12:00:00.000Z', 'family-1', 'member-1'),
        event('two', '2026-09-07T12:30:00.000Z', 'family-1', 'member-1'),
        event('three', '2026-09-07T18:00:00.000Z', 'family-1', 'member-1'),
      ],
      outcomes: { calendar_events: { rowLimit: 2 } },
    });
    const signals = await collectTomorrowReadiness(db, 'family-1', 'America/New_York', NOW);
    expect(signals.tomorrowCalendarCoverage).toBe('partial');
    expect(signals.tomorrowConflicts).toBe(1);
    const card = tomorrowCard(signals);
    expect(card.status).toBe('not_ready');
    expect(card.gaps.map((gap) => gap.label)).toContain('At least 1 schedule clash tomorrow');
    expect(card.ready.map((check) => check.label)).not.toContain('Everything has an owner');
  });
});
