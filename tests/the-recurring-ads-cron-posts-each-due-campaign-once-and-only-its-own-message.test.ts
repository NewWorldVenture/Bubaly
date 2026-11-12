// GET /api/cron/marketing-social, driven through the real route, the real
// cron-auth check and the real runner (lib/marketing/recurring-ads-runner.ts)
// over the in-memory database. Only the social connectors are stubbed, at the
// seam tests/post-now-publishes-an-occurrence-once.test.ts and
// tests/an-ended-campaign-does-not-post-on-demand.test.ts already stub.
//
// Recurring ads are brand campaigns, not household data: there is no family on
// these rows. The isolation question is therefore asked per CAMPAIGN — one
// campaign's message, link and ledger never reach another's.
//
// Already proven elsewhere (not repeated here):
//   tests/recurring-ads-runner.test.ts — outcome classification, platform
//     filtering, first-run arithmetic, source-text checks that the route is
//     auth-gated and the claim is a compare-and-set, the ledger's unique index.
//   tests/an-ended-campaign-does-not-post-on-demand.test.ts — runDueRecurringAds
//     retires a campaign in the claim that posts its last in-window slot.
//   tests/post-now-publishes-an-occurrence-once.test.ts — the admin "Post now"
//     action's claim against a racing cron.
//   tests/cron-dispatch*.test.ts — the 15-minute dispatcher schedule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

type PublishInput = { platform: string; body: string; link: string | null };

const state = vi.hoisted(() => ({
  client: undefined as unknown,
  serviceCalls: 0,
  publish: undefined as unknown as import('vitest').Mock<(input: { platform: string; body: string; link: string | null }) => Promise<unknown>>,
  /** The ad row as the database held it at the moment each provider call was made. */
  rowAtPublish: [] as Row[],
}));

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { state.serviceCalls += 1; return state.client; },
}));
vi.mock('@/lib/social/connectors', () => ({
  getConnector: (platform: string) => ({
    publish: (input: PublishInput) => state.publish({ ...input, platform }),
  }),
}));

import { GET } from '@/app/api/cron/marketing-social/route';

const NOW = '2026-09-21T12:00:00.000Z';
const SECRET = 'test-cron-secret-not-real';
const AD_A = '00000000-0000-4000-8000-0000000000a1';
const AD_B = '00000000-0000-4000-8000-0000000000b1';
const AD_PAUSED = '00000000-0000-4000-8000-0000000000c1';
const AD_DELETED = '00000000-0000-4000-8000-0000000000c2';
const AD_FUTURE = '00000000-0000-4000-8000-0000000000c3';
const AD_CAPPED = '00000000-0000-4000-8000-0000000000c4';

const A_MESSAGE = 'Campaign A: the family calendar, finally shared.';
const B_FIRST = 'Campaign B variant one.';
const B_SECOND = 'Campaign B variant two.';

let db: InMemorySupabase;

function ad(over: Row): Row {
  return {
    name: 'Campaign', status: 'active', body_variants: ['Generic message'], link: null, media_urls: [],
    platforms: ['x'], cadence: 'daily', times_of_day: [9 * 60], days_of_week: [], day_of_month: null,
    timezone: 'UTC', starts_at: '2026-09-01T00:00:00.000Z', ends_at: null, max_occurrences: null,
    next_run_at: '2026-09-21T09:00:00.000Z', last_run_at: null, occurrences: 0, deleted_at: null,
    last_error: 'an earlier note', ...over,
  };
}

function seed(): void {
  db.seed('marketing_recurring_ads', [
    ad({ id: AD_A, name: 'A', body_variants: [A_MESSAGE], link: 'https://example.com/a', platforms: ['x'], occurrences: 3 }),
    ad({ id: AD_B, name: 'B', body_variants: [B_FIRST, B_SECOND], link: 'https://example.com/b', platforms: ['x', 'reddit'], occurrences: 1,
      next_run_at: '2026-09-21T11:45:00.000Z', times_of_day: [11 * 60 + 45] }),
    ad({ id: AD_PAUSED, name: 'paused', status: 'paused', body_variants: ['paused message'] }),
    ad({ id: AD_DELETED, name: 'deleted', deleted_at: '2026-09-20T00:00:00.000Z', body_variants: ['deleted message'] }),
    ad({ id: AD_FUTURE, name: 'future', next_run_at: '2026-09-22T09:00:00.000Z', body_variants: ['future message'] }),
    ad({ id: AD_CAPPED, name: 'capped', max_occurrences: 5, occurrences: 5, body_variants: ['capped message'] }),
  ]);
}

