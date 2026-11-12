// API-C06797833926 — POST /api/mkt/track, request level.
//
// The public visitor-intelligence ingest: upserts mkt_visitors by the
// `bubaly_vid` cookie (SEC-007) and writes one mkt_sessions and one
// mkt_touchpoints row, only when the visitor's consent allows analytics.
// Service-role over tables with RLS on and no policies; no session is read.
//
// Already proven elsewhere, and not repeated here:
//   tests/a-visit-is-recorded-only-against-the-browser-that-sent-it.test.ts —
//     naming another visitor is 403 before consent is read and changes nothing
//     of theirs; a denier is not profiled; the browser's own visit is recorded
//     (hand-built store, limiter mocked).
//   tests/a-first-visit-with-two-events-records-both.test.ts — the create race
//     and a failed create answered 503 (consent and limiter mocked).
//   tests/a-route-write-is-confirmed.test.ts — the visitor update is confirmed
//     (source scan); tests/request-body-boundaries.test.ts — bounded body.
//
// Added here, over the in-memory database with the real consent reader and the
// real limiter: the rows a first and a returning visit write, field by field; a
// GPC browser with no decision is not profiled; a signed-in member of any role
// is one more browser and no session is read; another visitor's rows are left
// as they were; the 60-a-minute limit (local and durable) refusing before any
// write; a failed consent read and a failed attribution write answered 503,
// never `recorded: true`.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, createServer: vi.fn(), durableRefuses: false }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: h.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const MINE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const THEIRS = '9f8b2c11-1d2e-4a3b-8c4d-5e6f70819a2b';
const THEIR_ROW = '7a000000-0000-4000-8000-0000000000aa';
const FAMILY_A = '4a000000-0000-4000-8000-00000000000a';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const PRIVATE_DETAIL = 'mkt_sessions_visitor_id_fkey internal detail';

let db: InMemorySupabase;

