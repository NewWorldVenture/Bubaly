import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveChildPassword } from '@/lib/onboarding/child-password';
import { DEFAULT_POLICY } from '@/lib/auth/child-throttle';

/**
 * A burst of PIN guesses meets the per-username lock. (SEC-019)
 *
 * Sign-in read `child_login_throttle`, checked the PIN, and only then wrote the
 * failure back — a read-modify-write across the password request. Every guess
 * in a concurrent burst read the same count, passed the same gate, and wrote the
 * same "one more". On the local stack, against the real action: 25 concurrent
 * wrong PINs all reached the password check and left `fails = 1`, and the right
 * PIN placed 21st in such a burst signed in. A 4-digit PIN is 10,000 guesses.
 *
 * The table double below is what makes this a test of the race rather than of
 * the spelling: every call resolves on a later macrotask, so concurrent actions
 * interleave the way PostgREST requests do, and a conditional update is judged
 * against the row as it is WHEN it runs, not as it was read.
 */

type Row = { fails: number; window_start: string; locked_until: string | null };
const CHILD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RIGHT_PIN = '4321';

const state = vi.hoisted(() => ({
  rows: new Map<string, { fails: number; window_start: string; locked_until: string | null }>(),
  known: true,
  failInsert: false,
  neverMatch: false,
  checked: [] as string[],
  // Runs once, between a reservation's read and its conditional write.
  interleave: null as null | (() => void),
}));

const later = <T>(value: () => T): Promise<T> => new Promise(resolve => setTimeout(() => resolve(value()), 0));

function throttleTable() {
  const filters: Array<[string, 'eq' | 'is', unknown]> = [];
  let patch: Row | null = null;
  const matches = (username: string, row: Row | undefined) => row !== undefined && filters.every(([column, op, value]) => {
    const actual = column === 'username' ? username : row[column as keyof Row];
    return op === 'is' ? actual === value : actual === value;
  });
  const target = () => filters.find(([column]) => column === 'username')?.[2] as string;
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters.push([column, 'eq', value]); return chain; },
    is: (column: string, value: unknown) => { filters.push([column, 'is', value]); return chain; },
    update: (value: Row) => { patch = value; return chain; },
    maybeSingle: () => later(() => {
      const username = target();
      const row = state.rows.get(username);
      if (!patch) return { data: row ? { ...row } : null, error: null };
      if (state.interleave) { const write = state.interleave; state.interleave = null; write(); }
      const current = state.rows.get(username);
      if (state.neverMatch || !matches(username, current)) return { data: null, error: null };
      state.rows.set(username, { ...patch });
      return { data: { username }, error: null };
    }),
    insert: (value: Row & { username: string }) => later(() => {
      if (state.failInsert) return { error: { code: 'XX000', message: 'synthetic write failure' } };
      if (state.rows.has(value.username)) return { error: { code: '23505', message: 'duplicate key' } };
      const { username, ...row } = value;
      state.rows.set(username, row);
      return { error: null };
    }),
    upsert: (value: Row & { username: string }) => later(() => {
      const { username, ...row } = value;
      state.rows.set(username, row);
      return { error: null };
    }),
  };
  return chain;
}

vi.mock('next/headers', () => ({ cookies: async () => { throw new Error('cookies'); }, headers: async () => new Headers({ 'x-forwarded-for': '192.0.2.1' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: vi.fn(), isSuperAdmin: vi.fn() }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: () => { throw new Error('Cookie-bound auth must not run'); },
  createServiceClient: () => ({ from: (table: string) => {
    if (table === 'child_login_throttle') return throttleTable();
    const lookup = { select: () => lookup, eq: () => lookup,
      limit: () => later(() => ({ data: state.known ? [{ username: 'emma', user_id: CHILD }] : [], error: null })) };
    return lookup;
  } }),
}));
vi.mock('@supabase/supabase-js', async importOriginal => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return { ...actual, createClient: (url: string, key: string, options: Parameters<typeof actual.createClient>[2]) =>
    actual.createClient(url, key, { ...options, global: { ...options?.global, fetch: provider } }) };
});

