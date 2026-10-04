import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Preference = { user_id: string; email_enabled: unknown; [key: string]: unknown };
const h = vi.hoisted(() => ({
  db: null as SupabaseClient<Database> | null,
  userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as string | null,
  authError: false, authThrow: false, clientThrow: false,
  rows: [] as Preference[],
  readMode: 'healthy' as 'healthy' | 'error' | 'null' | 'object' | 'foreign' | 'malformed',
  writeMode: 'healthy' as 'healthy' | 'error' | 'empty' | 'null' | 'object' | 'foreign' | 'wrong-value' | 'duplicate' | 'throw',
  requests: [] as { method: string; query: string; body: Record<string, unknown> | null; prefer: string }[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => {
  if (h.clientThrow) throw new Error('Synthetic client unavailable');
  return h.db;
} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
import { getEmailPreferenceAction, setEmailPreferenceAction } from '@/app/(app)/settings/notification-actions';

beforeEach(() => {
  h.userId = A; h.authError = false; h.authThrow = false; h.clientThrow = false;
  h.rows = [{ user_id: A, email_enabled: true, theme: 'light', active_family_id: 'synthetic-family', notification_prefs: { quietHours: { start: 22 }, appLock: { enabled: true } } },
    { user_id: B, email_enabled: true, notification_prefs: { other: 'untouched' } }];
  h.readMode = 'healthy'; h.writeMode = 'healthy'; h.requests = [];
  h.db = createClient<Database>('https://preference-fixture.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://preference-fixture.invalid' || url.pathname !== '/rest/v1/user_preferences') throw new Error('Unexpected fixture destination');
      const query = url.searchParams;
      if (query.get('select') !== 'user_id,email_enabled') throw new Error('Incorrect preference projection');
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
      const prefer = new Headers(init?.headers).get('prefer') ?? '';
      h.requests.push({ method, query: url.search, body, prefer });
      const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
      const failure = () => response({ code: '42501', message: 'Synthetic policy refusal' }, 403);
      if (method === 'GET') {
        if (query.get('user_id') !== `eq.${h.userId}` || query.get('limit') !== '1') throw new Error('Missing self-only read');
        if (h.readMode === 'error') return failure();
        if (h.readMode === 'null') return response(null);
        if (h.readMode === 'object') return response({ user_id: A, email_enabled: true });
        if (h.readMode === 'foreign') return response([{ user_id: B, email_enabled: false }]);
        if (h.readMode === 'malformed') return response([{ user_id: A, email_enabled: 'false' }]);
        return response(h.rows.filter(row => row.user_id === h.userId).slice(0, 1).map(row => ({ user_id: row.user_id, email_enabled: row.email_enabled })));
      }
      if (method !== 'POST' || query.get('on_conflict') !== 'user_id' || !prefer.includes('resolution=merge-duplicates')
        || !prefer.includes('return=representation')) throw new Error('Incorrect preference upsert');
      if (!body || body.user_id !== h.userId || typeof body.email_enabled !== 'boolean'
        || Object.keys(body).sort().join(',') !== 'email_enabled,user_id') throw new Error('Unexpected owner or collateral preference write');
      if (h.writeMode === 'error') return failure();
      if (h.writeMode === 'throw') throw new Error('Synthetic transport failure');
      if (h.writeMode === 'empty') return response([]);
      if (h.writeMode === 'null') return response(null);
      if (h.writeMode === 'object') return response(body);
      if (h.writeMode === 'foreign') return response([{ ...body, user_id: B }]);
      if (h.writeMode === 'wrong-value') return response([{ ...body, email_enabled: !body.email_enabled }]);
      if (h.writeMode === 'duplicate') return response([body, body]);
      const found = h.rows.find(row => row.user_id === h.userId);
      if (found) found.email_enabled = body.email_enabled;
      else h.rows.push({ user_id: String(body.user_id), email_enabled: body.email_enabled });
      return response([body]);
    } },
  });
  // Identity verification is an inert boundary. Actual SDK Data API query
  // construction, response parsing and the full exported actions execute.
  vi.spyOn(h.db.auth, 'getUser').mockImplementation(async () => {
    if (h.authThrow) throw new Error('Synthetic identity verification unavailable');
    return { data: { user: h.userId ? { id: h.userId } as User : null }, error: h.authError ? new Error('Synthetic auth failure') : null } as Awaited<ReturnType<typeof h.db.auth.getUser>>;
  });
});
afterEach(() => vi.restoreAllMocks());

