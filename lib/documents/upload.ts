// The one place a document upload decides what it is before anything moves.
//
// This was inline in `components/modules/files-hub-module.tsx`, and the order of
// its steps was the whole security property: the classification has to be
// settled BEFORE the bytes reach the bucket, or a refusal arrives after the
// file is already stored. It used to compute `is_secure: view === 'vault' &&
// manager`, so a non-manager uploading to the Secure Vault got their file
// filed as Shared — visible to the whole family — under a success toast.
//
// Inline, that ordering could only be asserted by reading the source. Here the
// effects are injected, so a test can hold real spies and prove the refusal
// path performs neither of them. The component keeps its own toasts and its
// own error wording; this owns the decision and the sequence.
//
// The database is still the boundary (0266). This is so a person gets a
// sentence instead of a policy error, and so the bucket does not collect
// orphans from writes the policy was always going to reject.
import { isSensitiveCategory } from './sensitivity';

export type UploadView = 'cloud' | 'vault' | 'shared';

export type UploadRequest = {
  view: UploadView;
  /** What the person typed in the category box. May be blank. */
  category: string;
  /** Whether the acting member is a parent or another adult. */
  manager: boolean;
};

/** Refused, with the sentence to show; or allowed, with the destination honoured as asked. */
export type UploadDecision =
  | { allowed: false; reason: string }
  | { allowed: true; isSecure: boolean };

/**
 * Decide before anything moves.
 *
 * A non-manager is refused the Secure Vault outright, and refused a sensitive
 * category wherever they file it — re-labelling a medical record as "other" is
 * the obvious way around a flag-only rule, which is why `0266`'s SQL predicate
 * checks the category too.
 *
 * When it is allowed, `isSecure` is the destination the person actually chose.
 * Never a quiet downgrade: a refusal they can read beats a success they cannot
 * verify.
 */
export function decideUpload(request: UploadRequest): UploadDecision {
  if (!request.manager && request.view === 'vault') {
    return {
      allowed: false,
      reason: 'Only a parent or another adult can add a file to the Secure Vault. Ask one of them, or upload it to Shared Files instead.',
    };
  }
  if (!request.manager && isSensitiveCategory(request.category)) {
    return {
      allowed: false,
      reason: `Only a parent or another adult can file a ${request.category.trim().toLowerCase()} document. Ask one of them to add it.`,
    };
  }
  return { allowed: true, isSecure: request.view === 'vault' };
}

export type UploadEffects = {
  /** Put the bytes in the bucket. Returns the stored path, or why not. */
  store: (folder: string) => Promise<{ path: string | null; error: string | null }>;
  /** Write the row. Returns a message to show, or null on success. */
  record: (row: { storagePath: string; isSecure: boolean }) => Promise<{ error: string | null }>;
  /** Delete a stored object whose row did not land, so the bucket keeps no orphan. */
  discard: (path: string) => Promise<void>;
};

export type UploadOutcome =
  | { ok: false; reason: string }
  | { ok: true; storagePath: string; isSecure: boolean };

/**
 * Decide, then store, then record — and unwind the store if the record fails.
 *
 * `folderFallback` is the view's default folder, used when the person left the
 * category blank.
 */
export async function performUpload(
  request: UploadRequest & { folderFallback: string },
  effects: UploadEffects,
): Promise<UploadOutcome> {
  const decision = decideUpload(request);
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  const folder = request.category.trim() || request.folderFallback;
  const { path, error: storeError } = await effects.store(folder);
  if (storeError || !path) return { ok: false, reason: storeError ?? 'Upload failed' };

  const { error: recordError } = await effects.record({ storagePath: path, isSecure: decision.isSecure });
  if (recordError) {
    // The row is what makes the file findable; a stored object with no row is
    // invisible to the app and still occupies the family's storage. 0266 can
    // reject this insert for a reason the client did not anticipate, so the
    // unwind is not dead code.
    await effects.discard(path);
    return { ok: false, reason: recordError };
  }
  return { ok: true, storagePath: path, isSecure: decision.isSecure };
}
