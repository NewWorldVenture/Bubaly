import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// A-05 (agent-05, PLA-0801): the Photos module's deletePhoto removed the storage
// object first, then deleted the DB row — dropping BOTH errors and showing
// "Photo deleted" UNCONDITIONALLY. On a failed row-delete after storage removal
// this orphaned a library row pointing at an already-removed image AND told the
// user it was deleted. toggleFavorite/updateCaption likewise swallowed write errors.
// Fix: delete the DB row (source of truth) first + surface errors before claiming
// success; only remove storage once the row is gone.

const src = fs.readFileSync('components/modules/photos-module.tsx', 'utf8');

describe('photos module mutations surface failures (A-05)', () => {
  it('deletePhoto deletes the DB row first, guards the error, and only then removes storage', () => {
    const fn = src.slice(src.indexOf('async function deletePhoto'), src.indexOf('async function updateCaption'));
    expect(fn).toContain("const { error } = await supabase.from('family_photos').delete()");
    expect(fn).toContain('if (error) { toastError(describeDbError(error)); return; }');
    // Row delete + its guard must precede both the storage removal and the
    // success toast. The removal is located by what it DOES, not by how it is
    // spelled: this read `.storage.from('family-media').remove` and broke when
    // the call moved behind removeFamilyMedia — the ordering it cares about was
    // unchanged, and the property was still true.
    const removalAt = Math.min(
      ...[/\.storage\.from\('family-media'\)\.remove/, /removeFamilyMedia\(/]
        .map((pattern) => { const m = pattern.exec(fn); return m ? m.index : Number.POSITIVE_INFINITY; }),
    );
    expect(removalAt, 'deletePhoto must remove the storage object somehow').toBeLessThan(Number.POSITIVE_INFINITY);
    expect(fn.indexOf('.delete()')).toBeLessThan(removalAt);
    expect(fn.indexOf('if (error)')).toBeLessThan(fn.indexOf("success(tr('photosModule.photoDeleted'))"));
    // SEC-015: and the removal must be checked before success is claimed.
    expect(removalAt).toBeLessThan(fn.indexOf("success(tr('photosModule.photoDeleted'))"));
    expect(fn.slice(removalAt, fn.indexOf("success(tr('photosModule.photoDeleted'))")))
      .toMatch(/if \(removal\.error\)[\s\S]*return;/);
  });

  it('toggleFavorite and updateCaption surface write errors instead of swallowing them', () => {
    const fav = src.slice(src.indexOf('async function toggleFavorite'), src.indexOf('async function deletePhoto'));
    expect(fav).toContain('const { error } =');
    expect(fav).toContain('if (error) toastError(describeDbError(error));');
    const cap = src.slice(src.indexOf('async function updateCaption'));
    expect(cap).toContain('const { error } =');
    expect(cap).toContain('if (error) toastError(describeDbError(error));');
  });
});
