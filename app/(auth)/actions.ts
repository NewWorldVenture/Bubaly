'use server';

import { cookies, headers } from 'next/headers';
import { getTranslations } from '@/lib/i18n/server';
import { getUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { DEFAULT_LANDING_PATH, landingPathForRole } from '@/lib/auth/landing';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { stitchVisitorIdentity } from '@/lib/marketing/identity';
import { isValidPin } from '@/lib/onboarding/pin';
import { normalizeUsername, isValidUsername, syntheticChildEmail } from '@/lib/onboarding/child-login';
import { deriveChildPassword } from '@/lib/onboarding/child-password';
import {
  evaluateThrottle, registerFailure, clearedState, retryAfterLabel, type ThrottleRow,
} from '@/lib/auth/child-throttle';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { createClient as createPasswordClient } from '@supabase/supabase-js';

/** Where a just-signed-in user should land: the admin console for super
 *  admins, the Grandparent Portal for a guest (M28 — the role extended-family
 *  invites use), otherwise the family Home dashboard (/home). Resolved
 *  server-side so the env/code super-admin allowlist (not just the DB) is
 *  honored, and so the role comes from the membership rather than the browser.
 *
 *  Never throws: a context read that fails must not block a sign-in, and /home
 *  is the answer for every role but one. */
export async function resolveLandingPathAction(): Promise<string> {
  if (await isSuperAdmin()) return '/admin';
  try {
    const ctx = await getUserContext();
    if (!ctx || 'needsFamily' in ctx) return DEFAULT_LANDING_PATH;
    return landingPathForRole(ctx.active.role);
  } catch (error) {
    console.error('[auth] landing role lookup failed', error);
    return DEFAULT_LANDING_PATH;
  }
}

const VID_COOKIE = 'bubaly_vid';
const VID_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * Stitch the just-authenticated user to their anonymous marketing spine: link
 * `mkt_visitors` → `crm_contacts` and carry consent forward (see
 * `stitchVisitorIdentity`). Fire-and-forget from the login/signup forms — fully
 * best-effort, so it can never block or fail a sign-in. On a shared-device
 * `fork`, rotate this browser's anonymous id so the new person starts clean.
 */
export async function stitchIdentityAction(): Promise<void> {
  try {
    const supabase = await createServer();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) return;

    const jar = await cookies();
    const anonymousId = jar.get(VID_COOKIE)?.value?.trim();
    if (!anonymousId) return;

    const admin = createServiceClient();
    const { decision } = await stitchVisitorIdentity(admin, { anonymousId, email: user.email, userId: user.id });

    if (decision === 'fork') {
      // A different person already owns this device's visitor spine — hand the
      // new user a fresh anonymous id so their history never merges with the last.
      const fresh = (globalThis.crypto?.randomUUID?.() ?? `v-${Date.now().toString(36)}`);
      jar.set(VID_COOKIE, fresh, { path: '/', maxAge: VID_MAX_AGE, sameSite: 'lax' });
    }
  } catch { /* best-effort — never block auth */ }
}

/**
 * Sign a child in with their username + 4-digit PIN (no email). Resolves the
 * username → the child's synthetic auth user via the service role, then signs in
 * with an isolated server client. The browser owns session adoption, so a late
 * action response cannot replace a newer account through Set-Cookie headers.
 * Deliberately vague on failure so it can't be used to enumerate usernames.
 */
export async function childSignInAction(input: { username: string; pin: string }): Promise<
  { ok: true; tokens: { access_token: string; refresh_token: string } } | { ok: false; error: string }
