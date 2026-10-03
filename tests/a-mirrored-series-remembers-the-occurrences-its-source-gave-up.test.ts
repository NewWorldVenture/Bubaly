// A mirrored series remembers the occurrences its source gave up.
//
// Google's events list runs with `singleEvents=false`: a series arrives as ONE
// master whose `recurrence` carries the RRULE and any EXDATE lines, plus one
// event per occurrence the family changed or cancelled, each naming its master
// (`recurringEventId`) and the slot it left (`originalStartTime`). The mapper
// kept the RRULE and dropped the rest; the engine had no column for it; the
// moved and cancelled occurrences were plain events. So the mirror in
// `sync_calendar_events`, and the feed at /api/sync/feeds/[token] that every
// subscribed phone reads from it, expanded the series over the piano lesson the
// family moved to Thursday and over the one they cancelled — and published the
// moved lesson a second time under the series' own UID, with nothing to say it
// replaced an occurrence.
//
// Now the master row carries `exception_dates` (its own EXDATE lines plus the
// slot every exception left, folded in after the pull so the order of the page
// does not matter and an exception arriving alone on an incremental pull still
// reaches its master), a changed occurrence carries `recurrence_id`, and the
// feed emits EXDATE and RECURRENCE-ID. A database without the column yet is
// told apart from a failed write: the engine and the feed say so once and
// carry on without it.
//
// This file drives the real Google engine (provider calls faked at the module
// seam, every database write through the in-memory client) and then the real
// feed route over the rows it wrote.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

type GEvent = import('@/lib/sync/providers/google').GEvent;

const seam = vi.hoisted(() => ({
  pulls: [] as Array<{ events: GEvent[]; nextSyncToken: string | null; gone: boolean }>,
  failures: [] as string[],
  db: null as unknown,
}));

vi.mock('@/lib/sync/providers/google', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sync/providers/google')>()),
  listCalendars: async () => [{ id: 'cal-primary', summary: 'Family', primary: true, timeZone: 'America/New_York' }],
  pullEvents: async () => seam.pulls.shift() ?? { events: [], nextSyncToken: 'tok-idle', gone: false },
  listTasks: async () => [],
}));
vi.mock('@/lib/sync/accounts', () => ({ getValidAccessToken: async () => 'access-token' }));
vi.mock('@/lib/services/sync/policy', () => ({
  loadSyncExecutionPolicy: async () => ({ ok: true, data: { mode: 'standard', pull: true, push: false } }),
}));
vi.mock('@/lib/sync/audit', () => ({
  logSyncProviderError: async (_db: unknown, row: { message_redacted: string }) => { seam.failures.push(row.message_redacted); },
  recordSyncFailure: async () => undefined,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db }));
