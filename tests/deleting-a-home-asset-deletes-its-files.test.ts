// Deleting a home asset deletes the files it carried, or deletes nothing.
//
// THE DEFECT. The Home page's "delete asset" removed the `home_assets` row and
// nothing else. `documents.asset_id` is ON DELETE CASCADE (0007), so the
// asset's manual and warranty ROWS went with it, but their OBJECTS stayed in
// the `documents` bucket: referenced by nothing, shown nowhere, never
// deletable from the app, still taking the family's storage.
//
// Worse, it is the SEC-015 shape (tests/a-deleted-row-does-not-unlock-a-file).
// The storage policy hides a sensitive file from a child through
// `document_object_is_restricted(name)`, which works by FINDING THE ROW. A
// parent can move an appliance's warranty PDF into the Secure Vault from the
// Files hub; deleting the appliance then took the row, the guard found
// nothing, and every member could list and download the file.
//
// So the asset's files go first, each confirmed gone before its row, and the
// asset only after all of them. Any step that fails leaves the asset in place,
// so its files stay findable and a second press finishes the job.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASSET_DOCUMENT_KINDS, removeHomeAsset } from '@/lib/home/remove-asset';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { at, bodyOf } from './helpers/source-order';

const FAMILY = 'fam-1';

const MANUAL = `${FAMILY}/manuals/asset-fridge/1790000000000-manual.pdf`;
const WARRANTY = `${FAMILY}/warranties/asset-fridge/1790000000001-warranty.pdf`;
const OTHER_ASSET_FILE = `${FAMILY}/manuals/asset-boiler/1790000000002-boiler.pdf`;
const LOOSE_FILE = `${FAMILY}/cloud/1790000000003-recipes.pdf`;
const OTHER_FAMILY_FILE = 'fam-2/manuals/asset-fridge/1790000000004-theirs.pdf';

type Bucket = {
  objects: Set<string>;
  /** Paths whose removal storage silently refuses: `data: []`, object kept. */
  refuse: Set<string>;
};

/** A `documents` bucket answering the three shapes real storage answers with. */
function bucket(paths: string[]): Bucket {
  return { objects: new Set(paths), refuse: new Set() };
}

function storageFor(store: Bucket) {
  return {
    remove: async (paths: string[]) => {
      const removed: { name: string }[] = [];
      for (const path of paths) {
        if (store.refuse.has(path)) continue;
        if (store.objects.delete(path)) removed.push({ name: path });
      }
      return { data: removed, error: null };
    },
    list: async (folder: string, options?: { search?: string }) => {
      const prefix = folder ? `${folder}/` : '';
      const names = [...store.objects]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
        .map((path) => path.slice(prefix.length))
        .filter((name) => !options?.search || name.startsWith(options.search));
      return { data: names.map((name) => ({ name })), error: null };
    },
  };
}

/** A builder that answers every chained call with the same reply. */
function answering(reply: { data: unknown; error: unknown }): unknown {
  const chain: Record<string, unknown> = {};
  const self = new Proxy(chain, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (value: unknown) => unknown) => Promise.resolve({ count: null, ...reply }).then(resolve);
      return () => self;
    },
  });
  return self;
}

const CONNECTION_LOST = { data: null, error: { code: '08006', message: 'connection lost', details: null, hint: null } };
/** What RLS answers for a delete it filters: no error, no rows. */
const FILTERED = { data: [], error: null };

type Household = { db: InMemorySupabase; store: Bucket; failDocumentReads: boolean; refuseDocumentDeletes: boolean };

