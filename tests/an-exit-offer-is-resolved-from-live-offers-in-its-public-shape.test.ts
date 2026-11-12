// POST /api/exit-intent/resolve (Register B API-A3760E1A3194), driven end to
// end through the real handler and the real resolveActiveExitIntent over the
// in-memory database.
//
// Public read: no session, household or role, so the member-role matrix is n/a
// and every caller here is anonymous. marketing_exit_intent is service-role
// only (RLS on, no policies, migration 0064), so the handler and
// lib/marketing/exit-intent-server.ts decide what an anonymous caller sees:
// one live (active, undeleted) offer, trimmed to the public shape — never the
// admin's name, audience rules, priority or counters.
//
// Already proven elsewhere and not repeated here:
//   tests/an-exit-offer-is-vetted-and-targeted-by-what-the-server-knows.test.ts —
//     country comes from the edge header, not the body; a forged
//     country/sessions/segments body chooses nothing; an unvetted CTA link is
//     served without a button.
//   tests/an-exit-offer-follows-consent-withdrawn-on-the-same-page.test.ts,
//   tests/an-exit-offer-is-not-chosen-by-visit-history-without-consent.test.ts —
//     `returning` true/false/absent each choose their own audience.
//   tests/provider-request-body-boundaries.test.ts — the bounded reader is used.
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const INTERNAL = 'permission denied for relation marketing_exit_intent (internal detail)';
let db: InMemorySupabase;

const offer = (id: string, extra: Row): Row => ({
  id, name: `admin name ${id}`, headline: `Offer ${id}`, body: null, cta_label: null, cta_href: null,
  match: {}, trigger_config: {}, priority: 0, status: 'active', deleted_at: null, impressions: 11, conversions: 4,
  metadata: { owner: 'marketing' }, created_by: 'aaaaaaaa-0000-4000-8000-0000000000ad',
  created_at: '2026-10-01T00:00:00.000Z', ...extra,
});

function seed(rpc: Record<string, (args: Record<string, unknown>, d: InMemorySupabase) => unknown> = { rate_limit_hit: rateLimitHit }) {
  db = createInMemorySupabase({ rpc });
  db.seed('marketing_exit_intent', [
    offer('aaaaaaaa-0000-4000-8000-0000000000b1', { priority: 1 }),
    offer('aaaaaaaa-0000-4000-8000-0000000000b2', {
      priority: 5, match: { paths: ['/pricing'], source: ['newsletter'] },
      headline: 'Before you go', body: 'Two months free on annual.', cta_label: 'See annual', cta_href: '/signup?plan=annual',
      trigger_config: { mode: 'scroll', delayMs: 999_999, scrollPercent: 140, secret: 'x' },
    }),
    // Higher priority but not live: never served.
    offer('aaaaaaaa-0000-4000-8000-0000000000b3', { priority: 50, status: 'paused' }),
    offer('aaaaaaaa-0000-4000-8000-0000000000b4', { priority: 60, deleted_at: '2026-10-02T00:00:00.000Z' }),
  ]);
  h.db = db;
}

async function resolve(body: unknown) {
  const { POST } = await import('@/app/api/exit-intent/resolve/route');
  return POST(new NextRequest('https://bubaly.example/api/exit-intent/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  }));
}
const offerReads = () => db.log.filter((entry) => entry.table === 'marketing_exit_intent').length;

beforeAll(async () => { await import('@/app/api/exit-intent/resolve/route'); }, 120_000);

beforeEach(() => {
  vi.resetModules();
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('who may call it', () => {
  it('API-A3760E1A3194 an anonymous visitor gets the best live matching offer in the public shape, and nothing is written', async () => {
    const before = structuredClone(db.table('marketing_exit_intent'));
    const res = await resolve({ path: '/pricing/family', source: 'newsletter', medium: 'email' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      offer: {
        id: 'aaaaaaaa-0000-4000-8000-0000000000b2',
        headline: 'Before you go',
        body: 'Two months free on annual.',
        cta_label: 'See annual',
        cta_href: '/signup?plan=annual',
        trigger: { mode: 'scroll', delayMs: 120_000, scrollPercent: 100 },
      },
    });
    // Resolving is not an impression: the counters and every row are as seeded.
    expect(db.table('marketing_exit_intent')).toEqual(before);
  });

  it('API-A3760E1A3194 a visitor outside the targeted audience gets the general offer; with none live, null', async () => {
    expect(((await (await resolve({ path: '/blog' })).json()) as { offer: { id: string } }).offer.id)
      .toBe('aaaaaaaa-0000-4000-8000-0000000000b1');
    db.replace('marketing_exit_intent', db.table('marketing_exit_intent').filter((r) => r.status === 'paused' || r.deleted_at !== null));
    const none = await resolve({ path: '/pricing', source: 'newsletter' });
    expect([none.status, await none.json()]).toEqual([200, { offer: null }]);
  });

  it('API-A3760E1A3194 past the per-IP limit the caller is refused before any offer is read', async () => {
    for (let i = 0; i < 60; i += 1) expect((await resolve({ path: '/blog' })).status).toBe(200);
    const reads = offerReads();
    const refused = await resolve({ path: '/blog' });
    expect([refused.status, await refused.json()]).toEqual([429, { offer: null }]);
    expect(offerReads()).toBe(reads);
  });

  it('API-A3760E1A3194 a durable limiter that refuses, or cannot answer, serves no offer (fails closed)', async () => {
    seed({ rate_limit_hit: () => [{ allowed: false, retry_after: 42 }] });
    expect((await resolve({ path: '/blog' })).status).toBe(429);
    vi.resetModules();
    seed({});
    const unavailable = await resolve({ path: '/blog' });
    expect([unavailable.status, await unavailable.json()]).toEqual([429, { offer: null }]);
    expect(offerReads()).toBe(0);
  });
});

describe('failure', () => {
  it('API-A3760E1A3194 a failed offer read serves no offer and leaks no database text', async () => {
    h.db = withFaults(db, (table) => (table === 'marketing_exit_intent' ? { message: INTERNAL } : null));
    const res = await resolve({ path: '/pricing', source: 'newsletter' });
    const text = await res.text();
    expect((JSON.parse(text) as { offer: unknown }).offer).toBeNull();
    expect(text).not.toContain('permission denied');
    expect(text).not.toContain('marketing_exit_intent');
  });
});
