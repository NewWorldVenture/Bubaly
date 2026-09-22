import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removeFamilyDocument } from '@/lib/storage/documents';
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

  it('the policy this depends on really does find the row', () => {
    // If the storage guard stopped keying on documents.storage_path, the whole
    // premise above would change and this test would be reasoning about nothing.
    const migrations = readFileSync('supabase/migrations/0303_document_bytes_boundary.sql', 'utf8');
    expect(migrations).toContain('document_object_is_restricted');
    expect(migrations).toMatch(/storage_path\s*=\s*p_object_name/);
    expect(migrations).toMatch(/is_sensitive_document/);
  });
});
