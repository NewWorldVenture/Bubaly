// lib/chores/proof-submit.ts — one attempt to submit chore proof, from the
// child's browser, without React in it (so its outcomes are testable and do not
// depend on the form still being on screen).
//
// The files go to Storage first, then the paths to submitProofAction. Whether
// this attempt's uploads are released depends on what is KNOWN:
//   - an upload failed, or the action answered with a refusal: nothing of this
//     attempt was recorded — or, where the action kept its submission despite
//     the refusal, the release skips what that submission references — so its
//     unreferenced uploads are released, including one whose upload response
//     was lost (its path is claimed before the upload starts);
//   - the action threw (a lost response, a dropped connection, a navigation):
//     the submission may have been recorded, so nothing is released.
import { proofObjectPath } from '@/lib/chores/proof-media';

export type ProofSubmitDeps = {
  /** Upload one file to `path`; resolves with an error, or throws, when it did not store. */
  upload: (path: string, file: File) => Promise<{ error: unknown }>;
  /** Release the paths no submission references (lib/chores/proof-cleanup). */
  release: (paths: string[]) => Promise<unknown>;
  submit: (form: FormData) => Promise<{ ok: boolean; error?: string }>;
  newId: () => string;
};

export type ProofSubmitInput = { assignmentId: string; familyId: string; memberId: string; note: string | null; files: File[] };

export type ProofSubmitOutcome =
  | { kind: 'sent' }
  | { kind: 'upload_failed' }
  | { kind: 'refused'; error?: string }
  /** The action's answer never arrived: the proof may or may not be recorded. */
  | { kind: 'unknown' };

export async function submitProofAttempt(input: ProofSubmitInput, deps: ProofSubmitDeps): Promise<ProofSubmitOutcome> {
  const form = new FormData();
  form.set('assignment_id', input.assignmentId);
  if (input.note !== null) form.set('note', input.note);

  const attempted: string[] = [];
  const release = () => deps.release(attempted).catch(() => undefined);
  for (const file of input.files) {
    const path = proofObjectPath(input.familyId, input.memberId, deps.newId(), file.name);
    attempted.push(path);
    let failed: unknown = null;
    try {
      ({ error: failed } = await deps.upload(path, file));
    } catch (thrown) {
      failed = thrown ?? true;
    }
    if (failed) {
      await release();
      return { kind: 'upload_failed' };
    }
    form.append('media_path', path);
  }

  let result: { ok: boolean; error?: string };
  try {
    result = await deps.submit(form);
  } catch {
    return { kind: 'unknown' };
  }
  if (result.ok) return { kind: 'sent' };
  await release();
  return { kind: 'refused', error: result.error };
}
