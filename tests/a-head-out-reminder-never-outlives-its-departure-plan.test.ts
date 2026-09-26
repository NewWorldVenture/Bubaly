// A "🚗 Head out for …" reminder is only ever on the family calendar while a
// departure plan stands behind it.
//
// Smart Departure (app/(app)/dashboard/trip-intel/actions.ts) writes TWO rows
// for one plan: a calendar_events row at the leave-by time, and the
// departure_plans row that links to it through `reminder_event_id`. The link
// runs plan → event only, so a reminder whose plan is gone — or was never
// written — has nothing in the product that can find it again. It sits on every
// member's calendar and the daily notifications run turns it into a push for a
// trip nobody is taking. Three ways that happened:
//
//   1. SAVE wrote the event first and the plan second, and a refused plan
//      insert returned its error with the event still on the calendar. Refused
//      is easy: departure_plans CHECKs buffer_minutes ≤ 120 (and prep ≤ 240,
//      park ≤ 120, title ≤ 200 characters); calendar_events checks none of it,
//      and the planner's HTML `max` never runs because the modal has no <form>.
//      Typing 180 into "Arrive early" put the reminder up and failed the plan.
//
//   2. DELETE read the plan's reminder id with its error discarded, so a failed
//      read looked like "no reminder": the plan was deleted, `ok: true`, and
//      the reminder stayed. The event delete's own error was discarded too.
//
//   3. Deleting the EVENT the plan was for cascades the plan away (00981:
//      event_id … ON DELETE CASCADE) while reminder_event_id is only SET NULL.
//      That one is the database's doing, so the fix is a migration (0360),
//      checked at the bottom of this file.
//
// The fake below keeps real rows for both tables and enforces the constraints
// 00981 declares, including the two foreign-key actions, so these tests read
// the family's calendar AFTER the action — the thing the family actually sees —
// rather than which calls were issued.
import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
type DbError = { code: string; message: string };
type Outcome = { data: unknown; error: DbError | null };
type Table = 'calendar_events' | 'departure_plans';
type Op = 'select' | 'insert' | 'update' | 'delete';

const db = vi.hoisted(() => ({
  calendar_events: [] as Record<string, unknown>[],
  departure_plans: [] as Record<string, unknown>[],
  /** `table.op` → the error the next such request gets back. */
  faults: {} as Record<string, { code: string; message: string } | undefined>,
  nextId: 0,
}));

/** departure_plans' CHECKs and foreign keys, as 00981_trip_intelligence.sql declares them. */
function refusedPlan(row: Row): DbError | null {
  const within = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  const title = String(row.title ?? '');
  if (Array.from(title).length < 1 || Array.from(title).length > 200) {
    return { code: '23514', message: 'new row for relation "departure_plans" violates check constraint "departure_plans_title_check"' };
  }
  if (!within(row.prep_minutes, 0, 240) || !within(row.park_minutes, 0, 120) || !within(row.buffer_minutes, 0, 120)) {
    return { code: '23514', message: 'new row for relation "departure_plans" violates check constraint "departure_plans_buffer_minutes_check"' };
  }
  for (const fk of ['event_id', 'reminder_event_id'] as const) {
    if (row[fk] != null && !db.calendar_events.some((e) => e.id === row[fk])) {
      return { code: '23503', message: `insert or update on table "departure_plans" violates foreign key constraint "departure_plans_${fk}_fkey"` };
    }
  }
  return null;
}

/** calendar_events rows going away fire 00981's two actions on departure_plans. */
function onCalendarEventsDeleted(ids: unknown[]) {
  db.departure_plans = db.departure_plans.filter((p) => !ids.includes(p.event_id));        // ON DELETE CASCADE
  for (const p of db.departure_plans) if (ids.includes(p.reminder_event_id)) p.reminder_event_id = null; // ON DELETE SET NULL
}