describe('own-user notification email preference actions through the actual SDK', () => {
  it.each([true, false])('reads the saved boolean %s for the authenticated user', async enabled => {
    h.rows[0].email_enabled = enabled;
    expect(await getEmailPreferenceAction()).toEqual({ ok: true, userId: A, enabled });
    expect(h.db!.auth.getUser).toHaveBeenCalledWith();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].method).toBe('GET');
  });

  it('defaults a truly absent preference row to enabled without writing', async () => {
    h.rows = h.rows.filter(row => row.user_id !== A);
    expect(await getEmailPreferenceAction()).toEqual({ ok: true, userId: A, enabled: true });
    expect(h.requests.map(request => request.method)).toEqual(['GET']);
  });

  it.each(['error', 'null', 'object', 'foreign', 'malformed'] as const)('refuses an unavailable or malformed %s read', async mode => {
    h.readMode = mode;
    expect(await getEmailPreferenceAction()).toEqual({ ok: false, error: 'assistantModule.somethingWentWrong' });
    expect(h.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it.each([null, undefined, 'true', 0, {}, []])('refuses a malformed stored preference %j', async enabled => {
    h.rows[0].email_enabled = enabled;
    expect((await getEmailPreferenceAction()).ok).toBe(false);
  });

  it.each(['missing', 'error', 'throw', 'client-throw'])('refuses both endpoints with %s identity verification', async failure => {
    h.userId = failure === 'missing' ? null : A;
    h.authError = failure === 'error'; h.authThrow = failure === 'throw'; h.clientThrow = failure === 'client-throw';
    expect((await getEmailPreferenceAction()).ok).toBe(false);
    expect((await setEmailPreferenceAction(false)).ok).toBe(false);
    expect(h.requests).toEqual([]);
  });

  it.each([null, undefined, 'false', 0, 1, {}, { user_id: B, enabled: false }, []])('refuses a non-boolean %j mutation at runtime', async input => {
    expect((await setEmailPreferenceAction(input as unknown as boolean)).ok).toBe(false);
    expect(h.requests).toEqual([]);
  });

  it.each([true, false])('saves and re-reads %s while retaining unrelated preferences and the other account', async enabled => {
    const unrelated = structuredClone(h.rows);
    expect(await setEmailPreferenceAction(enabled)).toEqual({ ok: true, userId: A, enabled });
    expect(await getEmailPreferenceAction()).toEqual({ ok: true, userId: A, enabled });
    expect(h.rows[0]).toEqual({ ...unrelated[0], email_enabled: enabled });
    expect(h.rows[1]).toEqual(unrelated[1]);
    expect(h.requests[0].body).toEqual({ user_id: A, email_enabled: enabled });
  });

  it('creates a previously absent own preference, and it survives another read', async () => {
    h.rows = h.rows.filter(row => row.user_id !== A);
    expect(await setEmailPreferenceAction(false)).toEqual({ ok: true, userId: A, enabled: false });
    expect(await getEmailPreferenceAction()).toEqual({ ok: true, userId: A, enabled: false });
    expect(h.rows.find(row => row.user_id === B)?.email_enabled).toBe(true);
  });

  it('does not accept an extra caller-supplied target user', async () => {
    const untrusted = setEmailPreferenceAction as unknown as (enabled: boolean, target: string) => ReturnType<typeof setEmailPreferenceAction>;
    expect(await untrusted(false, B)).toEqual({ ok: true, userId: A, enabled: false });
    expect(h.requests[0].body).toEqual({ user_id: A, email_enabled: false });
    expect(h.rows.find(row => row.user_id === B)?.email_enabled).toBe(true);
  });

  it.each(['empty', 'null', 'object', 'foreign', 'wrong-value', 'duplicate'] as const)('refuses to acknowledge a %s write receipt', async mode => {
    h.writeMode = mode;
    expect(await setEmailPreferenceAction(false)).toEqual({ ok: false, error: 'errors.thatChangeWasNotSaved' });
    expect(h.rows[0].email_enabled).toBe(true);
  });

  it.each(['error', 'throw'] as const)('settles a %s write failure without claiming success', async mode => {
    h.writeMode = mode;
    expect(await setEmailPreferenceAction(false)).toEqual({ ok: false, error: 'aiActions.couldNotSaveThoseSettings' });
    expect(h.rows[0].email_enabled).toBe(true);
  });

  it('uses the fresh authenticated identity on the next action instead of a cached account', async () => {
    await setEmailPreferenceAction(false);
    h.userId = B;
    expect(await getEmailPreferenceAction()).toEqual({ ok: true, userId: B, enabled: true });
    expect(await setEmailPreferenceAction(false)).toEqual({ ok: true, userId: B, enabled: false });
    expect(h.requests[2].body).toEqual({ user_id: B, email_enabled: false });
  });
});
