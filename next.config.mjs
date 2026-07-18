/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Pin tracing to this project (a stray lockfile in the home dir confuses inference).
  outputFileTracingRoot: import.meta.dirname,
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.supabase.co' },
      // Blog hero photos — free-license Unsplash CDN images (0195/0196).
      { protocol: 'https', hostname: 'images.unsplash.com' },
      // Blog hero photos — free Creative-Commons LoremFlickr images, one unique
      // photo per article via a per-post `lock` (0226). Keyworded per category.
      { protocol: 'https', hostname: 'loremflickr.com' },
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
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      // HSTS: force HTTPS for two years across subdomains. The site is
      // HTTPS-only (canonical is https://www.bubaly.com and Vercel serves
      // TLS), so this only hardens against protocol-downgrade / SSL-strip.
      // No `preload` — that commits every subdomain to the browser preload
      // list irreversibly, which we don't want to assert blindly.
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    ];
    return [
      { source: '/(.*)', headers: commonSecurity },
      // Clickjacking protection. DENY everywhere EXCEPT the PUBLIC marketing
      // blog: the logged-in app embeds /blog in a same-origin modal (the in-app
      // "Blog" launcher), which DENY forbids. /blog therefore uses SAMEORIGIN —
      // which still blocks ALL cross-origin framing (the actual clickjacking
      // threat); it only permits our own origin to frame our own public blog.
      // No sensitive actions or data live on /blog, so this is a negligible,
      // standard relaxation scoped to public content only.
      { source: '/((?!blog).*)', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] },
      { source: '/blog', headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] },
      { source: '/blog/:path*', headers: [{ key: 'X-Frame-Options', value: 'SAMEORIGIN' }] },
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
