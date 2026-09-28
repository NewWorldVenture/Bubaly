import { buildContentSecurityPolicy } from './lib/security/csp.mjs';
import { parseBuildRevision } from './lib/build-identity.mjs';

// Next's bundled react-dom client, production and development, stable and
// experimental: where scripts/react-hydration-replay-fix.cjs applies.
const REACT_DOM_CLIENT = /[\\/]next[\\/]dist[\\/]compiled[\\/]react-dom(?:-experimental)?[\\/]cjs[\\/]react-dom-client\.(?:production|development)\.js$/;
const REACT_HYDRATION_REPLAY_FIX = new URL('./scripts/react-hydration-replay-fix.cjs', import.meta.url).pathname;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 15's build re-ran the type-check and ESLint that CI already ran as
  // their own steps, in the SAME worker that held webpack's module graph.
  // That co-residency, not the type-check itself, is
  // what makes the build fragile: a Vercel deployment of this branch died in
  // "Linting and checking validity of types" with "Ineffective mark-compacts
  // near heap limit", and locally that worker was at 4,471 MB against the
  // 4,096 MB old-space cap in package.json.
  //
  // The same check standing on its own is cheap. Measured on this tree with
  // .next/types present: `tsc --noEmit` peaks at 1,082 MB and exits 0 — a
  // quarter of the memory for the same work, because it is not sharing a heap
  // with the compiler.
  //
  // So the pass moves rather than disappears. .github/workflows/ci.yml builds
  // first and type-checks after, which is what keeps the coverage whole:
  // tsconfig.json includes .next/types/**, so the standalone check validates
  // every generated route signature as well as the app, and Lint is its own
  // step (Next 16 no longer runs ESLint inside the build). Both gate every pull request, and production only builds a commit
  // that passed them.
  typescript: { ignoreBuildErrors: true },
  // Next inlines this literal into the build artifact. Never derive identity
  // from a request or substitute a branch/revision when the build input is absent.
  env: {
    BUBALY_BUILD_REVISION: parseBuildRevision(process.env.VERCEL_GIT_COMMIT_SHA) ?? '',
  },
  // Pin tracing to this project (a stray lockfile in the home dir confuses inference).
  outputFileTracingRoot: import.meta.dirname,
  // React #418 on about 0.7% of signed-in loads, on a tree identical on server
  // and client: react/react#37584 in the React Next 15.5 bundles, where a host
  // element that suspends mid-hydration is replayed without rewinding the
  // hydration cursor. The loader backports React 19.3's fix into Next's own
  // react-dom client, leaves a React that already has it (Next 16's) alone, and
  // fails the build on a React it does not recognise.
  // tests/react-hydration-replay-fix.test.ts holds the wiring.
  webpack(config) {
    config.module.rules.push({ test: REACT_DOM_CLIENT, use: [{ loader: REACT_HYDRATION_REPLAY_FIX }] });
    return config;
  },
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
      // Consolidated routes, kept alive for old links and bookmarks. These were
      // pages that only called redirect(), and a redirect() inside the signed-in
      // app streams: app/(app)/loading.tsx has already sent the shell, so the
      // "redirect" was a client-side navigation after the sidebar mounted — its
      // in-flight fetch was cut off and logged, and the first response was a
      // 200 (page audit, signed-in sweep, 2026-09-27). Here they are one 308.
      { source: '/parent', destination: '/dashboard/family-operations', permanent: true },
      { source: '/admin/tiers', destination: '/admin/tier-features', permanent: true },
      { source: '/dashboard/family-ai-assistant', destination: '/dashboard/assistant', permanent: true },
      { source: '/dashboard/family-knowledge-graph', destination: '/dashboard/graph', permanent: true },
      { source: '/dashboard/family-memory', destination: '/dashboard/memories', permanent: true },
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
      // The OAuth callback carries an authorization code in its URL, and the
      // sign-out form post a sign-out intent. Both routes set `no-referrer` on
      // their own responses, but the rule above replaced it, so the served policy
      // was the global one (seen on a production build, 2026-09-28). For the same
      // key the last matching rule wins, so this restores what the routes ask for.
      { source: '/auth/:route(callback|signout)', headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }] },
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
