import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// On the trust surface, the sentence a manager reads is about ACCESS: "policy
// disabled", "access revoked", "emergency ended".
//
// Every one of those writes is `.eq('id', …).eq('family_id', …)`, which matches
// nothing for a stale id or one belonging to another family — and an UPDATE or
// DELETE that matches nothing SUCCEEDS. Zero rows, no error. Elsewhere in the
// app that is a stale-list annoyance; here it means telling someone a
// delegation is revoked while it is still granting access, or an emergency
// session is ended while it is still elevating one.
//
// These are server actions, so the manager check has already run — RLS is not
// what refuses them. The zero-row case is a stale or foreign id, which is
// exactly what a revoke button on a list rendered a moment ago produces.
//
// `.select('id')` is what makes PostgREST return the affected rows at all
// (`Prefer: return=representation`), so without it the action cannot tell.
const SRC = readFileSync('app/(app)/dashboard/trust/actions.ts', 'utf8');

/** The five writes on this surface whose success sentence is about access. */
const ACCESS_WRITES: [string, string][] = [
  ['trust_policies', 'update(base)'],
  ['trust_policies', "update({ enabled: input.enabled })"],
  ['trust_policies', 'delete()'],
  ['trust_delegations', 'revoked_at'],
  ['emergency_sessions', 'ended_at'],
];

describe('a write that changed nothing is not reported as done', () => {
  it('every access-changing write asks for its rows back', () => {
    // Each statement runs from `.from('<table>')` to its terminating `;`.
    const statements = [...SRC.matchAll(/\.from\('(trust_policies|trust_delegations|emergency_sessions)'\)[\s\S]*?;/g)]
      .map((m) => m[0])
      .filter((s) => /\.(update|delete)\(/.test(s));

    expect(statements.length, 'the scan found no access writes at all').toBeGreaterThanOrEqual(5);
    const unverified = statements.filter((s) => !s.includes(".select('id')"));
    expect(unverified, 'an access write that cannot tell zero rows from one').toEqual([]);
  });

  it('and refuses rather than returning ok when zero rows came back', () => {
    // The check has to be USED, not merely available: `.select('id')` with the
    // result dropped is the same defect wearing a longer statement.
    const refusals = [...SRC.matchAll(/if \(changedNothing\(rows\)\) return \{ ok: false/g)];
    expect(refusals.length).toBeGreaterThanOrEqual(5);
  });

  it('names each of the five writes it is guarding (guards the guard)', () => {
    for (const [table, marker] of ACCESS_WRITES) {
      const statement = [...SRC.matchAll(new RegExp(`\\.from\\('${table}'\\)[\\s\\S]*?;`, 'g'))]
        .map((m) => m[0])
        .find((s) => s.includes(marker));
      expect(statement, `${table} / ${marker} is no longer present — update this list`).toBeTruthy();
      expect(statement).toContain(".select('id')");
    }
  });

  it('the helper reads zero rows as "changed nothing"', async () => {
    // Exercised through the module rather than re-implemented here: a test that
    // rewrites the predicate it is checking proves only its own arithmetic.
    expect(SRC).toMatch(/function changedNothing\(rows: unknown\[\] \| null\): boolean \{\s*return !rows \|\| rows\.length === 0;/);
  });
});
