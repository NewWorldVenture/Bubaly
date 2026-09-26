// Five surfaces reported a refused read as a successful reading of nothing.
//
// This is the E-01 shape, and this audit has now fixed it four times (U-02 on the
// Guardian profile, U-04 across five Guardian pages, the Family CFO forecast, and
// these). What makes these five worth their own file is that on three of them the
// empty state is not merely wrong — it CHANGES WHAT THE PAGE DOES.
//
// THE SHARPEST IS /family/members, and the proof is worth keeping.
// requireUserContext() resolves ctx.active from a family_members row for THIS
// caller with is_active = true (lib/supabase/auth.ts:118-126), and when there is
// none it provisions a family and re-resolves. So by the time the page body runs,
// the caller IS an active member of ctx.active.familyId. A correct read of the
// same table, same family, same filter therefore returns at least one row —
// always. "No members yet." was reachable ONLY when `data` was null: the error
// nothing was reading. A parent whose read was refused was told their household
// was empty, and there was no state of the world in which that message was true.
//
// The other two that change behaviour rather than wording:
//
//   /dashboard/family-access built `usernameByMember` from an unread
//   `child_logins` result, and that map decides between "reset this child's PIN"
//   and "give this child a login". A dropped error turned every existing login
//   into a create-a-login prompt — a WRITE offered on a read that did not happen.
//
//   recipes-module addToGrocery treated a failed `grocery_lists` read as "you
//   have no list" and offered to make one. A family with a perfectly good
//   Groceries list ends up with two, and their items split across both.
//
// These assert the PROPERTY — that the error is read, logged and rendered — and
// not the exact call text. Five guards in this audit failed because they pinned
// how something was written rather than what had to be true.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (f: string) => readFileSync(f, 'utf8');

type Surface = { file: string; table: string; log: string };

const SURFACES: Surface[] = [
  { file: 'app/(app)/family/members/page.tsx', table: 'family_members', log: '[family/members]' },
  { file: 'app/(app)/family/permissions/page.tsx', table: 'permissions', log: '[family/permissions]' },
  { file: 'app/(app)/dashboard/family-access/page.tsx', table: 'child_logins', log: '[dashboard/family-access]' },
];

describe('a page that reads may not report a failure as emptiness', () => {
  it.each(SURFACES)('$file destructures the error, logs it, and renders a retryable state', ({ file, log }) => {
    const source = read(file);
    expect(source, `${file} must destructure the read error`).toMatch(/error:\s*\w*[Ee]rror/);
    expect(source, `${file} must log the failure`).toContain(`console.error('${log}`);
    expect(source, `${file} must render an ErrorState`).toMatch(/return <ErrorState message=\{/);
  });

  it.each(SURFACES)('$file guards BEFORE it derives anything from the rows', ({ file }) => {
    const source = read(file);
    const guard = source.indexOf('return <ErrorState message={');
    expect(guard).toBeGreaterThan(-1);
    // The derivation that made the empty state look like data must come after the
    // guard, or the page still renders a conclusion drawn from a failed read.
    for (const derive of ['(members ?? [])', 'for (const p of perms ?? [])', 'members && members.length > 0']) {
      const at = source.indexOf(derive);
      if (at > -1) expect(at, `${derive} must sit after the guard`).toBeGreaterThan(guard);
    }
  });

  it('the recipe flow refuses to create a second list on a read it could not make', () => {
    const source = read('components/modules/recipes-module.tsx');
    const fn = source.slice(source.indexOf('async function addToGrocery'));
    const body = fn.slice(0, fn.indexOf('\n  }') + 4);
    expect(body, 'the grocery read must destructure its error').toMatch(/data: list, error/);
    // The error branch must come BEFORE the "offer to create one" branch — that
    // ordering is the whole fix.
    const errAt = body.indexOf('if (error)');
    const offerAt = body.indexOf('if (!list)');
    expect(errAt).toBeGreaterThan(-1);
    expect(offerAt).toBeGreaterThan(-1);
    expect(errAt, 'the failure must be handled before the empty case').toBeLessThan(offerAt);
    expect(body).toContain("console.error('[recipes] grocery list read failed'");
  });

  // The claim the /family/members guard rests on. If requireUserContext ever stops
  // guaranteeing an active membership, the comment on that page becomes false and
  // the reasoning behind its guard needs revisiting — so the contract is pinned
  // here rather than left as prose.
  it('requireUserContext still guarantees the caller is an active member', () => {
    const auth = read('lib/supabase/auth.ts');
    expect(auth, 'membership is read for the caller').toMatch(/\.from\('family_members'\)[\s\S]{0,200}?\.eq\('user_id', auth\.user\.id\)/);
    expect(auth, 'and only active rows count').toMatch(/\.eq\('is_active', true\)/);
    expect(auth, 'an empty result is onboarding, not a family').toContain("return { needsFamily: true };");
    expect(auth, 'and requireUserContext never returns that state to a page')
      .toMatch(/if \('needsFamily' in ctx\)/);
  });
});
