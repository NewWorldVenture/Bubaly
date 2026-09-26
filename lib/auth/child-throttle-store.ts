// lib/auth/child-throttle-store.ts — the PERSISTENCE half of the child sign-in
// brute-force throttle. `lib/auth/child-throttle.ts` decides policy and stays
// DB-free so it can be unit-tested; this module owns the read/write, and in
// particular owns making the failure count survive concurrency.
//
// Why a compare-and-set rather than a plain upsert: the count is read before
// the password attempt and written after it, so every caller in flight at the
// same moment computes its next value from the SAME observed row. A blind
// `upsert({ username, fails: observed + 1 })` therefore lets N simultaneous
// guesses cost ONE failure — the throttle counts rounds of parallel guessing,
// not guesses. Against a 4-digit PIN (10,000 combinations) and a budget of
// five, that is the difference between a bound and no bound at all.
//
// So the write carries the state it was computed from as a predicate. Zero rows
// updated means somebody else's attempt landed first — not an error — and we
// re-read and recompute against what they wrote.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { registerFailure, type ThrottleRow } from './child-throttle';

/** Contention rounds before giving up. Each round is one lost race. */
export const THROTTLE_WRITE_RETRIES = 4;

type DB = SupabaseClient<Database>;

async function readRow(db: DB, username: string): Promise<{ row: ThrottleRow | null; failed: boolean }> {
  const { data, error } = await db.from('child_login_throttle')
    .select('fails, window_start, locked_until').eq('username', username).maybeSingle();
  if (error) return { row: null, failed: true };
  return { row: (data as ThrottleRow | null) ?? null, failed: false };
}

/**
 * Count one failed attempt for `username`, starting from the row the caller
 * already observed. Returns false only when the failure could NOT be recorded —
 * the caller must then refuse the sign-in rather than let an uncounted attempt
 * through, which is what makes losing every race safe.
 */
export async function recordChildLoginFailure(
  db: DB,
  username: string,
  observed: ThrottleRow | null,
  now: Date = new Date(),
): Promise<boolean> {
  let current = observed;

  for (let attempt = 0; attempt <= THROTTLE_WRITE_RETRIES; attempt++) {
    const next = registerFailure(current, now);

    if (current) {
      // Both columns, not just `fails`: a window rollover can recompute the
      // same count from a different window, and the predicate has to tell
      // those apart.
      const { data, error } = await db.from('child_login_throttle')
        .update(next)
        .eq('username', username)
        .eq('fails', current.fails)
        .eq('window_start', current.window_start)
        .select('username');
      if (error) {
        console.error('[child-login] failed-attempt counter write failed', error);
        return false;
      }
      if (data && data.length > 0) return true;
    } else {
      const { error } = await db.from('child_login_throttle').insert({ username, ...next });
      if (!error) return true;
      // 23505: the first attempt for this username raced another first attempt.
      // Anything else is a real write failure.
      if (error.code !== '23505') {
        console.error('[child-login] failed-attempt counter write failed', error);
        return false;
      }
    }

    // Lost the race — re-read and count on top of whoever won.
    const reread = await readRow(db, username);
    if (reread.failed) {
      console.error('[child-login] failed-attempt counter re-read failed');
      return false;
    }
    current = reread.row;
  }

  console.error('[child-login] failed-attempt counter gave up after contention', { username });
  return false;
}
