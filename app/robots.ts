import type { MetadataRoute } from 'next';
import { CANONICAL_ORIGIN, DISALLOWED_PREFIXES } from '@/lib/marketing/sitemap-urls';

/**
 * Authenticated app surfaces, as directives rather than as an accident of
 * redirects.
 *
 * The disallow list lives in lib/marketing/sitemap-urls.ts because the SITEMAP
 * reads it too — `canonicalUrl` refuses to mint a `<loc>` under any of these
 * prefixes. One file asking Google to index what the other forbids fetching is
 * a contradiction only a shared constant can rule out, and it is also where the
 * reasoning for the list's contents is written down.
 *
 * Nothing here exposes data: every one of these answers 307 to /login while
 * signed out. The list is a policy statement, and for a long time it named four
 * of the twenty-four surfaces it meant.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [...DISALLOWED_PREFIXES],
    },
    sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
  };
}
