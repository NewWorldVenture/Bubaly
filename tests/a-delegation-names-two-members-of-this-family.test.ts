import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const ACTIONS = readFileSync(join(ROOT, 'app/(app)/dashboard/trust/actions.ts'), 'utf8');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/0093_trust_engine.sql'), 'utf8');

/**
 * THE TRUST PAGE IS THE ONE SURFACE THAT SAYS WHO MAY ACT FOR WHOM.
 *
 * Two things were wrong with it, and neither was a privilege escalation — which
 * is worth saying plainly, because it would be easy to file this as one.
 *
 * 1. `trust_delegations.from_member_id` and `to_member_id` reference
 *    `family_members(id)` with NOTHING tying either to `family_id` (0093:69-71).
 *    A member uuid from another household satisfies the foreign key, and
 *    `createDelegationAction` took both straight from its input while setting
 *    `family_id` from the session. The row lands in the caller's own family
 *    naming someone who is not in it.
 *
 *    It grants nothing. `evaluateTrust` (lib/trust/server.ts) selects
 *    `to_member_id` filtered by `family_id` and matches it against members of
 *    that family, so a foreign id never matches; `from_member_id` is not read
 *    by the evaluator at all. The defect is that the trust UI then displays a
 *    grant made BY a non-member — a lie on the surface whose entire job is
 *    saying who delegated what to whom.
 *
 * 2. `revokeDelegationAction` issued an UPDATE and returned `ok: true` on
 *    `error === null`. An update that matches no row is not an error, so
 *    revoking something already revoked, belonging to another family, or gone
 *    reported success and the page said the access was withdrawn.
 *
 * Both are now closed in code rather than left to the database: the action
 * checks both ids are in the family before inserting, and the revoke asks which
 * row it changed.
 */

describe('a delegation names two members of this family', () => {
  it('the schema still does not constrain either member to the family', () => {
    // The premise. If a migration ever adds that constraint, the in-code check
    // becomes belt-and-braces rather than the only thing standing there, and
    // this file should say so instead of implying otherwise.
    const table = MIGRATION.slice(
      MIGRATION.indexOf('CREATE TABLE IF NOT EXISTS public.trust_delegations'),
      MIGRATION.indexOf('CREATE INDEX IF NOT EXISTS idx_trust_delegations_active'),
    );
    expect(table).toContain('from_member_id uuid NOT NULL REFERENCES public.family_members(id)');
    expect(table).toContain('to_member_id  uuid NOT NULL REFERENCES public.family_members(id)');
    // Precise: a COMPOSITE foreign key or a CHECK that ties a member column to
    // family_id. The first version of this matched `family_id.*from_member_id`
    // with the `s` flag, which is satisfied by the two columns merely being
    // declared near each other — it would have failed on a table that
    // constrains nothing.
    expect(table, 'a family-scoped constraint appeared — revisit this guard')
      .not.toMatch(/(foreign key|references)[^\n]*\(\s*family_id\s*,|check[^\n]*(from_member_id|to_member_id)[^\n]*family_id/i);
  });

  it('createDelegationAction verifies both ids belong to the caller\'s family', () => {
    const body = ACTIONS.slice(
      ACTIONS.indexOf('export async function createDelegationAction'),
      ACTIONS.indexOf('export async function createSharingPresetAction'),
    );
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("from('family_members')");
    expect(body).toMatch(/\.eq\('family_id', ctx\.active\.familyId\)/);
    expect(body).toMatch(/\.in\('id', \[input\.fromMemberId, input\.toMemberId\]\)/);
    // Both, not one: a length check is what makes it cover the pair.
    expect(body).toMatch(/length !== 2/);
  });

  it('revokeDelegationAction asks which row it revoked', () => {
    const body = ACTIONS.slice(
      ACTIONS.indexOf('export async function revokeDelegationAction'),
      ACTIONS.indexOf('// ─── Approval decisions'),
    );
    expect(body.length).toBeGreaterThan(200);
    // Two spellings answer the same question, and this asks for the answer
    // rather than the spelling: read the row back, and refuse to report success
    // when none came. `changedNothing(rows)` is the same predicate applied
    // across all six write paths on this surface; the helper itself is pinned by
    // tests/a-revoke-that-revoked-nothing.test.ts.
    expect(body, 'the revoke must be scoped to the caller\'s own family')
      .toMatch(/\.eq\('family_id', ctx\.active\.familyId\)/);
    expect(body, 'the revoke must read back the row it claims to have revoked')
      .toMatch(/\.select\('id'\)/);
    expect(body, 'a no-op revoke must not report success')
      .toMatch(/if \((?:!revoked|changedNothing\(rows\))\) return \{ ok: false/);
  });

  it('the evaluator still reads to_member_id family-scoped, and never from_member_id', () => {
    // This is what bounds the impact to display rather than authority. If the
    // evaluator ever starts reading from_member_id, the finding gets worse and
    // this assertion is where that becomes visible.
    const server = readFileSync(join(ROOT, 'lib/trust/server.ts'), 'utf8');
    const read = server.slice(server.indexOf("from('trust_delegations')"), server.indexOf("from('emergency_sessions')"));
    expect(read).toContain('to_member_id');
    expect(read).toMatch(/\.eq\('family_id', familyId\)/);
    expect(read, 'the evaluator now reads from_member_id — re-assess the impact').not.toContain('from_member_id');
  });
});