/** One family with a fridge (manual + vaulted warranty) and a boiler. */
function household(): Household {
  const db = createInMemorySupabase();
  // The schema's cascade, modelled: `documents.asset_id … ON DELETE CASCADE`.
  const replace = db.replace.bind(db);
  db.replace = (name: string, rows: Row[]) => {
    if (name === 'home_assets') {
      const kept = new Set(rows.map((row) => row.id));
      const gone = new Set(db.table('home_assets').filter((row) => !kept.has(row.id)).map((row) => row.id));
      replace('documents', db.table('documents').filter((doc) => !gone.has(doc.asset_id)));
    }
    replace(name, rows);
  };
  db.seed('home_assets', [
    { id: 'asset-fridge', family_id: FAMILY, name: 'Fridge' },
    { id: 'asset-boiler', family_id: FAMILY, name: 'Boiler' },
  ]);
  db.seed('documents', [
    { id: 'doc-manual', family_id: FAMILY, asset_id: 'asset-fridge', title: 'Manual', category: 'manual', is_secure: false, storage_path: MANUAL },
    // Moved into the Secure Vault from the Files hub.
    { id: 'doc-warranty', family_id: FAMILY, asset_id: 'asset-fridge', title: 'Warranty', category: 'warranty', is_secure: true, storage_path: WARRANTY },
    { id: 'doc-boiler', family_id: FAMILY, asset_id: 'asset-boiler', title: 'Boiler manual', category: 'manual', is_secure: false, storage_path: OTHER_ASSET_FILE },
    { id: 'doc-loose', family_id: FAMILY, asset_id: null, title: 'Recipes', category: null, is_secure: false, storage_path: LOOSE_FILE },
    // Another household's row naming the same asset id: its file is not ours to remove.
    { id: 'doc-theirs', family_id: 'fam-2', asset_id: 'asset-fridge', title: 'Theirs', category: 'manual', is_secure: false, storage_path: OTHER_FAMILY_FILE },
  ]);
  const store = bucket([MANUAL, WARRANTY, OTHER_ASSET_FILE, LOOSE_FILE, OTHER_FAMILY_FILE]);
  return { db, store, failDocumentReads: false, refuseDocumentDeletes: false };
}

function client(home: Household) {
  return {
    from: (table: string) => {
      if (table !== 'documents') return home.db.from(table);
      if (home.failDocumentReads) return answering(CONNECTION_LOST);
      if (home.refuseDocumentDeletes) return { select: (list: string) => home.db.from(table).select(list), delete: () => answering(FILTERED) };
      return home.db.from(table);
    },
    // Only the `documents` bucket holds these files; any other bucket is empty.
    storage: { from: (name: string) => storageFor(name === 'documents' ? home.store : bucket([])) },
  } as unknown as Parameters<typeof removeHomeAsset>[0];
}

const ids = (rows: Row[]) => rows.map((row) => row.id).sort();

describe('deleting a home asset deletes the files it carried', () => {
  it('removes every file of the asset from storage, then its rows, then the asset', async () => {
    const home = household();
    const result = await removeHomeAsset(client(home), FAMILY, 'asset-fridge');

    expect(result).toEqual({ ok: true });
    // The whole finding: before, both objects outlived their rows.
    expect(home.store.objects.has(MANUAL)).toBe(false);
    expect(home.store.objects.has(WARRANTY)).toBe(false);
    expect(ids(home.db.table('home_assets'))).toEqual(['asset-boiler']);
    expect(ids(home.db.table('documents').filter((doc) => doc.family_id === FAMILY))).toEqual(['doc-boiler', 'doc-loose']);
  });

  it('touches nothing that is not this family’s asset', async () => {
    const home = household();
    await removeHomeAsset(client(home), FAMILY, 'asset-fridge');

    expect([...home.store.objects].sort()).toEqual([LOOSE_FILE, OTHER_ASSET_FILE, OTHER_FAMILY_FILE].sort());
  });

  it('keeps the asset and the protecting row when storage refuses a file', async () => {
    const home = household();
    home.store.refuse.add(WARRANTY);

    const result = await removeHomeAsset(client(home), FAMILY, 'asset-fridge');

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error');
    // The vaulted file is still there, so its row must be too: the row is what hides it from a child.
    expect(home.store.objects.has(WARRANTY)).toBe(true);
    expect(home.db.table('documents').some((doc) => doc.id === 'doc-warranty')).toBe(true);
    expect(home.db.table('home_assets').some((asset) => asset.id === 'asset-fridge')).toBe(true);
  });

  it('finishes on a second press after a half-finished delete', async () => {
    const home = household();
    home.store.refuse.add(WARRANTY);
    await removeHomeAsset(client(home), FAMILY, 'asset-fridge');
    home.store.refuse.clear();

    const retry = await removeHomeAsset(client(home), FAMILY, 'asset-fridge');

    expect(retry).toEqual({ ok: true });
    expect(home.store.objects.has(WARRANTY)).toBe(false);
    expect(home.db.table('home_assets').some((asset) => asset.id === 'asset-fridge')).toBe(false);
  });

  it('deletes nothing when the asset’s files could not be read', async () => {
    const home = household();
    home.failDocumentReads = true;

    const result = await removeHomeAsset(client(home), FAMILY, 'asset-fridge');

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('error');
    expect(home.db.table('home_assets').some((asset) => asset.id === 'asset-fridge')).toBe(true);
    expect(home.store.objects.has(MANUAL)).toBe(true);
    expect(home.store.objects.has(WARRANTY)).toBe(true);
  });

  it('keeps the asset when a file’s row would not delete', async () => {
    const home = household();
    home.refuseDocumentDeletes = true;

    const result = await removeHomeAsset(client(home), FAMILY, 'asset-fridge');

    expect(result).toEqual({ ok: false, notSaved: true });
    expect(home.db.table('home_assets').some((asset) => asset.id === 'asset-fridge')).toBe(true);
  });

  it('reports an asset that was not deleted rather than claiming it', async () => {
    const home = household();
    const result = await removeHomeAsset(client(home), FAMILY, 'asset-somewhere-else');

    expect(result).toEqual({ ok: false, notSaved: true });
  });
});

