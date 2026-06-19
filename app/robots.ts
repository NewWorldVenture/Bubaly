import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://familyos.app';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // Authenticated app surfaces should not be indexed.
      disallow: ['/dashboard', '/onboarding', '/api', '/auth'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
