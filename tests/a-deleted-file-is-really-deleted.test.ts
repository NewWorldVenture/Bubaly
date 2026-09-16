import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

/**
 * Audit C1-S6-01 — generalised from C4-S4-09.
 *
 * Five family-facing delete paths awaited a storage removal bare and deleted
 * the row regardless, then said "deleted". The ordering is what makes it a
 * privacy defect rather than an accounting one: with the row gone, a surviving
 * object is **invisible** — nothing in the product references it, so the family
 * cannot see it, open it, or try again — while the screen says it is gone. A
 * tax document, a warranty or a passport scan is plausibly being deleted
 * *because* of what it contains.
 *
 * The repository already had two correct implementations on the admin side.
 * `adminDeleteDocumentAction` removes the object first and refuses the row
 * delete when that fails; the marketing-asset action soft-deletes first and
 * **rolls the row back** when storage refuses. Both are asserted here too, so
 * this guard notices if the models themselves drift.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

/** Object removed and CHECKED before the row is deleted. */
const OBJECT_FIRST: [string, string, string][] = [
  ['components/modules/home-module.tsx', 'removeFamilyDocument(', "from('documents').delete()"],
  ['components/modules/files-hub-module.tsx', 'removeFamilyDocument(', "from('documents').delete()"],
  ['components/modules/documents-module.tsx', 'removeFamilyDocument(', "from('documents').delete()"],
  ['components/modules/tax-vault-module.tsx', 'removeFamilyDocument(', "from('tax_documents').delete()"],
  ['components/modules/trip-memories-module.tsx', 'removeFamilyDocument(', "from('trip_memories').delete()"],
];

describe('a file the user deleted is really deleted', () => {
  it.each(OBJECT_FIRST)('%s removes the object, reads the result, then deletes the row', (path, remove, rowDelete) => {
    const source = read(path);
    expect(source, 'the storage result must be bound, not awaited bare').toContain(`const { error: storageError } = await ${remove}`);
    expect(at(source, 'if (storageError)')).toBeLessThan(at(source, rowDelete));
  });

  it.each(OBJECT_FIRST)('%s reports the refusal and does not claim success', (path, _remove, rowDelete) => {
    const source = read(path);
    // Everything between the check and the row delete is the refused path.
    const refusal = source.slice(at(source, 'if (storageError)'), at(source, rowDelete));
    expect(refusal, 'the refusal must reach the user').toContain('toastError(');
    expect(refusal, 'nothing may claim success before the row is even deleted').not.toContain('success(');
  });

  it('the photos module keeps its row-first ordering but stops claiming', () => {
    // It deletes the row first on purpose — its own comment explains that a
    // failed row delete must not orphan a library row pointing at a removed
    // image. That reasoning is left alone. What it must not do is discard the
    // storage result and say "Photo deleted" either way.
    const source = read('components/modules/photos-module.tsx');
    expect(source).toContain("const { error: storageError } = await supabase.storage.from('family-media').remove(");
    expect(at(source, 'if (storageError)')).toBeLessThan(at(source, "success(tr('photosModule.photoDeleted'))"));
    expect(source).toContain("tr('photosModule.theFileCouldNotBe')");
  });

  it('the two admin models this was measured against have not drifted', () => {
    const action = read('app/(app)/admin/actions.ts');
    expect(at(action, 'if (storageError)')).toBeLessThan(at(action, "from('documents').delete()"));

    // Row-first, but with a rollback — the other sound answer for a soft delete.
    const assets = read('app/(app)/admin/marketing/assets/actions.ts');
    expect(assets).toContain('const { error: removeError }');
    expect(at(assets, 'if (removeError)')).toBeLessThan(at(assets, 'logMarketingAudit('));
    expect(assets.slice(at(assets, 'if (removeError)'))).toContain('deleted_at: null');
  });

  it('no rollback discards its result silently', () => {
    for (const path of ['components/modules/home-module.tsx', 'components/modules/messages-module.tsx']) {
      const source = read(path);
      expect(source, path).toContain('const { error: rollbackError }');
      expect(source, path).toContain('left an object behind');
    }
  });
});