describe('the Home page deletes an asset through it', () => {
  // Comments blanked: the subject is quoted in the source's own comments.
  const source = readFileSync('components/modules/home-module.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const removeAsset = bodyOf(source, 'async function removeAsset', 'void refreshAssets();');

  it('calls removeHomeAsset and never deletes the asset row by itself', () => {
    expect(removeAsset).toContain('await removeHomeAsset(');
    expect(removeAsset).not.toContain(".from('home_assets')");
  });

  it('says so when the delete did not happen', () => {
    expect(at(removeAsset, 'if (!removed.ok)')).toBeLessThan(at(removeAsset, "success(tr('homeModule.assetRemoved'))"));
  });
});

// AUD-1022-L1. The asset delete is its own statement, so the cascade takes
// every row linked at THAT moment: rows a capped read never returned, and rows
// committed after the last read. Each loses the row that hid its object from a
// child (0303 lets the family read an object no row names).
describe('files attached while the asset is being deleted', () => {
  const LATE = `${FAMILY}/warranties/asset-fridge/1790000000009-late-policy.pdf`;
  const lateRow = { id: 'doc-late', family_id: FAMILY, asset_id: 'asset-fridge', title: 'Late policy', category: 'warranty', is_secure: true, storage_path: LATE };

  /** The same client, with `commit` run as the asset DELETE is issued: after every read of the asset's files. */
  function committingBeforeAssetDelete(home: Household, commit: () => void) {
    const base = client(home) as unknown as { from: (table: string) => unknown; storage: unknown };
    return {
      ...base,
      from: (table: string) => {
        const query = base.from(table) as { delete: () => unknown };
        if (table !== 'home_assets') return query;
        const remove = query.delete.bind(query);
        query.delete = () => { commit(); return remove(); };
        return query;
      },
    } as unknown as Parameters<typeof removeHomeAsset>[0];
  }

  /** A vaulted file uploaded object-first, row-second, as the Home page does. */
  function attachLate(home: Household) {
    home.store.objects.add(LATE);
    home.db.table('documents').push({ ...lateRow });
  }

  it('removes the file of a row committed after the last read, which the cascade took', async () => {
    const home = household();
    let committed = false;
    const result = await removeHomeAsset(committingBeforeAssetDelete(home, () => { committed = true; attachLate(home); }), FAMILY, 'asset-fridge');

    expect(committed).toBe(true);
    expect(result).toEqual({ ok: true });
    expect(home.db.table('documents').some((doc) => doc.id === 'doc-late')).toBe(false);
    // The row went with the asset, so the object must not outlive it.
    expect(home.store.objects.has(LATE)).toBe(false);
    expect(home.db.table('home_assets').some((asset) => asset.id === 'asset-fridge')).toBe(false);
  });

  it('reports a sweep it could not finish, and a second press finishes it', async () => {
    const home = household();
    home.store.refuse.add(LATE);
    const first = await removeHomeAsset(committingBeforeAssetDelete(home, () => attachLate(home)), FAMILY, 'asset-fridge');

    expect(first.ok).toBe(false);
    expect(first).toHaveProperty('error');
    expect(home.store.objects.has(LATE)).toBe(true);

    home.store.refuse.clear();
    const retry = await removeHomeAsset(client(home), FAMILY, 'asset-fridge');

    // This press deleted no asset, and says so; the file is gone all the same.
    expect(retry).toEqual({ ok: false, notSaved: true });
    expect(home.store.objects.has(LATE)).toBe(false);
  });

  // Stored outside the asset's folders (linked some other way than the Home
  // page's upload), so only reading every row can find these files.
  it('reads every linked row when the server returns fewer than a page', async () => {
    const db = createInMemorySupabase({ maxRows: 2 });
    const replace = db.replace.bind(db);
    db.replace = (name: string, rows: Row[]) => {
      if (name === 'home_assets') {
        const kept = new Set(rows.map((row) => row.id));
        const gone = new Set(db.table('home_assets').filter((row) => !kept.has(row.id)).map((row) => row.id));
        replace('documents', db.table('documents').filter((doc) => !gone.has(doc.asset_id)));
      }
      replace(name, rows);
    };
    const paths = Array.from({ length: 5 }, (_, i) => `${FAMILY}/cloud/179000000001${i}-linked.pdf`);
    db.seed('home_assets', [{ id: 'asset-fridge', family_id: FAMILY, name: 'Fridge' }]);
    db.seed('documents', paths.map((path, i) => ({ id: `doc-page-${i}`, family_id: FAMILY, asset_id: 'asset-fridge', category: 'manual', is_secure: true, storage_path: path })));
    const home: Household = { db, store: bucket(paths), failDocumentReads: false, refuseDocumentDeletes: false };

    expect(await removeHomeAsset(client(home), FAMILY, 'asset-fridge')).toEqual({ ok: true });
    expect([...home.store.objects]).toEqual([]);
    expect(db.table('documents')).toEqual([]);
  });

  it('leaves an object in the asset folder that a surviving row still names', async () => {
    const home = household();
    const kept = `${FAMILY}/manuals/asset-fridge/1790000000020-kept.pdf`;
    home.store.objects.add(kept);
    home.db.table('documents').push({ id: 'doc-unlinked', family_id: FAMILY, asset_id: null, title: 'Kept', category: 'manual', is_secure: true, storage_path: kept });

    expect(await removeHomeAsset(client(home), FAMILY, 'asset-fridge')).toEqual({ ok: true });
    expect(home.store.objects.has(kept)).toBe(true);
    expect(home.db.table('documents').some((doc) => doc.id === 'doc-unlinked')).toBe(true);
  });

  it('leaves the folders of an asset whose delete did not happen', async () => {
    const home = household();
    // Uploaded, row not yet inserted: the asset still exists, so it may yet be.
    const inFlight = `${FAMILY}/warranties/asset-fridge/1790000000030-in-flight.pdf`;
    home.store.objects.add(inFlight);
    const base = client(home) as unknown as { from: (table: string) => unknown; storage: unknown };
    const filtered = {
      ...base,
      from: (table: string) => (table === 'home_assets'
        ? { delete: () => answering(FILTERED), select: (list: string) => home.db.from(table).select(list) }
        : base.from(table)),
    } as unknown as Parameters<typeof removeHomeAsset>[0];

    expect(await removeHomeAsset(filtered, FAMILY, 'asset-fridge')).toEqual({ ok: false, notSaved: true });
    expect(home.store.objects.has(inFlight)).toBe(true);
    expect(home.db.table('home_assets').some((asset) => asset.id === 'asset-fridge')).toBe(true);
  });
});

describe('the Home page uploads an asset’s files where the sweep looks', () => {
  const source = readFileSync('components/modules/home-module.tsx', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const handleFile = bodyOf(source, 'async function handleFile', 'const { error: insertError }');

  it('names the folder through assetDocumentFolder, one of the swept kinds', () => {
    expect(at(handleFile, 'uploadFamilyDocument(supabase, {'))
      .toBeLessThan(at(handleFile, "folder: assetDocumentFolder(manual ? 'manuals' : 'warranties', asset.id)"));
    expect([...ASSET_DOCUMENT_KINDS].sort()).toEqual(['manuals', 'warranties']);
  });
});
