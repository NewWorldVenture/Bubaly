// Deleting a home asset, files and all.
//
// `documents.asset_id` is ON DELETE CASCADE (0007): deleting an appliance
// deletes the ROWS of its manuals and warranty PDFs, but the database cannot
// reach the bucket, so their OBJECTS used to stay behind. Nothing referenced
// them any more, so the family could neither see nor remove them, and the
// storage policy that hides a Secure Vault file from a child
// (`document_object_is_restricted`, SEC-015, 0303) works by finding the row: a
// warranty a parent had moved into the vault became readable by every member
// the moment its appliance was deleted.
//
// So the files go first, in the order every single-file delete already uses:
// the object, confirmed gone (`removeConfirmed`), then its row, read back. Any
// step that fails stops here with the asset still in place, so the remaining
// files stay listed under it and pressing delete again finishes the job (an
// object already gone confirms as gone).
//
// EVERY linked row, not the first page of them. PostgREST caps one response
// (`db-max-rows`, 1,000 on a default project) without saying so, and the
// cascade takes the rows a capped read never returned. The rows are read a
// page at a time until a read comes back empty; each page is deleted before
// the next is read, so the next read starts where this one left off and a
// file attached while the removal runs is read too.
//
// AND the rows that land after the last read. The asset delete is a separate
// statement, so a document committed between the last empty read and that
// delete still goes with the cascade, and with it the row that protected its
// object. No read from here can close that gap (the database would have to
// refuse the delete; see the AUD-1022-L1 note on #1022). What this can do is
// find those objects afterwards: an asset's files are only ever uploaded under
// `{family}/manuals/{asset}` and `{family}/warranties/{asset}` (the Home
// page's handleFile, through `assetDocumentFolder` below), and once the asset
// is gone no new row can name it. So after a confirmed asset delete both
// folders are listed and every object no surviving row names is removed,
// each confirmed gone. A sweep that fails is reported, and a second press —
// which finds the asset already gone — sweeps again.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { removeConfirmed, type RemovableBucket } from '@/lib/storage/confirm-removal';
import { describeActionError, describeDbError, wroteNoRows } from '@/lib/supabase/errors';

const BUCKET = 'documents';

/** Rows read per page. Below PostgREST's default cap; a lower cap only means more pages. */
const ROW_PAGE = 500;
/** Pages read before giving up with the asset kept: progress is one deleted row or more per page. */
const MAX_ROW_PAGES = 200;
/** Objects listed per storage page, and pages listed per folder before giving up. */
const LIST_PAGE = 100;
const MAX_LIST_PAGES = 50;
/** Paths per "does a row still name this object" read. */
const PATH_CHUNK = 50;
/** List-and-remove rounds, so an object a concurrent removal shifted past a page is still found. */
const MAX_SWEEP_ROUNDS = 5;

/** The two folders an asset's files are uploaded to, under the family's own folder. */
export const ASSET_DOCUMENT_KINDS = ['manuals', 'warranties'] as const;
export type AssetDocumentKind = (typeof ASSET_DOCUMENT_KINDS)[number];

/** Where the Home page uploads one of an asset's files (relative to the family folder). */
export function assetDocumentFolder(kind: AssetDocumentKind, assetId: string): string {
  return `${kind}/${assetId}`;
}

type ListedObject = { name: string; id?: string | null };
type AssetBucket = {
  remove: RemovableBucket['remove'];
  list: (
    folder: string,
    options?: { search?: string; limit?: number; offset?: number },
  ) => Promise<{ data: ListedObject[] | null; error: { message: string } | null }>;
};

type AssetRemovalDb = Pick<SupabaseClient<Database>, 'from'> & {
  storage: { from: (bucket: string) => AssetBucket };
};

export type AssetRemoval =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; notSaved: true };

type Step = AssetRemoval | null;

/** Every object directly in one folder, or why the listing is not complete. */
async function listFolder(bucket: AssetBucket, folder: string): Promise<{ paths: string[] } | { failed: AssetRemoval }> {
  const seen = new Set<string>();
  const files = new Set<string>();
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const { data, error } = await bucket.list(folder, { limit: LIST_PAGE, offset: page * LIST_PAGE });
    if (error) return { failed: { ok: false, error: describeActionError(error) } };
    // Only a well-formed listing can say what is there (as in removeConfirmed).
    if (!Array.isArray(data) || data.some((entry) => !entry || typeof entry.name !== 'string' || entry.name.length === 0)) {
      return { failed: { ok: false, notSaved: true } };
    }
    const before = seen.size;
    for (const entry of data) {
      seen.add(entry.name);
      // A folder placeholder lists with a null id; it is not a file.
      if (entry.id !== null && !entry.name.includes('/')) files.add(entry.name);
    }
    // A short page is the end; a page with nothing new is a store ignoring the offset.
    if (data.length < LIST_PAGE || seen.size === before) return { paths: [...files].map((name) => `${folder}/${name}`) };
  }
  return { failed: { ok: false, notSaved: true } };
}

