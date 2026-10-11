// A work item whose landing stalls on every tick does not hold the Guardian
// recovery tick: it is cut off, counted as tried, and passed, and the newer
// owed escalations and the records already on file still get their turn.
//
// The retry sweep (lib/guardian/escalation-retry.ts) first lands the records
// that escalations left owed (lib/guardian/escalation-owed.ts), least-tried
// first, then oldest, and then re-attempts the records on file. The landing
// phase shared the run's whole deadline, with no part of its own, and a
// landing cut off by that deadline was not counted as tried. So one owed item
// whose record insert never answered — on every tick — took the whole run: it
// was cut off at the deadline, not counted, and read first again on the next
// tick at the same count. A newer owed escalation behind it was never landed,
// and the records already on file were never re-attempted (their read ran on
// the expired deadline). Every tick answered 503 at its deadline, for as long
// as the item stayed in the window: a day.
//
// Driven here through the real cron route, the real retry sweep and the real
// landing, over a PostgREST fixture that keeps its rows from tick to tick, on a
// fake clock. Only the escalation's own sends are stood in for.
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';

const seam = vi.hoisted(() => ({ client: null as unknown, drain: vi.fn(), escalate: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.client }));
vi.mock('@/lib/guardian/sms-recovery', () => ({ drainGuardianSmsReceipts: seam.drain }));
vi.mock('@/lib/guardian/escalate', async (original) => ({
  ...await original<typeof import('@/lib/guardian/escalate')>(),
  escalateGuardianEmergency: seam.escalate,
}));

