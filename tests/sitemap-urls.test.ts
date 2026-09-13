import { describe, expect, it, vi } from 'vitest';
import { canonicalUrl, isRegistryRenderedPath, REGISTRY_RENDERED_PREFIXES, DISALLOWED_PREFIXES } from '@/lib/marketing/sitemap-urls';
import { PAGE_TYPES } from '@/lib/marketing/platform';
import robots from '@/app/robots';

// Which URLs may be listed at all.
//
// The production sitemap held 1,508 URLs, of which 991 should not have been
// there: 435 answered 404 with `noindex`, 9 canonicalised to /blog, and the
// homepage appeared twice. None of it was caught, because nothing asserted that
// a listed URL is one a crawler can actually index.

describe('canonicalUrl', () => {
  it('renders the homepage once, in one form', () => {
    // Production listed BOTH, from two different sources. They are one page:
    // https://www.bubaly.com/ serves 200 with canonical=https://www.bubaly.com.
    expect(canonicalUrl('')).toBe('https://www.bubaly.com');
    expect(canonicalUrl('/')).toBe('https://www.bubaly.com');
  });

  it('drops a trailing slash so one page cannot occupy two entries', () => {
    expect(canonicalUrl('/pricing/')).toBe(canonicalUrl('/pricing'));
  });

  it('refuses a URL carrying a query string or fragment', () => {
    // /blog?category=X renders /blog, which declares canonical=/blog.
    expect(canonicalUrl('/blog?category=Parenting')).toBeUndefined();
    expect(canonicalUrl('/blog#recent')).toBeUndefined();
  });

  it('refuses every path robots.txt disallows', () => {
    for (const prefix of DISALLOWED_PREFIXES) {
      expect(canonicalUrl(prefix)).toBeUndefined();
      expect(canonicalUrl(`${prefix}/anything`)).toBeUndefined();
    }
  });

  it('refuses a path that is not site-relative', () => {
    expect(canonicalUrl('https://example.com/x')).toBeUndefined();
    expect(canonicalUrl('blog/post')).toBeUndefined();
  });

  it('percent-encodes slugs, because a raw space is not a URL', () => {
    // Production emitted <loc>…/blog/Seed 8e4…</loc> verbatim: 435 entries that
    // no conforming parser can even read as URLs.
    expect(canonicalUrl('/blog/Seed f1afa20e-7208-411d-8b10-8ad60a060157'))
      .toBe('https://www.bubaly.com/blog/Seed%20f1afa20e-7208-411d-8b10-8ad60a060157');
    expect(canonicalUrl('/blog/café-nights')).toBe('https://www.bubaly.com/blog/caf%C3%A9-nights');
  });

  it('leaves an already-encoded path encoded exactly once', () => {
    expect(canonicalUrl('/blog/Seed%20f1afa20e')).toBe('https://www.bubaly.com/blog/Seed%20f1afa20e');
  });

  it('keeps path separators intact', () => {
    expect(canonicalUrl('/resources/benchmarks')).toBe('https://www.bubaly.com/resources/benchmarks');
  });
});

describe('the marketing registry may only claim paths it renders', () => {
  it('does not claim the /blog URL space, which blog_posts owns', () => {
    // /blog/[slug] is served from blog_posts, which hides synthetic seed rows.
    // A registry row for one of those slugs is not a page — it is a 404 the
    // sitemap was inviting Google to crawl, 435 times.
    expect(isRegistryRenderedPath('/blog/Seed f1afa20e-7208-411d-8b10-8ad60a060157')).toBe(false);
    expect(isRegistryRenderedPath('/blog/a-real-post')).toBe(false);
  });

  it('does not claim the homepage or a bare prefix', () => {
    expect(isRegistryRenderedPath('/')).toBe(false);
    expect(isRegistryRenderedPath('/lp')).toBe(false);
  });

  it('claims the prefixes whose [slug] route renders from it', () => {
    for (const prefix of REGISTRY_RENDERED_PREFIXES) {
      expect(isRegistryRenderedPath(`${prefix}/something`)).toBe(true);
    }
  });

  it('stays in step with PAGE_TYPES', () => {
    // The copy in sitemap-urls.ts exists only to keep `server-only` out of the
    // sitemap's import graph. If a page type is added, this fails until the
    // sitemap is told whether its pages are real URLs.
    const rendered = PAGE_TYPES.filter((t) => t.value !== 'blog').map((t) => t.prefix).sort();
    expect([...REGISTRY_RENDERED_PREFIXES].sort()).toEqual(rendered);
  });
});

describe('the sitemap and robots.txt agree', () => {
  it('disallows the same prefixes in both files', () => {
    // Both read one constant, so they cannot drift — this asserts the wiring.
    const rules = robots().rules as { disallow?: string[] };
    expect([...(rules.disallow ?? [])].sort()).toEqual([...DISALLOWED_PREFIXES].sort());
  });

  it('points robots.txt at the sitemap on the canonical origin', () => {
    expect(robots().sitemap).toBe('https://www.bubaly.com/sitemap.xml');
  });
});

describe('registry rows reach the sitemap only when they are pages', () => {
  it('lists the renderable ones and drops the rest', async () => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key');

    const rows = {
      marketing_landing_pages: [],
      marketing_pages: [
        { path: '/guides/calm-mornings', updated_at: '2026-04-01T00:00:00.000Z', published_at: null },
        // The three shapes production was publishing as URLs:
        { path: '/blog/Seed f1afa20e-7208-411d-8b10-8ad60a060157', updated_at: '2026-07-18T18:21:18.182Z', published_at: null },
        { path: '/blog/a-real-post', updated_at: '2026-07-18T18:21:19.000Z', published_at: null },
        { path: '/', updated_at: '2026-07-18T18:21:21.267Z', published_at: null },
      ],
    } as Record<string, unknown[]>;

    vi.doMock('@/lib/blog/posts', () => ({
      getAllPosts: vi.fn(async () => [{ slug: 'a-real-post', date: '2026-02-01', updatedAt: undefined }]),
      ALL_CATEGORIES: [],
    }));
    vi.doMock('@/lib/network/benchmarks-server', () => ({ readBenchmarksPublication: vi.fn(async () => ({ ok: false })) }));
    vi.doMock('@/lib/supabase/server', () => ({
      createServiceClient: () => ({
        from(table: string) {
          const result = Promise.resolve({ data: rows[table] ?? [], error: null });
          const chain: Record<string, unknown> = {};
          for (const method of ['select', 'eq', 'is', 'order']) chain[method] = () => chain;
          chain.then = result.then.bind(result);
          return chain;
        },
      }),
    }));

    const { default: sitemap } = await import('@/app/sitemap');
    const urls = (await sitemap()).map((e) => e.url);

    expect(urls).toContain('https://www.bubaly.com/guides/calm-mornings');
    // Owned by blog_posts, and listed exactly once from there.
    expect(urls.filter((u) => u === 'https://www.bubaly.com/blog/a-real-post')).toHaveLength(1);
    expect(urls.some((u) => u.includes('Seed'))).toBe(false);
    // The registry's '/' row and the static '' route are the same page.
    expect(urls.filter((u) => u === 'https://www.bubaly.com' || u === 'https://www.bubaly.com/')).toHaveLength(1);

    vi.doUnmock('@/lib/blog/posts');
    vi.doUnmock('@/lib/supabase/server');
    vi.doUnmock('@/lib/network/benchmarks-server');
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
