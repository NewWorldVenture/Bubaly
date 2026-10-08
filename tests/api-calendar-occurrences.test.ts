import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
const context = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('@/lib/supabase/bearer', async original => ({ ...await original<typeof import('@/lib/supabase/bearer')>(), getBearerUserContext: context.read }));
import { GET } from '@/app/api/calendar/occurrences/route';
let db: ReturnType<typeof createInMemorySupabase>;
const row = (id: string, starts_at: string, extra = {}) => ({ id, family_id: 'family', title: id, starts_at, ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null, location: null, category: 'family', ...extra });
const request = (query = 'fromDay=2026-03-08&days=3', headers = {}) => new NextRequest(`https://example.invalid/api/calendar/occurrences?${query}`, { headers: { authorization: 'Bearer synthetic.jwt', 'X-Bubaly-User-Id': 'user', 'X-Bubaly-Family-Id': 'family', ...headers } });
beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1 });
  context.read.mockReset().mockResolvedValue({ ok: true, supabase: db, ctx: { user: { id: 'user' }, active: { familyId: 'family', family: { timezone: 'America/New_York' } } } });
});
describe('native occurrence bearer endpoint with actual shared reader', () => {
  it('expands an old daily master across a gap and counts beyond the display limit', async () => {
    db.seed('calendar_events', [row('series', '2026-03-01T07:30:00.000Z', { recurrence: 'daily' }), row('foreign', '2026-03-09T09:00:00Z', { family_id: 'other' })]);
    const res = await GET(request('fromDay=2026-03-08&days=3&limit=1'));
    expect(res.status).toBe(200); expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(body.count).toBe(3); expect(body.occurrences).toHaveLength(1);
    // Native recurrence retains its existing pre-gap-offset policy.
    expect(body.occurrences[0].starts_at).toBe('2026-03-08T07:30:00.000Z');
    expect(body).toMatchObject({ userId: 'user', familyId: 'family', timezone: 'America/New_York' });
  });
  it('keeps civil DATE fields, ongoing overlap and unique recurring keys', async () => {
    db.seed('calendar_events', [row('day', '2026-03-07T00:00:00.000Z', { all_day: true, ends_at: '2026-03-10T00:00:00.000Z' }), row('daily', '2026-03-01T14:00:00.000Z', { recurrence: 'daily' })]);
    const body = await (await GET(request())).json();
    expect(body.count).toBe(4); expect(body.occurrences.find((r: { eventId: string }) => r.eventId === 'day')).toMatchObject({ startDate: '2026-03-07', endDate: '2026-03-10' });
    expect(new Set(body.occurrences.map((r: { occurrenceKey: string }) => r.occurrenceKey)).size).toBe(4);
  });
  it.each(['', 'Basic value', 'Bearer two words'])('rejects malformed bearer %s even with a browser cookie', async authorization => {
    expect((await GET(request(undefined, { authorization, cookie: 'admin=true' }))).status).toBe(401); expect(context.read).not.toHaveBeenCalled();
  });
  it.each([['invalid_token', 401], ['needs_family', 403], ['unavailable', 503]])('fails closed for %s', async (reason, status) => {
    context.read.mockResolvedValue({ ok: false, reason }); expect((await GET(request())).status).toBe(status);
  });
  it.each([{ 'X-Bubaly-User-Id': 'other' }, { 'X-Bubaly-Family-Id': 'other' }, { 'X-Bubaly-User-Id': '' }, { 'X-Bubaly-Family-Id': '' }])('requires the exact expected owner %j', async headers => {
    expect((await GET(request(undefined, headers))).status).toBe(409);
  });
  it.each(['fromDay=2026-02-30', 'fromDay=2026-01-01&days=32', 'fromDay=2026-01-01&limit=0'])('rejects invalid bounds %s', async query => { expect((await GET(request(query))).status).toBe(400); });
  it('executes the actual Supabase bearer SDK and shared reader through synthetic HTTP', async () => {
    const actual = await vi.importActual<typeof import('@/lib/supabase/bearer')>('@/lib/supabase/bearer');
    const oldUrl = process.env.NEXT_PUBLIC_SUPABASE_URL; const oldKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://calendar-fixture.supabase.co'; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'synthetic-anon';
    const reads: Array<{ path: string; family: string | null; authorization: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      reads.push({ path: url.pathname, family: url.searchParams.get('family_id'), authorization: headers.get('authorization') });
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'user', email: 'synthetic@example.invalid' });
      if (url.pathname.endsWith('/family_members')) return Response.json([{ id: 'member', family_id: 'family', user_id: 'user', role: 'parent', is_active: true }]);
      if (url.pathname.endsWith('/families')) return Response.json([{ id: 'family', timezone: 'America/New_York' }]);
      if (url.pathname.endsWith('/user_preferences')) return Response.json({ active_family_id: 'family' });
      if (url.pathname.endsWith('/calendar_events')) {
        const rows = url.searchParams.get('recurrence') === 'neq.none' ? [row('sdk-series', '2026-03-01T14:00:00.000Z', { recurrence: 'daily' })] : [];
        return Response.json(rows, { headers: { 'content-range': rows.length ? '0-0/1' : '*/0' } });
      }
      throw new Error(`Unexpected synthetic request ${url.pathname}`);
    });
    context.read.mockImplementation(actual.getBearerUserContext);
    try {
      const response = await GET(request()); const body = await response.json();
      expect(response.status).toBe(200); expect(body.count).toBe(3);
      expect(reads.find(r => r.path === '/auth/v1/user')?.authorization).toBe('Bearer synthetic.jwt');
      const calendarReads = reads.filter(r => r.path.endsWith('/calendar_events'));
      expect(calendarReads).toHaveLength(2); expect(calendarReads.every(r => r.family === 'eq.family' && r.authorization === 'Bearer synthetic.jwt')).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      if (oldUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = oldUrl;
      if (oldKey === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = oldKey;
    }
  });
});