> {
  const t = await getTranslations();
  const sec = process.env.CHILD_LOGIN_SECRET || null;
  if (!sec) return { ok: false, error: t('actions.kidSignInIsnT') };

  const payload = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const username = normalizeUsername(typeof payload.username === 'string' ? payload.username : '');
  const pin = typeof payload.pin === 'string' ? payload.pin : '';
  const admin = createServiceClient();
  const limited = await enforceRequestRateLimit(admin, `child-login:${clientIp(await headers())}`, { limit: 30 });
  if (!limited.ok) return { ok: false, error: t('actions.tooManySignInAttempts') };

  if (!isValidUsername(username) || !isValidPin(pin)) {
    return { ok: false, error: t('actions.checkTheUsernameAndPin') };
  }

  // Brute-force guard: reject flooded attempts BEFORE touching the password, so a
  // 4-digit PIN on a guessable username can't be enumerated. Keyed by username
  // (durable + cross-instance via the child_login_throttle table). Note we check
  // the lock even for unknown usernames so the throttle isn't a lookup oracle.
  const now = new Date();
  const { data: tRow, error: throttleReadError } = await admin.from('child_login_throttle')
    .select('fails, window_start, locked_until').eq('username', username).maybeSingle();
  if (throttleReadError) {
    console.error('[child-login] throttle lookup failed', throttleReadError);
    return { ok: false, error: t('actions.kidSignInIsTemporarily') };
  }
  const gate = evaluateThrottle(tRow as ThrottleRow | null, now);
  if (gate.locked) {
    return { ok: false, error: `Too many tries. Try again in ${retryAfterLabel(gate.retryAfterSec)}.` };
  }

  const recordFailure = async () => {
    const next = registerFailure(tRow as ThrottleRow | null, now);
    const { error } = await admin.from('child_login_throttle').upsert(
      { username, ...next }, { onConflict: 'username' });
    if (error) console.error('[child-login] failed-attempt counter write failed', error);
    return !error;
  };

  const { data: rows, error: loginLookupError } = await admin.from('child_logins').select('username,user_id').ilike('username', username).limit(1);
  if (loginLookupError) {
    console.error('[child-login] login lookup failed', loginLookupError);
    return { ok: false, error: t('actions.kidSignInIsTemporarily') };
  }
  const row = rows?.[0];
  if (!row) {
    if (!(await recordFailure())) return { ok: false, error: t('actions.kidSignInIsTemporarily') };
    return { ok: false, error: t('actions.thatUsernameOrPinIsn') };
  }

  let passwordClient: ReturnType<typeof createPasswordClient> | null = null;
  try {
    const configuration = [process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY].map(value => {
      const trimmed = (value ?? '').trim();
      return /^(["']).*\1$/.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed;
    });
    passwordClient = createPasswordClient(configuration[0], configuration[1], {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true },
    });
    const { data, error } = await passwordClient.auth.signInWithPassword({
      email: syntheticChildEmail(row.username),
      password: deriveChildPassword(sec, row.username, pin),
    });
    if (error) {
      if (!(await recordFailure())) return { ok: false, error: t('actions.kidSignInIsTemporarily') };
      return { ok: false, error: t('actions.thatUsernameOrPinIsn') };
    }
    const session = data.session;
    if (!session || !data.user || data.user.id !== row.user_id || session.user?.id !== data.user.id
      || typeof session.access_token !== 'string' || !session.access_token.trim()
      || typeof session.refresh_token !== 'string' || !session.refresh_token.trim()) {
      return { ok: false, error: t('actions.kidSignInIsTemporarily') };
    }
    // Reject an internally inconsistent receipt; provider authentication, not
    // this decoded claim, established the credentials above.
    const tokenPayload = session.access_token.split('.')[1];
    if (!tokenPayload || tokenPayload.length > 64 * 1024
      || JSON.parse(Buffer.from(tokenPayload, 'base64url').toString('utf8'))?.sub !== row.user_id) {
      return { ok: false, error: t('actions.kidSignInIsTemporarily') };
    }

    // Success: wipe the throttle so a genuine kid never carries a stale lock.
    await admin.from('child_login_throttle').upsert(
      { username, ...clearedState(now) }, { onConflict: 'username' });
    return { ok: true, tokens: { access_token: session.access_token, refresh_token: session.refresh_token } };
  } catch {
    // Provider/configuration failures never expose the derived password or any
    // SDK diagnostic that may contain request details.
    return { ok: false, error: t('actions.kidSignInIsTemporarily') };
  } finally { await passwordClient?.auth.dispose(); }
}
