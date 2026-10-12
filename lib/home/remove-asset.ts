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
// object. No read or write from here can close that gap: the database has to
// refuse the delete while a row is attached, and that is a change to 0007's
// foreign key (ON DELETE NO ACTION), which is the owner's to make — the exact
// statement is in the AUD-1022-L1 notes on #1022. Until it lands, what this
// can do is find those objects afterwards: an asset's files are only ever
// uploaded under `{family}/manuals/{asset}` and `{family}/warranties/{asset}`
// (the Home page's handleFile, through `assetDocumentFolder` below), and once
// the asset is gone no new row can name it. So after a confirmed asset delete
// both folders are listed, and every object no surviving row names is
//
//   1. GUARDED first: one vaulted row (`is_secure`, no asset, filed under
//      PENDING_REMOVAL_CATEGORY) per object, inserted and read back before any
//      removal is tried. While it exists 0303 restricts the object to the
//      family's managers again, so the unguarded stretch runs from the cascade
//      to this insert — the folder listings and one read — not the whole
//      sweep, and not past a removal storage refuses;
//   2. removed, confirmed gone;
//   3. and only then is its guarding row deleted, read back.
//
// A removal storage refuses leaves the object AND its guarding row: a vault
// file a parent sees in Files after any reload and deletes there (object
// first, confirmed), and a record the next sweep of these folders picks up and
// finishes. The caller is told the file was kept in the vault. If the guarding
// row cannot be written the removal is still tried, because removing the file
// is the point and the guard only covers its failing.
//
// An upload whose row insert fails because the asset is already gone (its FK
// no longer resolves) never had a row, and the Home page never inserts one
// into the vault (a file is vaulted later, from Files, by changing a row that
// exists), so no protection is lost with it: its object is as readable as its
// row would have made it. The uploader's compensating removal is what clears
// it, and a failed compensation is logged there (Audit C4-S4-09).
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

/**
 * The folder a guarding row is filed under. Stored data, like the Home page's
 * 'manual' and 'warranty': it is the folder name a parent sees in Files, and
 * what tells a later sweep that the row is a guard it may clear rather than a
 * document of the family's to leave alone.
 */
export const PENDING_REMOVAL_CATEGORY = 'pending removal';

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
  // keptInVault: the asset is gone, and a file of it that could not be removed
  // is kept under a guarding row in the Secure Vault (see the header).
  | { ok: false; error: string; keptInVault?: true }
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

/**
 * Which of these objects rows of this family name: `guarded` by a guarding row
 * an earlier sweep left (pending removal), `kept` by any other row (a document
 * of the family's, left alone).
 */
async function rowsNaming(
  db: AssetRemovalDb, familyId: string, paths: string[],
): Promise<{ kept: Set<string>; guarded: Set<string> } | { failed: AssetRemoval }> {
  const kept = new Set<string>();
  const guarded = new Set<string>();
  for (let i = 0; i < paths.length; i += PATH_CHUNK) {
    const { data, error } = await db.from('documents').select('storage_path, asset_id, category')
      .eq('family_id', familyId).in('storage_path', paths.slice(i, i + PATH_CHUNK));
    if (error) return { failed: { ok: false, error: describeDbError(error) } };
    for (const row of data ?? []) {
      if (!row.storage_path) continue;
      if (!row.asset_id && row.category === PENDING_REMOVAL_CATEGORY) guarded.add(row.storage_path);
      else kept.add(row.storage_path);
    }
  }
  return { kept, guarded };
}

/** A guarding row's title: the stored file name, without the upload's timestamp prefix. */
function fileTitle(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/^\d+-/, '') || name;
}

/**
 * Guard objects nothing names with one vaulted row each, read back. Answers
 * the paths now guarded; an empty answer means the guard could not be written,
 * and the sweep goes on to remove them unguarded rather than not at all.
 */
async function guardObjects(db: AssetRemovalDb, familyId: string, assetId: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const { data: guards, error } = await db.from('documents').insert(paths.map((path) => ({
    family_id: familyId, asset_id: null, storage_path: path, title: fileTitle(path),
    category: PENDING_REMOVAL_CATEGORY, is_secure: true,
  }))).select('storage_path');
  // One statement, so all of them or none: a short read-back is treated as none.
  if (error || !guards || guards.length !== paths.length) {
    console.error('[home/remove-asset] could not guard the files of a deleted asset', { familyId, assetId, code: error?.code ?? 'short read-back' });
    return [];
  }
  return paths;
}

/**
 * After the asset is gone: remove every object left in its folders that no
 * row of the family's names any more, guarding each one first (see the
 * header). Those are the files of rows the cascade took — attached after the
 * last read — and a file nothing names is readable by the whole family
 * (0303), whatever vault it was in.
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
    const named = await rowsNaming(db, familyId, found);
    if ('failed' in named) return named.failed;
    const pending = found.filter((path) => !named.kept.has(path));
    if (pending.length === 0) return null;

    const guarded = new Set([...named.guarded].filter((path) => !named.kept.has(path)));
    const newlyGuarded = await guardObjects(db, familyId, assetId, pending.filter((path) => !guarded.has(path)));
    for (const path of newlyGuarded) guarded.add(path);

    for (const path of pending) {
      const { error: storageError } = await removeConfirmed(bucket, path);
      if (storageError) {
        console.error('[home/remove-asset] an object of a deleted asset is still stored', { familyId, assetId, path, guarded: guarded.has(path) });
        return guarded.has(path) ? { ok: false, error: storageError, keptInVault: true } : { ok: false, error: storageError };
      }
      if (!guarded.has(path)) continue;
      // The object is confirmed gone, so the row guarding it goes too.
      const { data: cleared, error: clearError } = await db.from('documents').delete()
        .eq('family_id', familyId).eq('storage_path', path).is('asset_id', null)
        .eq('category', PENDING_REMOVAL_CATEGORY).select('id');
      if (clearError) return { ok: false, error: describeDbError(clearError) };
      if (wroteNoRows(cleared)) return { ok: false, notSaved: true };
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
