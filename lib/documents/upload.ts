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
import { isSensitiveCategory, needsSecureFlag } from './sensitivity';

export type UploadView = 'cloud' | 'vault' | 'shared';
export type UploadTranslator = (key: string, params?: Record<string, string | number>) => string;

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
 * When it is allowed, `isSecure` is the destination the person actually chose,
 * raised (never lowered) for a folder that is sensitive only in translation.
 * Never a quiet downgrade: a refusal they can read beats a success they cannot
 * verify.
 */
export function decideUpload(request: UploadRequest, t: UploadTranslator): UploadDecision {
  if (!request.manager && request.view === 'vault') {
    return {
      allowed: false,
      reason: t('filesHubModule.refuseVault'),
    };
  }
  if (!request.manager && isSensitiveCategory(request.category)) {
    return {
      allowed: false,
      reason: t('filesHubModule.refuseSensitive', { category: request.category.trim().toLowerCase() }),
    };
  }
  // A folder that is sensitive only in translation ("Financiën", "Santé") is
  // ordinary to the database's category rule, so the row carries the flag the
  // database does read; otherwise a child reads what a teen was refused.
  return { allowed: true, isSecure: request.view === 'vault' || needsSecureFlag(request.category) };
}

export type UploadEffects = {
  /** Allocate a stable path; this must not send bytes to storage. */
  prepare: (folder: string) => string;
  /** Confirm a matching protective documents row before any file bytes move. */
  record: (row: { storagePath: string; isSecure: boolean }) => Promise<{ error: string | null }>;
  /** Upload exactly the reserved path. Retries must use the same file and reservation. */
  store: (path: string) => Promise<{ error: string | null }>;
};

export type UploadOutcome =
  | { ok: false; reason: string }
  | { ok: true; storagePath: string; isSecure: boolean };

/**
 * Decide, reserve metadata, then store the bytes. Storage policy 0303 uses
 * the documents row to restrict a private object; an unmatched object is
 * readable by the family. Neither deleting bytes after an unanswered insert
 * nor retaining an unmatched private object is safe. Reserving first means a
 * lost row response sends no bytes, and a lost upload response retains its
 * protective row. An incomplete upload can leave metadata for a safe retry.
 *
 * `folderFallback` is the view's default folder, used when the person left the
 * category blank.
 */
export async function performUpload(
  request: UploadRequest & { folderFallback: string },
  effects: UploadEffects,
  t: UploadTranslator,
): Promise<UploadOutcome> {
  const decision = decideUpload(request, t);
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  const folder = request.category.trim() || request.folderFallback;
  let path: string;
  try {
    path = effects.prepare(folder);
  } catch {
    return { ok: false, reason: t('avatarPicker.uploadFailed') };
  }
  if (!path) return { ok: false, reason: t('avatarPicker.uploadFailed') };

  let recorded: Awaited<ReturnType<UploadEffects['record']>>;
  try {
    recorded = await effects.record({ storagePath: path, isSecure: decision.isSecure });
  } catch {
    return { ok: false, reason: t('quickCapture.saveUncertain') };
  }
  if (recorded.error) return { ok: false, reason: recorded.error };

  try {
    const stored = await effects.store(path);
    if (stored.error) return { ok: false, reason: stored.error };
  } catch {
    // Keep the protective row: a lost storage reply may hide committed bytes.
    return { ok: false, reason: t('quickCapture.saveUncertain') };
  }
  return { ok: true, storagePath: path, isSecure: decision.isSecure };
}
