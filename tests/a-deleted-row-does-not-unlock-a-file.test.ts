import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removeFamilyDocument } from '@/lib/storage/documents';
import { removeConfirmed, type RemovableBucket } from '@/lib/storage/confirm-removal';
import type { SupabaseBrowser } from '@/lib/supabase/types';

// SEC-015. The `documents` storage policy hides a secure-vault file from a
// non-manager through `document_object_is_restricted(name)`, which works by
// FINDING THE ROW whose `storage_path` equals the object name. The guard's
// premise is that the row still names the object.
//
// All four delete paths removed the object first — deliberately, with the
// reasoning written down in three of them — and then deleted the row. Three
// discarded the removal's result entirely; the fourth checked only `error`.
//
// Storage reports a delete the policy refused exactly as it reports a delete of
// something that was never there. Measured on the local stack:
//
//   removed       -> error null, data ['<key>']
//   refused       -> error null, data []
//   never existed -> error null, data []
//
// So `error === null` was not evidence, and the row went anyway. With the row
// gone and the object alive the guard finds nothing, returns false, and the file
// becomes readable by the whole family. Proven end to end against live storage
// with a real parent and a real child:
//
//   row present -> child download: DENIED (Object not found);  listed: no
//   row deleted -> child download: ALLOWED — "THE FAMILY WILL — private";  listed: YES
//
// Reachability, also measured: a child CANNOT delete the secure row
// (`rows=[]`), so a child cannot create the orphan. The actor who can is a
// manager — and a manager can list the object, so the confirmation below sees
// it. The trigger is a manager deleting a secure document while the storage
// removal fails: a timeout, a 5xx, an offline tab.

type RemoveResult = { data: { name: string }[] | null; error: { message: string } | null };
type ListResult = { data: { name: string }[] | null; error: { message: string } | null };

/** A storage double that answers the three shapes real storage answers with. */
function client(remove: RemoveResult, list: ListResult, seen?: { listedFolder?: string; listedSearch?: string }): SupabaseBrowser {
  return {
    storage: {
      from: () => ({
        remove: async () => remove,
        list: async (folder: string, options?: { search?: string }) => {
          if (seen) { seen.listedFolder = folder; seen.listedSearch = options?.search; }
          return list;
        },
      }),
    },
  } as unknown as SupabaseBrowser;
}

const KEY = 'fam-1/legal/1790000000000-Will.pdf';
const NAME = '1790000000000-Will.pdf';

