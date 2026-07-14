import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = () => readFileSync(resolve(process.cwd(), 'app/(app)/missions/actions.ts'), 'utf8');

describe('chore proof persistence boundaries', () => {
  it('uses collision-resistant server-side proof paths and stable upload errors', () => {
    const code = source();

    expect(code).toContain("import { randomUUID } from 'node:crypto'");
    expect(code).toContain('randomUUID()}-${safe}');
    expect(code).not.toContain('Upload failed: ${error.message}');
  });

  it('cleans uploaded media when the submission row cannot be saved', () => {
    const code = source();

    expect(code).toContain('if (subErr || !submission)');
    expect(code).toContain('await cleanupProofMedia(supabase, mediaPaths);');
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
    expect(code).toContain("return { ok: false, error: 'Could not review your proof. Please try again.' }");
    expect(code).toContain('await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);');
  });
});