function fakeClient() {
  return {
    from(table: Table) {
      let op: Op = 'select';
      let values: Row = {};
      const filters: [string, unknown][] = [];
      const chain: Record<string, unknown> = {};
      const matches = (r: Row) => filters.every(([col, v]) => r[col] === v);

      const run = async (): Promise<Outcome> => {
        const fault = db.faults[`${table}.${op}`];
        if (fault) return { data: null, error: fault };
        if (op === 'select') {
          const hit = db[table].find(matches);
          return { data: hit ? { ...hit } : null, error: null };
        }
        if (op === 'insert') {
          if (table === 'departure_plans') {
            const refused = refusedPlan(values);
            if (refused) return { data: null, error: refused };
          }
          const row = { id: `${table === 'calendar_events' ? 'evt' : 'plan'}-${++db.nextId}`, ...values };
          db[table].push(row);
          return { data: { id: row.id }, error: null };
        }
        if (op === 'update') {
          for (const r of db[table].filter(matches)) Object.assign(r, values);
          return { data: null, error: null };
        }
        const gone = db[table].filter(matches);
        db[table] = db[table].filter((r) => !matches(r));
        if (table === 'calendar_events') onCalendarEventsDeleted(gone.map((r) => r.id));
        return { data: null, error: null };
      };

      // `.insert(…).select('id')` keeps the insert: only a bare select reads.
      chain.select = () => chain;
      chain.eq = (col: string, v: unknown) => { filters.push([col, v]); return chain; };
      chain.insert = (v: Row) => { op = 'insert'; values = v; return chain; };
      chain.update = (v: Row) => { op = 'update'; values = v; return chain; };
      chain.delete = () => { op = 'delete'; return chain; };
      chain.maybeSingle = run;
      chain.single = run;
      chain.then = (onOk: (o: Outcome) => unknown, onErr?: (e: unknown) => unknown) => run().then(onOk, onErr);
      return chain;
    },
  };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeClient() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// The REAL en-US catalogue, not `(key) => key`. An identity mock cannot tell a
// key no catalogue holds from one that does, and lib/i18n/translate.ts falls
// back to the key, so the family would read 'actions.departureMinutesOutOfRange'
// in the toast (trip-intel-module.tsx toasts `res.error` as-is). The sentences
// below are typed out, never looked up. The three keys are new with this fix
// and reach en-US.json through the catalogue merge that lands in the same
// commit; UNTIL THAT MERGE LANDS the cases that read them are red, on purpose.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => MESSAGES[key] ?? key }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtDate: () => '6:03 PM' }) }));

const { saveDeparturePlanAction, refreshDeparturePlanAction, deleteDeparturePlanAction } =
  await import('@/app/(app)/dashboard/trip-intel/actions');

const TIMEOUT: DbError = { code: '57014', message: 'canceling statement due to statement timeout' };
const SOURCE_EVENT_GONE: DbError = {
  code: '23503',
  message: 'insert or update on table "departure_plans" violates foreign key constraint "departure_plans_event_id_fkey"',
};

const MINUTES_OUT_OF_RANGE =
  'Use whole minutes: up to 240 to get ready, and up to 120 each to park & walk and to arrive early.';
const TITLE_TOO_LONG =
  "This event's name is too long to plan a departure for. Shorten it to 200 characters or fewer on the calendar, then try again.";
const REMINDER_LEFT_ON_CALENDAR =
  'The departure plan was not saved, and the “Head out” reminder we had just added could not be taken off the calendar. Please delete it from the calendar.';

/** What every member sees on the family calendar. */
const headOutReminders = () => db.calendar_events.filter((e) => String(e.title).startsWith('🚗 Head out'));

const SOCCER = { id: 'evt-soccer', family_id: 'fam-1', title: 'Soccer game', starts_at: '2026-06-26T19:00:00.000Z' };

const NEW_PLAN = {
  title: 'Soccer game',
  eventId: 'evt-soccer',
  eventStart: '2026-06-26T19:00:00.000Z',
  origin: 'Home',
  destination: 'Riverside Fields',
  prepMinutes: 30,
  parkMinutes: 10,
  bufferMinutes: 5,
  driveSeconds: 1200,
  trafficFactor: 1,
  weatherDelayMinutes: 0,
};

const LIVE = { driveSeconds: 1500, trafficFactor: 1.4, weatherDelayMinutes: 12, weatherSummary: '🌧 Rain' };

beforeEach(() => {
  db.calendar_events = [{ ...SOCCER }];
  db.departure_plans = [];
  db.faults = {};
  db.nextId = 0;
});

/** A saved plan with its reminder on the calendar, the state every delete/refresh starts from. */
async function savedPlan(): Promise<{ planId: string; reminderId: string }> {
  const saved = await saveDeparturePlanAction(NEW_PLAN);
  if (!saved.ok) throw new Error(`setup: ${saved.error}`);
  const plan = db.departure_plans[0];
  return { planId: saved.data!.id, reminderId: String(plan.reminder_event_id) };
}

// ── 1. Saving ────────────────────────────────────────────────────────────────

describe('saving a departure plan the table refuses', () => {
  it('puts nothing on the calendar when "Arrive early" is past the 120-minute limit', async () => {
    // An airport run: the parent types 180. The HTML max="120" does not stop it.
    const result = await saveDeparturePlanAction({ ...NEW_PLAN, bufferMinutes: 180 });

    expect(result.ok).toBe(false);
    expect(headOutReminders(), 'no reminder may reach the calendar for a plan that was never saved').toEqual([]);
    // And the family is told which number to change, not "some information is invalid".
    expect(result.ok === false && result.error).toBe(MINUTES_OUT_OF_RANGE);
  });

  it.each([
    ['Get ready over 240', { prepMinutes: 300 }],
    ['Park & walk over 120', { parkMinutes: 150 }],
    ['a part-minute the INTEGER column cannot hold', { parkMinutes: 12.5 }],
  ])('refuses %s before writing anything', async (_label, overrides) => {
    const result = await saveDeparturePlanAction({ ...NEW_PLAN, ...overrides });

    expect(result.ok === false && result.error).toBe(MINUTES_OUT_OF_RANGE);
    expect(headOutReminders()).toEqual([]);
  });

  it('refuses an event name the plan cannot store before writing anything', async () => {
    const result = await saveDeparturePlanAction({ ...NEW_PLAN, title: 'Tournament '.repeat(20) });

    expect(result.ok === false && result.error).toBe(TITLE_TOO_LONG);
    expect(headOutReminders()).toEqual([]);
  });

  it('counts an emoji in the name as one character, the way the database does', async () => {
    // 200 characters, 400 UTF-16 units: the table accepts it, so must we.
    const result = await saveDeparturePlanAction({ ...NEW_PLAN, title: '🥅'.repeat(200) });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
  });
});

describe('saving a departure plan whose insert fails after the reminder is written', () => {
  it('takes the reminder back off the calendar when the event was deleted while the planner was open', async () => {
    // Someone else deletes the soccer game from the calendar while this parent
    // waits on the traffic and weather lookups. The plan insert now fails its
    // event_id foreign key — after the reminder has landed.
    db.calendar_events = db.calendar_events.filter((e) => e.id !== 'evt-soccer');

    const result = await saveDeparturePlanAction(NEW_PLAN);

    expect(result.ok).toBe(false);
    expect(db.departure_plans).toEqual([]);
    expect(headOutReminders(), 'a failed save must leave no "Head out" reminder behind').toEqual([]);
  });

  it('takes the reminder back when the plan insert times out', async () => {
    db.faults['departure_plans.insert'] = TIMEOUT;

    const result = await saveDeparturePlanAction(NEW_PLAN);

    expect(result.ok).toBe(false);
    expect(headOutReminders()).toEqual([]);
  });

  it('does not stack a second reminder on the calendar when the family retries', async () => {
    db.faults['departure_plans.insert'] = TIMEOUT;
    await saveDeparturePlanAction(NEW_PLAN);
    db.faults = {};

    const retry = await saveDeparturePlanAction(NEW_PLAN);

    expect(retry.ok, retry.ok ? '' : retry.error).toBe(true);
    expect(headOutReminders(), 'one plan, one reminder').toHaveLength(1);
    expect(db.departure_plans[0].reminder_event_id).toBe(headOutReminders()[0].id);
  });

  it('says the reminder is still on the calendar when it cannot be taken back', async () => {
    db.faults['departure_plans.insert'] = SOURCE_EVENT_GONE;
    db.faults['calendar_events.delete'] = TIMEOUT;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await saveDeparturePlanAction(NEW_PLAN);

      // The one case the action cannot repair: the family must hear that a
      // reminder is up, not a message implying nothing was written.
      expect(headOutReminders()).toHaveLength(1);
      expect(result.ok === false && result.error).toBe(REMINDER_LEFT_ON_CALENDAR);
      // That message replaces the plan write's own error, so WHY the plan
      // failed must still reach the log, beside the event id someone has to
      // clean up — not only the withdraw's timeout.
      expect(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        eventId: headOutReminders()[0].id,
        planError: SOURCE_EVENT_GONE,
        withdrawError: TIMEOUT,
      }));
    } finally {
      logged.mockRestore();
    }
  });
});

