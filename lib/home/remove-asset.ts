// Deleting a home asset, files and all.
//
// `documents.asset_id` is ON DELETE CASCADE (0007): deleting an appliance
// deletes the ROWS of its manuals and warranty PDFs, but the database cannot
// reach the bucket, so their OBJECTS used to stay behind. Nothing referenced
// them any more, so the family could neither see nor remove them, and the
// storage policy that hides a Secure Vault file from a child
// (`document_object_is_restricted`, SEC-015) works by finding the row: a
// warranty a parent had moved into the vault became readable by every member
// the moment its appliance was deleted.
//
// So the files go first, in the order every single-file delete already uses:
// the object, confirmed gone (`removeConfirmed`), then its row, read back. The
// asset row goes last. Any step that fails stops here with the asset still in
// place, so the remaining files stay listed under it and pressing delete again
// finishes the job (an object already gone confirms as gone).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { removeConfirmed, type RemovableBucket } from '@/lib/storage/confirm-removal';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';

const BUCKET = 'documents';

type AssetRemovalDb = Pick<SupabaseClient<Database>, 'from'> & {
  storage: { from: (bucket: string) => RemovableBucket };
};

export type AssetRemoval =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; notSaved: true };

export async function removeHomeAsset(db: AssetRemovalDb, familyId: string, assetId: string): Promise<AssetRemoval> {
  // Read before anything moves: once the asset is gone the cascade has taken
  // the rows, and with them the only record of which objects were its files.
  const { data: files, error: readError } = await db.from('documents').select('id, storage_path')
    .eq('family_id', familyId).eq('asset_id', assetId);
  if (readError) return { ok: false, error: describeDbError(readError) };

  for (const file of files ?? []) {
    if (file.storage_path) {
      const { error: storageError } = await removeConfirmed(db.storage.from(BUCKET), file.storage_path);
      if (storageError) return { ok: false, error: storageError };
    }
    const { data: gone, error: rowError } = await db.from('documents').delete()
      .eq('id', file.id).eq('family_id', familyId).select('id');
    if (rowError) return { ok: false, error: describeDbError(rowError) };
    if (wroteNoRows(gone)) return { ok: false, notSaved: true };
  }

  const { data: removed, error } = await db.from('home_assets').delete()
    .eq('id', assetId).eq('family_id', familyId).select('id');
  if (error) return { ok: false, error: describeDbError(error) };
  if (wroteNoRows(removed)) return { ok: false, notSaved: true };
  return { ok: true };
}
