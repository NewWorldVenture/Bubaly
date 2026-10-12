import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removeHomeAsset } from '@/lib/home/remove-asset';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';

const FAMILY = 'synthetic-family';
const ASSET = 'synthetic-asset';
const pathOf = (id: string) => `${FAMILY}/warranties/${ASSET}/${id}.pdf`;
const doc = (id: string): Row => ({ id, family_id: FAMILY, asset_id: ASSET, storage_path: pathOf(id), is_secure: true, category: 'warranty' });
const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

function household(count: number, cap?: number) {
  const db = createInMemorySupabase(cap === undefined ? {} : { maxRows: cap });
  const originalRows = Array.from({ length: count }, (_, i) => doc(`document-${i}`));
  db.seed('home_assets', [{ id: ASSET, family_id: FAMILY }]);
  db.seed('documents', originalRows);
  const objects = new Set(originalRows.map((row) => String(row.storage_path)));
  const removedPaths: string[] = [];
  // Same 0007 referential action as the author's unchanged fixture: deleting
  // the asset removes ALL attached rows, not just those returned by a read.
  const replace = db.replace.bind(db);
  db.replace = (table: string, rows: Row[]) => {
    if (table === 'home_assets') {
      const kept = new Set(rows.map((row) => row.id));
      const gone = new Set(db.table(table).filter((row) => !kept.has(row.id)).map((row) => row.id));
      replace('documents', db.table('documents').filter((row) => !gone.has(row.asset_id)));
    }
    replace(table, rows);
  };
  let beforeRemove: (() => Promise<void>) | undefined;
  const client = {
    from: (table: string) => db.from(table),
    storage: { from: (bucket: string) => {
      expect(bucket).toBe('documents');
      return {
        remove: async (paths: string[]) => {
          if (beforeRemove) await beforeRemove();
          const removed = paths.filter((path) => objects.delete(path));
          removedPaths.push(...removed);
          return { data: removed.map((name) => ({ name })), error: null };
        },
        list: async (folder: string, options?: { search?: string }) => ({
          data: [...objects].filter((path) => path.startsWith(`${folder}/`))
            .map((path) => path.slice(folder.length + 1))
            .filter((name) => !name.includes('/') && (!options?.search || name.startsWith(options.search)))
            .map((name) => ({ name })),
          error: null,
        }),
      };
    } },
  } as unknown as Parameters<typeof removeHomeAsset>[0];
  // A finite interpretation of 0303 for these is_secure=true synthetic rows.
  // It is NOT an execution of PostgreSQL/RLS or an authorization probe.
  const restrictedForNonManager = (path: string) => db.table('documents')
    .some((row) => row.storage_path === path && row.is_secure === true);
  const orphans = () => [...objects].filter((path) => !restrictedForNonManager(path));
  return { db, objects, removedPaths, client, orphans, restrictedForNonManager,
    setBarrier: (barrier: () => Promise<void>) => { beforeRemove = barrier; } };
}

describe('home cleanup complete enumeration and concurrent attachment review', () => {
  it('control: a sensitive document attached before enumeration is removed with its asset', async () => {
    const home = household(1);
    home.objects.add(pathOf('early-upload'));
    const inserted = await home.db.from('documents').insert(doc('early-upload')).select('id');
    expect(inserted.error).toBeNull();
    expect(home.restrictedForNonManager(pathOf('early-upload'))).toBe(true);
    expect(await removeHomeAsset(home.client, FAMILY, ASSET)).toEqual({ ok: true });
    expect([...home.objects]).toEqual([]);
    expect(home.db.table('documents')).toEqual([]);
  });

  it('control: exactly the 1000-row response cap still removes all known sensitive objects', async () => {
    const home = household(1000, 1000);
    expect(await removeHomeAsset(home.client, FAMILY, ASSET)).toEqual({ ok: true });
    expect(home.removedPaths).toHaveLength(1000);
    expect(home.orphans()).toEqual([]);
    expect(home.db.table('home_assets')).toEqual([]);
  });

  it('does not report success while a document beyond a capped 1000-row read becomes an unprotected object', async () => {
    const home = household(1001, 1000);
    const omitted = pathOf('document-1000');
    expect(home.restrictedForNonManager(omitted)).toBe(true);
    const result = await removeHomeAsset(home.client, FAMILY, ASSET);
    const observation = { case: 'capped-page', result, removedObjects: home.removedPaths.length,
      objects: [...home.objects], documentRows: home.db.table('documents').length,
      assetRows: home.db.table('home_assets').length, restricted: home.restrictedForNonManager(omitted) };
    console.log('HOME_REVIEW ' + JSON.stringify(observation));
    expect(home.orphans(), 'every remaining sensitive object must retain its protecting row').toEqual([]);
  });

  it('does not orphan a sensitive upload completed after enumeration but before asset deletion', async () => {
    const home = household(1);
    const reached = defer();
    const release = defer();
    let first = true;
    home.setBarrier(async () => {
      if (!first) return;
      first = false;
      reached.resolve();
      await release.promise;
    });
    const deletion = removeHomeAsset(home.client, FAMILY, ASSET);
    await reached.promise;
    // The enumerating read has completed. The asset still exists, so another
    // authorized uploader can finish the object-first / row-second workflow.
    expect(home.db.table('home_assets').some((row) => row.id === ASSET)).toBe(true);
    const latePath = pathOf('late-upload');
    home.objects.add(latePath);
    const inserted = await home.db.from('documents').insert(doc('late-upload')).select('id');
    expect(inserted.error).toBeNull();
    expect(home.restrictedForNonManager(latePath)).toBe(true);
    release.resolve();
    const result = await deletion;
    console.log('HOME_REVIEW ' + JSON.stringify({ case: 'concurrent-upload', result,
      objects: [...home.objects], documentRows: home.db.table('documents').length,
      assetRows: home.db.table('home_assets').length, restricted: home.restrictedForNonManager(latePath) }));
    expect(home.orphans(), 'concurrent uploads must not lose their protecting row').toEqual([]);
  });

  it('control: an uncapped 1001-row read removes every object', async () => {
    const home = household(1001);
    expect(await removeHomeAsset(home.client, FAMILY, ASSET)).toEqual({ ok: true });
    expect(home.removedPaths).toHaveLength(1001);
    expect(home.orphans()).toEqual([]);
  });

  it('control: the source schema explicitly cascades document rows and permits unmatched family objects', () => {
    const foreignKey = readFileSync('supabase/migrations/0007_home_asset_warranties.sql', 'utf8');
    const policy = readFileSync('supabase/migrations/0303_document_bytes_boundary.sql', 'utf8');
    expect(foreignKey).toMatch(/asset_id uuid REFERENCES home_assets\(id\) ON DELETE CASCADE/);
    expect(policy).toMatch(/select exists \([\s\S]*from public\.documents d[\s\S]*d\.storage_path = p_object_name/);
    expect(policy).toContain('and not public.document_object_is_restricted(name)');
    expect(policy).toContain('An object with NO matching row stays readable by the family');
  });
});
