import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/(app)/admin/actions.ts', 'utf8');
const action = source.slice(source.indexOf('export async function adminDeleteDocumentAction'));

describe('admin document deletion boundary', () => {
  it('uses the database path and stops before row deletion when storage removal fails', () => {
    expect(action).toContain("select('family_id, title, storage_path')");
    expect(action).toContain("remove([doc.storage_path])");
    expect(action).toContain('if (storageError) return actionFailure');
    expect(action.indexOf('if (storageError)')).toBeLessThan(action.indexOf(".from('documents').delete()"));
  });

  it('fails closed for missing rows and confirms the database delete returned a row', () => {
    expect(action).toContain("if (!doc) return { ok: false, error: t('actions.documentNotFound') }");
    expect(action).toContain("select('id').maybeSingle()");
    expect(action).toContain("if (!deleted) return { ok: false, error: t('actions.documentWasNotDeleted') }");
  });
});
