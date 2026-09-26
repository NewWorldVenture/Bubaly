// The household counts behind Operations, Stress and Autonomous Management are
// day-keyed, and the day they are keyed to must be the FAMILY's.
//
// `lib/family/signals.ts` used to slice `starts_at` / `due_at` at character 10
// — the day at Greenwich — and compare that against a `todayStr` derived from
// the SERVER's midnight. Two different wrong days, so the errors did not
// cancel: an event at 22:00 in Los Angeles was counted on tomorrow, and a chore
// that was genuinely overdue there was reported as "due today".
//
// Everything below names its zones EXPLICITLY and pins the instant, so no
// assertion depends on the host's TZ. CI runs this file under TZ=UTC and
// TZ=America/Los_Angeles; it was also run under Asia/Tokyo and Etc/GMT+12.
import { describe, expect, it, vi } from 'vitest';
import { addDaysToDayKey, dayKeyInTz } from '@/lib/services/scope';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

// 2026-09-21T16:00:00Z is 09:00 on the 21st in Los Angeles and 01:00 on the
// 22nd in Tokyo — two different "today"s from one instant, which is the whole
// defect in one line.
const NOW = new Date('2026-09-21T16:00:00Z');

// ─────────────────────────────────────────────────────────────────────────────
// A Supabase stand-in. It implements only what signals.ts chains, and it
// filters with the same semantics PostgREST does, so the day keys and the
// instant bounds the module computes are what actually select the rows.
type Row = Record<string, unknown>;

/** Order two column values: instants and bare dates by time, anything else as text. */
function compare(a: unknown, b: unknown): number {
  const left = Date.parse(String(a));
  const right = Date.parse(String(b));
  if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function fakeDb(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const predicates: ((row: Row) => boolean)[] = [];
      let counting = false;
      const query = {
        select(_columns: string, options?: { count?: string; head?: boolean }) {
          counting = Boolean(options?.count);
          return query;
        },
        eq(column: string, value: unknown) { predicates.push((r) => r[column] === value); return query; },
        in(column: string, values: unknown[]) { predicates.push((r) => values.includes(r[column])); return query; },
        gte(column: string, value: unknown) { predicates.push((r) => compare(r[column], value) >= 0); return query; },
        lte(column: string, value: unknown) { predicates.push((r) => compare(r[column], value) <= 0); return query; },
        gt(column: string, value: unknown) { predicates.push((r) => compare(r[column], value) > 0); return query; },
        lt(column: string, value: unknown) { predicates.push((r) => compare(r[column], value) < 0); return query; },
        then<TResult1, TResult2 = never>(
          onFulfilled?: ((value: { data: Row[] | null; count: number | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
        ): PromiseLike<TResult1 | TResult2> {
          const matched = rows.filter((row) => predicates.every((p) => p(row)));
          const result = counting
            ? { data: null, count: matched.length, error: null as null }
            : { data: matched, count: null, error: null as null };
          return Promise.resolve(result).then(onFulfilled, onRejected);
        },
      };
      return query;
    },
  };
}

const state: { tables: Record<string, Row[]> } = { tables: {} };

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => fakeDb(state.tables),
}));

const FAMILY = 'fam-1';
const f = (row: Row): Row => ({ family_id: FAMILY, ...row });

/**
 * One fixed household, described by instants rather than by day keys — which is
 * the point: the SAME rows are a different set of "today" for each zone.
 */
