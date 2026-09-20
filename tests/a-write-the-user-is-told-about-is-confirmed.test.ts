import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between, bodyOf } from './helpers/source-order';

/** Line comments only — so an assertion cannot match the prose explaining it. */
function stripComments(source: string): string {
  // `[^\S\n]*`, not `\s*`: `\s` matches newlines, so `^\s*` greedily ate the
  // line break between consecutive comment lines and collapsed them. Harmless
  // for `toContain`, but it silently shifted every offset `at()` returns — and
  // the same bug in the audit scanners misreported every file:line they
  // published (C1-S9-52).
  return source.replace(/^[^\S\n]*\/\/.*$/gm, '');
}

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

/**
 * Audit C1-S9-47 — eleven more from the 102, chosen by what each write
 * controls rather than by file order.
 *
 * The recurring shape across all three files: the action returns a value or a
 * message that ASSERTS the write happened — a celebration toast, an email
 * address, "it won't be suggested again" — while the write itself could not say
 * whether it touched anything.
 */
const independence = readFileSync('app/(app)/dashboard/independence/actions.ts', 'utf8');
const contactCenter = readFileSync('app/(app)/dashboard/contact-center/actions.ts', 'utf8');
const home = readFileSync('app/(app)/dashboard/home/actions.ts', 'utf8');

describe('a milestone the child is congratulated for is confirmed (C1-S9-47)', () => {
  it('both milestone transitions ask what they changed', () => {
    for (const binding of ['achieved', 'skipped']) {
      expect(independence, binding).toContain(`wroteNoRows(${binding})`);
    }
    expect(independence.match(/\.select\('id'\)/g) ?? []).toHaveLength(2);
  });

  it('each stays scoped to the acting family', () => {
    for (const fn of ['achieveMilestoneAction', 'skipMilestoneAction']) {
      const body = bodyOf(independence, `export async function ${fn}`, 'return { ok: true };');
      expect(body, fn).toContain("eq('family_id', ctx.active.familyId)");
    }
  });

  it('the module still celebrates only on ok', () => {
    // The reason this matters: the toast is the product here. If the action
    // stops gating it, the guard above becomes decorative.
    const module = readFileSync('components/modules/independence-module.tsx', 'utf8');
    expect(module).toContain('achieved “');
    expect(module).toContain('router.refresh()');
  });
});

describe('an address the family is told they have is confirmed (C1-S9-47)', () => {
  it('the email assignment confirms before returning the address', () => {
    // It returns `{ ok: true, local }` — it hands the family the address. An
    // update matching no row gave them one that was never stored, and mail sent
    // to it goes nowhere.
    expect(contactCenter).toContain('wroteNoRows(assigned)');
    expect(at(contactCenter, 'wroteNoRows(assigned)')).toBeLessThan(at(contactCenter, 'return { ok: true, local };'));
  });

  it('the concierge patch and the message status are confirmed', () => {
    for (const binding of ['patched', 'updated']) {
      expect(contactCenter, binding).toContain(`wroteNoRows(${binding})`);
    }
    // The concierge patch includes call forwarding, which is why it is not
    // treated as a cosmetic settings write.
    expect(contactCenter).toContain('patch.forward_to_phone = normalized;');
  });
});

describe('the home records repeat auto\'s split, not its omission (C1-S9-47)', () => {
  it('every save confirms the update branch and exempts the insert', () => {
    expect(home.match(/if \(id && wroteNoRows\(saved\)\)/g) ?? []).toHaveLength(2);
    // The insert branches must NOT have grown a select: an insert cannot match
    // zero rows, and asking for the row back buys nothing.
    const inserts = stripComments(home).split('\n').filter((l) => l.includes('.insert({ ...row'));
    expect(inserts.length).toBeGreaterThan(0);
    for (const line of inserts) expect(line, 'an insert does not need .select()').not.toContain('.select(');
  });

  it('every soft delete confirms unconditionally', () => {
    expect(home.match(/if \(wroteNoRows\(removed\)\)/g) ?? []).toHaveLength(3);
    // No `id &&` on a soft delete — it has no insert branch to exempt.
    expect(home).not.toContain('if (id && wroteNoRows(removed))');
  });

  it('the best-effort asset touch stays best-effort', () => {
    // `last_serviced_on` is explicitly documented as best-effort because the
    // service record itself is already saved. Asserting that it is NOT gated
    // stops a later sweep from hardening it into a thrown error that would lose
    // a record the family successfully created.
    expect(home).toContain('last_serviced_on update failed');
    const touch = bodyOf(home, "update({ last_serviced_on: serviceDate })", '\n  }');
    expect(touch).not.toContain('wroteNoRows');
    expect(touch).not.toContain('throw');
  });
});

