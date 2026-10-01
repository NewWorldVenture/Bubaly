import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { activeFamilyTimeZone } from '@/lib/server/family-time-zone';

// Match the existing optional layout-data budget in social-links and SEO.
// Fake timers assert a deadline contract, not wall-clock runner performance.
const BUDGET_MS = 1_500;
const USER = '00000000-0000-4000-8000-000000000001';
const EARLY = '00000000-0000-4000-8000-000000000002';
const PREFERRED = '00000000-0000-4000-8000-000000000003';
const members = [
  { family_id: PREFERRED, created_at: '2026-01-01', families: { timezone: 'Asia/Tokyo' } },
  { family_id: EARLY, created_at: '2025-01-01', families: { timezone: 'UTC' } },
];
const cleanups: Array<() => void> = [];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type RequestRecord = { table: string; url: URL; signal?: AbortSignal | null };
function sdk(options: {
  rows?: unknown;
  preference?: unknown;
  memberError?: boolean;
  preferenceError?: boolean;
  hold?: 'family_members' | 'user_preferences' | 'both';
  ignoreAbort?: boolean;
  accessToken?: () => Promise<string | null>;
} = {}) {
  const requests: RequestRecord[] = [];
  const held: Array<{ request: RequestRecord; resolve: () => void; reject: () => void }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('https://fixture.invalid');
    const table = url.pathname.split('/').pop()!;
    expect(['family_members', 'user_preferences']).toContain(table);
    const request = { table, url, signal: init?.signal };
    requests.push(request);
    const result = () => table === 'family_members'
      ? reply(options.memberError ? { message: 'synthetic membership refusal' } : options.rows ?? members, options.memberError ? 400 : 200)
      : reply(options.preferenceError ? { message: 'synthetic preference refusal' } : options.preference === undefined ? { active_family_id: PREFERRED } : options.preference, options.preferenceError ? 400 : 200);
    if (options.hold === table || options.hold === 'both') {
      const pending = deferred<Response>();
      const onAbort = () => pending.reject(new DOMException('Synthetic abort', 'AbortError'));
      if (!options.ignoreAbort) {
        if (request.signal?.aborted) onAbort();
        else request.signal?.addEventListener('abort', onAbort, { once: true });
      }
      const release = () => pending.resolve(result());
      held.push({ request, resolve: release, reject: () => pending.reject(new Error('Synthetic late rejection')) });
      cleanups.push(release);
      try { return await pending.promise; }
      finally { request.signal?.removeEventListener('abort', onAbort); }
    }
    return result();
  });
  // Actual SDK auth-token acquisition and PostgREST thenables; no provider or
  // auth storage. The pre-fetch case holds this real SDK access-token seam.
  const client = createClient<Database>('https://fixture.invalid', 'synthetic-public-key', {
    accessToken: options.accessToken ?? (async () => 'synthetic-access-token'),
    global: { fetch },
  });
  return { client, requests, held, fetch };
}

