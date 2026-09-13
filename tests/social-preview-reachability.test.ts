// A shared Bubaly link must render a preview card.
//
// Two independent defects removed that from the whole site, and each was enough
// on its own. Production evidence, taken 2026-09-13 against www.bubaly.com:
//
//   GET /opengraph-image            -> 307 /login?redirect=%2Fopengraph-image
//   GET /twitter-image              -> 307 /login?redirect=%2Ftwitter-image
//   GET /          og: tags present -> og:title, og:description ONLY
//   GET /pricing   og: tags present -> og:title, og:description ONLY
//   GET /login     og: tags present -> og:title, og:description, og:image,
//                  og:image:alt/width/height/type, og:site_name, og:type, og:url
//
// /login renders the complete set because it does not call
// resolveMarketingMetadata. Every page that does call it lost the image.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';

describe('the social preview images are reachable without a session', () => {
// The public allowlist moved to lib/auth/route-access.ts when middleware
// gained a PROTECTED list (so an unrouted path 404s instead of being sent
// to /login). Both files are read here: the routing LOGIC is still in
// middleware.ts, the allowlist entries are in the other.
  const middleware = readFileSync('middleware.ts', 'utf8') + readFileSync('lib/auth/route-access.ts', 'utf8');
  const publicList = /const PUBLIC = \[([\s\S]*?)\];/.exec(middleware);

  it.each(['/opengraph-image', '/twitter-image'])('%s is public', (path) => {
    expect(publicList, 'the middleware PUBLIC list could not be read').not.toBeNull();
    // Every crawler that renders a shared link fetches these with no cookie.
    // Behind the session boundary they answer 307 to /login and the preview is
    // a login page, or nothing at all.
    expect(publicList![1], `${path} must be reachable by an unauthenticated crawler`).toContain(`'${path}'`);
  });
});

describe('resolveMarketingMetadata keeps the whole Open Graph card', () => {
  // No admin SEO row is reachable from a unit test, so the fallback path is the
  // one under test — which is also the path every marketing page takes today.
  async function og(path: string, fallback = {}) {
    const meta = await resolveMarketingMetadata(path, fallback);
    return (meta.openGraph ?? {}) as Record<string, unknown>;
  }

  it('carries an image, so a shared link is not a bare headline', async () => {
    const images = (await og('/pricing')).images as Array<Record<string, unknown>>;
    expect(images, 'og:image is what every unfurl renders').toBeTruthy();
    expect(images[0].url).toBe('https://www.bubaly.com/opengraph-image');
    expect(images[0].width).toBe(1200);
    expect(images[0].height).toBe(630);
    expect(images[0].alt).toBeTruthy();
  });

  it('carries the site identity the root layout declares', async () => {
    const result = await og('/features');
    expect(result.type).toBe('website');
    expect(result.siteName).toBe('Bubaly');
    expect(result.url).toBe('https://www.bubaly.com/features');
  });

  it('still lets a page override what it sets for itself', async () => {
    const result = await og('/blog/a-post', {
      openGraph: { type: 'article', url: 'https://www.bubaly.com/blog/a-post' },
    });
    expect(result.type, 'a blog post is an article, not a website').toBe('article');
    expect(result.url).toBe('https://www.bubaly.com/blog/a-post');
    // Overriding type must not cost the page its image.
    expect(result.images).toBeTruthy();
  });
});