// Negative control: without it, every "nothing on the calendar" above would
// also pass on an action that never writes a reminder at all.
describe('saving a departure plan the table accepts', () => {
  it('puts exactly one reminder on the calendar and links the plan to it', async () => {
    const result = await saveDeparturePlanAction({ ...NEW_PLAN, prepMinutes: 240, parkMinutes: 120, bufferMinutes: 120 });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(headOutReminders()).toHaveLength(1);
    expect(headOutReminders()[0].title).toBe('🚗 Head out for Soccer game');
    expect(db.departure_plans[0].reminder_event_id).toBe(headOutReminders()[0].id);
  });
});

// ── Refreshing a plan that had lost its reminder ─────────────────────────────

describe('refreshing a plan whose reminder had been deleted from the calendar', () => {
  it('takes back the reminder it re-created when the plan could not be re-linked', async () => {
    const { planId, reminderId } = await savedPlan();
    // Someone deletes the reminder by hand; 00981's SET NULL clears the link.
    db.calendar_events = db.calendar_events.filter((e) => e.id !== reminderId);
    onCalendarEventsDeleted([reminderId]);
    db.faults['departure_plans.update'] = TIMEOUT;

    const result = await refreshDeparturePlanAction({ id: planId, ...LIVE });

    expect(result.ok).toBe(false);
    expect(headOutReminders(), 'a reminder nothing links to would be duplicated by the next refresh').toEqual([]);
  });

  it('leaves the plan’s own reminder alone when only moving it failed to record', async () => {
    const { planId, reminderId } = await savedPlan();
    db.faults['departure_plans.update'] = TIMEOUT;

    await refreshDeparturePlanAction({ id: planId, ...LIVE });

    // That event is still the plan's — the link to it never changed.
    expect(headOutReminders().map((e) => e.id)).toEqual([reminderId]);
    expect(db.departure_plans[0].reminder_event_id).toBe(reminderId);
  });

  it('says the re-created reminder is still on the calendar, and logs why, when it cannot be taken back', async () => {
    const { planId, reminderId } = await savedPlan();
    db.calendar_events = db.calendar_events.filter((e) => e.id !== reminderId);
    onCalendarEventsDeleted([reminderId]);
    const refused: DbError = { code: '42501', message: 'permission denied for table departure_plans' };
    db.faults['departure_plans.update'] = refused;
    db.faults['calendar_events.delete'] = TIMEOUT;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await refreshDeparturePlanAction({ id: planId, ...LIVE });

      expect(headOutReminders()).toHaveLength(1);
      expect(result.ok === false && result.error).toBe(REMINDER_LEFT_ON_CALENDAR);
      expect(logged).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        eventId: headOutReminders()[0].id,
        planError: refused,
        withdrawError: TIMEOUT,
      }));
    } finally {
      logged.mockRestore();
    }
  });
});