vi.mock('@/lib/server/rate-limit', () => ({ clientIp: () => '203.0.113.9', rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));

import { runGoogleSync } from '@/lib/sync/engine/google';
import { GET as feed } from '@/app/api/sync/feeds/[token]/route';

const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000e1';
const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const TOKEN = 'feed-token-fixture-0001';
const account = { id: ACCOUNT, user_id: USER, family_id: FAMILY, external_id: 'parent@gmail.test' };

/** The series: Wednesdays 15:00 New York, with one occurrence already excluded by the master itself. */
const MASTER: GEvent = {
  id: 'piano', iCalUID: 'piano@google.com', status: 'confirmed', summary: 'Piano', etag: '"m1"', updated: '2026-07-01T00:00:00Z',
  start: { dateTime: '2026-07-01T15:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-07-01T16:00:00-04:00', timeZone: 'America/New_York' },
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE', 'EXDATE;TZID=America/New_York:20260805T150000'],
};
/** 22 July, moved to Thursday the 23rd. */
const MOVED: GEvent = {
  id: 'piano_20260722T190000Z', iCalUID: 'piano@google.com', status: 'confirmed', summary: 'Piano (Thursday this week)', etag: '"x1"', updated: '2026-07-10T00:00:00Z',
  recurringEventId: 'piano', originalStartTime: { dateTime: '2026-07-22T15:00:00-04:00', timeZone: 'America/New_York' },
  start: { dateTime: '2026-07-23T15:00:00-04:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-07-23T16:00:00-04:00', timeZone: 'America/New_York' },
};
/** 29 July, cancelled. Google sends the tombstone with its identity and little else. */
const CANCELLED: GEvent = {
  id: 'piano_20260729T190000Z', status: 'cancelled', recurringEventId: 'piano',
  originalStartTime: { dateTime: '2026-07-29T15:00:00-04:00', timeZone: 'America/New_York' },
  start: { dateTime: '2026-07-29T15:00:00-04:00', timeZone: 'America/New_York' },
};
/** An ordinary appointment, the control: nothing about exceptions touches it. */
const DENTIST: GEvent = {
  id: 'dentist', iCalUID: 'dentist@google.com', status: 'confirmed', summary: 'Dentist', etag: '"d1"',
  start: { dateTime: '2026-07-15T13:00:00Z' }, end: { dateTime: '2026-07-15T13:30:00Z' },
};

let db: InMemorySupabase;
const admin = () => db as unknown as SupabaseClient<Database>;
const mirror = () => db.table('sync_calendar_events') as Array<Row & { external_id: string }>;
const rowFor = (externalId: string) => mirror().find((r) => r.external_id === externalId);

function pull(events: GEvent[], nextSyncToken = 'tok-next') { seam.pulls.push({ events, nextSyncToken, gone: false }); }

async function run(client: SupabaseClient<Database> = admin()) {
  const result = await runGoogleSync(client, account);
  expect(seam.failures, 'the sync must not have failed').toEqual([]);
  expect(result.error).toBeUndefined();
  return result;
}

async function publish(): Promise<{ status: number; body: string }> {
  const calendar = db.table('sync_calendars')[0];
  Object.assign(calendar, { feed_enabled: true, feed_token: TOKEN, description: null });
  const res = await feed(new NextRequest(`https://fixture.invalid/api/sync/feeds/${TOKEN}`), { params: Promise.resolve({ token: TOKEN }) });
  return { status: res.status, body: await res.text() };
}

/** The in-memory client, but every `sync_calendar_events` write or read that names `exception_dates` is answered as a database without the column answers it. */
function withoutTheColumn(base: InMemorySupabase, counts: { refused: number }): SupabaseClient<Database> {
  const refusal = { code: '42703', message: 'column sync_calendar_events.exception_dates does not exist' };
  const refused = () => {
    counts.refused += 1;
    const stub: Record<string, unknown> = {};
    Object.assign(stub, {
      select: () => stub, eq: () => stub, is: () => stub, lte: () => stub, order: () => stub, range: () => stub,
      single: () => Promise.resolve({ data: null, error: refusal }), maybeSingle: () => Promise.resolve({ data: null, error: refusal }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: refusal }),
    });
    return stub;
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
        if (table !== 'sync_calendar_events') return builder;
        const insert = builder.insert.bind(builder); const update = builder.update.bind(builder); const select = builder.select.bind(builder);
        builder.insert = (rows: unknown) => ('exception_dates' in (rows as Row) ? refused() : insert(rows));
        builder.update = (patch: unknown) => ('exception_dates' in (patch as Row) ? refused() : update(patch));
        builder.select = (columns?: unknown) => (typeof columns === 'string' && columns.includes('exception_dates') ? refused() : select(columns));
        return builder;
      };
    },
  }) as unknown as SupabaseClient<Database>;
}