describe('a deleted row does not unlock a file (SEC-015)', () => {
  it('confirms a removal that actually happened', async () => {
    const result = await removeFamilyDocument(client({ data: [{ name: KEY }], error: null }, { data: [], error: null }), KEY);
    expect(result).toEqual({ error: null });
  });

  it('refuses when the removal was refused and the object is still there', async () => {
    // The whole finding: no error, an empty list, and the file alive.
    const result = await removeFamilyDocument(
      client({ data: [], error: null }, { data: [{ name: NAME }], error: null }),
      KEY,
    );
    expect(result.error).toBeTruthy();
  });

  it('allows a retry when the object is genuinely gone already', async () => {
    // A half-finished earlier delete must not strand the row for ever.
    const result = await removeFamilyDocument(client({ data: [], error: null }, { data: [], error: null }), KEY);
    expect(result).toEqual({ error: null });
  });

  it('reports a transport error rather than swallowing it', async () => {
    const result = await removeFamilyDocument(client({ data: null, error: { message: 'network timeout' } }, { data: [], error: null }), KEY);
    expect(result.error).toBe('network timeout');
  });

  it('treats an unreadable listing as unconfirmed rather than as absent', async () => {
    const result = await removeFamilyDocument(client({ data: [], error: null }, { data: null, error: { message: 'permission denied' } }), KEY);
    expect(result.error).toBe('permission denied');
  });

  it('compares the name exactly, because `search` is a prefix match', async () => {
    const seen: { listedFolder?: string; listedSearch?: string } = {};
    // A neighbouring object whose name merely starts with the same text must not
    // be mistaken for this one.
    const result = await removeFamilyDocument(
      client({ data: [], error: null }, { data: [{ name: `${NAME}.bak` }], error: null }, seen),
      KEY,
    );
    expect(seen.listedFolder).toBe('fam-1/legal');
    expect(seen.listedSearch).toBe(NAME);
    expect(result).toEqual({ error: null });
  });

  it('every delete path keeps the row when the removal is not confirmed', () => {
    // Structural, because these are UI handlers: the row delete must not be
    // reachable from a failed removal.
    const paths: [string, string][] = [
      ['components/modules/files-hub-module.tsx', "sb.from('documents').delete()"],
      ['components/modules/documents-module.tsx', "sb.from('documents').delete()"],
      ['components/modules/home-module.tsx', "supabase.from('documents').delete()"],
    ];
    for (const [file, rowDelete] of paths) {
      const source = readFileSync(file, 'utf8');
      const removeAt = source.indexOf('removeFamilyDocument(');
      const deleteAt = source.indexOf(rowDelete);
      expect(removeAt, `${file}: no removeFamilyDocument call`).toBeGreaterThan(-1);
      expect(deleteAt, `${file}: no documents row delete`).toBeGreaterThan(-1);
      expect(removeAt, `${file}: the object must be removed before the row`).toBeLessThan(deleteAt);
      // Between the two there must be a guard that returns.
      const between = source.slice(removeAt, deleteAt);
      expect(between, `${file}: the removal result is not checked before the row delete`).toMatch(/\.error\)?\s*\)?\s*\{?[^}]*return/);
    }
  });

  it('the admin path confirms the object by name, not by the absence of an error', () => {
    const admin = readFileSync('app/(app)/admin/actions.ts', 'utf8');
    expect(admin).toContain("const { data: removed, error: storageError } = await supabase.storage.from('documents').remove([doc.storage_path]);");
    expect(admin).toMatch(/!removed\?\.some\(\(object\) => object\.name === doc\.storage_path\)/);
  });

  it('every storage remove either confirms or is a marked best-effort rollback', () => {
    // The generalisation: ten call sites share the return shape above. Each is
    // recorded with what it is, so a new one has to say which it is.
    const ACCOUNTED: Record<string, string> = {
      'lib/storage/confirm-removal.ts': 'the shared rule itself',
      'lib/storage/documents.ts': 'delegates to removeConfirmed',
      'lib/storage/feedback-attachments.ts': 'delegates to removeConfirmed',
      'lib/storage/marketplace-photos.ts': 'delegates to removeConfirmed',
      'lib/storage/family-media.ts': 'delegates to removeConfirmed',
      'app/(app)/admin/actions.ts': 'confirms by name inline, and keeps the documents row otherwise',
      'components/modules/photos-module.tsx': 'the delete goes through removeFamilyMedia and refuses to claim success; the upload rollback reports its own failure to the person',
      'components/memories/create-memory.tsx': 'rollback after a failed insert — reports "the uploaded photo could not be removed" to the person, who has already been told the save failed',
      'components/modules/messages-module.tsx': 'rollback after a failed insert — logged, and the insert failure is what the person is told',
      'app/(app)/admin/marketing/assets/actions.ts': 'the delete confirms by name, then restores deleted_at and fails the action; the upload rollback logs',
    };
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry)) files.push(full);
      }
    };
    for (const root of ['app', 'components', 'lib']) walk(root);

    const unaccounted: string[] = [];
    const seen = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      if (!/\.remove\(\s*\[/.test(source) && !/removeConfirmed\(/.test(source)) continue;
      if (!/storage/.test(source)) continue;
      // A file counts as removing from storage whether it calls `.remove([...])`
      // itself or delegates to the shared rule; the three storage helpers now do
      // the latter, and a staleness check that only looked for the former
      // reported all three as gone.
      if (/removeConfirmed\(/.test(source)) seen.add(file);
      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/\.remove\(\s*\[/.test(lines[i])) continue;
        seen.add(file);
        if (!(file in ACCOUNTED)) unaccounted.push(`${file}:${i + 1} — a storage remove with no recorded handling`);
      }
    }
    expect(unaccounted, unaccounted.join('\n')).toEqual([]);
    const stale = Object.keys(ACCOUNTED).filter((f) => !seen.has(f));
    expect(stale, `no longer remove from storage: ${stale.join(', ')}`).toEqual([]);
  });

  it('the shared rule has no second copy', () => {
    // SEC-014's lesson applied here: one rule, imported, not four.
    const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const file of ['lib/storage/documents.ts', 'lib/storage/feedback-attachments.ts', 'lib/storage/marketplace-photos.ts', 'lib/storage/family-media.ts']) {
      const code = strip(readFileSync(file, 'utf8'));
      expect(code, file).toContain('removeConfirmed(');
      expect(code, `${file} still has its own copy of the confirmation`).not.toMatch(/\.list\([^)]*search/);
    }
  });

  it('the deleted photo no longer reports success it cannot vouch for', () => {
    const photos = readFileSync('components/modules/photos-module.tsx', 'utf8');
    const removeAt = photos.indexOf('removeFamilyMedia(supabase, photo.storage_path)');
    const successAt = photos.indexOf("success(tr('photosModule.photoDeleted'))");
    expect(removeAt).toBeGreaterThan(-1);
    expect(successAt).toBeGreaterThan(removeAt);
    const between = photos.slice(removeAt, successAt);
    // Through the shared rule, not an inline copy of it.
    expect(between).toMatch(/removeFamilyMedia\(supabase, photo\.storage_path\)/);
    expect(between).toMatch(/if \(removal\.error\)/);
    expect(between).toContain('return;');
  });

  it('the two best-effort rollbacks say so rather than dropping the result', () => {
    const messages = readFileSync('components/modules/messages-module.tsx', 'utf8');
    expect(messages).toMatch(/const rollback = await supabase\.storage\.from\('family-media'\)\.remove/);
    expect(messages).toMatch(/attachment rollback not confirmed/);
    const assets = readFileSync('app/(app)/admin/marketing/assets/actions.ts', 'utf8');
    expect(assets).toMatch(/!removal\.data\?\.some\(\(object\) => object\.name === storageFile\)/);
    expect(assets).toContain('The asset file was not removed.');
  });

  it('the shared rule is what the documents wrapper runs', async () => {
    // Both entry points, one behaviour.
    const refusing = { remove: async () => ({ data: [], error: null }), list: async () => ({ data: [{ name: NAME }], error: null }) } as RemovableBucket;
    expect((await removeConfirmed(refusing, KEY)).error).toBeTruthy();
  });

  it('the policy this depends on really does find the row', () => {
    // If the storage guard stopped keying on documents.storage_path, the whole
    // premise above would change and this test would be reasoning about nothing.
    const migrations = readFileSync('supabase/migrations/0303_document_bytes_boundary.sql', 'utf8');
    expect(migrations).toContain('document_object_is_restricted');
    expect(migrations).toMatch(/storage_path\s*=\s*p_object_name/);
    expect(migrations).toMatch(/is_sensitive_document/);
  });
});
