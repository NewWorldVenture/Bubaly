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
//
// A claim is let go only once nothing it covers can still change. A removal
// that was sent without an answer to rely on (it threw, or came back with an
// error) may yet land, so its paths' claims are KEPT, for good: letting go
// would let a submission record a path whose delete is still in flight. That
// disposition travels with the claims (ProofClaims.keep), so a caller that
// lets go of them later — submitProofAction's finally — keeps those too.
//
// These are COOPERATIVE application claims, not integrity the database
// enforces: every path in this app that records or removes proof goes through
// here and takes one, but a writer that does not (a script with the service
// role, a direct Storage call, a future feature written without this module)
// is not stopped by them.
//
// Bucket hardening note: claims are empty `text/plain` objects in the
// chore-proof bucket, which today sets only a file size limit (00430). A future
// allowed_mime_types on that bucket must admit text/plain, and any minimum size
// must admit an empty object, or every claim — and so every submission and
// release — is refused (tests/chore-proof-claims-survive-bucket-hardening.test.ts
// holds the migrations to that). No bucket or config change is made here.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { PROOF_BUCKET } from '@/lib/chores/proof-media';

type ProofClient = SupabaseClient<Database>;

/** Where the claim on a proof object is kept. A fourth path segment, so a claim is never itself a proof path (isProofPathFor). */
export function proofClaimPath(path: string): string {
  const cut = path.lastIndexOf('/');
  return `${path.slice(0, cut)}/claims/${path.slice(cut + 1)}`;
}

/** The claims one caller holds. */
export type ProofClaims = {
  readonly held: readonly string[];
  /** Paths whose removal was sent with no answer to rely on: their claims are never let go. */
  keep(paths: readonly string[]): void;
  /** Lets go of every claim held, except those kept. */
  letGo(): Promise<void>;
};

/** Takes the claim on each path; resolves to the claims this caller now holds. */
export async function claimProof(client: ProofClient, paths: readonly string[]): Promise<ProofClaims> {
  const held: string[] = [];
  for (const path of new Set(paths)) {
    // Any error is "not held": a claim that exists, a refusal, or a lost answer
    // to an upload that did store (then nobody holds it, and the path is kept).
    const { error } = await client.storage.from(PROOF_BUCKET)
      .upload(proofClaimPath(path), new Blob([]), { contentType: 'text/plain', upsert: false });
    if (!error) held.push(path);
  }
  const kept = new Set<string>();
  return {
    held,
    keep: (keep) => { for (const path of keep) kept.add(path); },
    letGo: () => unclaimProof(client, held.filter((path) => !kept.has(path))),
  };
}

/** Removes claim objects. One that cannot be removed keeps its path from ever being removed: logged, not raised. */
async function unclaimProof(client: ProofClient, paths: readonly string[]): Promise<void> {
  if (!paths.length) return;
  const { error } = await client.storage.from(PROOF_BUCKET).remove(paths.map(proofClaimPath));
  if (error) console.warn('[chore proof] could not let go of a claim; its object will be kept', error);
}

/**
 * Removes the paths no chore submission in the family references; returns the
 * ones removed. It claims each path first and touches only those it holds,
 * unless the caller passes the claims it already holds (`claims`), as
 * submitProofAction does while it works on the paths it was given; a removal
 * whose outcome is unknown is then marked on those claims for the caller.
 */
export async function releaseUnreferencedProof(
  client: ProofClient,
  familyId: string,
  paths: readonly string[],
  { claims }: { claims?: ProofClaims } = {},
): Promise<string[]> {
  const unique = [...new Set(paths)];
  if (!unique.length) return [];
  const own = claims ?? await claimProof(client, unique);
  const held = unique.filter((path) => own.held.includes(path));
  try {
    return await removeUnreferenced(client, familyId, held, own);
  } finally {
    if (!claims) await own.letGo();
  }
}

async function removeUnreferenced(client: ProofClient, familyId: string, held: string[], claims: ProofClaims): Promise<string[]> {
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
  let removeError: unknown = null;
  try {
    ({ error: removeError } = await client.storage.from(PROOF_BUCKET).remove(free));
  } catch (thrown) {
    removeError = thrown ?? true;
  }
  if (removeError) {
    // Sent, and no answer to rely on: the delete may still land. Keep these
    // claims, so no submission can record a path that may yet vanish.
    claims.keep(free);
    console.error('[chore proof] media cleanup failed or went unanswered; keeping its claims', removeError);
    return [];
  }
  return free;
}
