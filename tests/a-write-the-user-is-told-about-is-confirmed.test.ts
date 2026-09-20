import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between } from './helpers/source-order';

/**
 * Audit C1-S9-16 — two server actions that reported success for work that may
 * not have happened, found by scanning all 135 `'use server'` files for
 * mutations with no confirmation.
 *
 * The class is the one this repository already has a helper for. PostgREST
 * returns affected rows only when asked — it is `.select()` that appends
 * `Prefer: return=representation` — so without it `data` is null whether one
 * row changed or none did. A caller cannot tell even in principle, and both of
 * these answered "done" regardless.
 */
const wallet = readFileSync('app/(app)/wallet/hub-actions.ts', 'utf8');
const childLogin = readFileSync('app/(app)/family/child-login-actions.ts', 'utf8');

describe('deleting a wallet row is confirmed before it is reported (C1-S9-16)', () => {
  it('asks for the deleted rows on every branch of the allowlist', () => {
    const body = between(wallet, 'export async function deleteWalletRowAction', 'return { ok: true };');
    // The five branches are one ternary chain, so they are one statement — the
    // count has to come from the branches themselves, not from splitting on `;`.
    const deletes = body.match(/\.delete\(\)[^\n]*/g) ?? [];
    expect(deletes.length, 'the five DELETABLE branches').toBe(5);
    for (const d of deletes) {
      expect(d, 'a delete that cannot be confirmed').toContain(".select('id')");
      // And each stays scoped to the acting family.
      expect(d).toContain("eq('family_id', ctx.active.familyId)");
    }
  });

  it('treats "matched nothing" as a failure, not a success', () => {
    const body = between(wallet, 'export async function deleteWalletRowAction', 'return { ok: true };');
    expect(body).toContain('wroteNoRows(deleted)');
    // The zero-row bail must be reached BEFORE the success return. `body` is
    // sliced to end at `return { ok: true };`, so being inside it IS that
    // ordering — and the bail must itself return a failure. (An earlier version
    // of this assertion used `between(body, 'wroteNoRows(deleted)',
    // 'return { ok: false')`, which reverses: the guard clauses above already
    // contain `return { ok: false`. `between()` refused it, which is what it is
    // for.)
    const bail = body.slice(at(body, 'wroteNoRows(deleted)'));
    expect(bail).toContain('return { ok: false');
  });

  it('keeps the money tables manager-only', () => {
    // Unchanged by this fix, asserted so the confirmation work cannot quietly
    // cost the authorization that sits beside it.
    expect(wallet).toContain("MANAGER_ONLY_DELETES = new Set(['financial_accounts', 'transactions'])");
    expect(wallet).toContain('MANAGER_ONLY_DELETES.has(input.table) && !isManager(ctx.active.role)');
  });
});

describe('clearing a child login lockout is not best-effort (C1-S9-16)', () => {
  it('both throttle clears check their error', () => {
    // Match from the DESTRUCTURE, not from `from(` — the thing being asserted
    // (that the error is captured) sits to the LEFT of the table name.
    const clears = childLogin.match(/const \{ error: \w+ \} = await [\s\S]{0,120}?from\('child_login_throttle'\)/g) ?? [];
    expect(clears.length, 'both the create and the reset path clear the throttle').toBe(2);
    // A bare `await admin.from(...)` discards the error entirely, which is how
    // both of these silently failed while reporting success.
    // A bare `await admin.from('child_login_throttle')` would not match above,
    // so an uncaptured clear shows up as a missing pair rather than a pass.
    expect(childLogin.match(/from\('child_login_throttle'\)/g) ?? []).toHaveLength(2);
    expect(childLogin).toContain('if (staleThrottleErr) return { ok: false');
    expect(childLogin).toContain('if (throttleErr) return { ok: false');
  });

  it('the reset lifts the lockout BEFORE changing the PIN', () => {
    // Ordering is the fix, not decoration. Afterwards, a failed clear left the
    // child locked out with a PIN that really had changed — so neither "ok" nor
    // a hard failure would have been true. Running it first makes the outcome
    // all-or-nothing.
    const reset = between(childLogin, 'export async function resetChildPinAction', 'return { ok: true };');
    expect(at(reset, "from('child_login_throttle')")).toBeLessThan(at(reset, 'updateUserById(row.user_id'));
  });

  it('the create path clears the stale lockout before anything is created', () => {
    const create = between(childLogin, "const { data: taken }", 'const email = syntheticChildEmail');
    expect(create).toContain("from('child_login_throttle')");
  });
});
