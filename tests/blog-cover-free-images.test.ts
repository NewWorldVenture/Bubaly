import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// MKT-IMG (LB-016, product bar: "all images free + unique, no duplicates"):
// the 500-article blog engine used to hotlink loremflickr.com — mixed-license
// (not verified free) images drawn from only 9 keyword pools (visual duplicates).
// Fix: loremflickr URLs are stripped at the data layer and posts without a
// free-licensed hero render a bespoke, per-title generated <BlogCover> (owned,
// unique, duplicate-free, no external host). These guards lock that in.

const posts = fs.readFileSync('lib/blog/posts.ts', 'utf8');
const nextConfig = fs.readFileSync('next.config.mjs', 'utf8');
const cover = fs.readFileSync('components/blog/blog-cover.tsx', 'utf8');
const listPage = fs.readFileSync('app/(marketing)/blog/page.tsx', 'utf8');
const articlePage = fs.readFileSync('app/(marketing)/blog/[slug]/page.tsx', 'utf8');

describe('blog covers are free + unique (MKT-IMG / LB-016)', () => {
  it('unverified-license hosts are stripped at the data layer', () => {
    expect(posts).toContain('loremflickr.com');
    expect(posts).toContain('freeLicensedImage(');
    // The mapping must route hero_image_url through the free-license filter.
    expect(posts).toContain('heroImageUrl: freeLicensedImage(r.hero_image_url)');
  });

  it('loremflickr is no longer an allowed next/image host', () => {
    const remote = nextConfig.slice(nextConfig.indexOf('remotePatterns'), nextConfig.indexOf('remotePatterns') + 600);
    expect(remote).not.toContain("hostname: 'loremflickr.com'");
  });

  it('the generated cover is deterministic per title (unique, no duplicates)', () => {
    // Seeded from the title/slug → stable, unique art; no runtime randomness.
    expect(cover).toContain('function hash(');
    expect(cover).toContain('function rng(');
    expect(cover).toMatch(/seedProp \?\? `\$\{category\}::\$\{title\}`/);
    // Fully self-contained: no external image/CDN reference (the only URL is the
    // SVG xmlns namespace, which is not a network asset).
    const urls = cover.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    expect(urls.every((u) => u === 'http://www.w3.org/2000/svg')).toBe(true);
  });

  it('both render surfaces fall back to <BlogCover>, not a stock hotlink', () => {
    expect(listPage).toContain('<BlogCover');
    expect(articlePage).toContain('<BlogCover');
    expect(articlePage).not.toContain('loremflickr');
    expect(listPage).not.toContain('loremflickr');
  });
});
