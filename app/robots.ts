import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://www.bubaly.com';

/**
 * Authenticated app surfaces, as directives rather than as an accident of
 * redirects.
 *
 * Every one of these answers 307 to /login when signed out, so nothing here
 * exposes data. What was wrong is narrower and still worth fixing: the rule
 * below says "authenticated app surfaces should not be indexed" and then named
 * four of them. The other twenty — /admin and its 80 pages among them — were
 * left to the redirect to handle, which is a behaviour, not a policy. A crawler
 * still spends budget discovering them, and a future route that answers 200 to
 * an anonymous request inherits no protection at all.
 *
 * Kept as an explicit list rather than derived at runtime because robots.ts is
 * prerendered and must not depend on a filesystem walk; a test derives the same
 * set from `app/(app)` and fails when a new segment is added without a line
 * here, so the list cannot quietly fall behind.
 */
export const DISALLOWED_APP_PATHS = [
  '/account',
  '/admin',
  '/api',
  '/auth',
  '/capture',
  '/dashboard',
  '/display',
  '/economy',
  '/family',
  '/feedback',
  '/guardian',
  '/home',
  '/kids',
  '/library',
  '/marketplace',
  '/missions',
  '/money',
  '/onboarding',
  '/parent',
  '/pay',
  '/referrals',
  '/services',
  '/settings',
  '/wallet',
] as const;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [...DISALLOWED_APP_PATHS],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
