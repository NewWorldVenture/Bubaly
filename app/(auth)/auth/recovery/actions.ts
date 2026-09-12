'use server';

import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { createServer } from '@/lib/supabase/server';
import { RECOVERY_HANDOFF_COOKIE, RecoveryError, prepareImplicitRecovery, verifyRecoveryGrant, updateRecoveryPassword } from '@/lib/auth/recovery-server';
import { isRetryableAuthError } from '@/lib/auth/session';

function failure(error: unknown) {
  return { ok: false as const, errorKey: error instanceof RecoveryError ? error.key : 'authRecovery.temporarilyUnavailable' };
}

async function currentToken(): Promise<string> {
  const client = await createServer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      client.auth.getSession(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RecoveryError('authRecovery.temporarilyUnavailable')), 15_000); }),
    ]);
    if (result.error) throw new RecoveryError(isRetryableAuthError(result.error) ? 'authRecovery.temporarilyUnavailable' : 'authRecovery.sessionChanged');
    if (!result.data.session?.access_token) throw new RecoveryError('authRecovery.sessionChanged');
    // Cookie contents identify a candidate only. Every caller verifies this
    // exact token against the provider and signed grant before using it.
    return result.data.session.access_token;
  } finally { if (timer) clearTimeout(timer); }
}

export async function prepareRecoveryAction(accessToken: string, refreshToken: string) {
  try { return { ok: true as const, ...await prepareImplicitRecovery(accessToken, refreshToken) }; }
  catch (error) { return failure(error); }
}

export async function consumeRecoveryAction(handoff: string) {
  try {
    if (typeof handoff !== 'string' || !/^[a-f0-9]{64}$/.test(handoff)) throw new RecoveryError('authRecovery.invalidLink');
    const jar = await cookies();
    const grant = jar.get(RECOVERY_HANDOFF_COOKIE)?.value;
    if (!grant || grant.length > 2048) throw new RecoveryError('authRecovery.invalidLink');
    const actual = createHash('sha256').update(grant).digest();
    if (!timingSafeEqual(actual, Buffer.from(handoff, 'hex'))) throw new RecoveryError('authRecovery.invalidLink');
    const identity = await verifyRecoveryGrant(grant, await currentToken());
    // Keep the short-lived bridge for reload/strict-mode duplicate reads. The
    // signed grant is not a bearer credential: the matching session is required.
    return { ok: true as const, identity, grant };
  } catch (error) { return failure(error); }
}

export async function inspectRecoveryAction(grant: string) {
  try { return { ok: true as const, identity: await verifyRecoveryGrant(grant, await currentToken()) }; }
  catch (error) { return failure(error); }
}

export async function saveRecoveryAction(grant: string, password: string) {
  try { return await updateRecoveryPassword(grant, await currentToken(), password); }
  catch (error) { return { outcome: 'failed' as const, errorKey: failure(error).errorKey }; }
}