/** The paths no row of this family still names: those objects lost their row with the asset. */
async function unreferenced(db: AssetRemovalDb, familyId: string, paths: string[]): Promise<{ paths: string[] } | { failed: AssetRemoval }> {
  const named = new Set<string>();
  for (let i = 0; i < paths.length; i += PATH_CHUNK) {
    const { data, error } = await db.from('documents').select('storage_path')
      .eq('family_id', familyId).in('storage_path', paths.slice(i, i + PATH_CHUNK));
    if (error) return { failed: { ok: false, error: describeDbError(error) } };
    for (const row of data ?? []) if (row.storage_path) named.add(row.storage_path);
  }
  return { paths: paths.filter((path) => !named.has(path)) };
}

/**
 * After the asset is gone: remove every object left in its folders that no
 * row names any more. Those are the files of rows the cascade took — attached
 * after the last read — and a file nothing names is readable by the whole
 * family (0303), whatever vault it was in.
 */
async function sweepAssetFolders(db: AssetRemovalDb, familyId: string, assetId: string): Promise<Step> {
  const bucket = db.storage.from(BUCKET);
  for (let round = 0; round < MAX_SWEEP_ROUNDS; round++) {
    const found: string[] = [];
    for (const kind of ASSET_DOCUMENT_KINDS) {
      const listed = await listFolder(bucket, `${familyId}/${assetDocumentFolder(kind, assetId)}`);
      if ('failed' in listed) return listed.failed;
      found.push(...listed.paths);
    }
    if (found.length === 0) return null;
    const orphaned = await unreferenced(db, familyId, found);
    if ('failed' in orphaned) return orphaned.failed;
    if (orphaned.paths.length === 0) return null;
    for (const path of orphaned.paths) {
      const { error: storageError } = await removeConfirmed(bucket, path);
      if (storageError) {
        console.error('[home/remove-asset] an object of a deleted asset is still stored', { familyId, assetId, path });
        return { ok: false, error: storageError };
      }
    }
  }
  return { ok: false, notSaved: true };
}

/** Remove every document row linked to the asset (object first, confirmed), page by page. */
async function removeLinkedDocuments(db: AssetRemovalDb, familyId: string, assetId: string): Promise<Step> {
  const bucket = db.storage.from(BUCKET);
  for (let page = 0; page < MAX_ROW_PAGES; page++) {
    const { data: files, error: readError } = await db.from('documents').select('id, storage_path')
      .eq('family_id', familyId).eq('asset_id', assetId).order('id').limit(ROW_PAGE);
    if (readError) return { ok: false, error: describeDbError(readError) };
    if (!files || files.length === 0) return null;

    for (const file of files) {
      if (file.storage_path) {
        const { error: storageError } = await removeConfirmed(bucket, file.storage_path);
        if (storageError) return { ok: false, error: storageError };
      }
      const { data: gone, error: rowError } = await db.from('documents').delete()
        .eq('id', file.id).eq('family_id', familyId).select('id');
      if (rowError) return { ok: false, error: describeDbError(rowError) };
      if (wroteNoRows(gone)) return { ok: false, notSaved: true };
    }
  }
  // Rows kept arriving faster than they could be removed: keep the asset.
  return { ok: false, notSaved: true };
}

export async function removeHomeAsset(db: AssetRemovalDb, familyId: string, assetId: string): Promise<AssetRemoval> {
  // Read before anything moves: once the asset is gone the cascade has taken
  // the rows, and with them the only record of which objects were its files.
  const documentsLeft = await removeLinkedDocuments(db, familyId, assetId);
  if (documentsLeft) return documentsLeft;

  const { data: removed, error } = await db.from('home_assets').delete()
    .eq('id', assetId).eq('family_id', familyId).select('id');
  if (error) return { ok: false, error: describeDbError(error) };
  if (wroteNoRows(removed)) {
    // Nothing deleted. If the asset is still there (RLS filtered the delete),
    // its folders hold live uploads and are left alone. If it is already gone —
    // a second press after a sweep that failed — its files are swept now.
    const { data: still, error: stillError } = await db.from('home_assets').select('id')
      .eq('id', assetId).eq('family_id', familyId).maybeSingle();
    if (stillError) return { ok: false, error: describeDbError(stillError) };
    if (!still) {
      const swept = await sweepAssetFolders(db, familyId, assetId);
      if (swept) return swept;
    }
    return { ok: false, notSaved: true };
  }

  const swept = await sweepAssetFolders(db, familyId, assetId);
  return swept ?? { ok: true };
}
