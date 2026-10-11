// Counting an owed landing that failed does not take the records' turn.
//
// The retry sweep (lib/guardian/escalation-retry.ts) first lands the records
// that escalations left owed (lib/guardian/escalation-owed.ts), for at most
// half of what is left of the run, and then re-attempts the records on file,
// starting an attempt only with 20 s of the run left (MIN_ATTEMPT_MS +
// SETTLE_MS). A landing that fails is counted on its item, so the next run
// takes the items tried fewer times first. That count was bounded by the run's
// own signal plus a fresh 10 s, not by the owed phase, so it could run on 10 s
// past the phase's end. With the receipt drain taking its whole 55 s, a stalled
// landing (cut off at 10 s) and a slow count (9 s), and then the next stalled
// landing cut off at the phase's end (77.5 s) and its own slow count, the owed
// phase held the run to 86.5 s: 13.5 s left, no attempt started, every record
// on file deferred, and the same again on every tick the slowness lasted.
//
// A count is advancement only once it is on file, too: one refused, matching
// no row, or cut off leaves the item at the count it had, and in the turn it
// had. That is asserted here as well, rather than claimed.
//
// Driven through the real cron route, the real receipt drain, the real retry
// sweep and the real landing, over a PostgREST fixture that keeps its rows
// from tick to tick, on a fake clock. Only a receipt's own resume (it hangs,
// so the drain takes its whole part of the tick) and the escalation's sends
// are stood in for.
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';

const seam = vi.hoisted(() => ({ client: null as unknown, resume: vi.fn(), escalate: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.client }));
vi.mock('@/lib/guardian/sms-processing', () => ({ resumeGuardianSms: seam.resume }));
vi.mock('@/lib/guardian/escalate', async (original) => ({
  ...await original<typeof import('@/lib/guardian/escalate')>(),
  escalateGuardianEmergency: seam.escalate,
}));