// ── 2. Deleting ──────────────────────────────────────────────────────────────

describe('removing a departure plan when a step fails', () => {
  it('keeps the plan, and says so, when its reminder could not be looked up', async () => {
    const { planId, reminderId } = await savedPlan();
    db.faults['departure_plans.select'] = TIMEOUT;

    const result = await deleteDeparturePlanAction({ id: planId });

    // Before: the failed read looked like "no reminder", the plan was deleted,
    // the family got a green "Removed", and the reminder stayed with nothing
    // left anywhere that could take it off.
    expect(result.ok, 'a removal that could not find the reminder did not finish').toBe(false);
    expect(headOutReminders().map((e) => e.id)).toEqual([reminderId]);
    expect(db.departure_plans.map((p) => p.reminder_event_id), 'the plan — and the way to retry — must survive').toEqual([reminderId]);
  });

  it('keeps the plan, and says so, when its reminder could not be deleted', async () => {
    const { planId, reminderId } = await savedPlan();
    db.faults['calendar_events.delete'] = TIMEOUT;

    const result = await deleteDeparturePlanAction({ id: planId });

    expect(result.ok).toBe(false);
    expect(db.departure_plans.map((p) => p.reminder_event_id)).toEqual([reminderId]);
  });

  it('removes both once the lookup works again', async () => {
    const { planId } = await savedPlan();
    db.faults['departure_plans.select'] = TIMEOUT;
    await deleteDeparturePlanAction({ id: planId });
    db.faults = {};

    const retry = await deleteDeparturePlanAction({ id: planId });

    expect(retry.ok, retry.ok ? '' : retry.error).toBe(true);
    expect(db.departure_plans).toEqual([]);
    expect(headOutReminders()).toEqual([]);
  });
});

describe('removing a departure plan when nothing fails', () => {
  it('takes the plan and its reminder off together', async () => {
    const { planId } = await savedPlan();

    const result = await deleteDeparturePlanAction({ id: planId });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(db.departure_plans).toEqual([]);
    expect(headOutReminders()).toEqual([]);
    // The event the plan was FOR is the family's own; it stays.
    expect(db.calendar_events.map((e) => e.id)).toEqual(['evt-soccer']);
  });
});

