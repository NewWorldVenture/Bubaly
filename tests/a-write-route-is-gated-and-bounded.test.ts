import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const API = join(ROOT, 'app/api');

/**
 * EVERY WRITE ROUTE IS GATED, AND EVERY JSON BODY IS BOUNDED.
 *
 * Both facts held when this was written — 141 routes, nothing to fix. The file
 * exists because establishing them by hand took three attempts, and each wrong
 * attempt was wrong in the SAME direction: a hand-written list of gate helpers
 * that missed one.
 *
 *   scan 1  26 "ungated" routes — the list omitted `authenticateAI`, so
 *           /api/ai/runs/[id]/pause and /cancel looked open. They are not.
 *   scan 2   3 unprotected write routes — the list omitted `hasInternalSecret`
 *           and `getUserContext`. All three were gated.
 *   scan 3   0.
 *
 * A list that lives in someone's head gets shorter every time it is retyped.
 * This one is derived from what the routes actually call, written down, and
 * checked — so the next person to add a gate helper finds out here rather than
 * by reading 141 files.
 *
 * WHAT THIS DOES NOT CLAIM. Presence of a gate is not proof the gate is correct
 * or that it covers every branch in the handler. It is the floor: a write route
 * that calls none of these is certainly wrong, and that is worth catching
 * cheaply. Authority itself is asserted where it lives — `cron-auth`,
 * `route-access-is-total`, and the RLS boundary probes under `docs/audit/`.
 */

/** The gates this codebase actually uses on write routes. Adding one? Add it here. */
const GATES = [
  'requireUserContext',      // session + family context, the common case
  'getUserContext',          // its lower-level twin
  'authenticateAI',          // cookie-or-bearer for the AI surface
  'auth.getUser', 'getUser()',
  'requireMarketingAdmin', 'isSuperAdmin',
  'hasInternalSecret',       // server-action-only endpoints
  // The shared cron secret. It was ABSENT from this list, and the gap was
  // invisible while the file only looked at POST/PUT/PATCH/DELETE: every cron
  // route is a GET, so none of them was ever checked against it. Extending the
  // scan to reads is what surfaced the omission — 24 scheduled jobs, all gated in
  // the code, none of them gated by this test.
  'hasCronAuthorization',
  'secretEquals',
  'stripe.webhooks', 'constructEvent', 'svix-signature',  // signature-verified webhooks
  'validateTwilioSignature',  // the Twilio callbacks: guardian inbound, screening, contact centre
];

/**
 * Deliberately PUBLIC write endpoints — a blog like, a contact form, an A/B
 * beacon, the gift flow — carry no identity by design. They are not ungated;
 * they are gated on RATE rather than on who you are, which is the only gate
 * available when the answer to "who is this" is "nobody yet". A public write
 * route with neither is the real defect this file looks for.
 */
const RATE_GATES = ['enforceRequestRateLimit', 'rateLimit'];

/** Reading a request body without a cap is how one POST becomes a memory limit. */
const BOUNDED = ['readBoundedRequestJson', 'MAX_SMALL_JSON_BYTES', 'MAX_BODY_BYTES', 'MAX_EMAIL_REQUEST_BYTES'];

/**
 * Substring matching is not enough. Renaming a call to
 * `DISABLED_enforceRequestRateLimit` leaves the gate's name inside the file, so
 * `includes()` keeps answering yes about a gate that no longer runs — which the
 * calibration for this file caught by failing to fail. Identifiers are matched
 * on word boundaries; the few entries that are not plain identifiers
 * (`stripe.webhooks`, `svix-signature`, `auth.getUser`, `getUser()`) fall back
 * to a literal search.
 */
function uses(src: string, needle: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(needle)) return src.includes(needle);
  return new RegExp(`(?<![A-Za-z0-9_])${needle}(?![A-Za-z0-9_])`).test(src);
}

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) routeFiles(p, out);
    else if (e === 'route.ts') out.push(p);
  }
  return out;
}

const writeRoutes = routeFiles(API)
  .map((p) => ({ path: p.slice(ROOT.length + 1), src: readFileSync(p, 'utf8') }))
  .filter((r) => /export async function (POST|PUT|PATCH|DELETE)/.test(r.src));

/**
 * The other half of the surface: a GET that reads a table.
 *
 * This file was named for WRITE routes and filtered to POST/PUT/PATCH/DELETE, so
 * 56 GET handlers were never examined by it at all. A write with no gate lets a
 * stranger change something; a READ with no gate lets them see it, and on these
 * tables what they would see is one family's calendar, documents or health
 * records. Both belong here.
 *
 * Four GETs read a table with no identity gate, and all four are public BY
 * DESIGN — so this list is the point of the rule rather than an exception to it:
 * each is named with the capability that stands in for a session, and a fifth
 * appearing fails until someone writes down which it is.
 */
const PUBLIC_READS: { path: string; why: string }[] = [
  {
    path: 'app/api/blog/like/route.ts',
    why: 'The public blog ♥. Anonymous by design, keyed by the durable bubaly_vid '
      + 'visitor id with one like per (post, visitor) enforced by a unique constraint, '
      + 'IP rate-limited, and it reads blog_posts — published marketing content, not '
      + 'family data.',
  },
  {
    path: 'app/api/blog/unsubscribe/route.ts',
    why: 'The one-click unsubscribe link a digest email carries. The UUID token IS the '
      + 'authorization — requiring a session would break the only flow it exists for — '
      + 'and it is idempotent, so a second visit is still unsubscribed.',
  },
  {
    path: 'app/api/marketing/unsubscribe/route.ts',
    why: 'The same shape for marketing email, rendering an HTML confirmation page '
      + 'rather than JSON because a person clicked it from their inbox.',
  },
  {
    path: 'app/api/sync/feeds/[token]/route.ts',
    why: 'The iCalendar feed. The feed_token is an unguessable capability slug and no '
      + 'OAuth is possible — Apple Calendar and Outlook cannot sign in. Its own header '
      + 'records that NOTHING ISSUES A TOKEN yet, so every request is a 404 today, and '
      + 'tests/a-capability-nothing-can-issue.test.ts goes red the moment a writer '
      + 'appears.',
  },
];

