// lib/auth/route-access.ts — which paths need a session, and which do not.
//
// Two lists, and the difference between them is the point.
//
// PUBLIC is the allowlist of paths that render without a session. It is long
// and hard-won: the comments below record webhooks, marketing families and
// share links that silently answered 307 to /login because they were missing
// from it.
//
// PROTECTED is the list of paths that DO require one. Until now there was no
// such list — anything not public was redirected to /login, so a path with no
// route at all answered 307 to a sign-in page instead of 404. A person
// following a stale link landed on a login form and, after signing in, a 404;
// a crawler saw a redirect to an irrelevant page, which Google counts as a
// soft 404 and which makes the site look like it has unlimited valid URLs.
//
// With both lists, an unrouted path matches neither and falls through to the
// router, which renders app/not-found.tsx with a 404. Every real authenticated
// route still redirects exactly as before.
//
// tests/route-access-is-total.test.ts walks app/ and fails if any routable
// top-level path is in neither list, so adding a route without classifying it
// is a test failure rather than a page that renders to strangers.

import { MARKETING_PUBLIC_PREFIXES } from '@/lib/marketing/page-types';

export const PUBLIC = ['/', '/features', '/how-it-works', '/pricing', '/security',
  '/ai', '/mobile', '/faq', '/blog', '/contact', '/login', '/signup', '/auth',
  // The public family-display page (device compatibility + setup). Deliberately
  // NOT '/display': that path is the signed-in kiosk and must stay protected.
  '/family-display',
  // Both are sign-in entry points, not authenticated family data. The header's
  // Get started link and a child's PIN sign-in must work before a session exists.
  '/welcome', '/kid-login',
  '/join', '/offline',
  // Legal pages — public for everyone, including signed-out visitors.
  '/terms', '/privacy', '/cookies', '/acceptable-use',
  // Public household benchmarks (k-anonymized aggregates); the page itself
  // answers 404 while the admin publication flag is off.
  '/resources/benchmarks',
  // Public survey response pages (NPS/CSAT/CES) — respondents may be anonymous.
  '/s',
  // Public reviews wall + submission page — no login required.
  '/reviews',
  // Customer story pages enforce publication on the server before rendering.
  '/customers',
  // Public Family Wallet gift pages — relatives gift via an unguessable token.
  '/gift',
  // The Pay-ID resolver a relative follows from a shared handle. It is the
  // signed-out half of the gift flow: it reads through the service role
  // precisely because the visitor has no session, then forwards to the
  // '/gift' token above. Left out of this list, every shared Pay-ID answered
  // 307 to /login — so the grandparent the handle was shared with was asked
  // to create a Bubaly account before they could send a gift, while the
  // /gift link it resolves to worked. It leaks nothing a guess could not
  // already learn: an unknown or inactive handle renders the same dead-end
  // page as an active one with no live link.
  '/pay',
  // Public exit-intent offer resolve + metric beacon (anonymous visitors).
  '/api/exit-intent',
  // Public contact, blog, and marketing telemetry endpoints. These routes
  // apply their own bounded-body, rate-limit, and consent/token controls.
  '/api/contact',
  '/api/blog',
  '/api/ab',
  '/api/mkt',
  '/api/services/descriptions',
  // Public gift-link AI assistant; the gift token and durable IP limiter are
  // the authorization boundary for this narrowly scoped read path.
  '/api/ai/gift',
  // The landing-page metric beacon. The page prefixes themselves come from
  // MARKETING_PUBLIC_PREFIXES below, which is the same list the platform
  // publishes them under.
  '/api/lp/track',
  // Public marketing forms (lead capture) + their submit endpoint.
  '/f',
  '/api/forms',
  // Public iCalendar feeds: subscribed to by Apple Calendar / Outlook / Alexa
  // with no login — the unguessable feed token IS the authorization.
  '/api/sync/feeds',
  // The generated social preview images. Every crawler that renders a shared
  // Bubaly link — X, Slack, Discord, iMessage, WhatsApp, LinkedIn, Facebook —
  // fetches these WITHOUT a session, so behind the session boundary they
  // answered 307 to /login and no shared link showed a preview at all. They
  // render a fixed brand card from build-time assets: no request input, no
  // family data, nothing to protect.
  '/opengraph-image',
  '/twitter-image',
  // Liveness/readiness probe for uptime monitors + LB health checks. Must be
  // reachable without a session (a monitor cannot authenticate); it is read-only
  // and returns only booleans/latency/missing-var names — never a secret.
  '/api/health',
  // Scheduled jobs, internal callbacks, and provider webhooks authenticate
  // themselves with a shared secret or provider signature in their route.
  '/api/cron',
  '/api/concierge-calls',
  '/api/guardian',
  // NOTE: the Family Contact Center's inbound webhooks are deliberately NOT a
  // prefix here. They must be reachable without a session — omitted once, every
  // one of them was answered with a 307 to /login, so the route and its own
  // authentication never ran, and inbound email/SMS/voice could not work however
  // the numbers and MX were configured. But a prefix would also expose any
  // future session-backed route under /api/contact-center (settings, history).
  // So middleware.ts exempts the five callback paths EXACTLY, via
  // PUBLIC_CONTACT_CALLBACKS, and tests/middleware-public-api-boundary.test.ts
  // fails if this file ever widens that back into a prefix. Each of the five
  // authenticates itself: /email demands CONTACT_CENTER_INBOUND_SECRET and is
  // fail-closed in production; the rest verify x-twilio-signature and answer 401.
  '/api/email/welcome',
  // Provider webhooks (signature-verified) and the signed unsubscribe link must
  // be reachable without a session.
  '/api/webhooks',
  '/api/marketing/unsubscribe',
  // Every prefix a published marketing page can live under, read from the same
  // list the platform builds those paths with. Hand-copying them here is how
  // /questions, /guides, /compare, /alternatives, /audiences, /resources,
  // /glossary and /p came to answer 307 to /login for every anonymous visitor
  // and every search engine — eight of the eleven families, invisible. The page
  // is the authorization boundary: it renders only published, non-deleted rows.
  ...MARKETING_PUBLIC_PREFIXES];

/**
 * Every top-level path that requires a session.
 *
 * Derived from the routes that exist: the segments under app/(app), plus
 * /onboarding and /library, which sit outside that group but are just as
 * authenticated. /api is here so an unauthenticated call to a route that is
 * not on the public list keeps being turned away rather than answering.
 *
 * This list is exhaustive by test, not by convention.
 */
export const PROTECTED = [
  '/account', '/admin', '/api', '/capture', '/dashboard',
  // The signed-in kiosk. NOT the public /family-display page, which is the
  // marketing and setup page for it and is on the public list above — the two
  // differ by one word and only one of them may render without a session.
  '/display',
  '/economy', '/family', '/feedback', '/guardian', '/home', '/kids', '/library',
  '/marketplace', '/missions', '/money', '/onboarding', '/parent', '/referrals',
  '/services', '/settings', '/wallet',
];

/** True when `path` equals one of `prefixes` or sits underneath one. */
export function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
