import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// /blog shipped its own search index: all 1,048 published posts, passed to a
// client component as a prop and therefore serialised into the HTML. 446 KB of
// a 597 KB response, on a page that renders 25 cards, paid by every visitor so
// that the minority who type in the box could filter locally.

const component = readFileSync('app/(marketing)/blog/blog-search.tsx', 'utf8');
const page = readFileSync('app/(marketing)/blog/page.tsx', 'utf8');
const route = readFileSync('app/api/blog/search-index/route.ts', 'utf8');

describe('the blog typeahead index', () => {
  it('is not passed to the client component as a prop', () => {
    // The whole point: nothing about the corpus may reach the page's HTML.
    expect(page).toContain('<BlogSearch />');
    expect(page).not.toMatch(/<BlogSearch\s+posts=/);
    expect(component).not.toMatch(/export function BlogSearch\(\{\s*posts\s*\}/);
  });

  it('is fetched on first interaction, from both focus and typing', () => {
    // Focus fires first for a mouse user; a keyboard user tabbing in and
    // typing immediately must not race past the load either.
    expect(component).toContain("fetch('/api/blog/search-index')");
    expect(component).toMatch(/onFocus=\{\(\) => \{ loadIndex\(\);/);
    expect(component).toMatch(/onChange=\{\(e\) => \{ loadIndex\(\);/);
  });

  it('goes through the bounded loader, held in a ref so a re-render cannot re-arm it', () => {
    // At most one request in flight, none after a success, and a bounded
    // retry after a failure: all behavioural, in
    // tests/blog-search-index-loader.test.ts. Here, only that the component
    // uses that loader and keeps one per mount.
    expect(component).toContain("import { createSearchIndexLoader, type SearchIndexState } from '@/lib/blog/search-index-loader';");
    expect(component).toMatch(/loader\.current \?\?= createSearchIndexLoader</);
    expect(component).toContain("fetchIndex: () => fetch('/api/blog/search-index')");
  });

  it('says the index is unavailable instead of "no articles found" when it cannot be loaded', () => {
    // An outage read as an empty list said "no articles" for every query
    // (review 5372934636). The unavailable state has its own announced copy.
    expect(component).toMatch(/indexState === 'unavailable' \?/);
    expect(component).toMatch(/role="status"[^>]*>\s*\{t\('blogBlogSearch\.searchUnavailable'\)\}/);
  });
});

describe('the search-index route', () => {
  it('lets a CDN serve it, and serve it stale while refetching', () => {
    // Without this every keystroke-initiated load is an origin request for a
    // corpus that changes when someone publishes, not per visitor.
    expect(route).toContain('s-maxage=300');
    expect(route).toContain('stale-while-revalidate=3600');
  });

  it('sends only the four fields the typeahead matches or shows', () => {
    expect(route).toMatch(/slug: p\.slug/);
    expect(route).toMatch(/title: p\.title/);
    expect(route).toMatch(/excerpt: p\.excerpt\.slice\(0, 90\)/);
    expect(route).toMatch(/category: p\.category/);
    // Not the body, hero image, tags or author — none are searched.
    expect(route).not.toMatch(/body:|heroImageUrl:|tags:|author:/);
  });

  it('is bounded by the cache, with the per-instance limiter behind it', () => {
    // `toContain('rateLimit(')` used to be the whole assertion, and on a
    // serverless deployment that limiter is a bucket PER INSTANCE — the caller
    // decides how many instances there are by sending in parallel. Everywhere
    // else in app/api that is a defect (tests/no-route-gates-on-a-per-instance-limit).
    //
    // Here it is not, and the reason has to be asserted or the exemption is just
    // a habit: no query string and a five-minute shared cache mean a hammer is
    // answered by the CDN, so the origin sees roughly one request per five
    // minutes per edge location. If either of those goes, the argument goes with
    // it and this route needs the durable limiter like all the others.
    expect(route).toMatch(/s-maxage=\d{3,}/);
    expect(route).not.toMatch(/searchParams/);
    expect(route).toContain('rateLimit(');
    expect(route).toContain('429');
  });

  it('returns the published posts, cacheable, when the read succeeds', async () => {
    // The failed-read answer (503, no-store) is behavioural, against the real
    // loaders: tests/blog-search-index-unavailable.test.ts.
    vi.resetModules();
    vi.doMock('@/lib/blog/posts', () => ({
      readAllPosts: vi.fn(async () => ({ ok: true, posts: [
        { slug: 'a', title: 'A', excerpt: 'x'.repeat(200), category: 'Parenting', body: [], tags: ['t'] },
      ] })),
    }));
    vi.doMock('@/lib/server/rate-limit', () => ({
      rateLimit: () => ({ ok: true, remaining: 59, retryAfter: 0 }),
      clientIp: () => '127.0.0.1',
    }));
    const { GET } = await import('@/app/api/blog/search-index/route');
    const res = await GET({ headers: new Headers() } as never);
    expect(res.headers.get('Cache-Control')).toContain('s-maxage=300');
    const body = await res.json();
    expect(body).toEqual([{ slug: 'a', title: 'A', excerpt: 'x'.repeat(90), category: 'Parenting' }]);
    vi.doUnmock('@/lib/blog/posts');
    vi.doUnmock('@/lib/server/rate-limit');
    vi.resetModules();
  });
});