const T0 = Date.parse('2026-10-11T12:00:00.000Z');
const MIN = 60_000;
const FAM = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const OWED_ID = (n: number) => `20000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const RECORD_ID = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const MANAGER = '30000000-0000-4000-8000-000000000001';
/** The family whose owed record the database never answers for. */
const STALLED = FAM(1);
/** A family whose only number Twilio refuses, every time: retry work on every tick. */
const REFUSED = FAM(12);
type Row = Record<string, unknown>;

/** The rows, kept from tick to tick, and what each tick asked of them. */
type World = {
  owed: Row[];
  records: Row[];
  settings: Map<string, unknown>;
  /** The family of every landing insert, in the order they were sent. */
  landings: string[];
};
let world: World;
/** How long the database takes over the close of a work item, and over the count of one that failed. Zero unless a case asks. */
const slow = { closeMs: 0, countMs: 0 };
/** A statement that answers after `ms`, or is cut off by its signal first, as a real fetch is. */
const answerAfter = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('This operation was aborted', 'AbortError')); }, { once: true });
});

/** The work item an escalation leaves when its record cannot be written, as oweGuardianEscalation writes it. */
function owedItem(n: number, createdAt: number, attempt = 0): Row {
  return {
    id: OWED_ID(n), family_id: FAM(n), tool_name: 'guardian.escalation_owed', state: 'reserved', attempt,
    created_at: new Date(createdAt).toISOString(),
    inputs: { version: 1, pushSent: true, input: { familyId: FAM(n), escalationType: 'medical', severity: 'critical', description: `owed emergency ${n}`, callerNumber: '+15555550199' } },
  };
}
/** A record that reached nobody, as escalateGuardianEmergency writes it. */
function record(n: number, escalatedAt: number): Row {
  return {
    id: RECORD_ID(n), family_id: FAM(n), communication_id: null, escalation_type: 'medical', severity: 'critical',
    description: `recorded emergency ${n}`, caller_number: '+15555550199', notified_member_ids: [], sms_sent: false, call_attempted: false,
    acknowledged_at: null, escalated_at: new Date(escalatedAt).toISOString(),
  };
}

/** PostgREST's tuple comparisons, as the sweep's cursor writes them. */
function matchesFilter(expression: string, row: Row): boolean {
  const parts = (value: string) => {
    const result: string[] = []; let depth = 0, start = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      else if (value[i] === ',' && depth === 0) { result.push(value.slice(start, i)); start = i + 1; }
    }
    result.push(value.slice(start)); return result;
  };
  if (expression.startsWith('(')) return parts(expression.slice(1, -1)).some((part) => matchesFilter(part, row));
  if (expression.startsWith('and(')) return parts(expression.slice(4, -1)).every((part) => matchesFilter(part, row));
  const match = /^(escalated_at|id)\.(eq|gt|lt|lte)\.(.+)$/.exec(expression);
  if (!match) throw new Error(`Unexpected tuple comparison ${expression}`);
  const actual = match[1] === 'id' ? String(row.id) : Date.parse(String(row.escalated_at));
  const expected = match[1] === 'id' ? match[3] : Date.parse(match[3]);
  return match[2] === 'eq' ? actual === expected : match[2] === 'gt' ? actual > expected : match[2] === 'lt' ? actual < expected : actual <= expected;
}

/** PostgREST's `order=a.asc,b.asc` over these rows. */
function ordered(rows: Row[], order: string | null): Row[] {
  const keys = (order ?? '').split(',').filter(Boolean).map((part) => {
    const [column, direction] = part.split('.');
    return { column, sign: direction === 'desc' ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { column, sign } of keys) {
      const x = a[column] as string | number, y = b[column] as string | number;
      if (x < y) return -sign;
      if (x > y) return sign;
    }
    return 0;
  });
}

function makeClient() {
  return createClient<Database>('https://owed-landing.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').at(-1)!, method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : null;
      const eq = (column: string) => url.searchParams.get(column)?.replace(/^eq\./, '');
      // A real fetch given a signal that has already fired rejects at once.
      if (init.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError');
      if (table === 'app_settings') {
        if (method === 'GET') {
          const key = eq('key')!;
          return Response.json(world.settings.has(key) ? [{ key, value: structuredClone(world.settings.get(key)) }] : []);
        }
        if (method === 'POST') {
          world.settings.set(String(body?.key), structuredClone(body?.value));
          return Response.json([{ key: body?.key }]);
        }
      }
      if (table === 'ai_tool_calls' && eq('tool_name') === 'guardian.escalation_owed') {
        if (method === 'GET') {
          const open = world.owed.filter((item) => item.state === eq('state'));
          return Response.json(ordered(open, url.searchParams.get('order')).slice(0, Number(url.searchParams.get('limit'))).map((item) => structuredClone(item)));
        }
        if (method === 'PATCH') {
          // The close of a landed item, or the count of one that failed.
          const ms = body?.state === 'succeeded' ? slow.closeMs : slow.countMs;
          if (ms) await answerAfter(ms, init.signal);
          const matched = world.owed.filter((item) => item.id === eq('id') && item.family_id === eq('family_id') && item.state === eq('state'));
          for (const item of matched) Object.assign(item, body);
          return Response.json(matched.map((item) => ({ id: item.id })));
        }
      }
      if (table === 'guardian_escalations' && method === 'POST') {
        world.landings.push(String(body?.family_id));
        // Never answered, and never committed: it hangs until its signal cuts it off.
        if (body?.family_id === STALLED) {
          return new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
          });
        }
        if (world.records.some((row) => row.id === body?.id)) return Response.json({ code: '23505', message: 'duplicate key value' }, { status: 409 });
        world.records.push({ acknowledged_at: null, ...body });
        return Response.json([{ id: body?.id }], { status: 201 });
      }
      if (table === 'guardian_escalations' && method === 'GET') {
        const range = url.searchParams.get('or');
        const reachedNobody = world.records.filter((row) => row.acknowledged_at === null && row.sms_sent === false && row.call_attempted === false
          && Array.isArray(row.notified_member_ids) && (!range || matchesFilter(range, row)));
        return Response.json(ordered(reachedNobody, url.searchParams.get('order')).slice(0, Number(url.searchParams.get('limit'))).map((row) => structuredClone(row)));
      }
      if (table === 'guardian_callback_events' && method === 'GET') return Response.json([]);
      throw new Error(`Unexpected ${method} ${table} ${url.search}`);
    } },
  });
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  // Node's AbortSignal.timeout runs on an internal timer the fake clock does
  // not drive; model it on setTimeout, which it does — refusing what Node
  // refuses, a delay that is not a whole number of milliseconds.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    if (!Number.isInteger(ms) || ms < 0) throw new RangeError(`The value of "delay" is out of range. It must be an integer. Received ${ms}`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
    return controller.signal;
  });
  vi.stubEnv('CRON_SECRET', 'synthetic-recovery-cron-secret');
  world = { owed: [], records: [], settings: new Map(), landings: [] };
  slow.closeMs = 0; slow.countMs = 0;
  seam.client = makeClient();
  seam.drain.mockReset().mockResolvedValue({ examined: 0, completed: 0, busy: 0, unavailable: 0 });
  // A text and a call that go through, except to the family whose number
  // Twilio refuses; a manager reached is written on the record, as the
  // escalation writes it.
  seam.escalate.mockReset().mockImplementation(async (_client: unknown, input: { familyId: string }) => {
    if (input.familyId === REFUSED) return { kind: 'undelivered', pushSent: true, notifiedCount: 0, recorded: true, owed: false };
    for (const row of world.records) {
      if (row.family_id === input.familyId) Object.assign(row, { notified_member_ids: [MANAGER], sms_sent: true, call_attempted: true });
    }
    return { kind: 'delivered', pushSent: true, smsSent: true, callAttempted: true, notifiedCount: 1 };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** One tick, as the dispatcher calls it, with the clock run on well past maxDuration. */
async function tick() {
  const { GET, maxDuration } = await import('@/app/api/cron/guardian-sms-recovery/route');
  const landingsBefore = world.landings.length, escalatedBefore = seam.escalate.mock.calls.length;
  const started = Date.now();
  let settledAfter: number | null = null;
  const pending = GET(new NextRequest('https://owed-landing.invalid/api/cron/guardian-sms-recovery', { headers: { authorization: 'Bearer synthetic-recovery-cron-secret' } }))
    .then((res) => { settledAfter = Date.now() - started; return res; });
  await vi.advanceTimersByTimeAsync(5 * MIN);
  // However the landing went, the tick answered inside the function's life.
  expect(settledAfter, 'the tick answered').not.toBeNull();
  expect(settledAfter!).toBeLessThan(maxDuration * 1000);
  const res = await pending;
  return {
    status: res.status,
    escalations: (await res.json() as { escalations: Record<string, number> }).escalations,
    landed: world.landings.slice(landingsBefore),
    escalated: seam.escalate.mock.calls.slice(escalatedBefore).map(([, input]) => (input as { familyId: string }).familyId),
  };
}
const item = (n: number) => world.owed.find((row) => row.id === OWED_ID(n))!;
const recordOf = (n: number) => world.records.find((row) => row.family_id === FAM(n));

describe('an owed escalation whose landing stalls on every tick', () => {
  it('is cut off, counted as tried and passed: a newer owed escalation is landed and reached, and the records on file are re-attempted, every tick', async () => {
    // The oldest owed item, never tried, whose record insert never answers;
    // a newer one that lands at once; and three records on file that reached
    // nobody, one of them for a number Twilio refuses every time.
    world.owed = [owedItem(1, T0 - 40 * MIN), owedItem(2, T0 - 20 * MIN)];
    world.records = [record(10, T0 - 30 * MIN), record(11, T0 - 30 * MIN + 1000), record(12, T0 - 30 * MIN + 2000)];

    const first = await tick();
    // Least-tried first, then oldest: the stalled one is tried, and cut off
    // short of the run's deadline, with the next one still landed after it.
    expect(first.landed).toEqual([STALLED, FAM(2)]);
    // The defect: cut off at the deadline and left uncounted, so it stayed
    // first, at the same count, on every tick.
    expect(item(1)).toMatchObject({ state: 'reserved', attempt: 1 });
    expect(recordOf(1)).toBeUndefined();
    expect(item(2)).toMatchObject({ state: 'succeeded' });
    // The defect: the records' read ran on the expired deadline, and no
    // record was re-attempted. Now every one is — the newly landed one too.
    expect([...first.escalated].sort()).toEqual([FAM(2), FAM(10), FAM(11), REFUSED].sort());
    expect(recordOf(2)).toMatchObject({ notified_member_ids: [MANAGER], sms_sent: true });
    expect(first.escalations).toMatchObject({ recovered: 1, unavailable: 1, examined: 4, delivered: 3, undelivered: 1, deferred: 0 });
    expect(first.status).toBe(503);

    // A newer emergency is owed before the next tick: it goes ahead of the
    // stalled item, which has been tried once already.
    world.owed.push(owedItem(3, Date.now() - MIN));
    const second = await tick();
    expect(second.landed).toEqual([FAM(3), STALLED]);
    expect(item(3)).toMatchObject({ state: 'succeeded' });
    expect(item(1)).toMatchObject({ state: 'reserved', attempt: 2 });
    expect(second.escalated).toContain(FAM(3));
    expect(second.escalated).toContain(REFUSED);
    expect(second.escalations).toMatchObject({ recovered: 1, unavailable: 1, delivered: 1, undelivered: 1, deferred: 0 });

    // And on, for as long as it stalls: tried in its turn, never landed or
    // closed, and never again holding the rest behind it.
    const third = await tick();
    expect(third.landed).toEqual([STALLED]);
    expect(item(1)).toMatchObject({ state: 'reserved', attempt: 3 });
    expect(third.escalated).toEqual([REFUSED]);
    expect(third.escalations).toMatchObject({ recovered: 0, unavailable: 1, examined: 1, undelivered: 1, deferred: 0 });
    expect(recordOf(1)).toBeUndefined();
  });

  it('already tried more than every other owed item, and the only one: the records on file are still re-attempted', async () => {
    // Its count was never the whole defect: an item tried three times, and
    // alone in the queue, still took the run when its landing stalled.
    world.owed = [owedItem(1, T0 - 40 * MIN, 3)];
    world.records = [record(10, T0 - 30 * MIN), record(12, T0 - 30 * MIN + 1000)];
    const first = await tick();
    expect(first.landed).toEqual([STALLED]);
    expect(item(1)).toMatchObject({ state: 'reserved', attempt: 4 });
    expect([...first.escalated].sort()).toEqual([FAM(10), REFUSED].sort());
    expect(first.escalations).toMatchObject({ recovered: 0, unavailable: 1, examined: 2, delivered: 1, undelivered: 1, deferred: 0 });
  });

  it('when the receipt drain has taken its whole part of the tick, and several landings stall: the records on file still get an attempt, and the newer owed one lands next tick', async () => {
    // The drain held to its own deadline (a slow model, a Twilio outage),
    // answering a millisecond short of it: the escalation sweep has what is
    // left of the tick, under half of it, and an odd number of milliseconds.
    seam.drain.mockImplementation((_client: unknown, { deadline }: { deadline: number }) => new Promise((resolve) => {
      setTimeout(() => resolve({ examined: 1, completed: 0, busy: 0, unavailable: 1 }), deadline - Date.now() - 1);
    }));
    // Three owed items whose records the database never answers for, older
    // than a newer one behind them that would land at once.
    world.owed = [
      { ...owedItem(1, T0 - 50 * MIN) },
      { ...owedItem(1, T0 - 45 * MIN), id: OWED_ID(4) },
      { ...owedItem(1, T0 - 40 * MIN), id: OWED_ID(5) },
      owedItem(2, T0 - 20 * MIN),
    ];
    world.records = [record(10, T0 - 30 * MIN), record(12, T0 - 30 * MIN + 1000)];

    const first = await tick();
    expect(first.landed.every((family) => family === STALLED)).toBe(true);
    expect(first.landed.length).toBeGreaterThan(0);
    // The records on file got their attempts, inside what the drain left; every
    // record was attempted, and the owed items the phase ended before (the newer
    // one, never tried this tick, with no record yet) are reported as left.
    expect([...first.escalated].sort()).toEqual([FAM(10), REFUSED].sort());
    expect(first.escalations).toMatchObject({ examined: 2, delivered: 1, undelivered: 1, deferred: world.owed.length - first.landed.length });
    expect(first.escalations.deferred).toBeGreaterThan(0);
    // Every stalled landing tried was cut off short of the run's end, and so counted.
    expect(world.owed.filter((row) => row.family_id === STALLED && row.state === 'reserved' && row.attempt === 1)).toHaveLength(first.landed.length);

    // Next tick the one not yet tried goes first, and lands.
    const second = await tick();
    expect(second.landed[0]).toBe(FAM(2));
    expect(item(2)).toMatchObject({ state: 'succeeded' });
    expect(second.escalated).toContain(FAM(2));
    expect(second.escalated).toContain(REFUSED);
  });
});

// The owed phase ends with items it read and never tried. Those are emergencies
// that reached nobody, with no record on file for the sweep below to find, and
// the tick has to say so, as it does for the records it leaves: the route's
// promise is a non-2xx whenever something was not reached by this run, and the
// ticks between can be hours apart. The loop stopped at the phase's end
// without counting them, so a phase that ended inside a close, or between
// items, answered 200 with emergencies left unreached.
describe('an owed phase that ends before every item it read is tried', () => {
  it('inside a close that is slow but answers: the items left are counted deferred, the tick answers 503, and they lead the next tick', async () => {
    // Ten owed items, each landing at once, each close taking nine seconds
    // (cut off by its signal, as a real fetch is). The phase has half the run:
    // five closes, and a sixth cut off.
    slow.closeMs = 9_000;
    world.owed = Array.from({ length: 10 }, (_, i) => owedItem(20 + i, T0 - (60 - i) * MIN));

    const first = await tick();
    expect(first.landed).toEqual([20, 21, 22, 23, 24, 25].map(FAM));
    // Five landed and closed; the sixth landed, and its close was cut off.
    for (const n of [20, 21, 22, 23, 24]) expect(item(n)).toMatchObject({ state: 'succeeded', attempt: 1 });
    expect(item(25)).toMatchObject({ state: 'reserved', attempt: 0 });
    expect(recordOf(25)).toMatchObject({ notified_member_ids: [MANAGER] });
    // Four read and never tried: untouched, with nothing on file for them.
    for (const n of [26, 27, 28, 29]) {
      expect(item(n)).toMatchObject({ state: 'reserved', attempt: 0 });
      expect(recordOf(n)).toBeUndefined();
    }
    // The defect: { deferred: 0 } and a 200, with four emergencies reached by nobody.
    expect(first.status).toBe(503);
    expect(first.escalations).toMatchObject({ recovered: 6, examined: 6, delivered: 6, undelivered: 0, unavailable: 0, deferred: 4 });

    // Next tick, at the same pace: the item whose close was cut off first (its
    // record is there, so it is only closed), then the four left, all inside the phase.
    const second = await tick();
    expect(second.landed).toEqual([25, 26, 27, 28, 29].map(FAM));
    expect(world.owed.filter((row) => row.state !== 'succeeded')).toEqual([]);
    expect([...second.escalated].sort()).toEqual([26, 27, 28, 29].map(FAM).sort());
    expect(second.escalations).toMatchObject({ recovered: 5, examined: 4, delivered: 4, unavailable: 0, deferred: 0 });
    expect(second.status).toBe(200);
  });

  it('between items, after a count that outlasts it: the items left are counted deferred, and lead the next tick', async () => {
    // Six older items written in a shape this cannot read, whose count as tried
    // takes nine seconds, ahead of four that would land at once. The sixth
    // count runs past the phase's end; the four behind it are never tried.
    slow.countMs = 9_000;
    world.owed = [
      ...Array.from({ length: 6 }, (_, i) => ({ ...owedItem(30 + i, T0 - (60 - i) * MIN), inputs: { version: 2 } })),
      ...Array.from({ length: 4 }, (_, i) => owedItem(40 + i, T0 - (30 - i) * MIN)),
    ];

    const first = await tick();
    expect(first.landed).toEqual([]);
    for (const n of [30, 31, 32, 33, 34, 35]) expect(item(n)).toMatchObject({ state: 'reserved', attempt: 1 });
    for (const n of [40, 41, 42, 43]) {
      expect(item(n)).toMatchObject({ state: 'reserved', attempt: 0 });
      expect(recordOf(n)).toBeUndefined();
    }
    // The defect: { deferred: 0 }, the four never tried reported nowhere.
    expect(first.escalations).toMatchObject({ recovered: 0, examined: 0, unavailable: 6, deferred: 4 });
    expect(first.status).toBe(503);

    // Tried fewer times, the four go first next tick, and are landed and reached.
    const second = await tick();
    expect(second.landed).toEqual([40, 41, 42, 43].map(FAM));
    for (const n of [40, 41, 42, 43]) expect(item(n)).toMatchObject({ state: 'succeeded' });
    expect([...second.escalated].sort()).toEqual([40, 41, 42, 43].map(FAM).sort());
    expect(second.escalations).toMatchObject({ recovered: 4, examined: 4, delivered: 4, unavailable: 6, deferred: 0 });
  });
});