beforeEach(() => {
  vi.resetModules();
  h.createServer.mockReset();
  h.durableRefuses = false;
  db = createInMemorySupabase({
    uniques: { mkt_visitors: [['anonymous_id']] },
    rpc: { rate_limit_hit: (args, store) => (h.durableRefuses ? [{ allowed: false, retry_after: 41 }] : rateLimitHit(args, store)) },
  });
  db.seed('mkt_visitors', [{ id: THEIR_ROW, anonymous_id: THEIRS, session_count: 3, device_type: 'desktop', country: 'NL', last_seen: '2026-01-01T00:00:00.000Z' }]);
  db.seed('mkt_sessions', [{ visitor_id: THEIR_ROW, source: 'theirs', medium: null, campaign: null, landing_path: '/' }]);
  db.seed('family_members', [{ family_id: FAMILY_A, user_id: 'user-a', role: 'parent', is_active: true, display_name: 'Parent A' }]);
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

async function track(body: unknown, ip: string, visitor?: string, extraCookie?: string) {
  const cookie = [visitor ? `bubaly_vid=${visitor}` : null, extraCookie ?? null].filter(Boolean).join('; ');
  const request = new NextRequest('https://bubaly.example/api/mkt/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return (await import('@/app/api/mkt/track/route')).POST(request);
}

const visitor = (anonymousId: string) => db.table('mkt_visitors').find((row) => row.anonymous_id === anonymousId);
const sessionsOf = (id: unknown) => db.table('mkt_sessions').filter((row) => row.visitor_id === id);
const touchesOf = (id: unknown) => db.table('mkt_touchpoints').filter((row) => row.visitor_id === id);
const theirsSnapshot = () => structuredClone({ visitor: visitor(THEIRS), sessions: sessionsOf(THEIR_ROW), touches: touchesOf(THEIR_ROW) });

describe('API-C06797833926 POST /api/mkt/track', () => {
  it('API-C06797833926 a first signed-out visit creates the visitor and one session and one touch, fields cleaned', async () => {
    const response = await track({
      source: '  newsletter ', medium: 'email', campaign: 'c'.repeat(250), landingPath: '/pricing',
      deviceType: 'mobile', country: 'DE', kind: 'conversion',
    }, '203.0.113.50', MINE);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, recorded: true });
    const me = visitor(MINE);
    expect(me).toMatchObject({ anonymous_id: MINE, session_count: 1, device_type: 'mobile', country: 'DE' });
    expect(sessionsOf(me?.id).map(({ source, medium, campaign, landing_path }) => ({ source, medium, campaign: String(campaign).length, landing_path })))
      .toEqual([{ source: 'newsletter', medium: 'email', campaign: 200, landing_path: '/pricing' }]);
    expect(touchesOf(me?.id).map(({ source, kind }) => ({ source, kind }))).toEqual([{ source: 'newsletter', kind: 'conversion' }]);
  });

  it('API-C06797833926 a returning visit bumps the session count and writes one more session and touch on the same visitor', async () => {
    await track({ source: 'ad', deviceType: 'mobile' }, '203.0.113.51', MINE);
    const id = visitor(MINE)?.id;
    const response = await track({ source: 'search', deviceType: 'tablet', kind: 'weird' }, '203.0.113.51', MINE);
    expect(await response.json()).toEqual({ ok: true, recorded: true });
    expect(db.table('mkt_visitors').filter((row) => row.anonymous_id === MINE)).toHaveLength(1);
    expect(visitor(MINE)).toMatchObject({ id, session_count: 2, device_type: 'tablet' });
    expect(sessionsOf(id).map((row) => row.source)).toEqual(['ad', 'search']);
    expect(touchesOf(id).map((row) => row.kind)).toEqual(['touch', 'touch']);
  });

  it('API-C06797833926 a GPC browser that never chose is acknowledged and not profiled', async () => {
    const response = await track({ source: 'ad', gpc: true }, '203.0.113.52', MINE);
    expect(await response.json()).toEqual({ ok: true, recorded: false, reason: 'analytics_consent_absent' });
    expect(visitor(MINE)).toBeUndefined();
    expect(db.table('mkt_touchpoints')).toEqual([]);
  });

  it.each(ROLES)('API-C06797833926 a signed-in %s is one more browser: recorded the same, no session read, no household table touched', async (role) => {
    db.table('family_members')[0].role = role;
    const response = await track({ source: 'ad' }, '203.0.113.53', MINE, 'sb-bubaly-auth-token=member-session');
    expect(await response.json()).toEqual({ ok: true, recorded: true });
    expect(h.createServer).not.toHaveBeenCalled();
    expect(db.log.every((entry) => entry.table.startsWith('mkt_'))).toBe(true);
  });

  it('API-C06797833926 this browser\'s visit leaves another visitor\'s profile and rows as they were', async () => {
    const before = theirsSnapshot();
    await track({ source: 'ad', deviceType: 'mobile', country: 'KP' }, '203.0.113.54', MINE);
    const named = await track({ anonymousId: THEIRS, source: 'forged' }, '203.0.113.54', MINE);
    expect(named.status).toBe(403);
    expect(theirsSnapshot()).toEqual(before);
  });

  it('API-C06797833926 the 61st event from one address in a minute is 429 with Retry-After and writes nothing', async () => {
    for (let i = 0; i < 60; i++) expect((await track({ source: 'ad' }, '203.0.113.55', MINE)).status).toBe(200);
    const refused = await track({ source: 'ad' }, '203.0.113.55', MINE);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(visitor(MINE)?.session_count).toBe(60);
    expect(sessionsOf(visitor(MINE)?.id)).toHaveLength(60);
  });

  it('API-C06797833926 a durable bucket spent on another instance refuses before consent or any write', async () => {
    h.durableRefuses = true;
    const response = await track({ source: 'ad' }, '203.0.113.56', MINE);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('41');
    expect(db.log).toEqual([]);
  });

  it('API-C06797833926 a failed consent read is 503 and profiles nobody (never the analytics-on default)', async () => {
    h.db = withFaults(db, (table) => (table === 'mkt_consent_events' ? { code: '57014', message: PRIVATE_DETAIL } : null));
    const response = await track({ source: 'ad' }, '203.0.113.57', MINE);
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'track.analyticsIsTemporarilyUnavailable' });
    expect(text).not.toContain(PRIVATE_DETAIL);
    expect(visitor(MINE)).toBeUndefined();
  });

  it('API-C06797833926 a failed session write is 503, not recorded: true', async () => {
    h.db = withFaults(db, (table) => (table === 'mkt_sessions' ? { code: '23503', message: PRIVATE_DETAIL } : null));
    const response = await track({ source: 'ad' }, '203.0.113.58', MINE);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(PRIVATE_DETAIL);
    expect(sessionsOf(visitor(MINE)?.id)).toEqual([]);
  });
});