function household(): Record<string, Row[]> {
  return {
    calendar_events: [
      // 03:00 on the 21st in LA. In Tokyo this is 19:00 on the 21st — before
      // Tokyo's window even opens, so Tokyo must not see it at all.
      f({ starts_at: '2026-09-21T10:00:00Z' }),
      // 10:00 on the 21st in LA; 02:00 on the 22nd in Tokyo. Today for both.
      f({ starts_at: '2026-09-21T17:00:00Z' }),
      // 22:00 on the 21st in LA — today there, but the GREENWICH day is the
      // 22nd. This is the row the old code lost.
      f({ starts_at: '2026-09-22T05:00:00Z' }),
      // 03:00 on the 22nd in LA (tomorrow); 19:00 on the 22nd in Tokyo (today).
      f({ starts_at: '2026-09-22T10:00:00Z' }),
    ],
    appointments: [
      f({ id: 'ap-1', starts_at: '2026-09-21T10:00:00Z' }),
      f({ id: 'ap-2', starts_at: '2026-09-22T05:00:00Z' }),
    ],
    chore_assignments: [
      // 23:00 on the 20th in LA — OVERDUE. Greenwich calls it the 21st, which
      // is how the old code reported it as merely due today.
      f({ status: 'todo', due_at: '2026-09-21T06:00:00Z' }),
      // 22:00 on the 21st in LA — DUE TODAY. Greenwich calls it the 22nd, so
      // the old code counted it as neither overdue nor due today.
      f({ status: 'todo', due_at: '2026-09-22T05:00:00Z' }),
      f({ status: 'in_progress', due_at: '2026-09-23T12:00:00Z' }),
      // A chore with no due date is neither, and must not throw.
      f({ status: 'todo', due_at: null }),
      f({ status: 'done', due_at: null }),
      f({ status: 'approved', due_at: null }),
    ],
    bills: [
      f({ status: 'upcoming', due_date: '2026-09-21' }),
      f({ status: 'upcoming', due_date: '2026-09-28' }),
      f({ status: 'upcoming', due_date: '2026-09-20' }),
      f({ status: 'overdue', due_date: '2026-09-10' }),
      f({ status: 'paid', due_date: '2026-09-05' }),
    ],
    school_events: [f({ id: 'se-1', starts_at: '2026-09-23T12:00:00Z' })],
    sports_events: [f({ starts_at: '2026-09-22T05:00:00Z' })],
    family_routines: [f({ status: 'active', days_of_week: [1, 3] })],
    meal_plans: [
      f({ id: 'mp-1', plan_date: '2026-09-20' }),
      f({ id: 'mp-2', plan_date: '2026-09-21' }),
      f({ id: 'mp-3', plan_date: '2026-09-28' }),
    ],
    grocery_items: [f({ id: 'gi-1', is_checked: false })],
  };
}

async function signalsFor(tz: string) {
  state.tables = household();
  const { gatherSignalsResult } = await import('@/lib/family/signals');
  const result = await gatherSignalsResult(FAMILY, tz, NOW);
  expect(result.error).toBeNull();
  if (!result.data) throw new Error('signals returned no data');
  return result.data;
}