const T0 = Date.parse('2026-10-11T12:00:00.000Z');
const MIN = 60_000;
/** The route's whole run, and what an attempt needs left of it to be started (MIN_ATTEMPT_MS + SETTLE_MS). */
const RUN_MS = 100_000;
const ATTEMPT_NEEDS_MS = 20_000;
const DRAIN_KEY = 'guardian.sms_intake:recovery_cursor:v1';
const RECEIPT_ID = (n: number) => `40000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const FAM = (n: number) => `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const OWED_ID = (n: number) => `20000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const RECORD_ID = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const MANAGER = '30000000-0000-4000-8000-000000000001';
/** The families whose owed record the database never answers for. */
const STALLED = new Set([FAM(1), FAM(2)]);
/** A family whose only number Twilio refuses, every time: retry work on every tick. */
const REFUSED = FAM(12);
type Row = Record<string, unknown>;

/** How the count of a failed landing goes: answered after `ms`, never answered, refused, or matching no row. */
type CountFault = { kind: 'slow'; ms: number } | { kind: 'cut off' } | { kind: 'refused' } | { kind: 'no row' };

/** The rows, kept from tick to tick, and what each tick asked of them. */
type World = {
  receipts: Row[];
  owed: Row[];
  records: Row[];
  settings: Map<string, Row>;
  /** The family of every landing insert, in the order they were sent. */
  landings: string[];
  count: CountFault;
};
let world: World;

/** A statement that answers after `ms`, or is cut off by its signal first, as a real fetch is. */
const answerAfter = (ms: number, signal?: AbortSignal | null) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('This operation was aborted', 'AbortError')); }, { once: true });
});
/** A statement never answered, and never committed: it hangs until its signal cuts it off. */
const never = (signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) => {
  signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
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

/** PostgREST's tuple comparisons, as the drain and the sweep write them. */
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
  if (expression.startsWith('or(')) return parts(expression.slice(3, -1)).some((part) => matchesFilter(part, row));
  const match = /^(created_at|escalated_at|id)\.(eq|gt|lt|lte)\.(.+)$/.exec(expression);
  if (!match) throw new Error(`Unexpected tuple comparison ${expression}`);
  const actual = match[1] === 'id' ? String(row.id) : Date.parse(String(row[match[1]]));
  const expected = match[1] === 'id' ? match[3] : Date.parse(match[3]);
  return match[2] === 'eq' ? actual === expected : match[2] === 'gt' ? actual > expected : match[2] === 'lt' ? actual < expected : actual <= expected;
}

/** PostgREST's `order=a.asc,b.desc` over these rows. */
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
  return createClient<Database>('https://owed-count.invalid', 'synthetic-service-key', {
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
          const found = world.settings.has(key) ? [{ key, value: structuredClone(world.settings.get(key)) }] : [];
          return Response.json(found, { headers: { 'content-range': `0-${Math.max(0, found.length - 1)}/${found.length}` } });
        }
        if (method === 'POST') {
          // The drain's first cursor is inserted; the sweep's is upserted.
          const upsert = new Headers(init.headers).get('prefer')?.includes('merge-duplicates');
          if (world.settings.has(String(body?.key)) && !upsert) return Response.json({ code: '23505', message: 'duplicate key value' }, { status: 409 });
          world.settings.set(String(body?.key), structuredClone(body?.value as Row));
          return Response.json([{ key: body?.key }]);
        }
        if (method === 'PATCH') {
          // The drain's cursor, moved only from the revision it was read at.
          const fence = JSON.parse(url.searchParams.get('value')!.replace(/^cs\./, '')) as Row;
          const cursor = world.settings.get(DRAIN_KEY);
          if (!cursor || cursor.revision !== fence.revision || cursor.version !== fence.version) return Response.json([]);
          world.settings.set(DRAIN_KEY, structuredClone(body?.value as Row));
          return Response.json([{ key: DRAIN_KEY }]);
        }
      }
      // The receipts the drain resumes, oldest first, one at a time.
      if (table === 'ai_tool_calls' && eq('tool_name') === 'guardian.sms_intake' && method === 'GET') {
        const range = url.searchParams.get('or');
        const list = ordered(world.receipts.filter((row) => !range || matchesFilter(range, row)), url.searchParams.get('order'));
        return Response.json(list.slice(0, 1).map((row) => ({ id: row.id, created_at: row.created_at })));
      }
      if (table === 'ai_tool_calls' && eq('tool_name') === 'guardian.escalation_owed') {
        if (method === 'GET') {
          const open = world.owed.filter((item) => item.state === eq('state'));
          return Response.json(ordered(open, url.searchParams.get('order')).slice(0, Number(url.searchParams.get('limit'))).map((item) => structuredClone(item)));
        }
        if (method === 'PATCH') {
          // The count of a landing that failed (the close of a landed one is answered at once).
          if (body?.state !== 'succeeded') {
            const fault = world.count;
            if (fault.kind === 'cut off') return never(init.signal);
            if (fault.kind === 'refused') return Response.json({ code: '42501', message: 'permission denied for table ai_tool_calls' }, { status: 403 });
            if (fault.kind === 'no row') return Response.json([]);
            await answerAfter(fault.ms, init.signal);
          }
          const matched = world.owed.filter((item) => item.id === eq('id') && item.family_id === eq('family_id') && item.state === eq('state'));
          for (const item of matched) Object.assign(item, body);
          return Response.json(matched.map((item) => ({ id: item.id })));
        }
      }
      if (table === 'guardian_escalations' && method === 'POST') {
        world.landings.push(String(body?.family_id));
        if (STALLED.has(String(body?.family_id))) return never(init.signal);
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

/** When, from the start of the tick in progress, each escalation attempt began. */
const attemptsAt: number[] = [];
let tickStartedAt = T0;

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
  // Two receipts whose resume hangs (a slow model, a Twilio outage): the drain
  // is held to its own deadline, 55 s into the tick, on every tick.
  world = {
    receipts: [1, 2].map((n) => ({ id: RECEIPT_ID(n), created_at: new Date(T0 - 2 * MIN + n * 1000).toISOString() })),
    owed: [], records: [], settings: new Map(), landings: [], count: { kind: 'slow', ms: 0 },
  };
  seam.client = makeClient();
  seam.resume.mockReset().mockImplementation(() => new Promise(() => {}));
  attemptsAt.length = 0;
  // A text and a call that go through, except to the family whose number
  // Twilio refuses; a manager reached is written on the record, as the
  // escalation writes it.
  seam.escalate.mockReset().mockImplementation(async (_client: unknown, input: { familyId: string }) => {
    attemptsAt.push(Date.now() - tickStartedAt);
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
  const landingsBefore = world.landings.length, escalatedBefore = seam.escalate.mock.calls.length, attemptsBefore = attemptsAt.length;
  tickStartedAt = Date.now();
  let settledAfter: number | null = null;
  const pending = GET(new NextRequest('https://owed-count.invalid/api/cron/guardian-sms-recovery', { headers: { authorization: 'Bearer synthetic-recovery-cron-secret' } }))
    .then((res) => { settledAfter = Date.now() - tickStartedAt; return res; });
  await vi.advanceTimersByTimeAsync(5 * MIN);
  // However the landings and their counts went, the tick answered inside the function's life.
  expect(settledAfter, 'the tick answered').not.toBeNull();
  expect(settledAfter!).toBeLessThan(maxDuration * 1000);
  const res = await pending;
  const body = await res.json() as { examined: number; unavailable: number; escalations: Record<string, number> };
  const attempted = attemptsAt.slice(attemptsBefore);
  // The receipt drain took its whole part of the tick, every tick: it is the
  // slow drain, not an early one, that the records' turn has to survive.
  expect(body.unavailable, 'the drain was held to its deadline').toBeGreaterThan(0);
  if (attempted.length) expect(attempted[0]).toBeGreaterThanOrEqual(55_000);
  return {
    status: res.status,
    escalations: body.escalations,
    landed: world.landings.slice(landingsBefore),
    escalated: seam.escalate.mock.calls.slice(escalatedBefore).map(([, input]) => (input as { familyId: string }).familyId),
    attempted,
  };
}
const item = (n: number) => world.owed.find((row) => row.id === OWED_ID(n))!;

/** The records on file got their turn: the first attempt began with what an attempt needs still left of the run. */
function recordsGotTheirTurn(result: { attempted: number[]; escalated: string[]; escalations: Record<string, number> }) {
  // The defect: the owed phase held the run to 86.5 s, the first record was
  // left 13.5 s, and none was attempted — examined 0, every record deferred.
  expect(result.attempted.length).toBeGreaterThan(0);
  expect(result.attempted[0]).toBeLessThanOrEqual(RUN_MS - ATTEMPT_NEEDS_MS);
  expect(result.escalated).toContain(REFUSED);
  expect(result.escalations.examined).toBe(result.escalated.length);
}

describe('a recovery tick whose receipt drain takes its whole part, with owed landings that stall and counts that are slow', () => {
  it('leaves the records on file their attempts on every tick: the count after a landing cut off at the phase\'s end stops short of the records\' time, and is not taken as advancement', async () => {
    // Two owed items whose record insert never answers, and each count of a
    // failed landing takes nine seconds; two records on file that reached
    // nobody, one of them for a number Twilio refuses every time.
    world.count = { kind: 'slow', ms: 9_000 };
    world.owed = [owedItem(1, T0 - 40 * MIN), owedItem(2, T0 - 30 * MIN)];
    world.records = [record(10, T0 - 20 * MIN), record(12, T0 - 20 * MIN + 1000)];

    // The drain to 55 s; the first landing cut off at 65 s, and its count on
    // file at 74 s; the second landing cut off at the phase's end, 77.5 s.
    const first = await tick();
    expect(first.landed).toEqual([FAM(1), FAM(2)]);
    recordsGotTheirTurn(first);
    expect([...first.escalated].sort()).toEqual([FAM(10), REFUSED].sort());
    expect(first.escalations).toMatchObject({ recovered: 0, unavailable: 2, examined: 2, delivered: 1, undelivered: 1, deferred: 0 });
    expect(first.status).toBe(503);
    // The first count landed. The second was cut off where the records' time
    // begins, so it is not on file, and the item is not counted as tried.
    expect(item(1)).toMatchObject({ state: 'reserved', attempt: 1 });
    expect(item(2)).toMatchObject({ state: 'reserved', attempt: 0 });

    // Next tick, the slowness lasting: tried fewer times, the second goes
    // first and its count lands; the first's is the one cut off this time.
    const second = await tick();
    expect(second.landed).toEqual([FAM(2), FAM(1)]);
    recordsGotTheirTurn(second);
    expect(second.escalated).toEqual([REFUSED]);
    expect(second.escalations).toMatchObject({ recovered: 0, unavailable: 2, examined: 1, undelivered: 1, deferred: 0 });
    expect(item(2)).toMatchObject({ state: 'reserved', attempt: 1 });
    expect(item(1)).toMatchObject({ state: 'reserved', attempt: 1 });

    // And on: tied at one try each, the older goes first; the records on file
    // keep their turn on every tick.
    const third = await tick();
    expect(third.landed).toEqual([FAM(1), FAM(2)]);
    recordsGotTheirTurn(third);
    expect(third.escalated).toEqual([REFUSED]);
    expect(third.escalations).toMatchObject({ recovered: 0, unavailable: 2, examined: 1, undelivered: 1, deferred: 0 });
    expect(item(1)).toMatchObject({ state: 'reserved', attempt: 2 });
    expect(item(2)).toMatchObject({ state: 'reserved', attempt: 1 });
  });

  it.each([
    { kind: 'cut off' },
    { kind: 'refused' },
    { kind: 'no row' },
  ] as const)('a count that is $kind is not advancement: the item keeps its count and its turn, on every tick, and the records on file still get theirs', async (fault) => {
    // Two owed items whose record insert never answers, and whose count as
    // tried never lands; a newer owed item behind them that would land at once.
    world.count = fault;
    world.owed = [owedItem(1, T0 - 40 * MIN), owedItem(2, T0 - 30 * MIN), owedItem(3, T0 - 10 * MIN)];
    world.records = [record(12, T0 - 20 * MIN)];

    for (let n = 0; n < 3; n += 1) {
      const result = await tick();
      // Never counted, so tried first again, in the same order, every tick.
      expect(result.landed.slice(0, 2)).toEqual([FAM(1), FAM(2)]);
      expect(item(1)).toMatchObject({ state: 'reserved', attempt: 0 });
      expect(item(2)).toMatchObject({ state: 'reserved', attempt: 0 });
      recordsGotTheirTurn(result);
      expect(result.escalations.unavailable).toBeGreaterThanOrEqual(2);
      expect(result.status).toBe(503);
      if (fault.kind === 'cut off') {
        // Each count cut off (the first after ten seconds, the second where the
        // records' time begins) used the time the newer item would have had: it
        // is not reached while they stall, and is reported left, never dropped.
        expect(result.landed).toEqual([FAM(1), FAM(2)]);
        expect(item(3)).toMatchObject({ state: 'reserved', attempt: 0 });
        expect(result.escalations.deferred).toBe(1);
      }
    }
    if (fault.kind !== 'cut off') {
      // Refused or matching no row, a count costs no time: the newer item was
      // landed on the first tick, behind the two, and closed.
      expect(item(3)).toMatchObject({ state: 'succeeded', attempt: 1 });
      expect(world.records.find((row) => row.family_id === FAM(3))).toMatchObject({ notified_member_ids: [MANAGER] });
    }
  });
});
