import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Product bar: "every single article has a UNIQUE FREE image ... related to the
// subject matter." 0231 assigns each published article a hero photo via a
// per-slug UPDATE. This guard locks in: full coverage of the seeded articles,
// zero duplicate image URLs, and only allow-listed (next/image-configured) hosts.
const ROOT = join(__dirname, '..');
const MIG = readFileSync(join(ROOT, 'supabase/migrations/0232_blog_hero_photos.sql'), 'utf8');
const SEED = readFileSync(join(ROOT, 'supabase/migrations/0226_blog_500_articles.sql'), 'utf8');
const NEXT = readFileSync(join(ROOT, 'next.config.mjs'), 'utf8');

// Slugs of the real (non-synthetic) seeded articles.
const seedSlugs = (SEED.match(/^\('([a-z0-9-]+)'/gm) ?? [])
  .map((m) => m.slice(2, -1))
  .filter((s) => !/^seed-blog_posts-\d+$/i.test(s));

// Parse the migration's per-slug photo assignments (one UPDATE per line; URLs
// are URL-encoded so contain no single quote, slugs are [a-z0-9-]).
const updates = MIG.split('\n')
  .filter((l) => l.startsWith('update public.blog_posts'))
  .map((l) => ({
    url: l.match(/hero_image_url='([^']+)'/)?.[1] ?? '',
    slug: l.match(/where slug='([a-z0-9-]+)'/)?.[1] ?? '',
  }))
  .filter((u) => u.url && u.slug);

// Hosts registered in next.config remotePatterns (so next/image won't throw).
const allowedHosts = new Set(
  [...NEXT.matchAll(/hostname: '([^']+)'/g)].map((m) => m[1].replace(/^\*\./, '')),
);

describe('0231 blog hero photos — unique, covered, allow-listed', () => {
  it('assigns a photo to every real seeded article', () => {
    const assigned = new Set(updates.map((u) => u.slug));
    const missing = seedSlugs.filter((s) => !assigned.has(s));
    expect(missing, `missing hero photo for: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0);
  });

  it('every hero image URL is unique (no duplicates)', () => {
    const urls = updates.map((u) => u.url);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('every hero image is https and on an allow-listed host', () => {
    for (const { url } of updates) {
      expect(url.startsWith('https://')).toBe(true);
      const host = new URL(url).hostname;
      const ok = allowedHosts.has(host) || [...allowedHosts].some((h) => host === h || host.endsWith(`.${h}`));
      expect(ok, `host not allow-listed in next.config: ${host}`).toBe(true);
    }
  });

  it('covers 500+ articles', () => {
    expect(updates.length).toBeGreaterThanOrEqual(500);
  });
});