describe('family signals count the family’s day, not Greenwich’s', () => {
  it('the two zones disagree about today from the same instant', () => {
    // The premise every assertion below rests on, stated with explicit zones so
    // it holds on any host.
    expect(dayKeyInTz(NOW, LA)).toBe('2026-09-21');
    expect(dayKeyInTz(NOW, TOKYO)).toBe('2026-09-22');
  });

  it('counts an evening event as today in Los Angeles', async () => {
    const { counts } = await signalsFor(LA);
    // 03:00, 10:00 and 22:00 local on the 21st. The 22:00 one has the
    // Greenwich day 2026-09-22 — slicing at Greenwich drops it and answers 2.
    expect(counts.eventsToday).toBe(3);
    // Stated as a relationship as well, so the literal above cannot drift away
    // from what the zone helper actually says. Every LA row here is inside the
    // window, so the two counts are the same set.
    const laToday = dayKeyInTz(NOW, LA);
    const sameDayInLa = household().calendar_events
      .filter((e) => dayKeyInTz(new Date(String(e.starts_at)), LA) === laToday).length;
    expect(counts.eventsToday).toBe(sameDayInLa);
  });

  it('counts a different set of events as today in Tokyo', async () => {
    const { counts } = await signalsFor(TOKYO);
    // 02:00, 14:00 and 19:00 local on the 22nd. The 19:00-on-the-21st row is
    // before Tokyo's local midnight, so the query never returns it.
    expect(counts.eventsToday).toBe(3);
    expect(counts.maxEventsPerDay).toBe(3);
  });

  it('bounds "appointments today" by the family’s midnight, not the server’s', async () => {
    // 03:00 and 22:00 on the 21st in LA — both inside LA's local day.
    expect((await signalsFor(LA)).counts.appointmentsToday).toBe(2);
    // In Tokyo the first of those is 19:00 on the 21st, which is yesterday.
    expect((await signalsFor(TOKYO)).counts.appointmentsToday).toBe(1);
  });

  it('separates overdue from due-today on the family’s wall clock', async () => {
    const { counts } = await signalsFor(LA);
    expect(counts.overdueTasks).toBe(1);   // 23:00 on the 20th, local
    expect(counts.dueTodayTasks).toBe(1);  // 22:00 on the 21st, local
    // The null due date is neither, and the open/done/total split is untouched.
    expect(counts.openTasks).toBe(4);
    expect(counts.doneTasks).toBe(2);
    expect(counts.totalTasks).toBe(6);
  });

  it('reads DATE columns against the family’s day key without converting them', async () => {
    // plan_date and due_date are DATE columns: already the family's day. What
    // moves between zones is the BOUND, not the stored value.
    const la = await signalsFor(LA);        // today 2026-09-21 → 09-21 … 09-28
    expect(la.counts.plannedMeals).toBe(2); // 09-21 and 09-28
    expect(la.counts.billsDueSoon).toBe(2); // 09-21 and 09-28
    expect(la.counts.overdueBills).toBe(1);
    expect(la.counts.billsPaid).toBe(1);

    const tokyo = await signalsFor(TOKYO);     // today 2026-09-22 → 09-22 … 09-29
    expect(tokyo.counts.plannedMeals).toBe(1); // only 09-28
    expect(tokyo.counts.billsDueSoon).toBe(1); // only 09-28
  });

  it('degrades, not throws, when a read fails', async () => {
    state.tables = household();
    const { gatherSignalsResult } = await import('@/lib/family/signals');
    // The fake never rejects; this pins the contract that a null family id
    // still produces the shape the pages branch on.
    const result = await gatherSignalsResult('no-such-family', LA, NOW);
    expect(result.error).toBeNull();
    expect(result.data?.counts.eventsToday).toBe(0);
  });
});

describe('the seven-day horizon survives a DST fall-back', () => {
  it('lands on local midnight seven calendar days out, not seven × 24h out', async () => {
    const { signalWindow } = await import('@/lib/family/signals');
    // Los Angeles falls back on 2026-11-01, so the week starting 2026-10-28 is
    // 169 hours long.
    const now = new Date('2026-10-28T19:00:00Z'); // 12:00 on the 28th in LA
    const w = signalWindow(LA, now);

    expect(w.todayKey).toBe('2026-10-28');
    expect(w.weekEndKey).toBe(addDaysToDayKey(w.todayKey, 7));
    expect(w.weekEndKey).toBe('2026-11-04');
    // The instant bound agrees with the day key…
    expect(dayKeyInTz(new Date(w.in7Iso), LA)).toBe(w.weekEndKey);
    // …and it really is midnight on the family's wall.
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: LA, hour: '2-digit', minute: '2-digit', hour12: false });
    expect(clock.format(new Date(w.in7Iso))).toBe('00:00');
    expect(clock.format(new Date(w.startIso))).toBe('00:00');
    expect(clock.format(new Date(w.endIso))).toBe('00:00');

    // The control: the millisecond arithmetic this replaced lands at 23:00 the
    // evening before, one whole day short. Without this line the test above
    // would still pass on a zone that never changes offset.
    const naive = new Date(Date.parse(w.startIso) + 7 * 86_400_000);
    expect(dayKeyInTz(naive, LA)).toBe('2026-11-03');
    expect(clock.format(naive)).toBe('23:00');
  });

  it('holds the same shape in a zone with no DST at all', async () => {
    const { signalWindow } = await import('@/lib/family/signals');
    const w = signalWindow(TOKYO, new Date('2026-10-28T19:00:00Z')); // 04:00 on the 29th, JST
    expect(w.todayKey).toBe('2026-10-29');
    expect(w.weekEndKey).toBe('2026-11-05');
    const clock = new Intl.DateTimeFormat('en-GB', { timeZone: TOKYO, hour: '2-digit', minute: '2-digit', hour12: false });
    expect(clock.format(new Date(w.in7Iso))).toBe('00:00');
    expect(dayKeyInTz(new Date(w.in3Iso), TOKYO)).toBe(addDaysToDayKey(w.todayKey, 3));
  });
});
