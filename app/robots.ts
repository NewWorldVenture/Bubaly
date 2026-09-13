import type { MetadataRoute } from 'next';
import { CANONICAL_ORIGIN, DISALLOWED_PREFIXES } from '@/lib/marketing/sitemap-urls';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Authenticated app surfaces should not be indexed. Shared with the
      // sitemap, which refuses to list any URL under these prefixes — one file
      // asking Google to index what the other forbids fetching is a
      // contradiction that only a shared constant can rule out.
      disallow: [...DISALLOWED_PREFIXES],
    },
    sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
  };
}
