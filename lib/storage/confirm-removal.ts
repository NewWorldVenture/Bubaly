// lib/storage/confirm-removal.ts — the ONE place that decides whether a storage
// object is actually gone.
//
// SEC-015. Supabase Storage reports a delete the policy refused exactly as it
// reports a delete of something that was never there. Measured against the
// local stack:
//
//   removed       -> error null, data ['<key>']
//   refused       -> error null, data []
//   never existed -> error null, data []
//
// So `error === null` is not evidence, and every caller that then deleted a row
// or reported success was doing so on no information. In the `documents` bucket
// that unlocked the Secure Vault, because the policy hides a file by finding its
// row; in the public `family-media` bucket it leaves a "deleted" photo
// retrievable by its URL for ever.
//
// An empty result is checked rather than trusted. If the object is still listed
// this reports a failure, so the caller can keep its row and say so. If it is
// genuinely absent — a retry after a half-finished delete — the caller may
// proceed, so a partial failure never strands a row.
//
// One caveat, stated because it is load-bearing: the listing uses the same
// client whose permissions may have hidden the object, so "not listed" is not
// proof of absence for an actor who could never see it. That actor is also the
// one who cannot delete the row (measured: a child's delete of a secure
// `documents` row returns zero rows), so the gap cannot produce the leak.

type StorageObject = { name: string };

/** The slice of the Storage bucket API this needs; keeps storage-js types out. */
export type RemovableBucket = {
  remove: (paths: string[]) => Promise<{ data: StorageObject[] | null; error: { message: string } | null }>;
  list: (
    folder: string,
    options?: { search?: string; limit?: number },
  ) => Promise<{ data: StorageObject[] | null; error: { message: string } | null }>;
};

/** Remove one object and answer with an error unless it is confirmed gone. */
export async function removeConfirmed(bucket: RemovableBucket, path: string): Promise<{ error: string | null }> {
  const { data, error } = await bucket.remove([path]);
  if (error) return { error: error.message };
  if (data?.some((object) => object.name === path)) return { error: null };

  const cut = path.lastIndexOf('/');
  const folder = cut > 0 ? path.slice(0, cut) : '';
  const name = path.slice(cut + 1);
  const listed = await bucket.list(folder, { search: name, limit: 100 });
  if (listed.error) return { error: listed.error.message };
  // `search` is a prefix match, so the name is compared exactly: a neighbouring
  // `<name>.bak` must not be mistaken for this object.
  return listed.data?.some((object) => object.name === name)
    ? { error: 'The file could not be removed.' }
    : { error: null };
}
