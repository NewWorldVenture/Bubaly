import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between, bodyOf } from './helpers/source-order';

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

/**
 * Audit C1-S9-33 — the same class in two more files, carried over from the
 * C1-S9-16/23 shortlist.
 *
 * Triaging these produced a rule worth stating, because it is what separates
 * the ~105 remaining candidates into real and cosmetic: **a silent no-op is
 * only self-correcting if the surface re-reads and actually re-renders from
 * that read.** `InstallButton` looks like it re-reads — `revalidatePath` does
 * re-render the page — but it holds `useState(initial)`, which is read once at
 * mount and ignores the fresh props. So it rolls back ONLY on `ok: false`, and
 * an unconfirmed write leaves the button disagreeing with the database until a
 * full page reload. That is exactly the case these guards pin.
 */
const appStore = readFileSync('app/(app)/dashboard/app-store/actions.ts', 'utf8');
const economy = readFileSync('app/(app)/economy/actions.ts', 'utf8');

describe('an install the button reports is confirmed (C1-S9-33)', () => {
  it('all three install-lifecycle writes ask what they changed', () => {
    const writes = appStore.match(/from\('family_app_installs'\)[\s\S]{0,320}?;/g) ?? [];
    expect(writes.length, 'install, uninstall, toggle').toBe(3);
    for (const w of writes) expect(w, 'a write that cannot be confirmed').toContain(".select('app_id')");
  });

  it('each one fails rather than reporting a write it cannot see', () => {
    for (const binding of ['installed', 'removed', 'toggled']) {
      expect(appStore, `${binding} is not checked`).toContain(`if (wroteNoRows(${binding}))`);
    }
    // Not a bare rethrow of the Postgres message: the button surfaces
    // `res.error` to the parent verbatim.
    expect(appStore).toContain("t('actions.couldNotInstallThatApp')");
    expect(appStore).toContain("t('actions.couldNotRemoveThatApp')");
    expect(appStore).toContain("t('actions.couldNotUpdateThatApp')");
  });

  it('every write stays scoped to the acting family', () => {
    // The confirmation must not be bought by widening the filter: a `.select()`
    // on an unscoped update would confirm a write to somebody else's row.
    const writes = appStore.match(/from\('family_app_installs'\)[\s\S]{0,320}?;/g) ?? [];
    // The upsert carries the family in its payload; the delete and update carry
    // it as a filter. Both forms scope the row — a `.select()` on an UNSCOPED
    // write would confirm a change to somebody else's row, which is why this is
    // asserted alongside the confirmation rather than separately from it.
    for (const w of writes) {
      expect(w).toMatch(/family_id: ctx\.active\.familyId|eq\('family_id', ctx\.active\.familyId\)/);
      expect(w).toContain('app_id');
    }
  });
});

describe('an archive the parent is told about is confirmed (C1-S9-33)', () => {
  it('the currency archive is confirmed', () => {
    const body = bodyOf(economy, 'export async function setCurrencyActiveAction', 'return { ok: true };');
    expect(body).toContain(".select('id')");
    expect(body).toContain('if (wroteNoRows(updated))');
    expect(body).toContain("eq('family_id', ctx.active.familyId)");
  });

  it('the reward archive is confirmed, which gates redemption', () => {
    // `requestRedemptionAction` reads `reward.is_active`, so an archive that
    // silently did not happen leaves the reward redeemable and still charging
    // tokens — the parent's decision is reported as applied and is not.
    const body = bodyOf(economy, 'export async function setRewardActiveAction', 'return { ok: true };');
    expect(body).toContain(".select('id')");
    expect(body).toContain('if (wroteNoRows(updated))');
    expect(body).toContain("eq('family_id', ctx.active.familyId)");
    // Scoped to the redemption body, not the whole file: the first version of
    // this assertion was a file-wide regex, and it stayed green when the gate
    // was deleted because the COMMENT four lines above still said
    // `reward.is_active`. A guard that a comment can satisfy is pinning a
    // spelling, which is the C1-S9-28 lesson in its cheapest form.
    const redemption = bodyOf(economy, 'export async function requestRedemptionAction', 'return { ok: true };');
    expect(redemption).toContain('if (!reward || !reward.is_active) return { ok: false');
  });

  it('the row is asked for before it is judged, in both', () => {
    // `bodyOf` ends each slice AT `return { ok: true };`, so finding the check
    // inside the slice is already the ordering assertion. What is left to pin is
    // that the check reads a binding the write actually produced, rather than
    // one left over from an earlier statement.
    for (const name of ['setCurrencyActiveAction', 'setRewardActiveAction']) {
      const body = bodyOf(economy, `export async function ${name}`, 'return { ok: true };');
      expect(at(body, "const { data: updated, error }"), name).toBeLessThan(at(body, 'wroteNoRows(updated)'));
    }
  });
});

