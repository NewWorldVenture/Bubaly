// child_login_throttle no longer grows without bound (audit N7).
//
// Child sign-in reserves an attempt for every syntactically valid username
// typed, BEFORE the account lookup — deliberately, so the throttle is not a
// lookup oracle — and so an anonymous caller adds a durable row per guessed
// name, 30 a minute per address, for usernames that exist nowhere. Nothing ever
// removed them: the migration defines no prune and rate_limit_prune covers
// another table. Driven against the in-memory database through the real store
// and the real automations cron: rows whose window and any lock ended more than
// a day ago go; a live lock, a lock that lifted today and a fresh window stay.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults } from './helpers/in-memory-supabase';
import { DEFAULT_POLICY } from '@/lib/auth/child-throttle';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
// The runner's summary also counts the subjects its run budget cut off.
vi.mock('@/lib/marketing/automation-runner', () => ({ runAutomations: async () => ({ workflows: 0, fired: 0, failures: 0, unserved: 0 }) }));

const NOW = new Date('2026-10-21T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

type Db = ReturnType<typeof createInMemorySupabase>;
let db: Db;
const usernames = () => db.table('child_login_throttle').map((row) => row.username).sort();

function seed(target: Db) {
  target.seed('child_login_throttle', [
    // What a guessing run leaves behind: a username nobody has, from two days ago.
    { username: 'stale.guess', fails: 1, window_start: ago(2 * DAY), locked_until: null },
    // A lock that lifted long enough ago to have no escalation memory left.
    { username: 'lock.lifted.long.ago', fails: 5, window_start: ago(3 * DAY), locked_until: ago(2 * DAY) },
    // KEPT: its lock lifted an hour ago, so the next failure still escalates.
    { username: 'recently.unlocked', fails: 10, window_start: ago(2 * DAY), locked_until: ago(HOUR) },
    // KEPT: a live lock decides sign-in right now.
    { username: 'locked.now', fails: 5, window_start: ago(2 * DAY), locked_until: ahead(HOUR) },
    // KEPT: a window that is still counting.
    { username: 'fresh', fails: 1, window_start: ago(10 * 60_000), locked_until: null },
  ]);
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ rpc: { rate_limit_prune: () => null } });
  seed(db);
  h.db = db;
  vi.stubEnv('CRON_SECRET', 'cron-fixture-secret');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the prune', () => {
  it('removes rows whose window and any lock ended more than lockMemoryMs ago, and nothing else', async () => {
    const { pruneChildLoginThrottle } = await import('@/lib/auth/child-throttle-store');
    expect(await pruneChildLoginThrottle(db as never, NOW)).toBe(true);
    expect(usernames()).toEqual(['fresh', 'locked.now', 'recently.unlocked']);
  });

  it('removes what a guessing run writes, once the day has passed', async () => {
    const { pruneChildLoginThrottle, reserveChildLoginAttempt } = await import('@/lib/auth/child-throttle-store');
    db = createInMemorySupabase({ uniques: { child_login_throttle: [['username']] } });
    for (const guess of ['olivia', 'liam', 'emma']) expect(await reserveChildLoginAttempt(db as never, guess, NOW)).toEqual({ ok: true });
    expect(usernames()).toEqual(['emma', 'liam', 'olivia']);
    // Still today: every row is inside its window or its memory, and stays.
    expect(await pruneChildLoginThrottle(db as never, NOW)).toBe(true);
    expect(usernames()).toHaveLength(3);
    // Tomorrow, after lockMemoryMs: gone.
    expect(await pruneChildLoginThrottle(db as never, new Date(NOW.getTime() + DEFAULT_POLICY.lockMemoryMs + HOUR))).toBe(true);
    expect(usernames()).toEqual([]);
  });

  it('reports a delete the database refused as not landed', async () => {
    const { pruneChildLoginThrottle } = await import('@/lib/auth/child-throttle-store');
    const faulty = withFaults(db, (table) => (table === 'child_login_throttle' ? { code: '42501', message: 'permission denied' } : null));
    expect(await pruneChildLoginThrottle(faulty as never, NOW)).toBe(false);
    expect(usernames()).toHaveLength(5);
  });
});

describe('the daily automations cron', () => {
  async function cron() {
    const { GET } = await import('@/app/api/cron/automations/route');
    return GET(new NextRequest('https://bubaly.test/api/cron/automations', { headers: { authorization: 'Bearer cron-fixture-secret' } }));
  }

  it('prunes the throttle on the same tick as the limiter and says so', async () => {
    const response = await cron();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ rateLimitsPruned: true, childLoginThrottlePruned: true, ok: true });
    expect(usernames()).toEqual(['fresh', 'locked.now', 'recently.unlocked']);
  });

  it('answers 502 when the prune did not land, so a silent regrowth is not a clean run', async () => {
    h.db = withFaults(db, (table) => (table === 'child_login_throttle' ? { code: '42501', message: 'permission denied' } : null));
    const response = await cron();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ rateLimitsPruned: true, childLoginThrottlePruned: false, ok: false });
  });
});
