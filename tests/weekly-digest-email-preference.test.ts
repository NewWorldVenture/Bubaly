import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

type Preference = { user_id: string; email_enabled: boolean | null };
const h = vi.hoisted(() => ({
  db: null as unknown, authorized: true, families: 2,
  preferences: [] as Preference[], prefError: null as string | null,
  rejectPreference: false, sends: [] as string[], requests: [] as URL[],
  sendFailure: false, skippedProvider: false, missingAccount: false, backupAvailable: false,
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => h.authorized }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/network/compare-line', () => ({ renderCompareLine: () => null }));
vi.mock('@/lib/emails/weekly-digest', () => ({ WeeklyDigestEmail: () => null }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: async () => ({
  users: h.missingAccount ? [] : [
    ...Array.from({ length: h.families }, (_, i) => ({ id: user(i), email: `parent${i}@synthetic.invalid` })),
    ...(h.backupAvailable ? [{ id: user(20), email: 'backup-parent@synthetic.invalid' }] : []),
  ], error: null,
}) }));
vi.mock('@/lib/email', () => ({ sendReactEmail: async ({ to }: { to: string }) => {
  h.sends.push(to);
  return { ok: !h.sendFailure, ...(h.skippedProvider ? { skipped: true } : {}) };
} }));
import { GET } from '@/app/api/cron/weekly-digest/route';

function user(i: number) { return `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`; }
function family(i: number) { return `10000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`; }
function response(rows: unknown[], single: boolean, head: boolean) {
  return new Response(head ? null : JSON.stringify(single ? rows[0] ?? null : rows), {
    status: 200, headers: { 'content-type': 'application/json', 'content-range': `*/${rows.length}` },
  });
}
beforeEach(() => {
  h.authorized = true; h.families = 2; h.preferences = []; h.prefError = null;
  h.rejectPreference = false; h.sends = []; h.requests = [];
  h.sendFailure = false; h.skippedProvider = false; h.missingAccount = false; h.backupAvailable = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.db = createClient('https://synthetic.invalid', 'synthetic-non-provider-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? 'GET';
      if (url.origin !== 'https://synthetic.invalid' || !['GET', 'HEAD'].includes(method)) throw new Error('Unexpected synthetic transport');
      h.requests.push(url);
      const table = url.pathname.split('/').at(-1);
      const headers = new Headers(init?.headers);
      const single = headers.get('accept')?.includes('object+json') ?? false;
      let rows: Record<string, unknown>[];
      if (table === 'families') {
        rows = Array.from({ length: h.families }, (_, i) => ({ id: family(i), name: `Synthetic family ${i}`, timezone: 'UTC' }));
        expect(url.searchParams.get('order')).toBe('id.asc');
      } else if (table === 'family_members') {
        const i = Array.from({ length: h.families }, (_, j) => j).find(j => url.searchParams.get('family_id') === `eq.${family(j)}`);
        if (i === undefined) throw new Error('Unscoped family membership read');
        expect(url.searchParams.get('is_active')).toBe('eq.true');
        rows = [{ user_id: user(i), display_name: `Synthetic parent ${i}` }];
        if (h.backupAvailable && i === 0) rows.push({ user_id: user(20), display_name: 'Synthetic backup parent' });
      } else if (table === 'user_preferences') {
        expect(url.searchParams.get('select')).toBe('email_enabled');
        const own = url.searchParams.get('user_id');
        expect(own).toMatch(/^eq\./);
        if (h.rejectPreference) throw new Error('Synthetic preference transport failure');
        if (h.prefError === own?.slice(3)) return new Response(JSON.stringify({ code: 'XX000', message: 'Synthetic preference unavailable' }), { status: 503 });
        rows = h.preferences.filter(p => own === `eq.${p.user_id}`);
      } else if (['calendar_events', 'chore_assignments', 'meal_plans'].includes(table ?? '')) {
        expect(url.searchParams.get('family_id')).toMatch(/^eq\./); rows = [];
      } else throw new Error(`Unexpected table ${table}`);
      const from = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? rows.length);
      return response(rows.slice(from, from + limit), single, method === 'HEAD');
    } },
  });
});
afterEach(() => vi.restoreAllMocks());
const run = () => GET(new NextRequest('https://synthetic.invalid/api/cron/weekly-digest'));

describe('weekly digest personal email preference', () => {
  it.each([false, null])('withholds an opted-out recipient (%s) without choosing another parent', async email_enabled => {
    h.backupAvailable = true;
    h.preferences = [{ user_id: user(0), email_enabled }, { user_id: user(20), email_enabled: true }];
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0, skipped: 1 });
    expect(h.sends).toEqual(['parent1@synthetic.invalid']);
    expect(h.requests.filter(u => u.pathname.endsWith('/user_preferences')).map(u => u.searchParams.get('user_id')).sort()).toEqual([`eq.${user(0)}`, `eq.${user(1)}`]);
  });
  it('allows an explicitly enabled recipient', async () => {
    h.preferences = [{ user_id: user(0), email_enabled: true }];
    const res = await run(); expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 2, failed: 0, skipped: 0 });
  });
  it('allows missing preferences using the existing default', async () => {
    expect((await run()).status).toBe(200); expect(h.sends).toHaveLength(2);
  });
  it('does not use another household user’s opt-out', async () => {
    h.preferences = [{ user_id: user(20), email_enabled: false }];
    expect((await run()).status).toBe(200); expect(h.sends).toHaveLength(2);
  });
  it('counts one unavailable preference as failed and still serves the healthy family', async () => {
    h.prefError = user(0); const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: 1, failed: 1, skipped: 0 });
    expect(h.sends).toEqual(['parent1@synthetic.invalid']);
  });
  it('counts rejected preference transport as failures before any send', async () => {
    h.rejectPreference = true; const res = await run();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: 0, failed: 2, skipped: 0 });
    expect(h.sends).toEqual([]);
  });
  it('reads the exact chosen user before each allowed send', async () => {
    await run();
    expect(h.requests.filter(u => u.pathname.endsWith('/user_preferences')).map(u => u.searchParams.get('user_id')).sort()).toEqual([`eq.${user(0)}`, `eq.${user(1)}`]);
  });
  it('retains provider failure accounting', async () => {
    h.sendFailure = true; const res = await run();
    expect(res.status).toBe(502); expect(await res.json()).toEqual({ sent: 0, failed: 2, skipped: 0 });
  });
  it('retains absent-provider skip accounting', async () => {
    h.skippedProvider = true; const res = await run();
    expect(res.status).toBe(200); expect(await res.json()).toEqual({ sent: 0, failed: 0, skipped: 2 });
  });
  it('skips accounts with no email without reading preferences', async () => {
    h.missingAccount = true; const res = await run();
    expect(await res.json()).toEqual({ sent: 0, failed: 0, skipped: 2 });
    expect(h.requests.some(u => u.pathname.endsWith('/user_preferences'))).toBe(false);
  });
  it('does nothing for no families', async () => {
    h.families = 0; expect(await (await run()).json()).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(h.sends).toEqual([]);
  });
  it('refuses unauthorized cron before SDK requests', async () => {
    h.authorized = false; expect((await run()).status).toBe(401);
    expect(h.requests).toEqual([]); expect(h.sends).toEqual([]);
  });
});
