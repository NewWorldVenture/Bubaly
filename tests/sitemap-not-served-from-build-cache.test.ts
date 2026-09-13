import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The sitemap is the file search engines read to discover articles, and it was
// shipping a SIX-DAY-OLD copy of the blog.
//
// Next patches `fetch`, and for a route it prerenders it stores the response in
// the build Data Cache under the route's revalidate. `app/sitemap.ts` declared
// no revalidate, so the entry was written with Next's "forever" value and no
// tag that could clear it. Measured, from .next/cache/fetch-cache:
//
//     url:        …/rest/v1/blog_posts?select=slug,title,…&published=eq.true
//     rows:       1000        (a second entry held the remaining 48)
//     revalidate: 31536000    ← one year
//     tags:       []          ← nothing can revalidate it
//     written:    2026-09-07 23:50
//
// A build on 2026-09-13 produced a sitemap from those two entries: 1,048 of the
// 1,049 published articles. The missing one had been published in between, and
// would have stayed missing for a year — and Vercel restores .next/cache
// between deploys, so redeploying would not have fixed it either.
//
// Two things keep it honest, and this pins both.
const POSTS = readFileSync(join(__dirname, '..', 'lib/blog/posts.ts'), 'utf8');
const SITEMAP = readFileSync(join(__dirname, '..', 'app/sitemap.ts'), 'utf8');

describe('the sitemap cannot be served from a stale build cache', () => {
  it('reads published articles with no-store, so no build cache can hold them', () => {
    const client = POSTS.slice(POSTS.indexOf('function anonClient()'), POSTS.indexOf('export function normalizeBody'));
    expect(client).toMatch(/cache:\s*'no-store'/);
    // Passed as the client's own fetch, so EVERY query this module makes is
    // covered — not just the one that happened to be noticed.
    expect(client).toMatch(/global:\s*\{\s*fetch:/);
  });

  it('renders the sitemap per request rather than at build time', () => {
    expect(SITEMAP).toMatch(/export const dynamic = 'force-dynamic'/);
  });

  it('does not swallow the error Next throws to mark a route dynamic', () => {
    // A catch-all around the read would turn "this route cannot be static" into
    // an empty article list and let Next prerender and ship that.
    expect(POSTS).toMatch(/import \{ unstable_rethrow \} from 'next\/navigation'/);
    for (const fn of ['getAllPosts', 'getAllPostRefs']) {
      const start = POSTS.indexOf(`export async function ${fn}(`);
      expect(start, `${fn} should exist`).toBeGreaterThan(-1);
      const next = POSTS.indexOf('\nexport async function ', start + 1);
      const source = POSTS.slice(start, next === -1 ? undefined : next);
      expect(source, `${fn} catches`).toMatch(/catch \(error\)/);
      expect(source, `${fn} rethrows framework errors first`).toMatch(/unstable_rethrow\(error\)/);
      // The rethrow must come BEFORE the fallback, or it never runs.
      expect(source.indexOf('unstable_rethrow(error)')).toBeLessThan(source.indexOf('return [];'));
    }
  });

  it('asks only for the columns a sitemap entry is made of', () => {
    // The route now runs per request; pulling every card column would read about
    // a megabyte of excerpts and hero-image metadata on every crawl.
    expect(SITEMAP).toContain('getAllPostRefs');
    expect(SITEMAP).not.toMatch(/\bgetAllPosts\b/);
    const start = POSTS.indexOf('export async function getAllPostRefs(');
    expect(start, 'getAllPostRefs should exist').toBeGreaterThan(-1);
    const next = POSTS.indexOf('\nexport ', start + 1);
    const refs = POSTS.slice(start, next === -1 ? undefined : next);
    // Dates and slug — `updated_at` because lastmod must reflect an EDIT, not
    // the publication date. Nothing else: no excerpt, no tags, no hero image.
    const select = refs.match(/fetchAllPublishedRows<[^>]*>\('([^']*)'\)/)?.[1];
    expect(select).toBe('slug, published_at, updated_at');
    for (const heavy of ['excerpt', 'hero_image_url', 'tags', 'body']) {
      expect(select, `a sitemap entry is not made of ${heavy}`).not.toContain(heavy);
    }
  });
});