beforeEach(() => {
  db = createInMemorySupabase();
  seam.db = db;
  seam.pulls = [];
  seam.failures = [];
  db.seed('sync_accounts', [{ id: ACCOUNT, user_id: USER, family_id: FAMILY, provider: 'google', external_id: account.external_id, sync_status: 'idle' }]);
  db.seed('sync_connections', [{ account_id: ACCOUNT, family_id: FAMILY, provider: 'google', health: 'unknown' }]);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the Google engine, pulling a series with exceptions', () => {
  it('the master learns every slot its exceptions left, whichever order the page came in', async () => {
    // Exceptions FIRST: their master has no mapping yet when they are read.
    pull([CANCELLED, MOVED, DENTIST, MASTER]);
    const result = await run();

    const master = rowFor('piano')!;
    expect(master.recurrence_rule).toBe('FREQ=WEEKLY;BYDAY=WE');
    // Its own EXDATE line (5 Aug, 15:00 New York) and the two slots the exceptions left.
    expect(master.exception_dates).toEqual(['2026-07-22T19:00:00.000Z', '2026-07-29T19:00:00.000Z', '2026-08-05T19:00:00.000Z']);
    expect(master.recurrence_id).toBeNull();

    // The moved occurrence is its own row, and says which slot it replaces.
    const moved = rowFor('piano_20260722T190000Z')!;
    expect(moved).toMatchObject({ uid: 'piano@google.com', starts_at: '2026-07-23T19:00:00.000Z', recurrence_id: '2026-07-22T19:00:00.000Z', exception_dates: [] });
    // The cancelled occurrence was never mirrored, so there is nothing to delete.
    expect(rowFor('piano_20260729T190000Z')).toBeUndefined();
    // Control: the dentist is untouched by any of it.
    expect(rowFor('dentist')).toMatchObject({ recurrence_rule: null, recurrence_id: null, exception_dates: [] });
    expect(result).toMatchObject({ imported: 3, skipped: 1, conflicts: 0 });
  });

  it('an occurrence cancelled later arrives alone on the incremental pull and still reaches its master', async () => {
    pull([MASTER, DENTIST]);
    await run();
    expect(rowFor('piano')!.exception_dates).toEqual(['2026-08-05T19:00:00.000Z']);

    // Google emits only the tombstone; the master is not re-sent.
    pull([CANCELLED], 'tok-after-cancel');
    await run();
    expect(rowFor('piano')!.exception_dates).toEqual(['2026-07-29T19:00:00.000Z', '2026-08-05T19:00:00.000Z']);
    expect(rowFor('piano_20260729T190000Z')).toBeUndefined();
  });

  it('a slot already known is not written again, so a full resync is idle on the master', async () => {
    pull([MASTER, CANCELLED]);
    await run();
    const before = { ...rowFor('piano')! };

    let writes = 0;
    const counting = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, (...args: unknown[]) => unknown>;
          if (table === 'sync_calendar_events') {
            const update = builder.update.bind(builder);
            builder.update = (patch: unknown) => { if ('exception_dates' in (patch as Row) && Object.keys(patch as Row).length === 1) writes += 1; return update(patch); };
          }
          return builder;
        };
      },
    }) as unknown as SupabaseClient<Database>;
    pull([MASTER, CANCELLED], 'tok-resync');
    await run(counting);
    expect(rowFor('piano')).toEqual(before);
    expect(writes, 'the fold wrote nothing it already knew').toBe(0);
  });

  it('an exception whose series was never mirrored is counted, not invented', async () => {
    pull([CANCELLED, DENTIST]);
    const result = await run();
    expect(mirror().map((r) => r.external_id)).toEqual(['dentist']);
    expect(result).toMatchObject({ imported: 1, skipped: 1 });
  });

  it('a database without the column yet syncs the series without exception dates, and says so once', async () => {
    const counts = { refused: 0 };
    pull([MASTER, MOVED, CANCELLED]);
    const result = await run(withoutTheColumn(db, counts));
    expect(result.error).toBeUndefined();
    expect(rowFor('piano')).toMatchObject({ recurrence_rule: 'FREQ=WEEKLY;BYDAY=WE' });
    expect(rowFor('piano')).not.toHaveProperty('exception_dates');
    expect(rowFor('piano_20260722T190000Z')).toMatchObject({ recurrence_id: '2026-07-22T19:00:00.000Z' });
    // One refusal taught the run; every later write went without the column.
    expect(counts.refused).toBe(1);
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes('exception_dates is not in this database yet'))).toHaveLength(1);
  });

  it('any other refusal of the write is still a failed sync (control)', async () => {
    const refusal = { code: '42501', message: 'permission denied for table sync_calendar_events' };
    const denied = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table) as unknown as Record<string, unknown>;
          if (table === 'sync_calendar_events') {
            const stub: Record<string, unknown> = {};
            Object.assign(stub, { select: () => stub, single: () => Promise.resolve({ data: null, error: refusal }), maybeSingle: () => Promise.resolve({ data: null, error: refusal }) });
            builder.insert = () => stub;
          }
          return builder;
        };
      },
    }) as unknown as SupabaseClient<Database>;
    pull([MASTER]);
    const result = await runGoogleSync(denied, account);
    expect(result.error).toBe('Sync event creation failed');
    expect(seam.failures).toEqual(['Sync event creation failed']);
  });
});

describe('the feed built from the mirror', () => {
  it('carries EXDATE on the series and RECURRENCE-ID on the moved occurrence', async () => {
    pull([MASTER, MOVED, CANCELLED, DENTIST]);
    await run();
    const { status, body } = await publish();
    expect(status).toBe(200);
    const lines = body.split('\r\n');
    expect(lines).toContain('EXDATE:20260722T190000Z,20260729T190000Z,20260805T190000Z');
    expect(lines).toContain('RECURRENCE-ID:20260722T190000Z');
    // Both VEVENTs of the series share the UID; the dentist is one plain event.
    expect(lines.filter((l) => l === 'UID:piano@google.com')).toHaveLength(2);
    expect(lines.filter((l) => l.startsWith('RRULE:'))).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=WE']);
    expect(lines.filter((l) => l.startsWith('EXDATE')), 'only the master carries exception dates').toHaveLength(1);
  });

  it('a database without the column yet still publishes, without EXDATE, and says so once', async () => {
    pull([MASTER, MOVED]);
    await run();
    const counts = { refused: 0 };
    seam.db = withoutTheColumn(db, counts);
    const { status, body } = await publish();
    expect(status).toBe(200);
    expect(body).not.toContain('EXDATE');
    expect(body).toContain('RECURRENCE-ID:20260722T190000Z');
    expect(counts.refused).toBe(1);
    const warnings = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    expect(warnings.filter((w) => w.includes('[sync-feed]') && w.includes('exception_dates'))).toHaveLength(1);
  });
});