function request(authorization?: string): NextRequest {
  return new NextRequest('https://app.example.com/api/cron/marketing-social',
    authorization ? { headers: { authorization } } : undefined);
}
const authorized = () => request(`Bearer ${SECRET}`);
const row = (id: string) => db.table('marketing_recurring_ads').find((r) => r.id === id)!;
const runs = (id: string) => db.table('marketing_recurring_ad_runs').filter((r) => r.ad_id === id);
const boardFor = (id: string) => db.table('marketing_social_posts')
  .filter((r) => (r.metadata as { recurringAdId?: string }).recurringAdId === id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.stubEnv('CRON_SECRET', SECRET);
  db = createInMemorySupabase({ uniques: { marketing_recurring_ad_runs: [['ad_id', 'occurrence', 'platform']] } });
  state.client = db;
  state.serviceCalls = 0;
  state.rowAtPublish = [];
  let n = 0;
  state.publish = vi.fn(async (input: PublishInput) => {
    const adId = db.table('marketing_recurring_ads').find((r) => (r.body_variants as string[]).includes(input.body))?.id as string;
    state.rowAtPublish.push({ ...row(adId) });
    n += 1;
    return { ok: true, providerObjectId: `synthetic-object-${n}`, permalinkUrl: `https://example.com/post/${n}` };
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  seed();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('GET /api/cron/marketing-social is refused without the cron secret', () => {
  it('API-9ED269DBDB75 JOB-F5185B999046: answers 401 to a request with no Authorization header before any read or post', async () => {
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(state.serviceCalls).toBe(0);
    expect(db.log).toEqual([]);
    expect(state.publish).not.toHaveBeenCalled();
  });

  it('API-9ED269DBDB75 JOB-F5185B999046: answers 401 to a wrong Bearer secret before any read or post', async () => {
    const response = await GET(request('Bearer not-the-cron-secret'));
    expect(response.status).toBe(401);
    expect(state.serviceCalls).toBe(0);
    expect(db.log).toEqual([]);
    expect(state.publish).not.toHaveBeenCalled();
  });
});

describe('a run over a populated campaign table', () => {
  it('API-9ED269DBDB75 JOB-F5185B999046: posts every due active campaign once, skips paused, deleted and future ones, and retires a capped one', async () => {
    const response = await GET(authorized());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      considered: 3, posted: 3, skipped: 1, failures: 0, reasons: { occurrence_cap: 1 }, ok: true,
    });

    expect(state.publish.mock.calls.map(([input]) => `${input.platform}:${input.body}`).sort())
      .toEqual([`reddit:${B_SECOND}`, `x:${A_MESSAGE}`, `x:${B_SECOND}`]);

    expect(row(AD_A)).toMatchObject({ occurrences: 4, next_run_at: '2026-09-22T09:00:00.000Z', last_run_at: NOW, status: 'active', last_error: null });
    expect(row(AD_B)).toMatchObject({ occurrences: 2, next_run_at: '2026-09-22T11:45:00.000Z', last_run_at: NOW, status: 'active', last_error: null });
    expect(row(AD_CAPPED)).toMatchObject({ occurrences: 5, next_run_at: null, status: 'paused' });
    for (const untouched of [AD_PAUSED, AD_DELETED, AD_FUTURE]) {
      expect(row(untouched)).toMatchObject({ occurrences: 0, last_run_at: null, last_error: 'an earlier note' });
      expect(runs(untouched)).toEqual([]);
    }
    expect(runs(AD_CAPPED)).toEqual([]);

    expect(runs(AD_A)).toEqual([expect.objectContaining({
      occurrence: 3, platform: 'x', status: 'published', body: A_MESSAGE,
      scheduled_for: '2026-09-21T09:00:00.000Z', provider_object_id: expect.stringMatching(/^synthetic-object-/),
    })]);
    expect(runs(AD_B).map((r) => `${r.platform}:${r.occurrence}:${r.status}`).sort())
      .toEqual(['reddit:1:published', 'x:1:published']);
    expect(db.table('marketing_social_posts')).toHaveLength(3);
  });

  it('API-9ED269DBDB75 JOB-F5185B999046: claims the occurrence on the row before the provider is called', async () => {
    await GET(authorized());
    const forA = state.rowAtPublish.filter((r) => r.id === AD_A);
    expect(forA).toHaveLength(1);
    expect(forA[0]).toMatchObject({ occurrences: 4, next_run_at: '2026-09-22T09:00:00.000Z' });
  });

  it('API-9ED269DBDB75 JOB-F5185B999046: one campaign\'s message, link and ledger never reach another campaign', async () => {
    await GET(authorized());
    for (const r of runs(AD_A)) expect(r.body).toBe(A_MESSAGE);
    for (const r of runs(AD_B)) expect([B_FIRST, B_SECOND]).toContain(r.body);
    expect(boardFor(AD_A).map((p) => [p.content, p.link])).toEqual([[A_MESSAGE, 'https://example.com/a']]);
    expect(boardFor(AD_B).map((p) => [p.content, p.link])).toEqual([[B_SECOND, 'https://example.com/b'], [B_SECOND, 'https://example.com/b']]);
    expect(state.publish.mock.calls.map(([input]) => `${input.platform}|${input.body}|${input.link}`).sort()).toEqual([
      `reddit|${B_SECOND}|https://example.com/b`, `x|${A_MESSAGE}|https://example.com/a`, `x|${B_SECOND}|https://example.com/b`,
    ]);
    // Each ledger row points at its own campaign's board row.
    expect(runs(AD_A).map((r) => r.post_id)).toEqual(boardFor(AD_A).map((p) => p.id));
    expect(runs(AD_B).map((r) => r.post_id).sort()).toEqual(boardFor(AD_B).map((p) => p.id).sort());
  });
});

describe('a second run and a failed run', () => {
  it('API-9ED269DBDB75 JOB-F5185B999046: a second run in the same tick posts nothing and writes nothing new', async () => {
    await GET(authorized());
    const ledger = db.table('marketing_recurring_ad_runs').length;
    const board = db.table('marketing_social_posts').length;
    const rows = structuredClone(db.table('marketing_recurring_ads'));

    const again = await GET(authorized());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ considered: 0, posted: 0, skipped: 0, failures: 0, reasons: {}, ok: true });
    expect(state.publish).toHaveBeenCalledTimes(3);
    expect(db.table('marketing_recurring_ad_runs')).toHaveLength(ledger);
    expect(db.table('marketing_social_posts')).toHaveLength(board);
    expect(db.table('marketing_recurring_ads')).toEqual(rows);
  });

  it('API-9ED269DBDB75 JOB-F5185B999046: a campaign another worker claimed between the read and the claim is not posted', async () => {
    // The other worker moves next_run_at on at the moment our claim reaches the
    // database, so our compare-and-set matches nothing.
    state.client = withFaults(db, (table, calls) => {
      if (table === 'marketing_recurring_ads' && calls.some((c) => c.method === 'update')
        && calls.some((c) => c.method === 'eq' && c.args[0] === 'id' && c.args[1] === AD_A)
        && calls.some((c) => c.method === 'eq' && c.args[0] === 'next_run_at')) {
        Object.assign(row(AD_A), { next_run_at: '2026-09-22T09:00:00.000Z', occurrences: 4 });
      }
      return null;
    });
    const response = await GET(authorized());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ posted: 2, failures: 0, reasons: { already_claimed: 1, occurrence_cap: 1 } });
    expect(state.publish.mock.calls.map(([input]) => input.body)).not.toContain(A_MESSAGE);
    expect(runs(AD_A)).toEqual([]);
    expect(row(AD_A)).toMatchObject({ occurrences: 4 });
  });

  it('API-9ED269DBDB75 JOB-F5185B999046: an unreadable campaign table answers 500 and posts nothing', async () => {
    state.client = withFaults(db, (table, calls) =>
      table === 'marketing_recurring_ads' && calls.some((c) => c.method === 'select') && calls.some((c) => c.method === 'lte')
        ? { message: 'synthetic read failure' } : null);
    const response = await GET(authorized());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Recurring ad run failed.' });
    expect(state.publish).not.toHaveBeenCalled();
    expect(db.table('marketing_recurring_ad_runs')).toEqual([]);
    expect(row(AD_A)).toMatchObject({ occurrences: 3, next_run_at: '2026-09-21T09:00:00.000Z' });
  });

  it('API-9ED269DBDB75 JOB-F5185B999046: a provider failure for one campaign answers 502 with ok false, records it on that campaign, and the other still posts', async () => {
    const succeed = state.publish.getMockImplementation()!;
    state.publish.mockImplementation(async (input: PublishInput) =>
      input.body === A_MESSAGE ? { ok: false, errorCode: 'provider_error', errorMessage: 'synthetic provider refusal' } : succeed(input));
    const response = await GET(authorized());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ considered: 3, posted: 2, failures: 1, ok: false });

    expect(runs(AD_A)).toEqual([expect.objectContaining({ status: 'failed', post_id: null, error_code: 'provider_error' })]);
    expect(boardFor(AD_A)).toEqual([]);
    expect(row(AD_A).last_error).toEqual(expect.stringContaining('No platform confirmed this post'));
    expect(runs(AD_B).map((r) => r.status)).toEqual(['published', 'published']);
    expect(row(AD_B).last_error).toBeNull();

    // The occurrence was claimed before publishing, by design (a missed post
    // over a duplicated one): the next tick does not retry it.
    const again = await GET(authorized());
    expect(await again.json()).toMatchObject({ considered: 0, ok: true });
    expect(state.publish).toHaveBeenCalledTimes(3);
  });

  it('API-9ED269DBDB75 JOB-F5185B999046: a platform without credentials is recorded as requires_setup and still turns the run red', async () => {
    state.publish.mockResolvedValue({ ok: false, errorCode: 'requires_setup' });
    const response = await GET(authorized());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ posted: 0, failures: 3, ok: false });
    expect(db.table('marketing_recurring_ad_runs').map((r) => r.status)).toEqual(['requires_setup', 'requires_setup', 'requires_setup']);
    expect(db.table('marketing_social_posts')).toEqual([]);
  });
});
