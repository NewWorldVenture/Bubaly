// A closed account stops serving the phone.
//
// closeAccountAction stamps families.closed_at and revalidates the web layout;
// it revokes no session, and the lock is the layout overlay plus the few routes
// that call refuseClosedOrTrialEnded or assertAIAccess. The Expo app holds a
// live Supabase JWT and never sees the overlay: getBearerUserContext loaded
// families.* and answered ok regardless of closed_at, so GET
// /api/calendar/occurrences kept returning the closed family's calendar for as
// long as the token lived — while /api/ai refused the same family with
// 'account_closed' through assertAIAccess.
//
// The bearer context now refuses a closed active family itself, for every
// bearer route at once, and the calendar route, /api/ai and authenticateAI
// answer it as the 403 the phone already understands. Only HTTP is synthetic:
// auth-js, the bearer resolver and the routes are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const token = 'synthetic.bearer.token';
const userId = 'synthetic-user';
const familyId = 'synthetic-family';
let reads: string[];
let closedAt: string | null;

const occurrences = () => new NextRequest(
  'https://app.example.invalid/api/calendar/occurrences?fromDay=2026-10-20&days=1',
  { headers: { authorization: `Bearer ${token}`, 'X-Bubaly-User-Id': userId, 'X-Bubaly-Family-Id': familyId } },
);

beforeEach(() => {
  reads = [];
  closedAt = null;
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://closed-family-fixture.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon');
  // The route's locked-family gate (refuseIfLocked) reads the plan with the
  // service client; the bearer refusal below runs first for a closed family.
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-role');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('https://closed-family-fixture.supabase.co');
    reads.push(url.pathname);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: userId, email: 'synthetic@example.invalid' });
    if (url.pathname === '/rest/v1/family_members') return Response.json([{ id: 'synthetic-member', family_id: familyId, user_id: userId, role: 'parent', is_active: true }]);
    if (url.pathname === '/rest/v1/families') return Response.json([{ id: familyId, timezone: 'UTC', closed_at: closedAt, trial_ends_at: null }]);
    if (url.pathname === '/rest/v1/subscriptions') return Response.json([]);
    if (url.pathname === '/rest/v1/user_preferences') return Response.json({ active_family_id: familyId });
    if (url.pathname === '/rest/v1/calendar_events') return Response.json([], { headers: { 'content-range': '*/0' } });
    throw new Error(`Unexpected synthetic request ${url.pathname}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('the bearer context', () => {
  it('refuses a closed active family with account_closed, and maps each refusal to its status', async () => {
    const { bearerRefusalStatus, getBearerUserContext } = await import('@/lib/supabase/bearer');
    closedAt = '2026-10-01T09:00:00Z';
    const ctx = await getBearerUserContext(token);
    expect(ctx).toMatchObject({ ok: false, reason: 'account_closed' });
    expect(bearerRefusalStatus('account_closed')).toBe(403);
    expect(bearerRefusalStatus('needs_family')).toBe(403);
    expect(bearerRefusalStatus('invalid_token')).toBe(401);
    expect(bearerRefusalStatus('unavailable')).toBe(503);
  });

  it('still resolves an open family (control)', async () => {
    const { getBearerUserContext } = await import('@/lib/supabase/bearer');
    const ctx = await getBearerUserContext(token);
    expect(ctx.ok).toBe(true);
  });
});

describe('GET /api/calendar/occurrences for a closed family', () => {
  it('answers 403 account_closed and reads no calendar', async () => {
    const { GET } = await import('@/app/api/calendar/occurrences/route');
    closedAt = '2026-10-01T09:00:00Z';
    const res = await GET(occurrences());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: 'account_closed' });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(reads).not.toContain('/rest/v1/calendar_events');
  });

  it('serves the same family once it reopens (control)', async () => {
    const { GET } = await import('@/app/api/calendar/occurrences/route');
    const res = await GET(occurrences());
    expect(res.status).toBe(200);
    expect(reads).toContain('/rest/v1/calendar_events');
  });
});

describe('the AI routes\' bearer half', () => {
  it('authenticateAI answers a closed family with the same 403 assertAIAccess gives it', async () => {
    const { authenticateAI } = await import('@/lib/server/ai-access');
    closedAt = '2026-10-01T09:00:00Z';
    const res = await authenticateAI(new NextRequest('https://app.example.invalid/api/ai/chef', { headers: { authorization: `Bearer ${token}` } }));
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'This Bubaly account is closed. Reopen it to continue.', code: 'account_closed', needLevel: 1 });
  });
});
