import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/missions/actions.ts', 'utf8');

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

  it('does not report auto-approval after reward finalization fails', () => {
    expect(source).toContain("await setSubmissionStatus(service, familyId, submission.id, 'parent_review');");
    expect(source).toContain("return { ok: false, error: t('actions.couldNotFinishTheChore2') }");
  });

  it('rolls back dispute and parent-review follow-up writes', () => {
    expect(source).toContain("await supabase.from('chore_disputes').delete().eq('id', dispute.id).eq('family_id', familyId);");
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
