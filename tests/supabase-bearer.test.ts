import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const tables: Record<string, { rows?: Row[]; error?: unknown; single?: Row | null }> = {};
let authUser: { id: string; email?: string } | null = null;
let lastToken: string | null = null;
let lastClientOptions: Record<string, unknown> | null = null;

function chain(table: string) {
  const t = tables[table] ?? {};
  const c: Record<string, unknown> = {
    select: () => c, eq: () => c, in: () => c,
    maybeSingle: () => Promise.resolve({ data: t.single ?? null, error: t.error ?? null }),
    then: (onF: (v: { data: Row[] | null; error: unknown }) => unknown) => Promise.resolve({ data: t.error ? null : (t.rows ?? []), error: t.error ?? null }).then(onF),
  };
  return c;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: (_url: string, _key: string, options: Record<string, unknown>) => {
    lastClientOptions = options;
    return {
      auth: { getUser: async (token: string) => { lastToken = token; return authUser ? { data: { user: authUser }, error: null } : { data: { user: null }, error: { message: 'bad jwt' } }; } },
      from: (table: string) => chain(table),
    };
  },
}));

import { createBearerClient, extractBearerToken, getBearerUserContext } from '@/lib/supabase/bearer';

describe('extractBearerToken', () => {
  it('accepts a well-formed header, case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def-ghi_jkl')).toBe('abc.def-ghi_jkl');
    expect(extractBearerToken('bearer  abc')).toBe('abc');
    expect(extractBearerToken('  Bearer abc  ')).toBe('abc');
  });
  it('rejects missing, empty, or non-bearer headers', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('')).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer a b')).toBeNull();
  });
});

describe('createBearerClient', () => {
  it('binds the token as the Authorization header without persisting a session', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://abc.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    createBearerClient('tok');
    expect(lastClientOptions).toEqual({
      global: { headers: { Authorization: 'Bearer tok' } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  });
});

describe('getBearerUserContext', () => {
  beforeEach(() => {
    for (const k of Object.keys(tables)) delete tables[k];
    authUser = { id: 'user-1', email: 'a@b.c' };
    lastToken = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('rejects an invalid token', async () => {
    authUser = null;
    const res = await getBearerUserContext('bad');
    expect(res).toEqual({ ok: false, reason: 'invalid_token' });
    expect(lastToken).toBe('bad');
  });

  it('reports needs_family when the user has no active membership', async () => {
    tables.family_members = { rows: [] };
    const res = await getBearerUserContext('tok');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('needs_family');
  });

  it('resolves the active family from user preferences, falling back to the first membership', async () => {
    tables.family_members = { rows: [
      { id: 'm1', family_id: 'fam-1', user_id: 'user-1', role: 'parent', is_active: true },
      { id: 'm2', family_id: 'fam-2', user_id: 'user-1', role: 'adult', is_active: true },
    ] };
    tables.families = { rows: [{ id: 'fam-1', name: 'One', timezone: 'UTC' }, { id: 'fam-2', name: 'Two', timezone: 'UTC' }] };
    tables.user_preferences = { single: { active_family_id: 'fam-2' } };
    const res = await getBearerUserContext('tok');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ctx.user).toEqual({ id: 'user-1', email: 'a@b.c' });
      expect(res.ctx.active.familyId).toBe('fam-2');
      expect(res.ctx.active.role).toBe('adult');
      expect(res.ctx.memberships).toHaveLength(2);
    }

    tables.user_preferences = { single: null };
    const fallback = await getBearerUserContext('tok');
    if (fallback.ok) expect(fallback.ctx.active.familyId).toBe('fam-1');
  });

  it('fails closed when a membership has no family row or a read errors', async () => {
    tables.family_members = { rows: [{ id: 'm1', family_id: 'fam-1', user_id: 'user-1', role: 'parent', is_active: true }] };
    tables.families = { rows: [] };
    const missing = await getBearerUserContext('tok');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe('unavailable');

    tables.family_members = { error: { message: 'boom' } };
    const errored = await getBearerUserContext('tok');
    expect(errored.ok).toBe(false);
    if (!errored.ok) expect(errored.reason).toBe('unavailable');
  });
});
