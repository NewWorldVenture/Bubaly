// lib/auth/child-throttle-store.ts — the child_login_throttle read/write that
// lib/auth/child-throttle.ts deliberately leaves to the server.
import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { DEFAULT_POLICY, evaluateThrottle, registerFailure, type ThrottlePolicy, type ThrottleRow } from './child-throttle';

/**
 * How many times a reservation may lose its compare-and-set before the attempt
 * is refused. A real child is never racing themselves; contention on one
 * username is a burst of guesses, and refusing the losers is the point.
 */
const RESERVE_ATTEMPTS = 8;

export type AttemptReservation =
  | { ok: true }
  | { ok: false; reason: 'locked'; retryAfterSec: number }
  | { ok: false; reason: 'unavailable'; error: unknown };

/**
 * Take one of this username's attempts BEFORE its PIN is checked, counting it
 * as a failure until a sign-in succeeds and clears the row.
 *
 * Recording the failure after the check, as sign-in used to, is a
 * read-modify-write across the password request: every guess in a concurrent
 * burst read the same count, passed the same gate, and wrote back the same
 * "one more". Measured on the local stack: 25 concurrent wrong PINs all reached
 * the password check and left `fails = 1`, and the right PIN placed 21st in
 * such a burst signed in. The per-username lock is what makes a 4-digit PIN
 * survivable; the per-IP limit bounds one address, not one child.
 *
 * So the gate and the count are one step. The write is conditional on the row
 * that was read — the same compare-and-set the Resend counter uses — and a
 * writer that loses re-reads and takes the NEXT slot, which is how the sixth
 * guess of a burst meets the lock the fifth one set.
 */
export async function reserveChildLoginAttempt(
  admin: SupabaseClient<Database>,
  username: string,
  now: Date = new Date(),
  policy: ThrottlePolicy = DEFAULT_POLICY,
): Promise<AttemptReservation> {
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
    const { data: row, error: readError } = await admin.from('child_login_throttle')
      .select('fails, window_start, locked_until').eq('username', username).maybeSingle();
    if (readError) return { ok: false, reason: 'unavailable', error: readError };

    const current = row as ThrottleRow | null;
    const gate = evaluateThrottle(current, now);
    if (gate.locked) return { ok: false, reason: 'locked', retryAfterSec: gate.retryAfterSec };
    const next = registerFailure(current, now, policy);

    if (!current) {
      const { error: insertError } = await admin.from('child_login_throttle').insert({ username, ...next });
      if (!insertError) return { ok: true };
      // Another attempt created the row first; its slot is taken, so take the next.
      if (insertError.code === '23505') continue;
      return { ok: false, reason: 'unavailable', error: insertError };
    }

    const guarded = admin.from('child_login_throttle').update(next)
      .eq('username', username).eq('fails', current.fails).eq('window_start', current.window_start);
    const { data: claimed, error: claimError } = await (current.locked_until === null
      ? guarded.is('locked_until', null)
      : guarded.eq('locked_until', current.locked_until)).select('username').maybeSingle();
    if (claimError) return { ok: false, reason: 'unavailable', error: claimError };
    if (claimed) return { ok: true };
  }
  return { ok: false, reason: 'unavailable', error: new Error('child login throttle contention') };
}
