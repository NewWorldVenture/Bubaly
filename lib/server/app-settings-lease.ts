// A short, time-bounded lease kept in `app_settings`, for work that must not run
// twice at once and has no row of its own to claim.
//
// Two schedulers drive the crons (vercel.json and scripts/cron-dispatch.mjs), a
// member can press a button that does a cron's work on demand, and several of
// those paths dedupe by READING what exists and then INSERTING what does not —
// with no unique key on the table to refuse the second writer. Two callers in
// the same read→insert window both insert. The unique key is the owner's
// migration; until it lands, the writer that holds this lease is the only one
// that generates, and the lease stays correct after it.
//
// The claim is a compare-and-set on one row: an INSERT when the key is new (the
// primary key refuses the second inserter, 23505), else an UPDATE fenced on the
// `updated_at` that was read, so two callers that both find the lease expired
// cannot both take it. A lease is held for `ttlMs` from its claim; a holder that
// finishes releases it (fenced on its own token), and an expiry is what frees a
// lease whose holder died. `app_settings` is service-role only and already
// carries one row per family for the push cursor, so per-family keys are the
// existing pattern. Every write asks for the row it changed (Audit C1-S9-61).
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;

export type LeaseClaim =
  | { claimed: true; token: string }
  /**
   * `held`: another caller holds it within its ttl, and `holder` is the kind
   * that caller recorded (`claimLease`'s `holder`): null when it recorded
   * none, absent when this caller lost a race and did not read it. `error`:
   * the lease could not be read or written, so nothing may be assumed.
   */
  | { claimed: false; reason: 'held' | 'error'; holder?: string | null };

/** A stamp every real claim is newer than: what a released lease is dated. */
const RELEASED_AT = '1970-01-01T00:00:00.000Z';

/**
 * What a claim stores: its token, and the KIND of holder when the caller names
 * one, so a caller that finds the lease held can tell whose it is. A key whose
 * claimers name no holder stores `{ token }` exactly as before.
 */
function leaseValue(token: string, holder?: string): { token: string; holder?: string } {
  return holder === undefined ? { token } : { token, holder };
}

function recordedHolder(value: unknown): string | null {
  const holder = value && typeof value === 'object' && !Array.isArray(value) ? (value as { holder?: unknown }).holder : null;
  return typeof holder === 'string' ? holder : null;
}

export async function claimLease(db: DB, key: string, opts: { ttlMs: number; now?: Date; holder?: string }): Promise<LeaseClaim> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const token = randomUUID();
  const value = leaseValue(token, opts.holder);

  const { data: stored, error: readError } = await db.from('app_settings')
    .select('value, updated_at').eq('key', key).maybeSingle();
  if (readError) {
    console.error('[lease] read failed', { key, error: readError });
    return { claimed: false, reason: 'error' };
  }

  if (!stored) {
    // First claim for this key: the primary key is the fence.
    const { data: inserted, error: insertError } = await db.from('app_settings')
      .insert({ key, value, updated_at: nowIso })
      .select('key').maybeSingle();
    if (insertError) {
      if (insertError.code === '23505') return { claimed: false, reason: 'held' };
      console.error('[lease] insert failed', { key, error: insertError });
      return { claimed: false, reason: 'error' };
    }
    if (inserted?.key !== key) {
      console.error('[lease] insert confirmed no row', { key });
      return { claimed: false, reason: 'error' };
    }
    return { claimed: true, token };
  }

  const heldSince = Date.parse(String(stored.updated_at ?? ''));
  if (Number.isFinite(heldSince) && now.getTime() - heldSince < opts.ttlMs) {
    return { claimed: false, reason: 'held', holder: recordedHolder(stored.value) };
  }

  // Expired, released or undatable: take it over, fenced on the stamp just read
  // so a second caller that read the same stamp loses here.
  const { data: taken, error: takeError } = await db.from('app_settings')
    .update({ value, updated_at: nowIso })
    .eq('key', key).eq('updated_at', String(stored.updated_at))
    .select('key').maybeSingle();
  if (takeError) {
    console.error('[lease] takeover failed', { key, error: takeError });
    return { claimed: false, reason: 'error' };
  }
  if (taken?.key !== key) return { claimed: false, reason: 'held' };
  return { claimed: true, token };
}

/**
 * Give the lease back once the work it covered is done, so the next caller
 * need not wait out the ttl. Fenced on the holder's token: a lease that expired
 * and was taken over in the meantime is the new holder's, and stays so. A
 * release that fails is logged and otherwise harmless — the ttl frees it.
 * `holder` is the one the claim named, so the fence matches what it stored.
 */
export async function releaseLease(db: DB, key: string, token: string, holder?: string): Promise<void> {
  const { data: released, error } = await db.from('app_settings')
    .update({ updated_at: RELEASED_AT })
    .eq('key', key).eq('value', JSON.stringify(leaseValue(token, holder)))
    .select('key').maybeSingle();
  if (error) console.error('[lease] release failed', { key, error });
  else if (released?.key !== key) console.error('[lease] release found the lease already taken over', { key });
}
