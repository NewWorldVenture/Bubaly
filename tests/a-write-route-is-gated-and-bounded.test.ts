import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
    const dead = [...GATES, ...RATE_GATES].filter((g) => !writeRoutes.some((r) => uses(r.src, g)));
    expect(dead, `gate entries no write route uses: ${dead.join(', ')}`).toEqual([]);
  });
});
