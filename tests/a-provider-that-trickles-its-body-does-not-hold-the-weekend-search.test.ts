// POST /api/weekend/discover: a keyed provider's reply is bounded in TIME as
// well as bytes (U6).
//
// `fetchWithTimeout` cleared its abort timer the moment `fetch` resolved —
// when the headers arrived — and the body was then read with a 2 MiB cap and
// no clock. A provider that trickled its body held the request until the
// platform's function limit; nothing in the route bounded it. The deadline now
// covers the body read too, so a body that never ends is a failed source like
// any other, and a search where every source failed is the 502 it always was.
//
// The REAL route, against an in-memory database, with `fetch` answering
// headers and then a body that never ends.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: null },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1', family_id: 'family-1' }, family: { id: 'family-1', timezone: 'America/Los_Angeles' } },
  }),
}));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({ fetchPublicCalendarText: async () => ({ ok: false, error: 'unreachable', status: 422 }) }));

const { POST } = await import('@/app/api/weekend/discover/route');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

let db: InMemorySupabase;
const search = () => POST(new NextRequest('https://fixture.invalid/api/weekend/discover', { method: 'POST', body: JSON.stringify({ zip: '94110', radius: 25, days: 6 }) }));
/** Headers now, a body that never ends. */
const trickling = () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>();
  harness.db = db;
  vi.stubEnv('TICKETMASTER_API_KEY', 'tm-fixture');
  vi.stubEnv('SEATGEEK_CLIENT_ID', '');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a provider that answers its headers and then trickles', () => {
  it('is a failed source once the deadline passes, and the search answers', async () => {
    vi.useFakeTimers();
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { fetched.push(String(url)); return trickling(); }));

    let answered: Response | null = null;
    const pending = search().then((res) => { answered = res; return res; });
    // The provider deadline is 9 s; nothing else in this search waits on a timer.
    await vi.advanceTimersByTimeAsync(9_500);
    for (let i = 0; i < 20 && !answered; i++) await vi.advanceTimersByTimeAsync(50);

    expect(fetched).toHaveLength(1);
    expect(answered, 'the search is still waiting on the provider body').not.toBeNull();
    const res = await pending;
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe(translate(SOURCE_MESSAGES, 'discover.eventSourcesUnreachable'));
    expect(body.errors).toEqual({ ticketmaster: 'Request failed.' });
    expect(db.table('weekend_events')).toEqual([]);
  });

  it('a provider that answers in time is still read whole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ _embedded: { events: [] } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const res = await search();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sources).toEqual(['ticketmaster']);
    expect(body.count).toBe(0);
  });
});
