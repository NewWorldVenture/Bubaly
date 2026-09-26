import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const source = fs.readFileSync(path.join(process.cwd(), 'app/sitemap.ts'), 'utf8');

/**
 * A published `marketing_pages` row, as the sitemap reads it. Two of these are
 * the exact shapes observed in the live sitemap on 2026-09-13, which carried
 * 435 `/blog/Seed <uuid>` URLs — every one of them answering 404.
 */
type PlatformRow = { path: string; updated_at: string; published_at: string | null };

let platformRows: PlatformRow[] = [];
let landingRows: { slug: string; updated_at: string }[] = [];

/**
 * Chainable stub for the PostgREST builder. A Proxy rather than a fixed method
 * list, so adding a `.limit()` or `.range()` to either query cannot silently
 * turn this into a false pass — the unknown method keeps the chain alive and
 * the assertion still runs against the resolved rows.
 */
function builder(table: string): unknown {
  const rows = table === 'marketing_pages' ? platformRows : landingRows;
  const result = { data: rows, error: null };
  const chain: unknown = new Proxy(
    {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    },
    {
      get(target: Record<string, unknown>, prop: string) {
        if (prop === 'then') return target.then;
        return () => chain;
      },
    },
  );
  return chain;
}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (table: string) => builder(table) }),
}));

// Only the blog reference read is replaced. isSyntheticBlogSeedSlug stays REAL, because it
// is the thing under test here: the sitemap must reject exactly what the blog
// renderer rejects, and a stubbed predicate would prove nothing about that.
vi.mock('@/lib/blog/posts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/blog/posts')>();
  return { ...actual, getAllPostRefs: async () => [] };
});

vi.mock('@/lib/network/benchmarks-server', () => ({
  readBenchmarksPublication: async () => ({ ok: true, published: false }),
}));

async function runSitemap() {
  const mod = await import('@/app/sitemap');
  const entries = await mod.default();
  return entries.map((e) => e.url);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://www.bubaly.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://project.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_secret_test');
  platformRows = [];
  landingRows = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('marketing sitemap closed loop', () => {
  it('reads published, non-deleted Super Admin landing pages', () => {
    expect(source).toContain("from('marketing_landing_pages')");
    expect(source).toContain(".eq('published', true)");
    expect(source).toContain(".is('deleted_at', null)");
  });

  it('emits public landing-page URLs without making sitemap generation fatal', () => {
    // Minted through canonicalUrl(), which percent-encodes each segment and
    // rejects anything that cannot be a canonical, indexable address. It is the
    // only thing in this file allowed to produce a <loc>.
    expect(source).toContain("import { canonicalUrl, isRegistryRenderedPath } from '@/lib/marketing/sitemap-urls'");
    expect(source).toContain('canonicalUrl(`/lp/${page.slug}`)');
    expect(source).not.toContain('${SITE_URL}');
    expect(source).toContain("console.error('[sitemap] published landing-page read failed'");
    expect(source).toContain('const byUrl = new Map');
    expect(source).toContain('return [...byUrl.values()]');
  });

  it('deduplicates URLs when canonical platform pages overlap legacy or static entries', () => {
    expect(source).toContain('byUrl.get(entry.url)');
    expect(source).toContain('Math.max(previous.priority ?? 0, entry.priority ?? 0)');
  });

  // ---------------------------------------------------------------------------
  // The cases above assert the SOURCE. They passed for as long as this defect
  // was live, because grepping a file cannot tell you what it emits. The rest of
  // this file runs the sitemap and looks at the URLs.
  // ---------------------------------------------------------------------------

  it('never advertises a blog path the renderer refuses', async () => {
    // Verbatim from the live sitemap. getPost() rejects these slugs outright
    // (isSyntheticBlogSeedSlug -> undefined -> notFound), so each is a 404.
    platformRows = [
      'Seed f1afa20e-7208-411d-8b10-8ad60a060157',
      'Seed b40afaf9-4b6e-43ff-b617-f2e682cca0f8',
      'Seed data 12 0665c96f-735b-4819-906c-38c0ca07a83b',
      'seed-blog_posts-3',
    ].map((slug) => ({
      path: `/blog/${slug}`,
      updated_at: '2026-07-18T00:00:00.000Z',
      published_at: '2026-07-18T00:00:00.000Z',
    }));

    const urls = await runSitemap();

    expect(urls.filter((u) => u.includes('Seed'))).toEqual([]);
    expect(urls.filter((u) => u.includes('seed-blog_posts'))).toEqual([]);
  });

  it('advertises no blog path from the registry at all, real or seeded', async () => {
    // This case previously asserted the opposite, and the opposite was my
    // design: filter the registry's /blog rows by the same predicate the
    // renderer uses. #526 replaced it with a stronger rule — the registry is a
    // path OVERLAY, not proof that a path resolves, so it may only mint a URL
    // for a prefix it actually renders, and /blog is served from blog_posts.
    //
    // That subsumes the seed filter rather than duplicating it: no registry row
    // can publish a /blog URL, so none can publish a wrong one. Blog entries
    // reach the sitemap through getAllPosts(), which filters via publicRows.
    platformRows = [{
      path: '/blog/a-simple-system-for-a-calm-approach-to-holiday-hosting',
      updated_at: '2026-09-01T00:00:00.000Z',
      published_at: '2026-09-01T00:00:00.000Z',
    }];

    const urls = await runSitemap();

    expect(urls.filter((u) => u.includes('/blog/'))).toEqual([]);
  });

  it('does not publish the homepage twice when a platform row stores the root as "/"', async () => {
    platformRows = [{ path: '/', updated_at: '2026-09-01T00:00:00.000Z', published_at: null }];

    const urls = await runSitemap();
    const homepages = urls.filter((u) => u === 'https://www.bubaly.com' || u === 'https://www.bubaly.com/');

    expect(homepages).toHaveLength(1);
  });

  it('emits no duplicate URLs at all', async () => {
    platformRows = [
      { path: '/', updated_at: '2026-09-01T00:00:00.000Z', published_at: null },
      { path: '/pricing', updated_at: '2026-09-01T00:00:00.000Z', published_at: null },
      { path: '/pricing', updated_at: '2026-09-02T00:00:00.000Z', published_at: null },
    ];

    const urls = await runSitemap();

    expect(urls).toHaveLength(new Set(urls).size);
  });

  it('rejects a platform path that is not a rooted path', async () => {
    platformRows = [
      { path: 'pricing', updated_at: '2026-09-01T00:00:00.000Z', published_at: null },
      { path: 'https://evil.example/x', updated_at: '2026-09-01T00:00:00.000Z', published_at: null },
    ];

    const urls = await runSitemap();

    expect(urls.some((u) => u.includes('evil.example'))).toBe(false);
    expect(urls).not.toContain('https://www.bubaly.compricing');
  });
});
