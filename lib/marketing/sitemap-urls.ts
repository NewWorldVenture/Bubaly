// lib/marketing/sitemap-urls.ts — the rules deciding which URLs may appear in
// the sitemap, and in what form.
//
// A sitemap is a set of assertions: "this URL exists, it is the canonical
// address for its content, and you should index it." Every entry that fails one
// of those is a cost — crawl budget spent to be told 404, or to be redirected to
// a URL already in the list. The production sitemap carried 991 such entries,
// so the checks live here, in one place, applied to every source.

/**
 * The origin every public URL is served from, always without a trailing slash.
 *
 * Production is www.bubaly.com; the env var exists so a preview deployment
 * describes itself rather than the live site.
 */
export const CANONICAL_ORIGIN = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com').replace(/\/+$/, '');

/**
 * Path prefixes robots.txt disallows.
 *
 * Listing a disallowed URL in the sitemap is a direct contradiction: one file
 * asks for it to be indexed while the other forbids fetching it. Kept in step
 * with app/robots.ts.
 */
export const DISALLOWED_PREFIXES = ['/dashboard', '/onboarding', '/api', '/auth'] as const;

/**
 * The path prefixes whose `[slug]` routes render FROM the marketing_pages
 * registry. Mirrors PAGE_TYPES in lib/marketing/platform.ts, minus `blog`.
 *
 * The registry is a path OVERLAY: a row keyed by `/some/path` supplies that
 * page's title, description and AEO answers. It is not a claim that the path
 * resolves — which matters most at `/blog/…`, where the page is served from
 * `blog_posts` and the registry only decorates it. Production had 435 registry
 * rows for synthetic seed slugs (`/blog/Seed <uuid>`); `blog_posts` correctly
 * hides those from the public site, so all 435 answered 404 with `noindex`
 * while the sitemap asked Google to index them. A registry row may therefore
 * only put a URL in the sitemap for a prefix the registry itself renders.
 *
 * (A copy rather than an import: lib/marketing/platform.ts is `server-only` and
 * pulls in the whole admin publishing graph. tests/sitemap-urls.test.ts asserts
 * the two stay in agreement.)
 */
export const REGISTRY_RENDERED_PREFIXES = [
  '/lp', '/questions', '/guides', '/compare', '/alternatives',
  '/audiences', '/resources', '/glossary', '/features', '/p',
] as const;

/** True when the registry is the source that renders `path`'s page. */
export function isRegistryRenderedPath(path: string): boolean {
  return REGISTRY_RENDERED_PREFIXES.some((prefix) => path.startsWith(`${prefix}/`));
}

/**
 * The canonical absolute URL for a site-relative path, or undefined if the path
 * may not be listed at all.
 *
 * Rejects anything that cannot be a canonical, indexable address:
 *  - a query string or fragment — `/blog?category=X` renders /blog, which
 *    declares `canonical: /blog`, so listing the variants asks a crawler to
 *    index URLs the page itself disowns;
 *  - a robots.txt-disallowed prefix;
 *  - a path that is not site-relative.
 *
 * And normalises what remains:
 *  - a trailing slash is dropped, so a registry row at `/` and the homepage at
 *    `''` become one entry instead of two (production listed both, and `/`
 *    canonicalises to the origin form);
 *  - every segment is percent-encoded, because a slug is arbitrary text. A post
 *    slugged `Seed 8e4…` produced `<loc>…/blog/Seed 8e4…</loc>` — a raw space in
 *    a URL, which is not a URL.
 */
export function canonicalUrl(path: string): string | undefined {
  if (path === '') return CANONICAL_ORIGIN;
  if (!path.startsWith('/')) return undefined;
  if (path.includes('?') || path.includes('#')) return undefined;

  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '') return CANONICAL_ORIGIN;
  if (DISALLOWED_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(`${p}/`))) return undefined;

  // Encode per segment: encodeURIComponent would escape the separators too.
  // decode first so an already-encoded path is not double-encoded.
  const encoded = trimmed
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/');
  return `${CANONICAL_ORIGIN}${encoded}`;
}