/**
 * Audit C1-S9-48 — the concierge autopilot, where the file's own reasoning
 * already covered half the hazard.
 *
 * `applyQueuedRunAction` materializes a plan and then stamps the run executed.
 * The comment above that stamp explains, correctly, why a FAILED stamp must be
 * surfaced: materializePlan is idempotent, so the manager can safely retry
 * rather than be left with a run stuck "pending" over a plan already applied.
 * A stamp that matched ZERO ROWS lands in exactly that state — and reported
 * success. The reasoning was right; it just stopped one verb short.
 */
const concierge = readFileSync('app/(app)/dashboard/concierge/actions.ts', 'utf8');

describe('an autopilot run is not left queued over work already done (C1-S9-48)', () => {
  it('the executed stamp is confirmed, not just error-checked', () => {
    expect(concierge).toContain('wroteNoRows(stamped)');
    expect(at(concierge, 'wroteNoRows(stamped)')).toBeLessThan(at(concierge, "return { ok: true, mode: 'auto'"));
  });

  it('the dismissal is confirmed', () => {
    // A dismissal that matched nothing leaves the run queued while telling the
    // manager it is gone, and the next tick offers it to them again.
    expect(concierge).toContain('wroteNoRows(dismissed)');
  });

  it('both keep the idempotence reasoning that makes a retry safe', () => {
    // If this comment goes, the justification for reporting rather than
    // swallowing goes with it — and someone will "simplify" the check away.
    expect(concierge).toContain('materializePlan is idempotent');
  });

  it('the approval stamps stay best-effort, and are not hardened', () => {
    // Both `approval_requests` stamps are explicitly logged-not-raised: the plan
    // is applied and the run is recorded by then, so failing the action would
    // report failure for work that succeeded. Asserting the ABSENCE of a bail
    // stops a later consistency sweep from inverting that.
    for (const marker of ['approval stamp after execution failed', 'approval decline stamp failed']) {
      const block = bodyOf(concierge, marker, ');');
      expect(block, marker).not.toContain('return { ok: false');
    }
  });

  it('the run and plan lookups distinguish a refusal from an absence', () => {
    // Both answered "run not found or already decided" / "plan no longer
    // exists" — claims about state, from reads that never saw it.
    for (const binding of ['runReadErr', 'planReadErr']) {
      expect(concierge, binding).toContain(`error: ${binding}`);
      expect(concierge).toContain(`if (${binding}) return { ok: false`);
    }
    expect(concierge).toContain("t('actions.runNotFoundOrAlready')");
    expect(at(concierge, 'if (runReadErr)')).toBeLessThan(at(concierge, "t('actions.runNotFoundOrAlready')"));
  });
});

/**
 * Audit C1-S9-49 — paperwork, kitchen and library, and the line between a write
 * that must be confirmed and one that must not be.
 */
const paperwork = readFileSync('app/(app)/dashboard/paperwork/actions.ts', 'utf8');
const kitchen = readFileSync('app/(app)/dashboard/kitchen/actions.ts', 'utf8');
const library = readFileSync('app/(app)/dashboard/library/actions.ts', 'utf8');

describe('marking paperwork done is confirmed (C1-S9-49)', () => {
  it('the status move asks what it changed', () => {
    // This is the one action that takes an item out of the deadline inbox that
    // C1-S9-30 had to stop lying about. A silent no-op leaves the parent
    // believing the permission slip is handled while it keeps its deadline.
    expect(paperwork).toContain('wroteNoRows(moved)');
    const body = bodyOf(paperwork, 'export async function setPaperworkStatusAction', 'revalidatePath(PATH);');
    expect(body).toContain(".select('id')");
    expect(body).toContain("eq('family_id', ctx.active.familyId)");
  });

  it('the AI draft persist stays best-effort', () => {
    // Explicitly documented as best-effort because the draft is returned to the
    // caller regardless. Gating it would fail an action whose product — the
    // draft — the user already has.
    expect(paperwork).toContain('Persisting the draft is best-effort');
    const block = bodyOf(paperwork, 'draft_reply persist failed', ');');
    expect(block).not.toContain('throw');
    expect(block).not.toContain('wroteNoRows');
  });
});

