import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, unavailable: false }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => {
  if (h.unavailable) throw new Error('service unavailable');
  return h.db;
} }));

const { readAppLockRecord, replaceAppLockRecord } = await import('@/lib/security/app-lock-store');
const USER = '10000000-0000-4000-8000-000000000001';
const OTHER = '10000000-0000-4000-8000-000000000002';
const CONFIG = { enabled: true, salt: 'a'.repeat(32), hash: 'b'.repeat(64) };
let db: InMemorySupabase;

beforeEach(() => {
  vi.restoreAllMocks();
  db = createInMemorySupabase({ uniques: { app_lock_credentials: [['user_id']] } });
  h.db = db;
  h.unavailable = false;
});

describe('private App Lock storage', () => {
  it('reads only the identified user and never falls back to public preferences', async () => {
    db.seed('user_preferences', [{ user_id: USER, notification_prefs: { appLock: CONFIG } }]);
    const other = await replaceAppLockRecord(OTHER, null, CONFIG);
    expect(other.ok).toBe(true);
    expect(await readAppLockRecord(USER)).toEqual({ ok: true, record: null });
    const own = await replaceAppLockRecord(USER, null, CONFIG);
    expect(await readAppLockRecord(USER)).toEqual(own);
  });

  it('fences overlapping saves and preserves the winning PIN', async () => {
    const first = await replaceAppLockRecord(USER, null, CONFIG);
    if (!first.ok) throw new Error('fixture failed');
    const second = await replaceAppLockRecord(USER, first.record.revision, { ...CONFIG, hash: 'c'.repeat(64) });
    expect(second.ok).toBe(true);
    expect(await replaceAppLockRecord(USER, first.record.revision, null)).toEqual({ ok: false, reason: 'conflict' });
    expect(await replaceAppLockRecord(USER, null, CONFIG)).toEqual({ ok: false, reason: 'conflict' });
    expect(await readAppLockRecord(USER)).toEqual(second);
  });

  it('retains a tombstone with a new revision when clearing a PIN', async () => {
    const first = await replaceAppLockRecord(USER, null, CONFIG);
    if (!first.ok) throw new Error('fixture failed');
    const cleared = await replaceAppLockRecord(USER, first.record.revision, null);
    if (!cleared.ok) throw new Error('clear failed');
    expect(cleared.record.config).toBeNull();
    expect(cleared.record.revision).not.toBe(first.record.revision);
    expect(db.table('app_lock_credentials')).toHaveLength(1);
    expect(await replaceAppLockRecord(USER, null, CONFIG)).toEqual({ ok: false, reason: 'conflict' });
  });

  it('rotates the revision even if lock-now saves the same PIN', async () => {
    const first = await replaceAppLockRecord(USER, null, CONFIG);
    if (!first.ok) throw new Error('fixture failed');
    const locked = await replaceAppLockRecord(USER, first.record.revision, CONFIG);
    if (!locked.ok) throw new Error('lock failed');
    expect(locked.record.config).toEqual(CONFIG);
    expect(locked.record.revision).not.toBe(first.record.revision);
  });

  it('fails closed for service failure and malformed private records', async () => {
    h.unavailable = true;
    expect((await readAppLockRecord(USER)).ok).toBe(false);
    expect(await replaceAppLockRecord(USER, null, CONFIG)).toMatchObject({ ok: false, reason: 'unavailable' });
    h.unavailable = false;
    db.seed('app_lock_credentials', [{ user_id: USER, enabled: true, salt: null, hash: null, revision: '10000000-0000-4000-8000-000000000099' }]);
    expect((await readAppLockRecord(USER)).ok).toBe(false);
    expect(await replaceAppLockRecord(USER, null, { ...CONFIG, hash: 'bad' })).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('bounds private reads and writes and fails closed when real SDK transport waits for abort', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const budgets: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      budgets.push(ms);
      return timeout(5); // Exercise the real abort path without waiting five seconds.
    });
    const abortedMethods = new Set<string>();
    h.db = createClient('https://app-lock-fixture.invalid', 'fixture-key', {
      auth: { persistSession: false },
      global: { fetch: async (_url, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error('A private credential query must have a deadline');
        return await new Promise<Response>((_accept, reject) => {
          const abort = () => { abortedMethods.add(String(options?.method ?? 'GET')); reject(signal.reason); };
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      } },
    });
    const [read, write] = await Promise.all([
      readAppLockRecord(USER), replaceAppLockRecord(USER, null, CONFIG),
    ]);
    expect(budgets).toEqual([5_000, 5_000]);
    expect(abortedMethods).toEqual(new Set(['GET', 'POST']));
    expect(read.ok).toBe(false);
    expect(write).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});
