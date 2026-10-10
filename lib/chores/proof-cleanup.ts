// lib/chores/proof-cleanup.ts — releasing proof uploads without losing proof.
//
// Every cleanup of chore-proof objects, on the server and in the browser, goes
// through here. A path can name an object an EARLIER submission already holds
// (a forged or replayed path, a duplicate in one request, a retry after a
// partial failure), so "this attempt failed" is never enough to delete it.
// Only an object no submission references, checked at the moment of removal,
// is removed; when that cannot be checked, nothing is.
//
// The check and the removal are two requests, so on their own another request
// could reference the object between them: a submission validates P, a release
// reads no reference to P, the submission records P, the release removes P.
// So both sides first CLAIM the path, and only the holder of its claim may
// record it in a submission or remove it. A claim is an empty object beside the
// proof, at <family>/<member>/claims/<name>; Storage creates an object for one
// caller only (an upload that does not upsert), so a second claim on a path is
// refused while the first is held. A path whose claim cannot be taken — another
// request holds it, or one stopped without letting go — is left alone: a
// release keeps it, a submission refuses it. Kept is the safe side: an orphan
// costs storage, a removed object costs a child their proof.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { PROOF_BUCKET } from '@/lib/chores/proof-media';

type ProofClient = SupabaseClient<Database>;

/** Where the claim on a proof object is kept. A fourth path segment, so a claim is never itself a proof path (isProofPathFor). */
export function proofClaimPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return `${path.slice(0, cut)}/claims/${path.slice(cut + 1)}`;
}

/** Takes the claim on each path; resolves to the paths this caller now holds. */
export async function claimProof(client: ProofClient, paths: readonly string[]): Promise<string[]> {
  const held: string[] = [];
  for (const path of new Set(paths)) {
    // Any error is "not held": a claim that exists, a refusal, or a lost answer
    // to an upload that did store (then nobody holds it, and the path is kept).
    const { error } = await client.storage.from(PROOF_BUCKET)
      .upload(proofClaimPath(path), new Blob([]), { contentType: 'text/plain', upsert: false });
    if (!error) held.push(path);
  }
  return held;
}

/** Lets go of claims this caller holds. One that cannot be removed keeps its path from ever being removed: logged, not raised. */
export async function unclaimProof(client: ProofClient, held: readonly string[]): Promise<void> {
  if (!held.length) return;
  const { error } = await client.storage.from(PROOF_BUCKET).remove(held.map(proofClaimPath));
  if (error) console.warn('[chore proof] could not let go of a claim; its object will be kept', error);
}

/**
 * Removes the paths no chore submission in the family references; returns the
 * ones removed. It claims each path first and touches only those it holds,
 * unless the caller already holds every claim (`claimed`), as submitProofAction
 * does while it works on the paths it was given.
 */
export async function releaseUnreferencedProof(
  client: ProofClient,
  familyId: string,
  paths: readonly string[],
  { claimed = false }: { claimed?: boolean } = {},
): Promise<string[]> {
  const unique = [...new Set(paths)];
  if (!unique.length) return [];
  const held = claimed ? unique : await claimProof(client, unique);
  try {
    return await removeUnreferenced(client, familyId, held);
  } finally {
    if (!claimed) await unclaimProof(client, held);
  }
}

async function removeUnreferenced(client: ProofClient, familyId: string, held: string[]): Promise<string[]> {
  if (!held.length) return [];
  const { data, error } = await client.from('chore_submissions')
    .select('media_paths').eq('family_id', familyId).overlaps('media_paths', held);
  if (error) {
    // Unknown is not "unreferenced": keep the objects, an orphan is cheaper than lost proof.
    console.warn('[chore proof] could not check which uploads are referenced; keeping them', error);
    return [];
  }
  const referenced = new Set((data ?? []).flatMap((row) => (row.media_paths as string[] | null) ?? []));
  const free = held.filter((path) => !referenced.has(path));
  if (!free.length) return [];
  const { error: removeError } = await client.storage.from(PROOF_BUCKET).remove(free);
  if (removeError) {
    console.error('[chore proof] media cleanup failed', removeError);
    return [];
  }
  return free;
}