// ── 3. Deleting the event the plan was for (0360) ────────────────────────────
//
// CI's vitest has no Postgres, so this half guards the migration's SHAPE — the
// parts that make the outcome true and the ways it could be quietly undone.
// The OUTCOME is proved by docs/audit/a-head-out-reminder-goes-with-its-
// departure-plan-check.sql, which CI's Database job runs against every
// migration replayed into a real Postgres: a signed-in member deletes the game
// and the reminder must be gone, with negative controls that drop the trigger
// and the family term and require the probe to see the difference. The last
// test below keeps that probe from being deleted or hollowed out unnoticed.

function migration0360(): string {
  const files = readdirSync('supabase/migrations').filter((f) => f.startsWith('0360_'));
  expect(files, 'the head-out cleanup migration must exist exactly once').toHaveLength(1);
  // Comments stripped: prose that describes the rule must not satisfy it.
  return readFileSync(`supabase/migrations/${files[0]}`, 'utf8').replace(/--[^\n]*/g, '');
}

describe('0360: a departure plan takes its head-out reminder with it, by any path', () => {
  // Read inside each test, so a missing migration fails THESE tests by name
  // instead of taking the whole file down at collection.
  let sql = '';
  let fn = '';
  beforeEach(() => {
    sql = migration0360();
    fn = sql.slice(
      sql.indexOf('create or replace function public.departure_plan_takes_its_head_out_event()'),
      sql.indexOf('$fn$;') + 5,
    );
    expect(fn.length, 'the cleanup function must be defined in 0360').toBeGreaterThan(0);
  });

  it('fires on every deleted plan row — the cascade from the source event included', () => {
    // AFTER DELETE FOR EACH ROW on departure_plans is what a cascade from
    // departure_plans.event_id fires too; a statement trigger would see no OLD
    // row, and a trigger on calendar_events could not tell a head-out event
    // from the family's own.
    expect(sql).toMatch(
      /create trigger departure_plans_take_their_head_out_event\s+after delete on public\.departure_plans\s+for each row execute function public\.departure_plan_takes_its_head_out_event\(\)/,
    );
  });

  it('deletes the plan’s own reminder, and only inside the plan’s own family', () => {
    expect(fn).toMatch(
      /delete from public\.calendar_events\s+where id = old\.reminder_event_id\s+and family_id = old\.family_id;/,
    );
  });

  it('runs as the member who deleted the row, so calendar RLS still decides', () => {
    // A definer function would delete past calendar_events_delete for anyone
    // who can delete a plan.
    expect(fn).toMatch(/security invoker/);
    expect(fn).not.toMatch(/security definer/);
  });

  it('re-applies over an existing schema without failing', () => {
    expect(sql.indexOf('drop trigger if exists departure_plans_take_their_head_out_event on public.departure_plans'))
      .toBeGreaterThan(-1);
    expect(sql.indexOf('drop trigger if exists')).toBeLessThan(sql.indexOf('create trigger'));
  });

  it('changes neither of 00981’s foreign keys', () => {
    // SET NULL on reminder_event_id is what lets a plan survive its reminder
    // being deleted by hand; the fix must not trade one orphan for another.
    expect(sql).not.toMatch(/alter table[^;]*departure_plans/i);
    expect(sql).not.toMatch(/\bconstraint\b/i);
  });

  it('is proved on a real database by a probe that deletes the game as a member', () => {
    // Comments stripped, as above: the probe's header describing a scenario
    // must not stand in for the statement that runs it.
    const probe = readFileSync('docs/audit/a-head-out-reminder-goes-with-its-departure-plan-check.sql', 'utf8')
      .replace(/--[^\n]*/g, '');
    const asMember = probe.indexOf("perform set_config('role','authenticated', true);");
    const deletesTheGame = probe.indexOf('delete from public.calendar_events where id = g1;');
    expect(asMember, 'the probe must act as a signed-in member, where RLS applies').toBeGreaterThan(-1);
    expect(deletesTheGame, 'the probe must delete the event the plan was for').toBeGreaterThan(asMember);
    expect(probe).toMatch(/select count\(\*\) into n from public\.calendar_events where id = h1;\s+if n <> 0 then/);
    // Its negative control: with the trigger gone the reminder must survive.
    expect(probe).toContain('drop trigger if exists departure_plans_take_their_head_out_event on public.departure_plans;');
    expect(probe).toMatch(/raise exception/);
    expect(probe.trimEnd().endsWith('rollback;'), 'the probe must leave the replayed database as it found it').toBe(true);
  });
});
