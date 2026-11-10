import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/missions/actions.ts', 'utf8');

/** One top-level function's own text, whitespace squeezed: from its `async function` line to its closing brace. */
function functionBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf('\n}\n', start);
  expect(start, `${name} is defined`).toBeGreaterThan(-1);
  expect(end, `${name} is closed`).toBeGreaterThan(start);
  return source.slice(start, end).replace(/\s+/g, ' ');
}
const squeezed = source.replace(/\s+/g, ' ');
const RESTORE = 'await restoreAssignmentState(supabase, familyId, assignment);';

describe('chore state transition persistence', () => {
  it('uses checked helpers for submission status transitions and restores assignments', () => {
    expect(source).toContain('async function restoreAssignmentState(');
    expect(source).toContain('async function setSubmissionStatus(');
    expect(source).toContain(".select('id').single();");
    // The AI-verdict / decision-status writes run under the service role (they are
    // server decisions, not the child's — chore_submissions decision statuses are
    // DB-guarded to managers/service-role by migration 0222).
    expect(source).toContain("await setSubmissionStatus(service, familyId, submission.id, 'pending');");
  });

  // `.select('id').single();` is written nine times in the action, so the case
  // above is satisfied by any of them. The check that makes the helper a
  // CHECKED one is read inside the helper.
  it('setSubmissionStatus confirms the row it updated, family-scoped, and reports a write that changed nothing', () => {
    const body = functionBody('setSubmissionStatus');
    expect(body).toContain(".eq('id', submissionId).eq('family_id', familyId).select('id').single();");
    expect(body).toContain('if (error || !data) {');
    expect(body).toMatch(/if \(error \|\| !data\) \{[^}]*return false; \} return true;$/);
  });

  it('restoreAssignmentState puts the row back family-scoped and reports a restore that changed nothing', () => {
    const body = functionBody('restoreAssignmentState');
    expect(body).toContain(".eq('id', assignment.id as string).eq('family_id', familyId).select('id');");
    expect(body).toContain('if (error || wroteNoRows(restored)) {');
  });

  it('restores the assignment in each of the three branches that fail after it was changed', () => {
    expect(squeezed).toContain(
      `if (!await setSubmissionStatus(service, familyId, submission.id, 'approved')) { ${RESTORE} return { ok: false, error: t('actions.couldNotFinishTheChore') }; }`,
    );
    expect(squeezed).toContain(
      `if (!await setSubmissionStatus(service, familyId, submission.id, subStatus)) { ${RESTORE} return { ok: false, error: t('actions.couldNotFinishTheProof') }; }`,
    );
    expect(squeezed).toContain(
      `if (submittedAssignmentError || !submittedAssignment) { await setSubmissionStatus(service, familyId, submission.id, 'pending'); ${RESTORE} return { ok: false, error: t('actions.couldNotFinishTheProof') }; }`,
    );
    expect(source.split(RESTORE)).toHaveLength(4);
  });

  it('does not report auto-approval after reward finalization fails', () => {
    expect(source).toContain("await setSubmissionStatus(service, familyId, submission.id, 'parent_review');");
    expect(source).toContain("return { ok: false, error: t('actions.couldNotFinishTheChore2') }");
  });

  it('rolls back dispute and parent-review follow-up writes', () => {
    // Re-pointed under C1-S9-60, for the reason given below for the chore
    // cleanup: the trailing semicolon made this an assertion about where the
    // statement ENDS, and confirming the second dispute rollback moved it. What
    // it was protecting is that the rollback happens, stays family-scoped, and
    // (since C1-S9-55 and C1-S9-60) reports a delete that removed nothing — on
    // BOTH paths that insert a dispute and then fail.
    const disputeRollbacks = source.match(
      /from\('chore_disputes'\)\s*\.delete\(\)\.eq\('id', dispute\.id\)\.eq\('family_id', familyId\)\.select\('id'\)/g,
    ) ?? [];
    expect(disputeRollbacks, 'both dispute rollbacks, family-scoped and confirmed').toHaveLength(2);
    expect(source).toContain('wroteNoRows(cleanedDispute)');
    expect(source).toContain('wroteNoRows(cleaned)');
    expect(source).toContain("await supabase.from('chore_disputes').update({ status: 'open'");
    expect(source).toContain("await setSubmissionStatus(supabase, familyId, submissionId, submission.status);");
  });

  it('cleans up a chore when assignment creation fails', () => {
    expect(source).toContain('const { data: chore, error: choreError }');
    expect(source).toContain('const { error: assignmentError }');
    // Same: the trailing semicolon was part of the assertion, and appending
    // `.select('id')` moved the statement's end. The cleanup now also reports a
    // delete that removed nothing, which would leave an unassigned chore in the
    // family's list.
    expect(source).toContain("from('chores').delete().eq('id', chore.id).eq('family_id', familyId)");
    expect(source).toContain('wroteNoRows(cleanedChore)');
    expect(source).toContain('an unassigned chore may remain');
  });
});
