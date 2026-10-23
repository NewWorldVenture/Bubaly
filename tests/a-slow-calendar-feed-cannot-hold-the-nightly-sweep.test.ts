// A slow calendar feed cannot hold the nightly sweep.
//
// /api/cron/calendar-feeds read every open family's feed in `order('id')` and
// awaited syncFeed for each in turn, with no maxDuration, no budget and no
// concurrency. One feed's fetch is bounded only by 15 s per hop, so a few
// unresponsive hosts at the head of that stable order ran the function into
// its limit every night, and the feeds after them — the same ones every night
// — silently never refreshed; the route answered nothing and the dispatcher
// aborted at 120 s.
//
// Behavioural, with syncFeed replaced by a recorder: the read is stalest
// first, several feeds sync at once so one held host does not serialise the
// night, and a budget that runs out leaves the tail counted `unreached` with a
// 502 rather than a silent cut.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  started: [] as string[],
  finished: [] as string[],
  hold: new Set<string>(),
  release: [] as (() => void)[],
  /** Feeds whose sync moves the clock this far: how a run outgrows its budget. */
  slow: new Map<string, number>(),
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/calendar-feeds', () => ({
  syncFeed: async (_db: unknown, feed: { id: string }) => {
    h.started.push(feed.id);
    const takes = h.slow.get(feed.id);
    if (takes) vi.setSystemTime(Date.now() + takes);
    if (h.hold.has(feed.id)) await new Promise<void>((resolve) => { h.release.push(resolve); });
    h.finished.push(feed.id);
    return { ok: true, imported: 1 };
  },
}));

const { GET, maxDuration } = await import('@/app/api/cron/calendar-feeds/route');

let db: InMemorySupabase;
const req = () => new Request('https://bubaly.test/api/cron/calendar-feeds') as never;
const feed = (id: string, lastSyncedAt: string | null) => ({ id, family_id: 'fam', url: `https://${id}.synthetic.invalid/cal.ics`, last_synced_at: lastSyncedAt, last_status: 'ok' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T05:00:00.000Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.started = []; h.finished = []; h.hold = new Set(); h.release = []; h.slow = new Map();
  db = createInMemorySupabase();
  h.db = db;
  db.seed('families', [{ id: 'fam', closed_at: null }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the order', () => {
  it('is stalest first, never synced first of all — not the id order a dead feed can head for ever', async () => {
    db.seed('calendar_feeds', [
      feed('feed-a', '2026-10-18T05:00:00.000Z'),
      feed('feed-b', null),
      feed('feed-c', '2026-10-01T05:00:00.000Z'),
      feed('feed-d', '2026-10-19T05:00:00.000Z'),
    ]);
    const res = await GET(req());
    expect(await res.json()).toMatchObject({ ok: true, synced: 4, unreached: 0 });
    expect(h.started, 'synced in id order, so the same stuck feed heads every night').toEqual(['feed-b', 'feed-c', 'feed-a', 'feed-d']);
  });
});

describe('a feed whose host does not answer', () => {
  it('does not serialise the night: the other feeds sync while it is held', async () => {
    db.seed('calendar_feeds', [feed('feed-held', null), feed('feed-1', '2026-10-01T05:00:00.000Z'), feed('feed-2', '2026-10-02T05:00:00.000Z')]);
    h.hold.add('feed-held');
    const pending = GET(req());
    await vi.waitFor(() => expect(h.finished).toEqual(expect.arrayContaining(['feed-1', 'feed-2'])));
    expect(h.finished, 'the sweep waited on the held host before touching anyone else').not.toContain('feed-held');
    for (const r of h.release.splice(0)) r();
    expect(await (await pending).json()).toMatchObject({ ok: true, synced: 3 });
  });
});

describe('a sweep that outgrows its budget', () => {
  it('stops starting feeds, counts the tail as unreached and answers 502 rather than a silent cut', async () => {
    db.seed('calendar_feeds', Array.from({ length: 8 }, (_, i) => feed(`feed-${i}`, `2026-10-0${i + 1}T05:00:00.000Z`)));
    // Every host answers slowly: the first wave alone spends the budget.
    for (let i = 0; i < 8; i++) h.slow.set(`feed-${i}`, 70_000);
    const res = await GET(req());
    expect(res.status, 'an unreached tail looked like a clean run').toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, feeds: 8, unreached: 4, failed: 4 });
    expect(h.started).toHaveLength(4);
  });

  it('declares its own limit rather than inheriting the platform default', () => {
    expect(maxDuration).toBe(300);
  });
});