/**
 * Audit C1-S9-35 — the last item on the C1-S9-16/23 shortlist, and the one
 * place where an unconfirmed write is worse than a lie: a COMPENSATING write.
 *
 * `createChildLoginAction` creates an auth user, links the member to it, then
 * inserts the map row and the preference. Each failure path undid the earlier
 * steps with bare `await`s whose results were discarded. The caller is already
 * returning an error on those paths, so a failed rollback is invisible — and
 * the state it leaves is a DEAD END rather than a retry, because the action
 * refuses any member that already has a `user_id`.
 */
const createLogin = bodyOf(childLogin, 'export async function createChildLoginAction', "return { ok: true, data: { username } };");

describe('a rollback that fails is not reported as a clean failure (C1-S9-35)', () => {
  it('no failure path undoes anything with a discarded result', () => {
    // The precise shape that was wrong: `await admin.from(...)` as a statement,
    // with nothing destructured off it.
    expect(createLogin).not.toMatch(/\n\s+await admin\.from\(/);
    expect(createLogin).not.toMatch(/\n\s+await admin\.auth\.admin\.deleteUser\(/);
  });

  it('both multi-step rollbacks go through the helper that checks every step', () => {
    const calls = createLogin.match(/rollbackChildLogin\(admin, \{[^}]*\}\)/g) ?? [];
    expect(calls.length, 'the child_logins insert path and the preference path').toBe(2);
    // The preference path has a row to remove; the insert path does not, because
    // its insert is what failed. Getting this backwards would either leave the
    // row or report a phantom failure.
    expect(calls.some((c) => c.includes('removeLoginRow: true'))).toBe(true);
    expect(calls.some((c) => c.includes('removeLoginRow: false'))).toBe(true);
  });

  it('the helper confirms each compensating write rather than assuming it', () => {
    const helper = bodyOf(childLogin, 'async function rollbackChildLogin', '\n  return complete;\n}');
    // Both database writes ask what they changed; zero rows is a failure here,
    // because on these paths the row demonstrably existed a moment ago.
    expect(helper.match(/\.select\('id'\)/g) ?? []).toHaveLength(2);
    expect(helper.match(/wroteNoRows\(/g) ?? []).toHaveLength(2);
    expect(helper).toContain('const { error: deleteError } = await admin.auth.admin.deleteUser');
    // Every step can set it, and none may skip straight to the end.
    expect(helper.match(/complete = false;/g) ?? []).toHaveLength(3);
  });

  it('an incomplete rollback gets its own message, not an invitation to retry', () => {
    // The generic "could not save the login" tells the parent to try again, and
    // the retry is already known to fail on the `member.user_id` guard.
    expect(createLogin.match(/if \(!undone\) return \{ ok: false, error: t\('childLoginActions\.couldNotFinishAndCouldNotUndo'\) \};/g) ?? [])
      .toHaveLength(2);
    expect(createLogin).toContain("t('childLoginActions.couldNotSaveTheLogin')");
    expect(createLogin).toContain("t('childLoginActions.couldNotFinishSettingUp')");
  });

  it('the single-step link failure is checked too', () => {
    const link = between(childLogin, 'const { error: linkErr }', 'const { error: rowErr }');
    expect(link).toContain('const { error: deleteError } = await admin.auth.admin.deleteUser(childUserId);');
    expect(link).toContain("t('childLoginActions.couldNotFinishAndCouldNotUndo')");
  });

  it('a stuck member is logged with enough to find them', () => {
    const helper = bodyOf(childLogin, 'async function rollbackChildLogin', '\n  return complete;\n}');
    // Three console.error calls, each carrying the member id — this is the only
    // trace an operator gets of a family that cannot create a login.
    const logs = helper.match(/console\.error\('\[child-login\][\s\S]*?\}\);/g) ?? [];
    expect(logs).toHaveLength(3);
    for (const log of logs) expect(log).toContain('memberId: opts.memberId');
  });

  it('the copy exists in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['childLoginActions.couldNotFinishAndCouldNotUndo'], `${locale} is missing it`).toBeTruthy();
    }
  });
});

/**
 * Audit C1-S9-46 — the server-action write sweep, rebuilt and re-run.
 *
 * The earlier estimate of "~105 unconfirmed writes" came from a heuristic that
 * was wrong in BOTH directions, and correcting it is part of the finding:
 *
 *  - It over-reported: it reassembled a statement by reading at most twelve
 *    lines, so long inserts whose `.select('id')` sat on line thirteen were
 *    filed as unconfirmed. Two admin marketing inserts were counted that way
 *    and are in fact correct.
 *  - It under-reported the distinction that matters: it treated every verb
 *    alike. **An `insert` cannot match zero rows** — it either inserts or
 *    errors — so a checked error is sufficient for one. Only `update` and
 *    `delete` with a filter can silently affect nothing.
 *
 * Rebuilt with bracket-balanced statement parsing and per-verb classification:
 * 130 `'use server'` files, 436 database mutations, **102** filtered
 * update/delete without `.select()`. That the corrected number lands within
 * three of the original estimate is a coincidence worth stating rather than
 * leaning on — the two were counting different things.
 */
const locator = readFileSync('app/(app)/dashboard/locator/actions.ts', 'utf8');
const auto = readFileSync('app/(app)/dashboard/auto/actions.ts', 'utf8');

describe('a place, and a geofence, are confirmed before they are reported (C1-S9-46)', () => {
  it('all three locator writes ask what they changed', () => {
    for (const binding of ['saved', 'removed', 'toggled']) {
      expect(locator, `${binding} is not confirmed`).toContain(`wroteNoRows(${binding})`);
    }
    // Three, not four: the insert branch of `savePlace` deliberately does not
    // select, because an insert cannot match zero rows and asking for the row
    // back would buy nothing.
    expect(locator.match(/\.select\('id'\)/g) ?? []).toHaveLength(3);
  });

  it('the insert branch is deliberately not gated on rows', () => {
    // `savePlace` is a ternary: update when an id is given, insert otherwise.
    // An insert cannot match zero rows, so gating it on `wroteNoRows` would
    // invent a failure mode. The `input.id &&` is the whole point.
    expect(locator).toContain('if (input.id && wroteNoRows(saved))');
  });

  it('every confirmed write stays scoped to the acting family', () => {
    // The cheapest wrong way to make a `.select()` return a row is to widen the
    // filter, which would confirm a write to another family's place.
    const body = bodyOf(locator, 'export async function setGeofenceEnabled', 'return { ok: true };');
    expect(body).toContain("eq('family_id', c.active.familyId)");
    const del = bodyOf(locator, 'export async function deletePlace', 'return { ok: true };');
    expect(del).toContain("eq('family_id', c.active.familyId)");
  });

  it('the geofence failure says the alert setting did not change', () => {
    // The point of the message: a switch that flips back with no error reads as
    // a glitch, and the parent's natural response is to try again and assume it
    // worked the second time.
    expect(locator).toContain("t('actions.couldNotUpdateThatGeofence')");
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      for (const key of ['actions.couldNotSaveThatPlace', 'actions.couldNotDeleteThatPlace', 'actions.couldNotUpdateThatGeofence']) {
        expect(catalogue[key], `${locale} is missing ${key}`).toBeTruthy();
      }
    }
  });
});

describe('the shared auto helpers confirm for all fifteen call sites (C1-S9-46)', () => {
  it('saveRow confirms the update branch only', () => {
    // Highest-leverage fix in the sweep: two helpers, fifteen callers.
    const body = bodyOf(auto, 'async function saveRow', '\n}');
    // Per BRANCH, not per body: both branches carry `.select('id')`, so a
    // `toContain` over the whole helper stayed green when the update branch
    // lost its one — the mutation that exposed this was the only survivor in
    // the batch. The update line is the one that can match zero rows.
    const updateBranch = body.split('\n').find((l) => l.includes('.update(row as never)')) ?? '';
    expect(updateBranch, 'the update branch must ask what it changed').toContain(".select('id')");
    expect(updateBranch).toContain("eq('family_id', familyId)");
    const insertBranch = body.split('\n').find((l) => l.includes('.insert({ ...row')) ?? '';
    expect(insertBranch, 'the insert branch is exempt from the ROW check, not from select').toBeTruthy();
    expect(body).toContain('if (id && wroteNoRows(data))');
  });

  it('softDelete confirms unconditionally, because it is always an update', () => {
    const body = bodyOf(auto, 'async function softDelete', '\n}');
    expect(body).toContain(".select('id')");
    expect(body).toContain('if (wroteNoRows(data))');
    // No `id &&` here — a soft delete has no insert branch to exempt.
    expect(body).not.toContain('if (id && wroteNoRows');
  });

  it('the pre-existing comment that stopped one step short is still there', () => {
    // It states the error half of the rule correctly and is worth keeping; the
    // fix extends it rather than replacing it. If it goes, the reasoning for
    // why an insert needs no `.select()` goes with it.
    expect(auto).toContain('A PostgREST write returns { error } without throwing');
    expect(auto).toContain('cannot match zero rows');
  });
});
