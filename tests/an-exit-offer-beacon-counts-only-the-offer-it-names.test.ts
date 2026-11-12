// POST /api/exit-intent/track (Register B API-1EA8BE1CCF2A), driven end to
// end through the real handler over the in-memory database.
//
// Public beacon: no session, household or role, so the member-role matrix is
// n/a and every caller here is anonymous. marketing_exit_intent is
// service-role only (RLS on, no policies, migration 0064); the counter moves
// through bump_exit_intent, a SECURITY DEFINER function granted to
// service_role alone. The RPC handler below is that function's body as 0064
// writes it (bump only an active, undeleted row; 'conversion' bumps
// conversions, anything else impressions), so the rows read back are what
// Postgres would hold.
//
// Already proven elsewhere and not repeated here:
//   tests/a-malformed-public-track-body-is-refused-not-a-500.test.ts — a
//     non-uuid or non-string id is 422 and reaches no RPC; a uuid reaches it.
//   tests/an-exit-offer-follows-consent-withdrawn-on-the-same-page.test.ts —
//     the browser only counts an offer it actually showed.
//   tests/public-side-effect-rate-limit.test.ts, tests/request-body-boundaries.test.ts,
//   tests/public-error-contract.test.ts — source scans.
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, bumps: [] as Record<string, unknown>[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { default: enUS } = await import('@/lib/i18n/messages/en-US.json');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(enUS, key, params),
  };
});

const SHOWN = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const OTHER = 'aaaaaaaa-0000-4000-8000-0000000000a2';
const INTERNAL = 'function bump_exit_intent: permission denied (internal detail)';

let db: InMemorySupabase;

function bumpExitIntent(args: Record<string, unknown>, d: InMemorySupabase) {
  h.bumps.push(args);
  const column = args.p_metric === 'conversion' ? 'conversions' : 'impressions';
  for (const row of d.table('marketing_exit_intent')) {
    if (row.id === args.p_id && row.status === 'active' && row.deleted_at === null) row[column] = Number(row[column]) + 1;
  }
  return null;
}

function seed(rpc: Record<string, (args: Record<string, unknown>, d: InMemorySupabase) => unknown> = {
  rate_limit_hit: rateLimitHit, bump_exit_intent: bumpExitIntent,
}) {
  db = createInMemorySupabase({ rpc });
  db.seed('marketing_exit_intent', [
    { id: SHOWN, name: 'Spring', headline: 'Wait', status: 'active', deleted_at: null, impressions: 3, conversions: 1 },
    { id: OTHER, name: 'Autumn', headline: 'Hold on', status: 'active', deleted_at: null, impressions: 7, conversions: 2 },
  ]);
  h.db = db;
}

async function post(body: unknown) {
  const { POST } = await import('@/app/api/exit-intent/track/route');
  return POST(new NextRequest('https://bubaly.example/api/exit-intent/track', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
    body: JSON.stringify(body),
  }));
}
const counters = () => db.table('marketing_exit_intent').map((r) => [r.id, r.impressions, r.conversions]);

beforeAll(async () => {
  await Promise.all([import('@/lib/i18n/messages/en-US.json'), import('@/app/api/exit-intent/track/route')]);
}, 120_000);

beforeEach(() => {
  vi.resetModules();
  h.bumps = [];
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('who may call it', () => {
  it('API-1EA8BE1CCF2A an anonymous visitor bumps the named offer’s impression, then its conversion, and no other offer', async () => {
    const seen = await post({ id: SHOWN });
    expect([seen.status, await seen.json()]).toEqual([200, { ok: true }]);
    const converted = await post({ id: ` ${SHOWN} `, kind: 'conversion' });
    expect([converted.status, await converted.json()]).toEqual([200, { ok: true }]);
    // An unknown kind is an impression, never a free-text metric.
    expect((await post({ id: SHOWN, kind: 'click' })).status).toBe(200);
    expect(h.bumps).toEqual([
      { p_id: SHOWN, p_metric: 'impression' },
      { p_id: SHOWN, p_metric: 'conversion' },
      { p_id: SHOWN, p_metric: 'impression' },
    ]);
    expect(counters()).toEqual([[SHOWN, 5, 2], [OTHER, 7, 2]]);
  });

  it('API-1EA8BE1CCF2A past the per-IP limit the caller is refused with Retry-After and nothing is bumped', async () => {
    for (let i = 0; i < 60; i += 1) expect((await post({ id: SHOWN })).status).toBe(200);
    const refused = await post({ id: SHOWN, kind: 'conversion' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(await refused.json()).toEqual({ error: 'Too many requests' });
    expect(h.bumps).toHaveLength(60);
    expect(counters()).toEqual([[SHOWN, 63, 1], [OTHER, 7, 2]]);
  });

  it('API-1EA8BE1CCF2A a durable limiter that refuses, or cannot answer, stops the bump (fails closed)', async () => {
    seed({ rate_limit_hit: () => [{ allowed: false, retry_after: 42 }], bump_exit_intent: bumpExitIntent });
    const refused = await post({ id: SHOWN });
    expect([refused.status, refused.headers.get('retry-after')]).toEqual([429, '42']);

    vi.resetModules();
    seed({ bump_exit_intent: bumpExitIntent });
    expect((await post({ id: SHOWN })).status).toBe(429);
    expect(h.bumps).toEqual([]);
    expect(counters()).toEqual([[SHOWN, 3, 1], [OTHER, 7, 2]]);
  });
});

describe('failure', () => {
  it('API-1EA8BE1CCF2A a failed RPC is a 500 with the catalogue sentence, never ok:true or the database text', async () => {
    seed({
      rate_limit_hit: rateLimitHit,
      bump_exit_intent: () => { throw new Error(INTERNAL); },
    });
    const res = await post({ id: SHOWN, kind: 'conversion' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Could not record the offer event.' });
    expect(text).not.toContain('permission denied');
    expect(console.error).toHaveBeenCalled();
    expect(counters()).toEqual([[SHOWN, 3, 1], [OTHER, 7, 2]]);
  });
});
