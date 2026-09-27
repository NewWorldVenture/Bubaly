import { describe, expect, it } from 'vitest';
import { loadGraphCompleteness } from '@/lib/twin/completeness-server';

/**
 * Four modules state a fail-closed contract and then do not keep it for the one
 * failure that matters.
 *
 * A Supabase query builder resolves with `{ data, error }` for anything the
 * database answers, and REJECTS only when the request never completed — DNS,
 * TCP, TLS, a timed-out fetch. lib/supabase/settle.ts records that this is what
 * took out /dashboard while production reported CONNECT_TIMEOUT.
 *
 * Each of these inspects `.error` on every element of its batch, deliberately
 * and in writing:
 *
 *   lib/twin/completeness-server.ts   "`{ ok: false }` when ANY of them failed.
 *                                      A partial snapshot would produce a
 *                                      confidently wrong score"
 *   lib/schedule/intelligence-server.ts  "READ BOUNDARY: this is a fail-closed
 *                                      loader. A failed read of any source
 *                                      returns `{ ok: false }`"
 *   lib/autopilot/policy-scan.ts      `.find((r) => r.error)`
 *   lib/briefing/deliver.ts           per-read `if (res.error)`
 *
 * All four handled the RESOLVED error and none handled the REJECTION. Inside
 * `Promise.all` one rejection rejects the batch, so a transport failure skipped
 * the check entirely and left the module as an unhandled rejection — the error
 * boundary, not `{ ok: false }`. The contract was true of the failure the
 * database reports and false of the failure the network produces.
 *
 * `settleAll` does not relax any of this. It converts a rejection into exactly
 * the `{ data: null, count: null, error }` shape those checks already read, so
 * the fail-closed loader still fails closed and the completeness score still
 * refuses to score a partial read — by its own stated rule now, rather than by
 * an exception nobody catches. That is why this is not a trade: nothing is
 * being softened, a promise is being kept.
 */

/**
 * A client whose Nth table read rejects the way a transport failure does, and
 * whose others resolve normally.
 */
function clientRejectingOn(table: string) {
  const builder = (name: string) => {
    const self: Record<string, unknown> = {
      select() { return self; },
      eq() { return self; },
      is() { return self; },
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        return name === table
          ? Promise.reject(new Error('fetch failed: ECONNRESET')).then(resolve, reject)
          : Promise.resolve({ data: [], error: null }).then(resolve);
      },
    };
    return self;
  };
  return { from: builder } as never;
}

describe('a fail-closed loader must actually close', () => {
  it('returns { ok: false } when a read REJECTS, not just when it errors', async () => {
    // Calibration is the shape of this assertion, not a second case: against the
    // bare Promise.all this call REJECTED, so `await` threw and the test failed
    // with ECONNRESET rather than returning a value at all.
    const result = await loadGraphCompleteness(clientRejectingOn('family_places'), 'fam-1');
    expect(result.ok).toBe(false);
  });

  it('still answers for a healthy read', async () => {
    // Non-vacuity: a loader that returned { ok: false } unconditionally would
    // pass the case above and be useless.
    const result = await loadGraphCompleteness(clientRejectingOn('nothing-rejects'), 'fam-1');
    expect(result.ok).toBe(true);
  });

  it('rejects on whichever element fails, not only the first', async () => {
    // The batch is nine reads; a guard that only covered the first would miss
    // the eight that a transport failure is just as likely to hit.
    for (const table of ['family_members', 'pets', 'vehicles', 'health_providers']) {
      const result = await loadGraphCompleteness(clientRejectingOn(table), 'fam-1');
      expect(result.ok, `rejecting ${table} did not close the loader`).toBe(false);
    }
  });
});
