// lib/security/csp.mjs — Content-Security-Policy composition.
//
// Plain ESM (no TypeScript) because next.config.mjs imports it at build time,
// where the policy is baked into the routes manifest. Unit-tested from vitest
// (tests/csp-header.test.ts) and enforced end-to-end (tests/e2e/csp.spec.ts).
//
// Design notes:
// - `script-src` keeps 'unsafe-inline' because Next.js hydrates through inline
//   scripts and the app does not run a nonce pipeline; the directives that stop
//   the classic injection/exfiltration paths (`object-src 'none'`, `base-uri`,
//   `connect-src`, `frame-src`, `frame-ancestors`) are strict.
// - `form-action` is intentionally omitted: Chromium applies it to the redirect
//   chain after a form POST, which would break server-action redirects into
//   Stripe Checkout and Supabase/Google OAuth.
// - Supabase: the browser client talks straight to the project (REST +
//   Realtime WebSocket). We allow the configured project origin plus the hosted
//   wildcard so preview builds against a different project still work.
// - Stripe (card reveal / Elements) and YouTube/Vimeo (marketing video embeds)
//   are the only third-party frames/scripts in the codebase.

const STRIPE_SCRIPT = ['https://js.stripe.com'];
const STRIPE_FRAMES = ['https://js.stripe.com', 'https://hooks.stripe.com', 'https://m.stripe.network'];
const STRIPE_CONNECT = ['https://api.stripe.com', 'https://r.stripe.com', 'https://m.stripe.network'];
const VIDEO_FRAMES = ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'];
// Third-party APIs the BROWSER calls directly (client components → lib/*):
//   Weather + Trip Intel modules: Open-Meteo forecast + geocoding, BigDataCloud
//   reverse geocoding (lib/weather/open-meteo.ts); Trip Intel drive estimates:
//   OSRM (lib/trips/routing.ts). tests/csp-client-hosts.test.ts keeps this list
//   in sync with the code — add here BEFORE adding a new browser-side API.
export const CLIENT_API_ORIGINS = [
  'https://api.open-meteo.com',
  'https://geocoding-api.open-meteo.com',
  'https://api.bigdatacloud.net',
  'https://router.project-osrm.org',
];

/** @param {string | undefined | null} url */
function originOf(url) {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** @param {(string | null | undefined)[]} values */
function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * @param {object} opts
 * @param {string | undefined} [opts.supabaseUrl] NEXT_PUBLIC_SUPABASE_URL at build time.
 * @param {boolean} [opts.isProduction] false adds the dev-only allowances (eval + HMR socket).
 * @param {"'none'" | "'self'"} [opts.frameAncestors] who may frame the page (mirrors X-Frame-Options).
 * @returns {string} the header value
 */
export function buildContentSecurityPolicy({ supabaseUrl, isProduction = true, frameAncestors = "'none'" } = {}) {
  const supabaseOrigin = originOf(supabaseUrl);
  const supabaseSocket = supabaseOrigin ? supabaseOrigin.replace(/^http/, 'ws') : null;
  const dev = isProduction ? [] : ['ws://localhost:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'http://127.0.0.1:*'];

  /** @type {[string, (string | null | undefined)[]][]} */
  const directives = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", "'unsafe-inline'", ...(isProduction ? [] : ["'unsafe-eval'"]), ...STRIPE_SCRIPT]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['font-src', ["'self'", 'data:']],
    ['media-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['connect-src', ["'self'", supabaseOrigin, supabaseSocket, 'https://*.supabase.co', 'wss://*.supabase.co', ...STRIPE_CONNECT, ...CLIENT_API_ORIGINS, ...dev]],
    ['frame-src', ["'self'", ...STRIPE_FRAMES, ...VIDEO_FRAMES]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['frame-ancestors', [frameAncestors]],
  ];

  return directives.map(([name, values]) => `${name} ${uniq(values).join(' ')}`).join('; ');
}

/**
 * Parse a policy string back into {directive: [sources]} — handy for tests and audits.
 * @param {string} value
 * @returns {Record<string, string[]>}
 */
export function parseContentSecurityPolicy(value) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}
