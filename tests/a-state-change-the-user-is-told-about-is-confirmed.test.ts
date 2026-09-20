import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { between, bodyOf } from './helpers/source-order';

/**
 * Audit C1-S9-23/24 — the second wave of "reported success for work that may
 * not have happened", found by three parallel workers sweeping disjoint scopes
 * (pages, `'use server'` writes, API routes) and then verified here before any
 * fix was applied.
 *
 * Each of these had a specific, checkable consequence rather than a shape. They
 * are pinned together because they share one root: PostgREST returns affected
 * rows only when asked, so a write without `.select()` cannot distinguish "one
 * row changed" from "none did" — and every one of these then told the user it
 * had worked.
 */
const read = (p: string) => readFileSync(p, 'utf8');

describe('a state change the user is told about is confirmed (C1-S9-23)', () => {
  it('pausing an allowance is confirmed, because a scheduler acts on it', () => {
    // The sharpest consequence in the set: app/api/cron/wallet-allowance
    // selects rules with `.eq('is_active', true)`, so a pause that matches no
    // row means the child keeps being paid weekly while the parent is told it
    // stopped. allowance_rules also carries a restrictive manager-only UPDATE
    // guard (0306) — precisely the shape that yields zero rows and no error.
    const wallet = read('app/(app)/wallet/actions.ts');
    const toggle = bodyOf(wallet, 'export async function toggleAllowanceRuleAction', 'return { ok: true };');
    expect(toggle).toContain(".select('id')");
    expect(toggle).toContain('wroteNoRows(toggled)');
    // And the cron really does filter on it — if this stops being true the
    // reasoning above is stale and this guard should be revisited, not deleted.
    expect(read('app/api/cron/wallet-allowance/route.ts')).toContain("eq('is_active', true)");
  });

  it('editing an allowance amount is confirmed on the update branch only', () => {
    // An insert either lands or errors; only the update can match nothing.
    const wallet = read('app/(app)/wallet/actions.ts');
    const save = bodyOf(wallet, 'export async function saveAllowanceRuleAction', 'revalidatePath(\'/wallet\');');
    expect(save).toContain('input.id && wroteNoRows(saved)');
  });

  it('a marketplace hand-off does not hand back a code it never stored', () => {
    // `.eq('status', 'proposed')` makes zero rows ORDINARY — the other party
    // confirming or cancelling a moment earlier does it. The action returned
    // `{ ok: true, data: { code } }` regardless, and completeHandoffAction
    // validates against the STORED code, so both people would meet in person
    // holding one that could never work.
    const handoff = read('app/(app)/marketplace/handoff/actions.ts');
    const confirm = bodyOf(handoff, 'export async function confirmHandoffAction', 'return { ok: true, data: { code } };');
    expect(confirm).toContain("eq('status', 'proposed').select('id')");
    expect(confirm).toContain('wroteNoRows(confirmed)');
  });

  it('the concierge autopilot dial is confirmed on both write paths', () => {
    // Governs whether Bubaly executes plans on its own, asks first, or stays
    // hands-off. Both the direct update and the 23505 retry are checked: the
    // retry re-filters on four equalities against a row a racing request just
    // wrote, which is its own way of matching nothing.
    const concierge = read('app/(app)/dashboard/concierge/actions.ts');
    const fn = bodyOf(concierge, 'export async function setConciergeAutopilotAction', 'revalidatePath(PATH)');
    // Count the UPDATE paths, not every .select('id') in the function — the
    // lookup read above them has one too, and asserting a raw total of 3 would
    // pin an unrelated statement.
    const updates = fn.match(/from\('trust_policies'\)\s*\n?\s*\.update\(/g) ?? [];
    expect(updates, 'the direct write and the 23505 retry').toHaveLength(2);
    expect(fn.match(/\?\.length\) return \{ ok: false/g) ?? [], 'each confirmed').toHaveLength(2);
  });
});

describe('an unauthenticated visitor cannot put markup in a trusted email (C1-S9-24)', () => {
  it('every interpolated value in the contact email is escaped', () => {
    const contact = read('app/api/contact/route.ts');
    // `name` went in raw while `message` was escaped on the SAME line, and
    // contactSchema bounds name only by length, not by character.
    expect(contact).not.toMatch(/html: `[^`]*\$\{name\}/);
    expect(contact).toContain('escapeHtml(name)');
    expect(contact).toContain('escapeHtml(message)');
    expect(contact).toContain('escapeHtml(email)');
    // And the helper covers more than `<` — a lone `<` escape leaves
    // attribute-context injection open.
    const helper = bodyOf(contact, 'function escapeHtml', '\n}');
    for (const ch of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) expect(helper).toContain(ch);
  });
});

describe('a form that overwrites is not prefilled with invented defaults (C1-S9-22)', () => {
  it('the setup questionnaire is withheld when its prefill cannot be read', () => {
    // saveFamilyDetailsAction upserts on family_id and performs NO read of its
    // own, so it has nothing to merge and no read error to notice. A form
    // prefilled with fabricated defaults therefore invites the submission that
    // overwrites the real household profile — and propagates it to the CRM.
    const page = read('app/(app)/dashboard/setup/page.tsx');
    expect(page).toMatch(/const \{ data: fo, error: foError \}/);
    expect(page).toContain('readFailures.length > 0');
    expect(page).toContain('<PartialReadBanner');
    // The form must be the ALTERNATIVE to the banner, not rendered beside it.
    expect(page).toMatch(/readFailures\.length > 0[\s\S]{0,200}?: <CompleteSetupForm/);
    // The premise: the action still has no read to merge with.
    expect(read('app/onboarding/actions.ts')).toContain("onConflict: 'family_id'");
  });
});
