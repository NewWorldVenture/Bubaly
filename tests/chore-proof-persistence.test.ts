import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = () => readFileSync(resolve(process.cwd(), 'app/(app)/missions/actions.ts'), 'utf8');

describe('chore proof persistence boundaries', () => {
  it('uses collision-resistant server-side proof paths and stable upload errors', () => {
    const code = source();

    // The form names each object (a random v4 id, then the sanitized file name)
    // and uploads it straight to Storage; the action accepts only a path that
    // is one such object in the assignment's member folder.
    const media = readFileSync(resolve(process.cwd(), 'lib/chores/proof-media.ts'), 'utf8');
    expect(media).toContain('crypto.randomUUID()');
    expect(media).toContain('`${familyId}/${memberId}/${id}-${proofFileName(name)}`');
    expect(code).toContain('isProofPathFor(path, familyId, assignment.member_id)');
    expect(code).not.toContain('Upload failed: ${error.message}');
  });

  it('cleans uploaded media when the submission row cannot be saved', () => {
    const code = source();

    expect(code).toContain('if (subErr || !submission)');
    expect(code).toContain('await cleanupProofMedia(supabase, familyId, mediaPaths);');
  });

  it('cleans the submission and media when validation or assignment persistence fails', () => {
    const code = source();

    expect(code).toContain('const { error: validationError }');
    expect(code).toContain('if (validationError)');
    expect(code).toContain('const { data: updatedAssignment, error: assignmentError }');
    expect(code).toContain('if (assignmentError || !updatedAssignment)');
    expect(code).toContain('await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);');
  });

  it('cleans up after an unexpected validator exception', () => {
    const code = source();

    expect(code).toContain('catch {');
    expect(code).toContain("return { ok: false, error: t('actions.couldNotReviewYourProof') }");
    expect(code).toContain('await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);');
  });
});