function track(promise: Promise<string | undefined>) {
  const state: { done: boolean; value?: string; error?: unknown } = { done: false };
  const observed = promise.then(value => { state.done = true; state.value = value; }, error => { state.done = true; state.error = error; });
  return { state, observed };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  cleanups.splice(0).forEach(release => release());
  await vi.advanceTimersByTimeAsync(10_000);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('optional family timezone enrichment', () => {
  it('keeps active-family selection and the signed-in membership predicates', async () => {
    const f = sdk();
    await expect(activeFamilyTimeZone(f.client, USER)).resolves.toBe('Asia/Tokyo');
    expect(f.requests).toHaveLength(2);
    const member = f.requests.find(r => r.table === 'family_members')!;
    expect(member.url.searchParams.get('select')).toBe('family_id,created_at,families(timezone)');
    expect(member.url.searchParams.get('user_id')).toBe(`eq.${USER}`);
    expect(member.url.searchParams.get('is_active')).toBe('eq.true');
    expect(f.requests.find(r => r.table === 'user_preferences')!.url.searchParams.get('user_id')).toBe(`eq.${USER}`);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['missing preference', null],
    ['preference outside memberships', { active_family_id: 'not-a-membership' }],
  ])('keeps earliest-membership fallback for %s', async (_name, preference) => {
    await expect(activeFamilyTimeZone(sdk({ preference }).client, USER)).resolves.toBe('UTC');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps earliest-membership fallback for a refused preference read', async () => {
    await expect(activeFamilyTimeZone(sdk({ preferenceError: true }).client, USER)).resolves.toBe('UTC');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['no memberships', []],
    ['invalid zone', [{ family_id: PREFERRED, families: { timezone: 'Invalid/Zone' } }]],
    ['missing embedded family', [{ family_id: PREFERRED, families: null }]],
  ])('keeps the no-zone default for %s', async (_name, rows) => {
    await expect(activeFamilyTimeZone(sdk({ rows }).client, USER)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts the existing array-shaped family embed', async () => {
    await expect(activeFamilyTimeZone(sdk({ rows: [{ family_id: PREFERRED, families: [{ timezone: 'Europe/Berlin' }] }] }).client, USER)).resolves.toBe('Europe/Berlin');
  });

  it('falls back on a refused membership read', async () => {
    await expect(activeFamilyTimeZone(sdk({ memberError: true }).client, USER)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up when constructing a query throws', async () => {
    const client = { from: () => { throw new Error('synthetic construction failure'); } } as unknown as SupabaseClient<Database>;
    await expect(activeFamilyTimeZone(client, USER)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['family_members', 'user_preferences'] as const)('bounds a stalled %s response and cancels both reads', async hold => {
    const f = sdk({ hold });
    const result = track(activeFamilyTimeZone(f.client, USER));
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    expect(result.state.done).toBe(false);
    expect(f.held).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(result.state).toEqual({ done: true, value: undefined });
    expect(f.requests.every(r => r.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses one shared cancellation signal and one total deadline for both reads', async () => {
    const f = sdk({ hold: 'both' });
    const result = track(activeFamilyTimeZone(f.client, USER));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(f.requests[0].signal).toBe(f.requests[1].signal);
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(result.state).toEqual({ done: true, value: undefined });
    expect(f.requests[0].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['resolve', 'reject'] as const)('settles even when fetch ignores abort; late %s cannot change the fallback', async completion => {
    const f = sdk({ hold: 'family_members', ignoreAbort: true });
    const result = track(activeFamilyTimeZone(f.client, USER));
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(result.state).toEqual({ done: true, value: undefined });
    expect(f.held[0].request.signal?.aborted).toBe(true);
    f.held[0][completion]();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(result.state).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
    // Vitest also fails the run on an unhandled late rejection.
  });

  it('bounds SDK token acquisition before fetch has even started', async () => {
    const token = deferred<string>();
    cleanups.push(() => token.resolve('synthetic-access-token'));
    const f = sdk({ accessToken: () => token.promise });
    const result = track(activeFamilyTimeZone(f.client, USER));
    await vi.advanceTimersByTimeAsync(BUDGET_MS);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(result.state).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
    token.resolve('synthetic-access-token');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.every(r => r.signal?.aborted)).toBe(true);
    expect(result.state).toEqual({ done: true, value: undefined });
  });

  it('accepts a healthy answer just before the deadline and removes its timer', async () => {
    const f = sdk({ hold: 'family_members' });
    const result = track(activeFamilyTimeZone(f.client, USER));
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 1);
    f.held[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(result.state).toEqual({ done: true, value: 'Asia/Tokyo' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(result.state.value).toBe('Asia/Tokyo');
  });

  it('keeps deadlines and cancellation isolated between requests', async () => {
    const stalled = sdk({ hold: 'family_members' });
    const pending = track(activeFamilyTimeZone(stalled.client, USER));
    await vi.advanceTimersByTimeAsync(100);
    await expect(activeFamilyTimeZone(sdk().client, USER)).resolves.toBe('Asia/Tokyo');
    expect(stalled.held[0].request.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(BUDGET_MS - 100);
    expect(pending.state).toEqual({ done: true, value: undefined });
    expect(vi.getTimerCount()).toBe(0);
  });
});
