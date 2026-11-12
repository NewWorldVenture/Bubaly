// API-02C7F9F1B8EA — POST /api/lp/track, request level.
//
// The public landing-page beacon. It holds a service-role client, reads no
// session, and its only side effect is `bump_landing_metric` (0053), which
// increments `views` or `conversions` on a published page by slug.
//
// Already proven elsewhere, and not repeated here:
//   tests/a-malformed-public-track-body-is-refused-not-a-500.test.ts — a
//     non-string or over-long slug is 422 and reaches no RPC; a well-formed
//     body reaches the RPC (control).
//   tests/public-side-effect-rate-limit.test.ts — the route imports the shared
//     durable limiter (source scan only).
//   tests/public-error-contract.test.ts — the error body shape (source scan).
//
// Added here: the handler driven over the in-memory database with the real
// limiter — the counter that moves and the ones that do not, that a signed-in
// member of any role gets exactly the public answer and no household read, the
// rate limit (local and durable, and a durable limiter that cannot answer)
// refusing BEFORE any count, and a failed RPC answered as a failure.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({
  db: null as unknown,
  createServer: vi.fn(),
  bumps: [] as Record<string, unknown>[],
  bumpError: null as string | null,
  durable: 'count' as 'count' | 'refuse' | 'fail',
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: h.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const FAMILY_A = '4a000000-0000-4000-8000-00000000000a';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const PRIVATE_DETAIL = 'relation "marketing_landing_pages" internal detail';

/** bump_landing_metric as 0053 writes it: published, undeleted pages only. */
function bump(args: Record<string, unknown>, db: InMemorySupabase) {
  h.bumps.push(args);
  if (h.bumpError) throw new Error(h.bumpError);
  const column = args.p_metric === 'view' ? 'views' : args.p_metric === 'conversion' ? 'conversions' : null;
  if (!column) return null;
  for (const page of db.table('marketing_landing_pages')) {
    if (page.slug === args.p_slug && page.published === true && page.deleted_at === null) page[column] = Number(page[column]) + 1;
  }
  return null;
}

let db: InMemorySupabase;
const page = (slug: string): Row => db.table('marketing_landing_pages').find((row) => row.slug === slug) as Row;
const counts = () => db.table('marketing_landing_pages').map((row) => [row.slug, row.views, row.conversions]);

beforeEach(() => {
  vi.resetModules();
  h.bumps = [];
  h.bumpError = null;
  h.durable = 'count';
  h.createServer.mockReset();
  db = createInMemorySupabase({
    rpc: {
      bump_landing_metric: bump,
      rate_limit_hit: (args, store) => {
        if (h.durable === 'fail') throw new Error('limiter offline');
        if (h.durable === 'refuse') return [{ allowed: false, retry_after: 37 }];
        return rateLimitHit(args, store);
      },
    },
  });
  db.seed('marketing_landing_pages', [
    { slug: 'spring-sale', published: true, deleted_at: null, views: 4, conversions: 1 },
    { slug: 'autumn-sale', published: true, deleted_at: null, views: 9, conversions: 2 },
  ]);
  db.seed('family_members', [{ family_id: FAMILY_A, user_id: 'user-a', role: 'parent', is_active: true, display_name: 'Parent A' }]);
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

function beacon(body: unknown, ip = '203.0.113.10', cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  if (cookie) headers.cookie = cookie;
  return new NextRequest('https://bubaly.example/api/lp/track', { method: 'POST', headers, body: JSON.stringify(body) });
}
const post = async (request: NextRequest) => (await import('@/app/api/lp/track/route')).POST(request);

describe('API-02C7F9F1B8EA POST /api/lp/track', () => {
  it('API-02C7F9F1B8EA a signed-out view moves the named page\'s view counter by one and nothing else', async () => {
    const response = await post(beacon({ slug: '  Spring-Sale ' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(h.bumps).toEqual([{ p_slug: 'spring-sale', p_metric: 'view' }]);
    expect(counts()).toEqual([['spring-sale', 5, 1], ['autumn-sale', 9, 2]]);
  });

  it('API-02C7F9F1B8EA a conversion moves the conversion counter, and an unknown kind is a view', async () => {
    expect((await post(beacon({ slug: 'autumn-sale', kind: 'conversion' }))).status).toBe(200);
    expect((await post(beacon({ slug: 'autumn-sale', kind: 'purchase' }))).status).toBe(200);
    expect(h.bumps.map((args) => args.p_metric)).toEqual(['conversion', 'view']);
    expect([page('autumn-sale').views, page('autumn-sale').conversions]).toEqual([10, 3]);
    expect([page('spring-sale').views, page('spring-sale').conversions]).toEqual([4, 1]);
  });

  it.each(ROLES)('API-02C7F9F1B8EA a signed-in %s gets the public answer and the route reads no session or household table', async (role) => {
    db.table('family_members')[0].role = role;
    const response = await post(beacon({ slug: 'spring-sale' }, '203.0.113.11', 'sb-bubaly-auth-token=member-session'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(h.createServer).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(page('spring-sale').views).toBe(5);
  });

  it('API-02C7F9F1B8EA the 61st beacon from one address in a minute is 429 with Retry-After and counts nothing', async () => {
    for (let i = 0; i < 60; i++) expect((await post(beacon({ slug: 'spring-sale' }, '203.0.113.13'))).status).toBe(200);
    const refused = await post(beacon({ slug: 'spring-sale' }, '203.0.113.13'));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await refused.json()).toEqual({ error: 'track.tooManyRequests' });
    expect(page('spring-sale').views).toBe(64);
    expect(h.bumps).toHaveLength(60);
    // Another address is not held by that one's budget.
    expect((await post(beacon({ slug: 'spring-sale' }, '198.51.100.7'))).status).toBe(200);
    expect(page('spring-sale').views).toBe(65);
  });

  it('API-02C7F9F1B8EA a durable bucket spent on another instance refuses before any count', async () => {
    h.durable = 'refuse';
    const response = await post(beacon({ slug: 'spring-sale' }, '203.0.113.14'));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('37');
    expect(h.bumps).toEqual([]);
    expect(page('spring-sale').views).toBe(4);
  });

  it('API-02C7F9F1B8EA a durable limiter that cannot answer fails closed and counts nothing', async () => {
    h.durable = 'fail';
    const response = await post(beacon({ slug: 'spring-sale' }, '203.0.113.15'));
    expect(response.status).toBe(429);
    expect(h.bumps).toEqual([]);
    expect(page('spring-sale').views).toBe(4);
  });

  it('API-02C7F9F1B8EA a failed metric write is a 500 that names no internal detail, not ok', async () => {
    h.bumpError = PRIVATE_DETAIL;
    const response = await post(beacon({ slug: 'spring-sale' }, '203.0.113.16'));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'track.couldNotRecordTheLanding' });
    expect(text).not.toContain('marketing_landing_pages');
    expect(page('spring-sale').views).toBe(4);
  });
});
