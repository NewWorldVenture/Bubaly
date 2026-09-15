import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Being in the family is not the same as being in the exchange.
//
// `loadOrderRole` scoped to `family_id` and stopped there, and every call site
// then wrote `order.seller_member === me ? 'seller' : 'buyer'` — so a family
// member who is NEITHER party silently became "buyer". From there they could
// overwrite an already-confirmed pickup (the upsert resets `confirm_code` and
// `confirmed_at`), pass confirmHandoff's `role !== proposer_role` check and
// RECEIVE THE HAND-OFF CODE, cancel, and complete. The RPC only checks
// `is_family_member`, so the database does not backstop it, and this file's own
// reason table already carried the refusal that never fired. Audit C3-S4-02.
//
// The check now lives in the loader, so a future call site cannot forget it —
// the lesson the four duplicated escapeLike helpers taught this repository.

const RAW = readFileSync(resolve('app/(app)/marketplace/handoff/actions.ts'), 'utf8');

/**
 * Comments stripped before matching. The first version of this test asserted
 * the old `? 'seller' : 'buyer'` expression was absent and then failed on the
 * COMMENT that quotes it while explaining why it is gone — a guard reading
 * prose as code. A source-scanning rule that cannot tell the two apart will
 * either false-positive on documentation or be silently weakened to avoid it.
 */
const SOURCE = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('a hand-off action refuses a family member who is not a party (C3-S4-02)', () => {
  it('the loader resolves the party role instead of leaving it to be inferred', () => {
    expect(SOURCE).toMatch(/const role:\s*'seller'\s*\|\s*'buyer'\s*\|\s*null/);
    // Both parties are matched explicitly; nobody falls through to a default.
    expect(SOURCE).toMatch(/seller_member === ctx\.active\.member\.id\s*\?\s*'seller'/);
    expect(SOURCE).toMatch(/buyer_member === ctx\.active\.member\.id\s*\?\s*'buyer'/);
  });

  it('no call site infers the role with a two-way ternary any more', () => {
    // This is the exact expression that made a third party a "buyer".
    expect(SOURCE).not.toMatch(/\?\s*'seller'\s*:\s*'buyer'/);
  });

  it('every action that loads an order refuses when the caller is not a party', () => {
    // propose, confirm and cancel. confirm is the one that MINTS the code.
    const guards = SOURCE.match(/if \(!role\) return \{ ok: false, error: t\(COMPLETE_REASON\.forbidden\) \};/g) ?? [];
    expect(guards.length, 'expected the refusal at all three loadOrderRole call sites').toBe(3);

    const loaderCalls = SOURCE.match(/await loadOrderRole\(/g) ?? [];
    // The matcher must find the call sites at all, or this rule is vacuous.
    expect(loaderCalls.length).toBe(3);
  });
});
