import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/missions/actions.ts', 'utf8');

describe('chore state transition persistence', () => {
  it('uses checked helpers for submission status transitions and restores assignments', () => {
    expect(source).toContain('async function restoreAssignmentState(');
    expect(source).toContain('async function setSubmissionStatus(');
    expect(source).toContain(".select('id').single();");
    expect(source).toContain("await setSubmissionStatus(supabase, familyId, submission.id, 'pending');");
  });

  it('does not report auto-approval after reward finalization fails', () => {
    expect(source).toContain("await setSubmissionStatus(supabase, familyId, submission.id, 'parent_review');");
    expect(source).toContain("return { ok: false, error: 'Could not finish the chore approval. It was sent for parent review.' }");
  });

  it('rolls back dispute and parent-review follow-up writes', () => {
    expect(source).toContain("await supabase.from('chore_disputes').delete().eq('id', dispute.id).eq('family_id', familyId);");
    expect(source).toContain("await supabase.from('chore_disputes').update({ status: 'open'");
    expect(source).toContain("await setSubmissionStatus(supabase, familyId, submissionId, submission.status);");
  });

  it('cleans up a chore when assignment creation fails', () => {
    expect(source).toContain('const { data: chore, error: choreError }');
    expect(source).toContain('const { error: assignmentError }');
    expect(source).toContain("await supabase.from('chores').delete().eq('id', chore.id).eq('family_id', familyId);");
  });
});
