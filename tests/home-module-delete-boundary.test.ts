import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * Audit C4-S4-09.
 *
 * `removeFile` awaited `removeFamilyDocument` bare and deleted the row
 * regardless, then said "File removed". Deleting the row first is what makes a
 * surviving object invisible: nothing in the product references it any more, so
 * the family cannot see it, open it or remove it — while the screen says it is
 * gone. A warranty or a manual is plausibly being deleted BECAUSE it carries a
 * serial or a policy number.
 *
 * The repository already had the right shape one directory away —
 * `adminDeleteDocumentAction` stops before the row delete when storage fails,
 * and `tests/admin-document-delete-boundary.test.ts` holds it there. This is
 * the same boundary on the client path, which had drifted from it.
 */
// Comments blanked: this file's subject is quoted in the source's own comments.
const module = readFileSync('components/modules/home-module.tsx', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');
const removeFile = module.slice(module.indexOf('async function removeFile'));

describe('removing a document does not report success for an object that survived', () => {
  it('reads the storage result and stops before the row delete', () => {
    expect(removeFile).toContain('const { error: storageError } = await removeFamilyDocument(');
    expect(at(removeFile, 'if (storageError)')).toBeLessThan(at(removeFile, ".from('documents').delete()"));
  });

  it('does not claim the removal when storage refused', () => {
    const beforeTheDelete = removeFile.slice(0, at(removeFile, ".from('documents').delete()"));
    expect(beforeTheDelete).toContain('return toastError(storageError)');
    expect(beforeTheDelete).not.toContain("success(tr('homeModule.fileRemoved'))");
  });

  it('names a failed upload rollback instead of discarding it', () => {
    // Lower stakes — the user is already being told the upload failed — but a
    // leaked object is still a leaked object.
    expect(module).toContain('const { error: rollbackError } = await removeFamilyDocument(supabase, path)');
    expect(module).toContain('upload rollback left an object behind');
  });

  it('matches the admin path this component had drifted from', () => {
    const admin = readFileSync('app/(app)/admin/actions.ts', 'utf8');
    const action = admin.slice(admin.indexOf('export async function adminDeleteDocumentAction'));
    expect(at(action, 'if (storageError)')).toBeLessThan(at(action, ".from('documents').delete()"));
  });
});