function receipt() {
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: CHILD, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.');
  return { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
    user: { id: CHILD, email: 'child.emma@kids.bubaly.app', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-24T00:00:00Z' } };
}
async function provider(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { password } = JSON.parse(String(init?.body));
  state.checked.push(password);
  await later(() => undefined);
  const right = password === deriveChildPassword('synthetic-child-secret', 'emma', RIGHT_PIN);
  return new Response(JSON.stringify(right ? receipt() : { error_code: 'invalid_credentials', msg: 'Invalid login credentials' }),
    { status: right ? 200 : 400, headers: { 'content-type': 'application/json' } });
}

import { childSignInAction } from '@/app/(auth)/actions';

const guess = (pin: string, username = 'emma') => childSignInAction({ username, pin });
const outcome = (r: Awaited<ReturnType<typeof childSignInAction>>) =>
  r.ok ? 'SIGNED IN' : r.error === 'actions.tooManyTriesTryAgainIn' ? 'LOCKED' : r.error;
const tally = (results: string[]) => results.reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {});
const wrongPins = (n: number, from = 1000) => Array.from({ length: n }, (_, i) => String(from + i));

beforeEach(() => {
  vi.stubEnv('CHILD_LOGIN_SECRET', 'synthetic-child-secret');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://child-burst-fixture.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon');
  state.rows.clear(); state.known = true; state.failInsert = false; state.neverMatch = false; state.checked = [];
  state.interleave = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the control: what a real child and a patient guesser each get', () => {
  it('signs a child in with the right PIN and leaves a clean slate', async () => {
    expect(outcome(await guess('1111'))).toBe('actions.thatUsernameOrPinIsn');
    expect(outcome(await guess(RIGHT_PIN))).toBe('SIGNED IN');
    expect(state.rows.get('emma')).toMatchObject({ fails: 0, locked_until: null });
  });

  it('locks a sequential guesser after the policy allows', async () => {
    const results: string[] = [];
    for (const pin of wrongPins(DEFAULT_POLICY.maxFails + 2)) results.push(outcome(await guess(pin)));
    expect(tally(results)).toEqual({ 'actions.thatUsernameOrPinIsn': DEFAULT_POLICY.maxFails, LOCKED: 2 });
    expect(state.checked).toHaveLength(DEFAULT_POLICY.maxFails);
  });
});

describe('a concurrent burst gets no more guesses than a sequential one', () => {
  it('checks at most the allowance out of 25 concurrent wrong PINs, and the rest meet the lock', async () => {
    const results = (await Promise.all(wrongPins(25).map(pin => guess(pin)))).map(outcome);
    expect(state.checked).toHaveLength(DEFAULT_POLICY.maxFails);
    expect(tally(results)).toEqual({ 'actions.thatUsernameOrPinIsn': DEFAULT_POLICY.maxFails, LOCKED: 25 - DEFAULT_POLICY.maxFails });
    const row = state.rows.get('emma')!;
    expect(row.fails).toBe(DEFAULT_POLICY.maxFails);
    expect(Date.parse(row.locked_until!)).toBeGreaterThan(Date.now());
  });

  it('refuses the right PIN when it arrives after the allowance in a burst, without checking it', async () => {
    const pins = wrongPins(25); pins[20] = RIGHT_PIN;
    const results = (await Promise.all(pins.map(pin => guess(pin)))).map(outcome);
    expect(results).not.toContain('SIGNED IN');
    expect(state.checked).not.toContain(deriveChildPassword('synthetic-child-secret', 'emma', RIGHT_PIN));
  });

  it('spends an unknown username the same way, so the lock is not a lookup oracle', async () => {
    state.known = false;
    const results = (await Promise.all(wrongPins(25).map(pin => guess(pin)))).map(outcome);
    expect(tally(results)).toEqual({ 'actions.thatUsernameOrPinIsn': DEFAULT_POLICY.maxFails, LOCKED: 25 - DEFAULT_POLICY.maxFails });
    expect(state.checked).toHaveLength(0);
  });
});

describe('the lock speaks the child\'s language', () => {
  it('answers a locked account from the catalogue, with whole minutes to wait', async () => {
    // Was a template literal in English — "Too many tries. Try again in 15
    // minutes." — whatever language the family had chosen.
    const params: Array<Record<string, unknown> | undefined> = [];
    const i18n = await import('@/lib/i18n/server');
    vi.spyOn(i18n, 'getTranslations').mockResolvedValue(((key: string, p?: Record<string, unknown>) => { params.push(p); return key; }) as never);
    state.rows.set('emma', { fails: 5, window_start: new Date().toISOString(), locked_until: new Date(Date.now() + 14.2 * 60_000).toISOString() });
    expect(await guess('1234')).toEqual({ ok: false, error: 'actions.tooManyTriesTryAgainIn' });
    expect(params.at(-1)).toEqual({ minutes: 15 });
  });
});

describe('an attempt that cannot be counted is not attempted', () => {
  it('refuses before the password check when the count cannot be written', async () => {
    state.failInsert = true;
    expect(outcome(await guess(RIGHT_PIN))).toBe('actions.kidSignInIsTemporarily');
    expect(state.checked).toHaveLength(0);
  });

  it('never writes over a row that changed after it was read — not even only its lock', async () => {
    // Every writer today moves window_start with the lock, but the reservation
    // compares the whole row it read: a write that set only the lock would
    // otherwise be overwritten with the reader's stale "unlocked".
    const windowStart = new Date().toISOString();
    state.rows.set('emma', { fails: 1, window_start: windowStart, locked_until: null });
    const lockedUntil = new Date(Date.now() + 600_000).toISOString();
    state.interleave = () => state.rows.set('emma', { fails: 1, window_start: windowStart, locked_until: lockedUntil });
    expect(outcome(await guess(RIGHT_PIN))).toBe('LOCKED');
    expect(state.rows.get('emma')!.locked_until).toBe(lockedUntil);
    expect(state.checked).toHaveLength(0);
  });

  it('refuses, rather than admits, a guess that keeps losing the compare-and-set', async () => {
    state.rows.set('emma', { fails: 1, window_start: new Date().toISOString(), locked_until: null });
    state.neverMatch = true;
    expect(outcome(await guess(RIGHT_PIN))).toBe('actions.kidSignInIsTemporarily');
    expect(state.checked).toHaveLength(0);
  });
});
