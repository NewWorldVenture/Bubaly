import { randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_BYTES = 32;

/** The provider-scoped cookie keeps parallel OAuth flows from colliding. */
export function syncOAuthStateCookie(provider: string): string {
  return `sync_oauth_state_${provider}`;
}

export function syncOAuthStatePath(provider: string): string {
  return `/api/sync/${provider}`;
}

export function createSyncOAuthState(): string {
  return randomBytes(STATE_BYTES).toString('base64url');
}

/** Compare OAuth state without leaking token-prefix timing information. */
export function verifySyncOAuthState(candidate: string | null | undefined, expected: string | null | undefined): boolean {
  if (!candidate || !expected) return false;
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes);
}
