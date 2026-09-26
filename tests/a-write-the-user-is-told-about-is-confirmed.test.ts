import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, between, bodyOf } from './helpers/source-order';

/** Line comments only — so an assertion cannot match the prose explaining it. */
function stripComments(source: string): string {
  // `[^\S\n]*`, not `\s*`: `\s` matches newlines, so `^\s*` starting at a
  // blank or whitespace-only line directly above a comment ate that line's
  // break on the way to the `//`. Harmless for `toContain`, but it silently
  // shifted every offset `at()` returns — and the same bug in the audit
  // scanners misreported every file:line they published (C1-S9-52; mechanism
  // stated precisely under C1-S9-61, where a fixture built on the looser
  // description could not fail).
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
    // Anchored on the FILTER, not the destructure. C1-S9-57 bound the link's
    // rows as well as its error, and this guard — one I wrote myself under
    // C1-S9-35 — went red on that improvement. Ninth of the session, and the
    // first of mine: `toContain("<exact statement>")` is a trap regardless of
    // who writes it.
    const link = between(childLogin, "update({ user_id: childUserId, is_active: true })", 'const { error: rowErr }');
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
    const moduleSource = readFileSync('components/modules/independence-module.tsx', 'utf8');
    expect(moduleSource).toContain('achieved “');
    expect(moduleSource).toContain('router.refresh()');
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
    const touch = stripComments(bodyOf(home, "update({ last_serviced_on: serviceDate })", '\n  }'));
    // Originally `not.toContain('wroteNoRows')` as well — a PROXY for "not
    // gated", and it went red when C1-S9-60 confirmed this write for its LOG.
    // The intent was always that nothing here leaves the action, so that is
    // what is asserted: no return and no throw, whatever the condition says.
    expect(touch).not.toMatch(/\breturn\b/);
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

/**
 * Audit C1-S9-55 — chore approvals and the generic family record helpers.
 *
 * Every write fixed here is either a COMPENSATING write on an already-failing
 * path, or a generic helper whose one missing confirmation is the defect
 * repeated across every surface that calls it.
 */
const missionsActions = readFileSync('app/(app)/missions/actions.ts', 'utf8');
const familyActions = readFileSync('lib/family/actions.ts', 'utf8');

describe('a chore rollback reports an empty undo (C1-S9-55)', () => {
  it.each([
    ['the approval rollback', 'rolledBackAssignment', 'an approval may be stranded'],
    ['the dispute reopen', 'reopened', 'a dispute may stay closed'],
    ['the dispute cleanup', 'cleanedDispute', 'an orphan dispute may remain'],
    ['the chore cleanup', 'cleanedChore', 'an unassigned chore may remain'],
  ])('%s says what was left behind', (_label, binding, message) => {
    expect(missionsActions, binding).toContain(`wroteNoRows(${binding})`);
    expect(missionsActions, message).toContain(message);
  });

  it('all four stay logged, not raised', () => {
    // Each runs on a path already returning or rethrowing a failure. Raising
    // here would replace the error the caller needs with a bookkeeping one —
    // and the approval rollback rethrows the ORIGINAL error two lines later.
    for (const message of [
      'an approval may be stranded', 'a dispute may stay closed',
      'an orphan dispute may remain', 'an unassigned chore may remain',
    ]) {
      const block = bodyOf(missionsActions, message, '});');
      expect(block, message).not.toContain('return { ok: false');
    }
    expect(missionsActions).toContain("throw error instanceof Error ? error : new Error('Could not apply chore rewards');");
  });

  it('the approval rollback restores every awarded field', () => {
    // The point of the rollback: leaving points or cash marked awarded while
    // the code that awards them failed records a child as paid without paying.
    const body = bodyOf(missionsActions, "from('chore_assignments').update({\n      status: args.assignment.status", ".select('id')");
    for (const field of ['approved_at', 'approved_by', 'points_awarded', 'cash_awarded_cents']) {
      expect(body, field).toContain(field);
    }
  });
});

describe('the generic family record helpers confirm (C1-S9-55)', () => {
  it.each([
    ['updateFamilyRecord', 'updated'],
    ['deleteFamilyRecord', 'deleted'],
    ['setRecommendationStatus', 'recommended'],
    ['resolveAutomationRun', 'resolved'],
  ])('%s asks what it changed', (_fn, binding) => {
    expect(familyActions, binding).toContain(`wroteNoRows(${binding}`);
  });

  it('the two generic helpers are confirmed before they assert the id', () => {
    // Both return `{ ok: true, id }` — an assertion that the record with THAT
    // id changed, which a write matching zero rows cannot support. They back
    // every whitelisted table, so one missing check is the defect repeated
    // across every surface that calls them.
    for (const binding of ['updated', 'deleted']) {
      const check = at(familyActions, `wroteNoRows(${binding}`);
      expect(familyActions.slice(check, check + 400), binding).toContain('return { ok: true, id };');
    }
  });

  it('every one stays scoped to the acting family', () => {
    expect(familyActions.match(/eq\('family_id', ctx\.active\.familyId\)[\s\S]{0,30}?\.select\('id'\)/g) ?? [])
      .toHaveLength(4);
  });
});

/**
 * Audit C1-S9-56 — marketplace orders, the social reader, and trip departures.
 *
 * One of these is not a confirmation finding at all: the marketplace order
 * transition was a read-then-write race, and the fix is the same predicated
 * claim the wallet allowance already uses. The others are the ordinary class,
 * plus one write that must deliberately stay ungated.
 */
const marketplaceActions = readFileSync('app/(app)/marketplace/actions.ts', 'utf8');
const socialFeed = readFileSync('app/(app)/dashboard/social-feed/actions.ts', 'utf8');
const tripIntel = readFileSync('app/(app)/dashboard/trip-intel/actions.ts', 'utf8');

describe('an order transition is claimed, not assumed (C1-S9-56)', () => {
  it('the update is predicated on the status it was validated against', () => {
    // `ORDER_FLOW` was checked against `order.status` read a moment earlier, and
    // nothing stopped that changing in between: two concurrent calls could both
    // read `requested` and both advance, or take divergent branches. Predicating
    // the write makes check and write one atomic step.
    const body = bodyOf(marketplaceActions, 'export async function setOrderStatusAction', 'return { ok: true };');
    expect(body).toContain(".eq('status', order.status)");
    expect(body).toContain('wroteNoRows(advanced)');
  });

  it('the order write carries its own family scope', () => {
    // Ownership is already proven by the read above and by RLS. Carrying the
    // scope on the write too means a later edit cannot detach it from its guard.
    const body = bodyOf(marketplaceActions, 'export async function setOrderStatusAction', 'return { ok: true };');
    expect(body.match(/eq\('family_id', ctx\.active\.familyId\)/g) ?? []).toHaveLength(2);
  });

  it('the match, save and follow writes are confirmed', () => {
    for (const binding of ['matched', 'unsaved', 'unfollowed']) {
      expect(marketplaceActions, binding).toContain(`wroteNoRows(${binding})`);
    }
  });
});

describe('the social reader confirms what it can, and not what it cannot (C1-S9-56)', () => {
  it('the three single-row writes are confirmed', () => {
    for (const binding of ['removed', 'favorited', 'marked']) {
      expect(socialFeed, binding).toContain(`wroteNoRows(${binding})`);
    }
  });

  it('mark-all-read is deliberately NOT gated on rows', () => {
    // Its `.eq('is_read', false)` predicate makes zero rows the ordinary
    // "everything is already read" case. Gating it would report an error for a
    // button that simply had nothing to do — the over-tightening direction, and
    // the reason this assertion exists.
    const body = bodyOf(socialFeed, 'export async function markAllReadAction', 'return { ok: true };');
    expect(body).toContain(".eq('is_read', false)");
    expect(body).not.toContain('wroteNoRows');
    expect(body).not.toContain(".select('id')");
  });
});

describe('a departure time the family is given is confirmed (C1-S9-56)', () => {
  it('the refresh confirms before returning leaveBy', () => {
    // It returns `leaveBy` — the time the family is told to leave. An update
    // matching nothing means that time was never stored, so the reminder still
    // fires against the old drive estimate while the screen shows the new one.
    expect(tripIntel).toContain('wroteNoRows(refreshed)');
    expect(at(tripIntel, 'wroteNoRows(refreshed)'))
      .toBeLessThan(at(tripIntel, 'return { ok: true, data: { leaveBy: plan.leaveByISO } };'));
  });

  it('the reminder cleanup is confirmed before the plan it belongs to is deleted', () => {
    // The departure plan is deleted either way, so a reminder left behind
    // becomes an orphan calendar event the family cannot reach from the trip
    // that created it.
    expect(tripIntel).toContain('wroteNoRows(removedEvent)');
    expect(at(tripIntel, 'wroteNoRows(removedEvent)')).toBeLessThan(at(tripIntel, 'wroteNoRows(removedDeparture)'));
  });

  it('both plan deletes are confirmed', () => {
    for (const binding of ['removedPlan', 'removedDeparture']) {
      expect(tripIntel, binding).toContain(`wroteNoRows(${binding})`);
    }
  });
});

/**
 * Audit C1-S9-57 — three writes in one file that look identical to a scanner,
 * and only one of which may be confirmed.
 *
 * `child-login-actions.ts` contains two `child_login_throttle` clears and one
 * `family_members` link. All three are filtered updates with a checked error
 * and no `.select()`, so the C1-S9-50 scan counts all three. Confirming all
 * three would break the feature.
 */
describe('a throttle clear and a member link are not the same write (C1-S9-57)', () => {
  const childLoginSource = readFileSync('app/(app)/family/child-login-actions.ts', 'utf8');

  it('the member link IS confirmed, and takes the rollback on zero rows', () => {
    // `member` was read moments earlier, so the row exists — a link matching
    // nothing leaves the child holding an auth user that resolves to no member:
    // they sign in successfully and have no identity, no family, nothing.
    expect(childLoginSource).toContain('if (linkErr || wroteNoRows(linked))');
    // The same rollback as a link error, not a fall-through to the insert.
    const bail = bodyOf(childLoginSource, 'if (linkErr || wroteNoRows(linked))', "t('childLoginActions.couldNotLinkTheLogin') };");
    expect(bail).toContain('deleteUser(childUserId)');
  });

  it('neither throttle clear is confirmed', () => {
    // A brand-new username has no throttle row, and a child who has never
    // failed a sign-in has none either — so zero rows is the ORDINARY case.
    // Gating them would refuse to create a login for every child whose username
    // nobody has used before. Their errors are checked, which is the part that
    // matters.
    const clears = childLoginSource.match(/from\('child_login_throttle'\)[\s\S]{0,220}?;/g) ?? [];
    expect(clears, 'the create path and the reset path').toHaveLength(2);
    for (const clear of clears) {
      expect(clear, 'a throttle clear must not be gated on rows').not.toContain('.select(');
    }
    expect(childLoginSource).toContain('if (staleThrottleErr) return { ok: false');
    expect(childLoginSource).toContain('if (throttleErr) return { ok: false');
  });

  it('the reason each way is written down beside it', () => {
    // Three writes that a scanner cannot tell apart need the distinction in the
    // file, or the next sweep makes them consistent and breaks two of them.
    expect(childLoginSource).toContain('Deliberately NOT confirmed');
    expect(childLoginSource).toContain('Zero rows is a real failure here');
  });
});

/**
 * Audit C1-S9-58 — eight more, and two that a "reset" makes obviously exempt.
 */
const customize = readFileSync('app/(app)/dashboard/customize-actions.ts', 'utf8');
const mealVote = readFileSync('app/(app)/dashboard/recipes/vote/actions.ts', 'utf8');
const relationship = readFileSync('app/(app)/dashboard/relationship/actions.ts', 'utf8');
const alerts = readFileSync('app/(app)/marketplace/alerts/actions.ts', 'utf8');
const libraryActions = readFileSync('app/(app)/dashboard/library/actions.ts', 'utf8');

describe('a reset that finds nothing has done what it promised (C1-S9-58)', () => {
  it('neither dashboard-layout reset is gated on rows', () => {
    // "Reset my layout" on a dashboard nobody customised matches nothing, and
    // that IS the success case: the layout is now the default, which is what was
    // asked for. Confirming these would fail the button for every user who had
    // not customised anything — the largest group.
    // DELETEs only — the file also upserts layouts when saving one, and an
    // upsert cannot match zero rows anyway.
    const deletes = (customize.match(/from\('dashboard_layouts'\)[\s\S]{0,220}?;/g) ?? [])
      .filter((w) => w.includes('.delete()'));
    expect(deletes, 'the per-user reset and the family-wide reset').toHaveLength(2);
    for (const d of deletes) expect(d).not.toContain('.select(');
    expect(customize).toContain('Deliberately NOT gated on rows');
  });
});

describe('a vote result is not computed and thrown away (C1-S9-58)', () => {
  it('closing a vote is confirmed', () => {
    // `winner` is computed here and stored nowhere else — a close matching no
    // rows leaves the vote open and discards the tally.
    expect(mealVote).toContain('wroteNoRows(closed)');
    expect(mealVote).toContain('stored nowhere else');
  });

  it('reopening is confirmed', () => {
    expect(mealVote).toContain('wroteNoRows(reopenedVote)');
  });
});

describe('a calendar link is not left dangling or duplicated (C1-S9-58)', () => {
  it('the unlink is confirmed, because the event is already gone', () => {
    // A no-op leaves `calendar_event_id` pointing at a deleted event, and the
    // next sync treats the date as already on the calendar — so it never goes
    // back on.
    expect(relationship).toContain('wroteNoRows(unlinked)');
    expect(relationship).toContain('it never goes back');
  });

  it('the link is confirmed, because the failure mode is duplication', () => {
    // The event exists by then. A link matching no rows leaves the date not
    // knowing about it, so the next run creates a SECOND event for the same
    // anniversary.
    expect(relationship).toContain('wroteNoRows(linked)');
    expect(relationship).toContain('a SECOND event');
  });
});

describe('saved searches and subscriptions are confirmed (C1-S9-58)', () => {
  it('both saved-search writes ask what they changed', () => {
    for (const binding of ['deletedSearch', 'seen']) {
      expect(alerts, binding).toContain(`wroteNoRows(${binding})`);
    }
  });

  it('unsubscribing is confirmed before it reports removal', () => {
    // "Subscription removed." is returned on success, so a delete that removed
    // nothing told the family a feed is gone while it keeps ingesting.
    expect(libraryActions).toContain('wroteNoRows(unsubscribed)');
    expect(at(libraryActions, 'wroteNoRows(unsubscribed)'))
      .toBeLessThan(at(libraryActions, "return { ok: true, message: 'Subscription removed.' };"));
  });

  it('the feed-error annotations stay ungated', () => {
    // C1-S9-49's deliberate case, re-asserted here because this pass touched
    // the same file and a tidy-up is exactly how it would get "fixed".
    const annotations = libraryActions.match(/update\(\{ last_error: result\.error \}\)[^;]*;/g) ?? [];
    expect(annotations).toHaveLength(2);
    for (const a of annotations) expect(a).not.toContain('.select(');
  });
});

/**
 * Audit C1-S9-59 — twelve more writes, and the pass where the triage rule earned
 * its keep three separate ways.
 *
 * Nine are confirmed. One (`markAffiliatePaidAction`) is confirmed for its COUNT
 * and deliberately not for a bail, because zero converted referrals is what a
 * quiet month looks like. One (`archiveContentAction`'s public unpublish) is left
 * ungated on rows for a reason the file states beside it. And one — the workload
 * rebalance — turned out to be confirmed already, by `count: 'exact'` rather than
 * by `.select()`: the scanner reads only the second route, so the annotation is
 * the fix and the code needed none.
 */
/**
 * The body of ONE exported action: from its signature to the first closing brace
 * at column 0 after it.
 *
 * `between()` searches for its end token from the START of the file, which is
 * right for a unique marker and wrong for `return { ok: true };` — a line most
 * of these files carry a dozen times, usually above the function in question. It
 * refused every such slice rather than handing back a reversed one, which is
 * what it is for; this is the slice those cases actually wanted.
 */
function actionBody(source: string, signature: string): string {
  const start = at(source, signature);
  const end = source.indexOf('\n}', start);
  expect(end, `no closing brace after ${signature}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

const affiliates = readFileSync('app/(app)/admin/marketing/affiliates/actions.ts', 'utf8');
const marketingContent = readFileSync('app/(app)/admin/marketing/content/actions.ts', 'utf8');
const recurringAds = readFileSync('app/(app)/admin/marketing/social/recurring/actions.ts', 'utf8');
const calendarFeeds = readFileSync('app/(app)/dashboard/sync/feeds/actions.ts', 'utf8');
const trustActions = readFileSync('app/(app)/dashboard/trust/actions.ts', 'utf8');
const workload = readFileSync('app/(app)/dashboard/workload/actions.ts', 'utf8');
const feedbackActions = readFileSync('app/(app)/feedback/actions.ts', 'utf8');
const community = readFileSync('app/(app)/marketplace/community/actions.ts', 'utf8');
const handoff = readFileSync('app/(app)/marketplace/handoff/actions.ts', 'utf8');
const onboarding = readFileSync('app/onboarding/actions.ts', 'utf8');

describe('a payout entry says how much it moved (C1-S9-59)', () => {
  it('asks what it settled without turning an empty month into an error', () => {
    const body = actionBody(affiliates, 'export async function markAffiliatePaidAction');
    expect(body, 'the settle update').toContain(".select('id')");
    // Deliberately no bail: an affiliate with nothing converted is the ordinary
    // case, and failing it would make "Mark paid" unusable on a quiet month.
    expect(stripComments(body)).not.toContain('wroteNoRows');
    expect(body).toContain('referralsPaid: paid?.length ?? 0');
  });

  it('records the reason for the asymmetry beside the code', () => {
    expect(affiliates).toContain('Confirmed for the COUNT, not for the bail');
  });
});

describe('regenerated AEO answers are not doubled up (C1-S9-59)', () => {
  it('the insert runs only if the clear succeeded', () => {
    const block = between(marketingContent, 'const aeo = deriveArticleAeoQuestions(', '} catch (aeoError) {');
    expect(block).toContain('const { error: clearError }');
    // Ordering is the whole fix: throwing before the insert is what keeps a
    // failed clear from leaving two generated sets for one `/blog/<slug>`.
    expect(at(block, 'if (clearError) throw clearError;'))
      .toBeLessThan(at(block, "from('marketing_aeo_questions').insert("));
  });

  it('still never blocks the publish, but no longer swallows the reason', () => {
    // Best-effort by design — the catch stays. What changed is that it says
    // what it swallowed, which an empty `catch {}` could not.
    expect(marketingContent).toContain("console.error('[marketing-content] AEO regeneration skipped'");
  });

  it('leaves the archive-time unpublish ungated on rows, with the contrast stated', () => {
    const body = actionBody(marketingContent, 'export async function archiveContentAction');
    const unpublish = body.slice(at(body, "from('blog_posts').update({ published: false })"));
    expect(unpublish.slice(0, 120), 'a draft that never shipped has no public row').not.toContain('.select(');
    expect(body).toContain('archived a CONTENT ITEM');
  });

  it('keeps the named-post unpublish confirmed, which is the other side of it', () => {
    const body = actionBody(marketingContent, 'export async function unpublishBlogPostAction');
    expect(body).toContain(".select('slug')");
    expect(body).toContain('Blog post not found.');
  });
});

describe('a campaign reported paused or removed really is (C1-S9-59)', () => {
  it('the status change confirms, and repeats the read filter on the write', () => {
    const body = actionBody(recurringAds, 'export async function setRecurringAdStatusAction');
    expect(body).toContain('wroteNoRows(changed)');
    // Without the predicate, a campaign soft-deleted between the read and the
    // write would be resumed by a race the read cannot see.
    expect(body).toContain(".eq('id', id).is('deleted_at', null).select('id')");
  });

  it('the soft delete confirms, and stays idempotent on purpose', () => {
    const body = actionBody(recurringAds, 'export async function deleteRecurringAdAction');
    expect(body).toContain('wroteNoRows(removed)');
    // Filtered on id ALONE: adding `.is('deleted_at', null)` here would make a
    // second removal report failure for a campaign that is already gone.
    expect(body).toContain(".eq('id', id).select('id')");
    expect(stripComments(body)).not.toContain("deleted_at', null).select");
  });
});

describe('a removed calendar feed stops appearing in the family calendar (C1-S9-59)', () => {
  it('confirms the delete before answering ok', () => {
    const body = actionBody(calendarFeeds, 'export async function removeCalendarFeed');
    expect(body).toContain('wroteNoRows(removed)');
    expect(at(body, 'wroteNoRows(removed)')).toBeLessThan(at(body, "revalidatePath('/dashboard/settings')"));
  });

  it('stays family-scoped while it does so', () => {
    const body = actionBody(calendarFeeds, 'export async function removeCalendarFeed');
    expect(body).toContain("eq('family_id', ctx.active.familyId)");
  });
});

describe('an accepted autopilot suggestion is not offered again (C1-S9-59)', () => {
  it('confirms the resolve, so the policies cannot be written twice', () => {
    const body = trustActions.slice(at(trustActions, "from('autopilot_suggestions')\n    .update({ status: 'executed'"));
    expect(body.slice(0, 700)).toContain('wroteNoRows(resolved)');
  });

  it('reuses the message that already described the halves coming apart', () => {
    const body = trustActions.slice(at(trustActions, 'wroteNoRows(resolved)'));
    expect(body.slice(0, 300)).toContain("t('actions.thePolicyWasSavedButTheSuggestion')");
  });
});

describe('the rebalance was already confirmed, by the other route (C1-S9-59)', () => {
  it('uses count: exact and bails on zero', () => {
    const body = actionBody(workload, 'export async function moveAssignmentAction');
    expect(body).toContain("{ count: 'exact' }");
    expect(body).toContain('if (!count) return { ok: false');
    // No `.select()` on the UPDATE and none needed: `Prefer: count=exact` is
    // answered whether or not a representation was requested. Scoped to the
    // update statement, because the member existence read above it legitimately
    // selects — an assertion over the whole body would have been about that read.
    const update = body.slice(at(body, "from('chore_assignments')"));
    expect(stripComments(update)).not.toContain('.select(');
  });

  it('says so in the file, because a grep for .select() reads it as unconfirmed', () => {
    expect(workload).toContain('Confirmed by COUNT rather than by `.select()`');
  });
});

describe('a public roadmap does not claim work that never moved (C1-S9-59)', () => {
  it('confirms the status change', () => {
    const body = actionBody(feedbackActions, 'export async function setIdeaStatusAction');
    expect(body).toContain('wroteNoRows(moved)');
  });

  it('keeps the super-admin gate in front of it', () => {
    const body = actionBody(feedbackActions, 'export async function setIdeaStatusAction');
    expect(at(body, 'await isSuperAdmin()')).toBeLessThan(at(body, "from('feedback_ideas')"));
  });
});

describe('sharing and unsharing are not mirrors of each other (C1-S9-59)', () => {
  it('the unshare is confirmed', () => {
    const body = actionBody(community, 'export async function unshareListingAction');
    expect(body).toContain('wroteNoRows(unshared)');
  });

  it('the share stays idempotent on the unique constraint', () => {
    // Deliberately unconfirmed in the other direction: a double share is
    // harmless, and `23505` is the success path rather than an error.
    const body = actionBody(community, 'export async function shareListingAction');
    expect(body).toContain("error.code !== '23505'");
    expect(stripComments(body)).not.toContain('wroteNoRows');
  });
});

describe('a cancelled pickup is not a completed one (C1-S9-59)', () => {
  it('confirms the cancel', () => {
    const body = actionBody(handoff, 'export async function cancelHandoffAction');
    expect(body).toContain('wroteNoRows(cancelled)');
    expect(body).toContain(".in('status', ['proposed', 'confirmed']).select('id')");
  });

  it('leaves the C1-S9-23 confirm guard in place beside it', () => {
    expect(handoff).toContain('wroteNoRows(confirmed)');
  });
});

describe('onboarding does not finish on a default timezone (C1-S9-59)', () => {
  it('confirms the adoption of an auto-provisioned family', () => {
    const body = onboarding.slice(at(onboarding, "const { data: adopted, error: adoptErr }"));
    expect(body.slice(0, 600)).toContain('wroteNoRows(adopted)');
  });

  it('fails through the same reporter as the error branch', () => {
    const body = onboarding.slice(at(onboarding, 'wroteNoRows(adopted)'));
    expect(body.slice(0, 300)).toContain("onboardingFailure('auto-provisioned family update'");
  });
});

/**
 * Audit C1-S9-60 — the last of the open write sites.
 *
 * Ten confirmed with a bail. Four confirmed for the LOG only, because the thing
 * the user came for has already succeeded by the time they run (a service record
 * saved, a draft returned, a rollback on a path already failing). One left
 * ungated on rows because zero rows IS the requested outcome. After this pass,
 * every write still counted by the ratchet is a member of the deliberate set.
 */
/** From `needle` to the brace that closes the block it opens. */
function ifBlock(source: string, needle: string): string {
  const open = source.indexOf('{', at(source, needle));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at(source, needle), i + 1);
  }
  throw new Error(`unbalanced block after ${needle}`);
}

const serviceAdmin = readFileSync('app/(app)/admin/services/actions.ts', 'utf8');
const assistants = readFileSync('app/(app)/dashboard/assistants/actions.ts', 'utf8');
const autoActions = readFileSync('app/(app)/dashboard/auto/actions.ts', 'utf8');
const contactDetail = readFileSync('app/(app)/dashboard/contacts/[id]/actions.ts', 'utf8');
const dining = readFileSync('app/(app)/dashboard/dining/actions.ts', 'utf8');
const twin = readFileSync('app/(app)/dashboard/family-digital-twin/actions.ts', 'utf8');
const signals = readFileSync('app/(app)/dashboard/family-signals/actions.ts', 'utf8');
const homeActions = readFileSync('app/(app)/dashboard/home/actions.ts', 'utf8');
const insights = readFileSync('app/(app)/dashboard/insight-actions.ts', 'utf8');
const lifeEvents = readFileSync('app/(app)/dashboard/life-event-actions.ts', 'utf8');
const moments = readFileSync('app/(app)/dashboard/moment-actions.ts', 'utf8');
const paperworkActions = readFileSync('app/(app)/dashboard/paperwork/actions.ts', 'utf8');
const playbook = readFileSync('app/(app)/dashboard/playbook/playbook-actions.ts', 'utf8');
const missionsFile = readFileSync('app/(app)/missions/actions.ts', 'utf8');

describe('a revoked assistant key really stops working (C1-S9-60)', () => {
  it('confirms the revoke before promising it', () => {
    const body = actionBody(assistants, 'export async function revokeAssistantLinkAction');
    expect(body).toContain('wroteNoRows(revoked)');
    expect(at(body, 'wroteNoRows(revoked)'))
      .toBeLessThan(at(body, "It stops working immediately."));
  });

  it('keeps the revoke family-scoped and parent-only', () => {
    const body = actionBody(assistants, 'export async function revokeAssistantLinkAction');
    expect(body).toContain(".eq('family_id', ctx.active.familyId)");
    expect(at(body, 'canManage(ctx.active.role)')).toBeLessThan(at(body, "from('assistant_links')"));
  });
});

describe('reset-to-default stays ungated on rows (C1-S9-60)', () => {
  it('does not fail a service nobody ever overrode', () => {
    const body = actionBody(serviceAdmin, 'export async function saveServiceDescriptionAction');
    const reset = body.slice(at(body, "from('service_descriptions').delete()"));
    expect(reset.slice(0, 160)).not.toContain('.select(');
    expect(stripComments(body)).not.toContain('wroteNoRows');
    expect(body).toContain('that IS the outcome asked for');
  });
});

describe('best-effort side writes are confirmed for the log, not for a bail (C1-S9-60)', () => {
  // Four writes whose caller has already got what it came for. Each now asks
  // what it changed, so the log that exists to make a broken update observable
  // is reached by the commonest way it breaks — and none of them returns.
  const cases: Array<[string, string, string, string]> = [
    ['vehicle odometer', autoActions, 'odoUpdated', "'[auto] vehicle odometer update failed'"],
    ['home asset last-serviced', homeActions, 'assetTouched', "'[home] home_assets last_serviced_on update failed'"],
    ['paperwork draft persist', paperworkActions, 'persisted', "'[paperwork] draft_reply persist failed'"],
    ['dispute rollback', missionsFile, 'cleaned', "'[chore state] dispute cleanup failed — an orphan dispute may remain'"],
    // C1-S9-48 made these two logged-not-raised; C1-S9-60 makes the log
    // reachable by zero rows. `ifBlock` also closes a gap in the older guard,
    // whose slice ends at the log call's `);` and so cannot see a bail after it.
    ['approval stamp after execution', concierge, 'approvedStamp', "'[concierge] approval stamp after execution failed'"],
    ['approval decline stamp', concierge, 'declinedStamp', "'[concierge] approval decline stamp failed'"],
  ];
  for (const [name, src, binding, log] of cases) {
    it(`${name}: asks, and logs zero rows`, () => {
      const check = src.slice(at(src, `wroteNoRows(${binding})`));
      expect(check.slice(0, 260), name).toContain(log);
    });
    it(`${name}: does not bail`, () => {
      // The whole `if` block, found by MATCHING BRACES from the one that opens
      // it. An earlier version ended the slice at the first `\n    }`, which is
      // an indent guess: in the paperwork action the block sits one level
      // shallower, so that token matched the `});` closing the log call and the
      // slice stopped before anything a mutation could add after it. A `return`
      // appended there survived — the only survivor in this batch.
      const block = stripComments(ifBlock(src, `wroteNoRows(${binding})`));
      expect(block, name).toContain(log);
      expect(block, name).not.toMatch(/\breturn\b|\bthrow\b/);
    });
  }
});

describe('toggles and dismissals ask what they changed (C1-S9-60)', () => {
  const cases: Array<[string, string, string, string]> = [
    ['restaurant favourite', dining, 'export async function toggleFavoriteAction', 'toggled'],
    ['simulation delete', twin, 'export async function deleteSimulationAction', 'deleted'],
    ['signal status', signals, 'export async function setSignalStatusAction', 'set'],
    ['insight status', insights, 'async function setInsightStatus', 'set'],
    ['life-event plan status', lifeEvents, 'export async function setLifeEventStatusAction', 'set'],
    ['playbook dismissal', playbook, 'export async function dismissSuggestionAction', 'dismissed'],
    ['moment grocery undo', moments, 'export async function removeMomentGroceryAction', 'removed'],
  ];
  for (const [name, src, signature, binding] of cases) {
    it(`${name}: bails on zero rows before answering ok`, () => {
      const body = actionBody(src, signature);
      expect(body, name).toContain(`if (wroteNoRows(${binding})) return { ok: false`);
      // The first success return AFTER THE WRITE. Not the first in the body —
      // several of these open with `return { ok: true }` for an empty input,
      // which the bail cannot precede. And not the LAST either, which was the
      // intermediate fix: an unconditional success return inserted just above
      // the bail left it dead code while the final return still came after it,
      // and that mutation survived. Anchored on the write's own binding.
      // Anchored on the whole BAIL STATEMENT, not the helper's name: a
      // condition such as `!wroteNoRows(x) || wroteNoRows(x)` mentions the
      // helper too, and a name-only anchor found that instead of the bail.
      const afterWrite = body.slice(at(body, `{ data: ${binding},`));
      expect(at(afterWrite, `if (wroteNoRows(${binding})) return { ok: false`), name)
        .toBeLessThan(at(afterWrite, 'return { ok: true'));
    });
  }

  it('deleting a contact interaction throws on zero rows, the same way it throws on error', () => {
    const body = actionBody(contactDetail, 'export async function deleteInteractionAction');
    expect(body).toContain("if (wroteNoRows(deleted)) throw new Error(t('actions.couldNotDeleteThatInteraction'));");
    expect(at(body, 'wroteNoRows(deleted)')).toBeLessThan(at(body, 'revalidatePath('));
  });

  it('the grocery undo fails only on NONE removed, never on a partial', () => {
    // `wroteNoRows` is length-zero. A family who deleted some of the items by
    // hand still gets their undo; an exact-count check here would refuse it.
    // Scoped to AFTER the delete, because `ids.length === 0` legitimately
    // appears above it as the empty-input early return. Below it, any use of
    // `ids.length` or of `removed`'s length is a count being compared — which
    // is the over-tightening this asserts against. (The first version matched
    // three spellings and missed a fourth, `(removed?.length ?? 0) !== ids.length`;
    // naming the operands rather than the operator closes that.)
    const body = actionBody(moments, 'export async function removeMomentGroceryAction');
    const afterDelete = stripComments(body.slice(at(body, ".delete().in('id', ids)")));
    expect(afterDelete).not.toMatch(/\bids\.length\b/);
    expect(afterDelete).not.toMatch(/removed\??\.length/);
  });

  it('every new message resolves in every base catalogue', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const cat = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      for (const key of ['actions.couldNotUpdateThatRestaurant', 'actions.couldNotDeleteThatSimulation', 'actions.couldNotUndoThatGroceryAdd']) {
        expect(cat[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});

/**
 * Audit C1-S9-61 — six writes the ratchet could not see.
 *
 * Each was the FIRST statement inside a block, and the scanner's statement
 * began at the last `;` — before the `if` — so a `.select(` anywhere in the
 * surrounding if/else counted it as confirmed. C1-S9-60 recorded the server
 * actions as burned down to their deliberate members; that was true only of the
 * writes the scanner could see.
 */
const platformActions = readFileSync('app/(app)/admin/marketing/platform/actions.ts', 'utf8');
const profileActions = readFileSync('app/(app)/dashboard/settings/profile-actions.ts', 'utf8');

describe('writes that were hidden as the first statement in a block (C1-S9-61)', () => {
  it('claiming a CRM lead never overwrites an owner, and is confirmed', () => {
    const body = actionBody(profileActions, 'async function resolveContactId');
    expect(body).toContain(".update({ owner_id: userId }).eq('id', byEmail[0].id).is('owner_id', null).select('id')");
    expect(body).toContain('if (!wroteNoRows(claimed)) return byEmail[0].id;');
  });

  it("a lead owned by SOMEONE ELSE is not returned as this user's", () => {
    // The old code returned `byEmail[0].id` whatever its owner. Now only an
    // unowned lead this call actually claimed, or one this user already owns.
    const body = actionBody(profileActions, 'async function resolveContactId');
    const branch = body.slice(at(body, 'if (byEmail?.[0]?.id) {'), at(body, "from('crm_contacts').insert("));
    const returns = branch.match(/return byEmail\[0\]\.id;/g) ?? [];
    expect(returns, 'exactly the claimed path and the already-ours path').toHaveLength(2);
    expect(branch).toContain('byEmail[0].owner_id === userId');
  });

  it('a departure event deleted from the calendar is re-created, not pointed at', () => {
    const body = tripIntel.slice(at(tripIntel, 'if (opts.existingId) {'));
    const block = ifBlock(tripIntel, 'if (opts.existingId) {');
    expect(block).toContain('if (!wroteNoRows(updated)) return opts.existingId;');
    // And the update must ASK. Without `.select('id')`, `updated` is null on
    // every call, `wroteNoRows` is always true, and each save would fall
    // through and create another event — duplication, the C1-S9-58 shape.
    expect(block).toContain(".eq('id', opts.existingId).eq('family_id', opts.familyId).select('id');");
    // Zero rows must reach the insert below rather than return: the block may
    // not end in an unconditional `return opts.existingId`.
    expect(stripComments(block)).not.toMatch(/\n\s*return opts\.existingId;/);
    expect(at(body, "from('calendar_events').insert(")).toBeGreaterThan(block.length);
  });

  it('both chore rollbacks log a restore or cleanup that matched nothing', () => {
    for (const [binding, log] of [
      ['removed', "'[chore proof] submission cleanup failed — an orphan submission may remain'"],
      ['restored', "'[chore state] assignment rollback failed'"],
    ] as const) {
      const block = stripComments(ifBlock(missionsFile, `error || wroteNoRows(${binding})`));
      expect(block, binding).toContain(log);
      expect(block, binding).not.toMatch(/\breturn\b|\bthrow\b/);
    }
  });

  it('clearing the previous default template stays ungated on rows', () => {
    const clear = platformActions.slice(at(platformActions, "const { error: clearDefaultError }"));
    expect(clear.slice(0, 260)).not.toContain('.select(');
    expect(platformActions).toContain('when none was, zero rows is exactly right');
  });

  it('removing a vote stays ungated on rows', () => {
    const body = actionBody(feedbackActions, 'export async function toggleVoteAction');
    const remove = body.slice(at(body, "from('feedback_votes').delete()"));
    expect(remove.slice(0, 120)).not.toContain('.select(');
    expect(body).toContain('the vote is already gone');
  });
});