const readRoutes = routeFiles(API)
  .map((p) => ({ path: p.slice(ROOT.length + 1).split(sep).join('/'), src: readFileSync(p, 'utf8') }))
  .filter((r) => /export async function GET/.test(r.src))
  // Only the ones that actually touch a table. A GET that computes, proxies or
  // renders reads nothing there is to leak, and demanding a gate would be asking
  // for a check with no subject.
  .filter((r) => /\.from\('[a-z_]+'\)/.test(r.src));

describe('a read route is gated, or is public on purpose', () => {
  it('finds the GET routes it claims to cover', () => {
    expect(readRoutes.length, 'no data-reading GET routes found — the filter broke').toBeGreaterThanOrEqual(20);
  });

  it('every data-reading GET is gated on identity, or named as public with its reason', () => {
    const named = new Set(PUBLIC_READS.map((p) => p.path));
    const ungated = readRoutes
      .filter((r) => !GATES.some((g) => uses(r.src, g)))
      .filter((r) => !named.has(r.path))
      .map((r) => `${r.path} — reads a table with no identity gate and is not in PUBLIC_READS`);
    expect(
      ungated,
      'a GET with no gate lets a stranger SEE what a write would let them change. '
      + 'Either gate it, or add it to PUBLIC_READS with the capability that stands in '
      + 'for a session:\n' + ungated.map((u) => `  ${u}`).join('\n'),
    ).toEqual([]);
  });

  it('every PUBLIC_READS entry still exists, still has a GET, and still lacks a gate', () => {
    // Non-vacuity in three directions. An entry whose file moved, whose GET went
    // away, or which has SINCE been gated is a claim nobody is checking — and the
    // third is the one that matters: a stale exemption is a hole the next edit
    // falls into.
    for (const { path, why } of PUBLIC_READS) {
      expect(why.length, `${path} does not say why it is public`).toBeGreaterThan(40);
      const route = readRoutes.find((r) => r.path === path);
      expect(route, `${path} is in PUBLIC_READS but reads no table (moved, or gone)`).toBeTruthy();
      expect(
        GATES.some((g) => uses(route!.src, g)),
        `${path} is gated now — remove it from PUBLIC_READS so the rule applies`,
      ).toBe(false);
    }
  });
});

describe('a write route is gated and bounded', () => {
  it('finds the routes it claims to cover', () => {
    // Non-vacuity: a broken walker or filter makes every assertion below pass
    // over an empty list, which is the failure these guards exist to prevent.
    expect(writeRoutes.length, 'no write routes found — the walker or the filter broke').toBeGreaterThanOrEqual(60);
    expect(routeFiles(API).length, 'no route files found at all').toBeGreaterThanOrEqual(120);
  });

  it('every write route is gated on identity or on rate', () => {
    const ungated = writeRoutes
      .filter((r) => !GATES.some((g) => uses(r.src, g)) && !RATE_GATES.some((g) => uses(r.src, g)))
      .map((r) => `${r.path} — neither an identity gate nor a rate limit`);
    expect(ungated, ungated.join('\n')).toEqual([]);
  });

  it('a write route with no identity gate is rate-limited, and there are some', () => {
    // Named rather than inferred: these are the endpoints anyone on the
    // internet can POST to, so the set is worth being able to read at a glance.
    const publicWrites = writeRoutes
      .filter((r) => !GATES.some((g) => uses(r.src, g)))
      .map((r) => r.path);
    expect(publicWrites.length, 'no public write routes found — the split broke').toBeGreaterThanOrEqual(5);
    for (const p of publicWrites) {
      const src = writeRoutes.find((r) => r.path === p)!.src;
      expect(RATE_GATES.some((g) => uses(src, g)), `${p} is public and NOT rate-limited`).toBe(true);
    }
  });

  it('every write route that reads a json body bounds it', () => {
    const unbounded = writeRoutes
      .filter((r) => /\b(req|request)\.json\(\)/.test(r.src))
      .filter((r) => !BOUNDED.some((b) => uses(r.src, b)))
      .map((r) => `${r.path} — reads an unbounded json body; use readBoundedRequestJson`);
    expect(unbounded, unbounded.join('\n')).toEqual([]);
  });

  it('the gate list is not padded with entries nothing uses', () => {
    // The other way a list rots: it grows names that stopped meaning anything,
    // and then "is it in the list" stops being a real question.
    //
    // Scanned over READ routes as well, and that is not a widening for
    // convenience — GATES now serves both rules, and while this looked only at
    // writes it would have REJECTED adding `hasCronAuthorization`, which every one
    // of the 24 scheduled GETs uses and none of the write routes does. A check
    // that forbids the fix for the gap beside it is how the gap survived.
    const everyRoute = [...writeRoutes, ...readRoutes];
    const dead = [...GATES, ...RATE_GATES].filter((g) => !everyRoute.some((r) => uses(r.src, g)));
    expect(dead, `gate entries no route uses at all: ${dead.join(', ')}`).toEqual([]);
  });
});
