import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const mig = readFileSync(join(ROOT, 'supabase/migrations/0235_blog_batch2_hero_photos.sql'), 'utf8');
const posts = readFileSync(join(ROOT, 'lib/blog/posts.ts'), 'utf8');

describe('0235 — real hero photos for image-less (batch-2) articles', () => {
  it('assigns a real, free Lorem Picsum photo keyed to each slug', () => {
    expect(mig).toMatch(/hero_image_url\s*=\s*'https:\/\/picsum\.photos\/seed\/'\s*\|\|\s*slug\s*\|\|\s*'\/1600\/900'/);
    expect(mig).toMatch(/'Lorem Picsum \(CC0\)'/);
  });

  it('only fills image-less published posts (idempotent, never overwrites)', () => {
    expect(mig).toMatch(/WHERE published/);
    expect(mig).toMatch(/hero_image_url IS NULL/);
    expect(mig).toMatch(/slug NOT LIKE 'seed-blog_posts-%'/);
  });

  it('uses a source the app does NOT strip (unlike loremflickr)', () => {
    // lib/blog/posts.ts strips only unverified hosts; picsum must not be listed.
    const m = posts.match(/UNVERIFIED_IMAGE_HOSTS\s*=\s*\[([^\]]*)\]/);
    expect(m).toBeTruthy();
    expect(m![1]).not.toMatch(/picsum/i);
    expect(m![1]).toMatch(/loremflickr/i);
  });
});
