'use server';

import { isSuperAdmin } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { isValidPin } from '@/lib/onboarding/pin';
import { normalizeUsername, isValidUsername, syntheticChildEmail } from '@/lib/onboarding/child-login';
import { deriveChildPassword } from '@/lib/onboarding/child-password';
import {
  evaluateThrottle, registerFailure, clearedState, retryAfterLabel, type ThrottleRow,
} from '@/lib/auth/child-throttle';

/** Where a just-signed-in user should land: the admin console for super
 *  admins, otherwise the family Home dashboard (/home). Resolved server-side so
 *  the env/code super-admin allowlist (not just the DB) is honored. */
export async function resolveLandingPathAction(): Promise<string> {
  return (await isSuperAdmin()) ? '/admin' : '/home';
}

/**
 * Sign a child in with their username + 4-digit PIN (no email). Resolves the
 * username → the child's synthetic auth user via the service role, then signs in
 * through the cookie-bound server client (so the session is set), returning ok.
 * Deliberately vague on failure so it can't be used to enumerate usernames.
 */
export async function childSignInAction(input: { username: string; pin: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const sec = process.env.CHILD_LOGIN_SECRET || null;
  if (!sec) return { ok: false, error: 'Kid sign-in isn’t available right now.' };

  const username = normalizeUsername(input.username);
  if (!isValidUsername(username) || !isValidPin(input.pin)) {
    return { ok: false, error: 'Check the username and PIN and try again.' };
  }

  const admin = createServiceClient();

  // Brute-force guard: reject flooded attempts BEFORE touching the password, so a
  // 4-digit PIN on a guessable username can't be enumerated. Keyed by username
  // (durable + cross-instance via the child_login_throttle table). Note we check
  // the lock even for unknown usernames so the throttle isn't a lookup oracle.
  const now = new Date();
  const { data: tRow } = await admin.from('child_login_throttle')
    .select('fails, window_start, locked_until').eq('username', username).maybeSingle();
  const gate = evaluateThrottle(tRow as ThrottleRow | null, now);
  if (gate.locked) {
    return { ok: false, error: `Too many tries. Try again in ${retryAfterLabel(gate.retryAfterSec)}.` };
  }

  const recordFailure = async () => {
    const next = registerFailure(tRow as ThrottleRow | null, now);
    await admin.from('child_login_throttle').upsert(
      { username, ...next }, { onConflict: 'username' });
  };

  const { data: rows } = await admin.from('child_logins').select('username').ilike('username', username).limit(1);
  const row = rows?.[0];
  if (!row) { await recordFailure(); return { ok: false, error: 'That username or PIN isn’t right.' }; }

  const supabase = await createServer(); // cookie-bound → sets the session on success
  const { error } = await supabase.auth.signInWithPassword({
    email: syntheticChildEmail(row.username),
    password: deriveChildPassword(sec, row.username, input.pin),
  });
  if (error) { await recordFailure(); return { ok: false, error: 'That username or PIN isn’t right.' }; }

  // Success: wipe the throttle so a genuine kid never carries a stale lock.
  await admin.from('child_login_throttle').upsert(
    { username, ...clearedState(now) }, { onConflict: 'username' });
  return { ok: true };
}
