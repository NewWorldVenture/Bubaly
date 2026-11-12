// POST /api/ab/track (Register B API-7BACE12808B7), driven end to end through
// the real handler over the in-memory database.
//
// The route is public: there is no session, no household and no role, so the
// member-role matrix is n/a and every case here is an anonymous caller. Its
// boundary is the service-role write into ab_events (RLS on, no client
// policies, migration 0049), so what the handler checks IS the boundary:
// the per-IP rate limit, the experiment being running and undeleted, and the
// variant being one of THAT experiment's variants.
//
// Already proven elsewhere and not repeated here:
//   tests/a-visitor-is-hearted-subscribed-and-bucketed-only-as-itself.test.ts —
//     the visitor id comes from the bubaly_vid cookie, a named other visitor
//     is 403, an exposure is recorded and deduped, no cookie records a
//     visitor-less event, non-string fields are 422.
//   tests/public-side-effect-rate-limit.test.ts, tests/request-body-boundaries.test.ts,
//   tests/public-error-contract.test.ts — source scans for the limiter, the
//     bounded reader and no raw error.message in a response.
//   tests/a-refused-read-is-not-an-absence.test.ts — the experiment read's
//     `{ recorded: false }` on a failed lookup is triaged as honest.
import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { default: enUS } = await import('@/lib/i18n/messages/en-US.json');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(enUS, key, params),
  };
});

const VISITOR = 'aaaaaaaa-0000-4000-8000-00000000000a';
const INTERNAL = 'permission denied for relation ab_events (internal detail)';

let db: InMemorySupabase;

function seed(rpc: Record<string, (args: Record<string, unknown>, d: InMemorySupabase) => unknown> = { rate_limit_hit: rateLimitHit }) {
  db = createInMemorySupabase({ uniques: { ab_events: [['experiment_key', 'visitor_id', 'kind']] }, rpc });
  db.seed('ab_experiments', [
    { id: 'aaaaaaaa-0000-4000-8000-0000000000e1', key: 'hero', status: 'running', deleted_at: null,
      variants: [{ key: 'control', label: 'Control' }, { key: 'b', label: 'Variant B' }] },
    { id: 'aaaaaaaa-0000-4000-8000-0000000000e2', key: 'pricing', status: 'running', deleted_at: null,
      variants: [{ key: 'control', label: 'Control' }, { key: 'annual-first', label: 'Annual first' }] },
    { id: 'aaaaaaaa-0000-4000-8000-0000000000e3', key: 'paused-test', status: 'paused', deleted_at: null,
      variants: [{ key: 'control', label: 'Control' }] },
    { id: 'aaaaaaaa-0000-4000-8000-0000000000e4', key: 'retired', status: 'running', deleted_at: '2026-10-01T00:00:00.000Z',
      variants: [{ key: 'control', label: 'Control' }] },
  ]);
  db.seed('ab_events', []);
  h.db = db;
}

async function post(body: unknown, cookie?: string) {
  const { POST } = await import('@/app/api/ab/track/route');
  return POST(new NextRequest('https://bubaly.example/api/ab/track', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9',
      ...(cookie ? { cookie: `bubaly_vid=${cookie}` } : {}),
    },
    body: JSON.stringify(body),
  }));
}
const events = () => db.table('ab_events').map((r) => [r.experiment_key, r.variant_key, r.kind, r.visitor_id]);
const experimentReads = () => db.log.filter((entry) => entry.table === 'ab_experiments').length;

beforeAll(async () => {
  await Promise.all([import('@/lib/i18n/messages/en-US.json'), import('@/app/api/ab/track/route')]);
}, 120_000);

beforeEach(() => {
  vi.resetModules();
  seed();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('who may call it', () => {
  it('API-7BACE12808B7 an anonymous visitor records an exposure and a conversion, each once, under its own cookie', async () => {
    const exposure = await post({ experiment: 'hero', variant: 'b' }, VISITOR);
    expect([exposure.status, await exposure.json()]).toEqual([200, { ok: true, recorded: true }]);
    const conversion = await post({ experiment: 'hero', variant: 'b', kind: 'conversion' }, VISITOR);
    expect([conversion.status, await conversion.json()]).toEqual([200, { ok: true, recorded: true }]);
    // Any kind other than 'conversion' is an exposure, never a free-text kind.
    expect((await post({ experiment: 'pricing', variant: 'control', kind: 'purchase' }, VISITOR)).status).toBe(200);
    expect(events()).toEqual([
      ['hero', 'b', 'exposure', VISITOR],
      ['hero', 'b', 'conversion', VISITOR],
      ['pricing', 'control', 'exposure', VISITOR],
    ]);
  });

  it('API-7BACE12808B7 past the per-IP limit the caller is refused with Retry-After and writes nothing', async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await post({ experiment: 'hero', variant: 'control' })).status).toBe(200);
    }
    const before = db.table('ab_events').length;
    const reads = experimentReads();
    const refused = await post({ experiment: 'hero', variant: 'control' });
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
    expect(await refused.json()).toEqual({ error: 'Too many requests' });
    expect(db.table('ab_events')).toHaveLength(before);
    expect(experimentReads()).toBe(reads);
  });

  it('API-7BACE12808B7 a durable limiter that refuses, or cannot answer, stops the write (fails closed)', async () => {
    seed({ rate_limit_hit: () => [{ allowed: false, retry_after: 42 }] });
    const refused = await post({ experiment: 'hero', variant: 'b' }, VISITOR);
    expect([refused.status, refused.headers.get('retry-after')]).toEqual([429, '42']);

    vi.resetModules();
    seed({});
    const unavailable = await post({ experiment: 'hero', variant: 'b' }, VISITOR);
    expect(unavailable.status).toBe(429);
    expect(db.table('ab_events')).toEqual([]);
    expect(experimentReads()).toBe(0);
  });
});

describe('another experiment’s ids', () => {
  it('API-7BACE12808B7 a variant that belongs to a different experiment is 422 and lands nowhere', async () => {
    const res = await post({ experiment: 'hero', variant: 'annual-first' }, VISITOR);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: 'Unknown experiment variant' });
    expect(events()).toEqual([]);
  });

  it('API-7BACE12808B7 a paused, soft-deleted or unknown experiment records nothing and says so', async () => {
    for (const experiment of ['paused-test', 'retired', 'no-such-experiment']) {
      const res = await post({ experiment, variant: 'control' }, VISITOR);
      expect([experiment, res.status, await res.json()]).toEqual([experiment, 200, { ok: true, recorded: false }]);
    }
    expect(events()).toEqual([]);
  });
});

describe('failure', () => {
  it('API-7BACE12808B7 a failed insert is a 500 with the catalogue sentence, never the database text or a recorded:true', async () => {
    h.db = withFaults(db, (table, calls) =>
      table === 'ab_events' && calls.some((c) => c.method === 'insert') ? { code: '42501', message: INTERNAL } : null);
    const res = await post({ experiment: 'hero', variant: 'b' }, VISITOR);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'Could not record the experiment event.' });
    expect(text).not.toContain('permission denied');
    expect(console.error).toHaveBeenCalled();
    expect(db.table('ab_events')).toEqual([]);
  });

  it('API-7BACE12808B7 a failed experiment read records nothing and answers recorded:false, not recorded:true', async () => {
    h.db = withFaults(db, (table) => (table === 'ab_experiments' ? { message: INTERNAL } : null));
    const res = await post({ experiment: 'hero', variant: 'b' }, VISITOR);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ ok: true, recorded: false });
    expect(text).not.toContain('permission denied');
    expect(db.table('ab_events')).toEqual([]);
  });
});