describe('leftovers are confirmed before they are reported (C1-S9-49)', () => {
  it('both the status change and the delete are confirmed', () => {
    for (const binding of ['updated', 'removed']) {
      expect(kitchen, binding).toContain(`wroteNoRows(${binding})`);
    }
    // Three `.select('id')` in the file, not two: an insert already had one to
    // return the new row's id to the caller. Counted by BINDING instead, so the
    // number says what it means.
    expect(kitchen.match(/wroteNoRows\(/g) ?? []).toHaveLength(2);
  });

  it('both stay scoped to the acting family', () => {
    // The scoping and the confirmation on one line, so a `.select()` cannot be
    // bought by widening the filter.
    expect(kitchen.match(/eq\('family_id', ctx\.active\.familyId\)\.select\('id'\)/g) ?? []).toHaveLength(2);
  });
});

describe('a feed error annotation is recorded, not raised (C1-S9-49)', () => {
  it('both annotations bind and log their error', () => {
    // The row staying, carrying the reason, is the documented intent. What was
    // wrong is that the result was discarded entirely, so a failed annotation
    // left a subscription that says nothing about why it is not updating.
    // `error: annotateError` appears twice per site — the destructure and the
    // log payload — so the destructure is counted on its own.
    expect(library.match(/const \{ error: annotateError \}/g) ?? []).toHaveLength(2);
    expect(library.match(/could not record the feed error/g) ?? []).toHaveLength(2);
  });

  it('neither is escalated into a failure the user already knows about', () => {
    // The user has the feed error in their hand — the action returns it. Failing
    // on a failed annotation would replace a useful message with a useless one.
    expect(library).toContain('A feed that failed once');
    const blocks = library.split('could not record the feed error').slice(1);
    expect(blocks).toHaveLength(2);
    for (const b of blocks) expect(b.slice(0, 200)).not.toContain('return { ok: false, error: annotateError');
  });
});

/**
 * Audit C1-S9-51 — account lifecycle and the admin console, where an
 * unconfirmed write also corrupts the record of what was done.
 *
 * Every write in `admin/actions.ts` is followed by `adminAuditLog`, which
 * records the change as having happened. So an unconfirmed write here does not
 * only mislead the admin on screen — it writes a FALSE ENTRY into the audit
 * trail, which is the record anyone later reaches for to establish what was
 * done and by whom. That is what lifts this file above the ordinary class.
 */
const account = readFileSync('app/(app)/account/actions.ts', 'utf8');
const adminActions = readFileSync('app/(app)/admin/actions.ts', 'utf8');

describe('closing and reopening an account are confirmed (C1-S9-51)', () => {
  it('both lifecycle writes ask what they changed', () => {
    for (const binding of ['closed', 'reopened']) {
      expect(account, binding).toContain(`wroteNoRows(${binding})`);
    }
  });

  it('the reopen would otherwise contradict itself on screen', () => {
    // `resolveEntitlement` in the app layout reads `closed_at` to decide whether
    // to show AccountClosedGate, and this revalidates the whole layout — so a
    // no-op told the family they were reopened and then put the gate straight
    // back in front of them. The comment carries that reasoning; if it goes, the
    // justification for the check goes with it.
    expect(account).toContain('AccountClosedGate');
    expect(account).toContain("revalidatePath('/', 'layout')");
  });
});

describe('an admin action is not audited as done when it was not (C1-S9-51)', () => {
  it.each([
    ['the subscription plan change', 'planned'],
    ['the super-admin revoke', 'revoked'],
    ['the support ticket status', 'ticket'],
    ['the feature flag toggle', 'flagged'],
  ])('%s is confirmed', (_label, binding) => {
    expect(adminActions, binding).toContain(`wroteNoRows(${binding})`);
  });

  it('every confirmed admin write precedes its audit-log call', () => {
    // The ordering IS the finding: the audit entry must not be written for a
    // change that did not land.
    for (const binding of ['planned', 'revoked', 'ticket', 'flagged']) {
      const check = at(adminActions, `wroteNoRows(${binding})`);
      const rest = adminActions.slice(check);
      expect(rest, `${binding} has no audit call after it`).toContain('adminAuditLog');
    }
  });

  it('the super-admin revoke keeps its reasoning', () => {
    // Three records of a demotion that did not happen: the screen, the audit
    // log, and the person's continued access.
    expect(adminActions).toContain('leaves that\n    // person a super-admin');
  });

  it('all three provisioning rollbacks report an empty cleanup', () => {
    // C1-S9-35's shape: the caller is already returning an error, so a failed
    // undo is invisible unless it says so itself. A rollback that removed
    // nothing leaves an orphan family behind.
    expect(adminActions.match(/wroteNoRows\(cleaned\)/g) ?? []).toHaveLength(3);
    expect(adminActions.match(/'no rows deleted'/g) ?? []).toHaveLength(3);
  });

  it('the rollbacks stay logged, not raised', () => {
    // They run on a path that is already failing; turning them into a throw
    // would replace the real error with a bookkeeping one.
    const blocks = adminActions.split('family cleanup failed').slice(1);
    expect(blocks).toHaveLength(3);
    for (const b of blocks) expect(b.slice(0, 120)).not.toContain('throw');
  });
});

/**
 * Audit C1-S9-53 — the walletActions and Guardian, the two highest-consequence files
 * left in the C1-S9-50 baseline: one moves money, the other decides who reaches
 * a family member.
 */
// `wallet` is already bound at the top of this file to hub-actions.ts.
const walletActions = readFileSync('app/(app)/wallet/actions.ts', 'utf8');
const guardian = readFileSync('app/(app)/guardian/actions.ts', 'utf8');

describe('a stranded hold and a skipped allowance are reported (C1-S9-53)', () => {
  it('the held-debit rollback reports an empty undo', () => {
    // Its own comment states the stakes: "A held debit without its approval row
    // can never be resolved." A rollback matching zero rows leaves exactly that
    // — the child's money held indefinitely — and said nothing.
    expect(walletActions).toContain('wroteNoRows(rolledBack)');
    expect(walletActions).toContain('a hold may be stranded');
    expect(walletActions).toContain('can never be resolved');
  });

  it('the allowance schedule rollback reports an empty undo', () => {
    // If it matched nothing the schedule stays advanced, so the child never
    // receives that run — not double-paid, not paid at all.
    expect(walletActions).toContain('wroteNoRows(restored)');
    expect(walletActions).toContain('a run may be skipped');
  });

  it('both rollbacks stay logged, not raised', () => {
    // They run on paths already returning a failure, and the held-debit one has
    // a `status` predicate that makes zero rows ALSO the benign "already
    // resolved" case. Raising would report the wrong thing twice over.
    for (const marker of ['a hold may be stranded', 'a run may be skipped']) {
      const block = bodyOf(walletActions, marker, '});');
      expect(block, marker).not.toContain('return { ok: false');
    }
  });

  it('the gift, babysitter and Pay-ID writes are confirmed', () => {
    for (const binding of ['dismissed', 'saved', 'archived', 'released']) {
      expect(walletActions, binding).toContain(`wroteNoRows(${binding})`);
    }
    // Releasing a Pay-ID is a privacy action — /pay/<handle> keeps resolving to
    // the child if the delete matched nothing (see C1-S9-31).
    expect(walletActions).toContain('privacy action');
  });

  it('the Pay-ID save confirms only its update branch', () => {
    expect(walletActions).toContain('if (input.id && wroteNoRows(savedHandle))');
    const insertLine = stripComments(walletActions).split('\n').find((l) => l.includes("from('pay_handles').insert(row)")) ?? '';
    expect(insertLine, 'an insert cannot match zero rows').not.toContain('.select(');
  });

  it('the idempotent allowance claim is untouched', () => {
    // The one write in this file that was ALREADY correct, and for a sharper
    // reason than the rest: its `.lte('next_run_on', today)` predicate plus
    // `.select()` is what stops a double-click crediting an allowance twice.
    // Pinned so this sweep cannot "simplify" it while tidying its neighbours.
    // Scoped to the CLAIM statement. A file-wide `toContain` passed with the
    // predicate deleted, because the phrase also appears in the comment above it
    // and in an unrelated read forty lines earlier — the C1-S9-34 trap for the
    // fourth time this session, and the reason every guard here is mutated.
    const claim = bodyOf(stripComments(walletActions), "const { data: advancedRule, error: advanceError }", '.maybeSingle();');
    expect(claim, 'the claim predicate is what stops a double credit').toContain(".lte('next_run_on', today)");
    expect(claim).toContain(".select('id')");
    expect(walletActions).toContain('double-crediting');
  });
});

describe('Guardian trust and escalations are confirmed (C1-S9-53)', () => {
  it('all six Guardian controls ask what they changed', () => {
    for (const binding of ['deleted', 'trusted', 'contexted', 'toggled', 'removedRule', 'acked']) {
      expect(guardian, binding).toContain(`wroteNoRows(${binding})`);
    }
  });

  it('the trust check precedes the Guardian audit log', () => {
    // `trust_level` decides whether an unknown caller is put straight through or
    // screened, and `trust_override: true` marks it as the parent's explicit
    // decision. Logging it as changed when it was not is the C1-S9-51 shape.
    // Sliced forward from the check, not compared against `at()`: this file has
    // four `logGuardianAudit` calls and `at()` finds the FIRST, which sits in a
    // different function entirely — the assertion passed or failed on where an
    // unrelated audit call happened to be.
    const afterCheck = guardian.slice(at(guardian, 'wroteNoRows(trusted)'));
    expect(afterCheck, 'the trust check has no audit call after it').toContain('logGuardianAudit({');
  });

  it('every Guardian write stays scoped to the acting family', () => {
    // Seven, not six: `saveGuardianContact`'s update branch was ALREADY
    // confirmed before this pass, with `.select('id').single()`. Counting six
    // would have meant asserting that a correct write did not exist.
    const scoped = guardian.match(/\.eq\('family_id', (?:ctx\.active\.familyId|familyId)\)\s*\n\s*\.select\(/g) ?? [];
    expect(scoped.length, 'a confirmation bought by widening the filter').toBe(7);
  });
});
