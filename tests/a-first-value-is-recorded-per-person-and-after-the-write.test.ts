// /home's "Do one thing now" card asks whether THIS person reached first value
// (activation_events read with `.eq('user_id', ctx.user.id)`), and the
// Outcomes / Briefing beacons are what record it. trackActivationOnce deduped
// on a localStorage flag keyed by the FAMILY, and set the flag before the
// insert: on a shared tablet the first parent to open Outcomes was the only one
// ever recorded from it, and an insert that failed (a network error, an
// expired session) was never retried (N3). And `ms_since_signup` is an
// INTEGER column, so for a household older than ~24.8 days every insert was
// refused outright. Driven through the real tracker (and the real server
// writer) over the in-memory database, with the browser's storage in memory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => h.client }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.client }));

const { trackActivationOnce } = await import('@/lib/analytics/activation-track');
const { recordActivationServer } = await import('@/lib/analytics/activation-server');

type DB = SupabaseClient<Database>;
const FAMILY = '10000000-0000-4000-8000-000000000001';
let db: ReturnType<typeof createInMemorySupabase<DB>>;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

const outcomes = (userId: string) => trackActivationOnce({
  milestone: 'first_outcome_viewed', familyId: FAMILY, userId, signupAtIso: '2026-09-01T00:00:00.000Z',
});
const rowsFor = (userId: string) => db.table('activation_events').filter((row) => row.user_id === userId);
/** The database as Postgres answers an INTEGER column given a larger value: 22003, for the whole insert. */
const integerClockColumn = () => withFaults(db, (table, calls) => {
  const row = calls.find((call) => call.method === 'insert')?.args[0] as { ms_since_signup?: number | null } | undefined;
  return table === 'activation_events' && typeof row?.ms_since_signup === 'number' && row.ms_since_signup > 2_147_483_647
    ? { code: '22003', message: 'value is out of range for type integer' } : null;
});
/** Two months after the household signed up (2026-09-01). */
async function twoMonthsLater(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  db = createInMemorySupabase<DB>();
  h.client = db;
  vi.stubGlobal('window', {});
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('first value on a shared browser', () => {
  it('records each person who opens Outcomes, not only the first one in the family', async () => {
    await outcomes('parent-a');
    await outcomes('parent-b');
    expect(rowsFor('parent-a')).toHaveLength(1);
    expect(rowsFor('parent-b')).toHaveLength(1);
    expect(rowsFor('parent-b')[0]).toMatchObject({ family_id: FAMILY, session_id: FAMILY, milestone: 'first_outcome_viewed' });
  });

  it('still records each person once', async () => {
    await outcomes('parent-a');
    await outcomes('parent-a');
    expect(rowsFor('parent-a')).toHaveLength(1);
  });
});

describe('a write that did not land', () => {
  it('is retried on the next visit after the insert was refused', async () => {
    h.client = withFaults(db, (table) => (table === 'activation_events' ? { code: '42501', message: 'new row violates row-level security policy' } : null));
    await outcomes('parent-a');
    expect(rowsFor('parent-a')).toHaveLength(0);
    h.client = db;
    await outcomes('parent-a');
    expect(rowsFor('parent-a')).toHaveLength(1);
  });

  it('is retried on the next visit after the request never completed', async () => {
    h.client = { from: () => { throw new Error('fetch failed'); } };
    await outcomes('parent-a');
    h.client = db;
    await outcomes('parent-a');
    expect(rowsFor('parent-a')).toHaveLength(1);
  });

  it('records a member of a household older than the INTEGER clock column can hold, untimed', async () => {
    h.client = integerClockColumn();
    await twoMonthsLater(() => outcomes('parent-b'));
    expect(rowsFor('parent-b')).toEqual([expect.objectContaining({ ms_since_signup: null, session_index: 3 })]);
  });

  it('the server writer records an old household’s calendar import the same way', async () => {
    h.client = integerClockColumn();
    await twoMonthsLater(() => recordActivationServer({
      userId: 'parent-b', familyId: FAMILY, milestone: 'calendar_imported', signupAtIso: '2026-09-01T00:00:00.000Z',
    }));
    expect(rowsFor('parent-b')).toEqual([expect.objectContaining({ milestone: 'calendar_imported', ms_since_signup: null, session_index: 3 })]);
  });

  it('writes nothing for a viewer it cannot name', async () => {
    await trackActivationOnce({ milestone: 'first_outcome_viewed', familyId: FAMILY, userId: null });
    expect(db.table('activation_events')).toHaveLength(0);
  });
});
