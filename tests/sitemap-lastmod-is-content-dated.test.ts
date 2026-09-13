import { describe, expect, it, vi, beforeEach } from 'vitest';
import { STATIC_REVISED, staticRevision } from '@/lib/marketing/content-revisions';

// `lastmod` is a claim: "the content at this URL changed on this date".
//
// app/sitemap.ts answered it with `new Date()` for every static route, so each
// regeneration told crawlers that ~1,500 URLs had all just changed. Nothing
// caught it, because a sitemap that is *generated* is not the same as a sitemap
// that is *true*, and only the second is worth testing.
//
// The test that matters is idempotence: generate twice, with real time passing
// between, and every date must be identical. A `new Date()` anywhere in the
// pipeline fails that immediately, however it was introduced.

const posts = [
  { slug: 'edited-after-publishing', date: '2026-01-10', updatedAt: '2026-03-02T09:30:00.000Z' },
  { slug: 'never-edited', date: '2026-02-14', updatedAt: undefined },
];

vi.mock('@/lib/blog/posts', () => ({
  getAllPosts: vi.fn(async () => posts),
  ALL_CATEGORIES: ['Family', 'Money'],
}));

// No Supabase credentials in the test env, so the admin-published branches are
// skipped and this exercises the repository-authored entries — which are the
// ones that were being stamped with the current time.
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => { throw new Error('no db in test'); }) }));
vi.mock('@/lib/network/benchmarks-server', () => ({ readBenchmarksPublication: vi.fn(async () => ({ ok: false })) }));

async function generate() {
  const mod = await import('@/app/sitemap');
  return mod.default();
}

describe('sitemap lastmod reflects content, not generation time', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  });

  it('does not change when the sitemap is generated again later', async () => {
    const first = await generate();

    // Real time passes between the two generations. `new Date()` would differ.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-05-05T12:00:00.000Z'));
    const second = await generate();
    vi.useRealTimers();

    const dates = (entries: Awaited<ReturnType<typeof generate>>) =>
      entries.map((e) => `${e.url} ${e.lastModified ? new Date(e.lastModified).toISOString() : '-'}`).sort();

    expect(dates(second)).toEqual(dates(first));
  });

  it('never reports a date at or after the moment of generation', async () => {
    const before = Date.now();
    const entries = await generate();
    // Any entry dated "now" is the bug this guards: content dates are in the
    // past, a generation timestamp is not.
    const stamped = entries.filter((e) => e.lastModified && new Date(e.lastModified).getTime() >= before);
    expect(stamped.map((e) => e.url)).toEqual([]);
  });

  it('prefers a post edit date over its publication date', async () => {
    const entries = await generate();
    const edited = entries.find((e) => e.url.endsWith('/blog/edited-after-publishing'));
    const untouched = entries.find((e) => e.url.endsWith('/blog/never-edited'));

    expect(new Date(edited!.lastModified!).toISOString()).toBe('2026-03-02T09:30:00.000Z');
    // No edit recorded: publication date stands, rather than today's.
    expect(new Date(untouched!.lastModified!).toISOString()).toBe('2026-02-14T00:00:00.000Z');
  });

  it('lists no URL that canonicalises somewhere else', async () => {
    const entries = await generate();
    // /blog?category=… renders the /blog page, which declares canonical=/blog.
    // Listing them asks a crawler to index URLs the page itself disowns.
    expect(entries.filter((e) => e.url.includes('?'))).toEqual([]);
  });

  it('lists only public, canonical origins', async () => {
    const entries = await generate();
    const PRIVATE = ['/dashboard', '/onboarding', '/admin', '/api', '/account', '/settings', '/auth'];
    for (const entry of entries) {
      expect(entry.url.startsWith('https://')).toBe(true);
      for (const prefix of PRIVATE) {
        expect(entry.url.includes(prefix)).toBe(false);
      }
    }
  });

  it('emits only valid W3C / ISO-8601 dates', async () => {
    const entries = await generate();
    for (const entry of entries) {
      if (!entry.lastModified) continue;
      const date = new Date(entry.lastModified);
      expect(Number.isNaN(date.getTime())).toBe(false);
      expect(date.toISOString()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('has a revision date for every routed static page', async () => {
    const entries = await generate();
    const missing = entries
      .filter((e) => !e.url.includes('/blog/') && !e.lastModified)
      .map((e) => e.url);
    // A routed page with no entry in content-revisions.ts means someone added a
    // route and did not date it. Better to fail here than to ship an undated
    // URL — or, worse, to reintroduce a fabricated one.
    expect(missing).toEqual([]);
  });

  it('exposes revision dates as calendar dates, parsed as UTC', () => {
    for (const [path, iso] of Object.entries(STATIC_REVISED)) {
      expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // Parsed with an explicit Z: a bare 'YYYY-MM-DD' is UTC in spec but the
      // local-time reading is a classic off-by-one across timezones.
      expect(staticRevision(path)!.toISOString()).toBe(`${iso}T00:00:00.000Z`);
    }
  });
});
