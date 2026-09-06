import { buildContentSecurityPolicy } from './lib/security/csp.mjs';
import { parseBuildRevision } from './lib/build-identity.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next inlines this literal into the build artifact. Never derive identity
  // from a request or substitute a branch/revision when the build input is absent.
  env: {
    BUBALY_BUILD_REVISION: parseBuildRevision(process.env.VERCEL_GIT_COMMIT_SHA) ?? '',
  },
  // Pin tracing to this project (a stray lockfile in the home dir confuses inference).
  outputFileTracingRoot: import.meta.dirname,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      // Blog hero photos — free-license Unsplash CDN images (0195/0196).
      { protocol: 'https', hostname: 'images.unsplash.com' },
      // Blog hero photos (0231) — each article's UNIQUE, free, subject-matched
      // photo. Sourced via the keyless Openverse API (Flickr CC, commercial-use)
      // with a Lorem Picsum (CC0) fallback so no article is ever image-less or
      // shares a photo. Every URL was HTTP-200 load-verified at generation time.
      { protocol: 'https', hostname: 'live.staticflickr.com' },
      { protocol: 'https', hostname: 'upload.wikimedia.org' },
      { protocol: 'https', hostname: 'picsum.photos' },
      { protocol: 'https', hostname: 'fastly.picsum.photos' },
      // NOTE: loremflickr.com was removed — its images are mixed-license (not
      // verified free) and drawn from too few pools (visual duplicates). It stays
      // stripped at the data layer (lib/blog/posts.ts); the generated <BlogCover>
      // remains the fallback for any post that still has no hero photo.
    ],
  },
  async redirects() {
    return [
      // Canonical domain is www.bubaly.com. Permanently redirect the legacy
      // theagoras.com (apex + www) to it so any request that reaches the app
      // lands on the live site. (The domains must also be attached to this
      // Vercel project for the alias to route here in the first place.)
      {
        source: '/:path*',
        has: [{ type: 'host', value: '(www\\.)?theagoras\\.com' }],
        destination: 'https://www.bubaly.com/:path*',
        permanent: true,
      },
      // Marketplace moved from /dashboard/marketplace to the top-level
      // /marketplace URL. Permanently redirect the old paths (and every
      // sub-route: browse, store, creators, saved, collections, orders, reviews,
      // seed) so existing links, bookmarks, and shares keep working.
      {
        source: '/dashboard/marketplace',
        destination: '/marketplace',
        permanent: true,
      },
      {
        source: '/dashboard/marketplace/:path*',
        destination: '/marketplace/:path*',
        permanent: true,
      },
    ];
  },
  async headers() {
    // Security headers that apply to EVERY route, framing aside.
    const commonSecurity = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      // Voice messages, document capture, and family check-ins need these APIs.
      // Same-origin access still requires the user's browser permission and
      // does not delegate device access to embedded third-party content.
      { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=(self)' },
      // HSTS: force HTTPS for two years across subdomains. The site is
      // HTTPS-only (canonical is https://www.bubaly.com and Vercel serves
      // TLS), so this only hardens against protocol-downgrade / SSL-strip.
      // No `preload` — that commits every subdomain to the browser preload
      // list irreversibly, which we don't want to assert blindly.
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    ];
    // Content-Security-Policy (composed in lib/security/csp.mjs, unit + e2e
    // tested). frame-ancestors mirrors the X-Frame-Options split below so the
    // two headers never disagree about who may frame a page.
    const csp = (frameAncestors) => ({
      key: 'Content-Security-Policy',
      value: buildContentSecurityPolicy({
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        isProduction: process.env.NODE_ENV === 'production',
        frameAncestors,
      }),
    });
    return [
      { source: '/(.*)', headers: commonSecurity },
      // Clickjacking protection. DENY everywhere EXCEPT the PUBLIC marketing
      // blog: the logged-in app embeds /blog in a same-origin modal (the in-app
      // "Blog" launcher), which DENY forbids. /blog therefore uses SAMEORIGIN —
      // which still blocks ALL cross-origin framing (the actual clickjacking
      // threat); it only permits our own origin to frame our own public blog.
      // No sensitive actions or data live on /blog, so this is a negligible,
      // standard relaxation scoped to public content only.
      { source: '/((?!blog).*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, csp("'none'")] },
      { source: '/blog', headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }, csp("'self'")] },
      { source: '/blog/:path*', headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }, csp("'self'")] },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default nextConfig;
