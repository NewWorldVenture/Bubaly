import type { RecoveryIdentity } from './recovery-server';

export type CallbackTokens = { access_token: string; refresh_token: string };
export type CallbackInput = { code: string; next: string; verifierFingerprint: string };
export type CallbackReceipt =
  | {
    status: 'exchanged';
    tokens: CallbackTokens;
    destination: string;
    visitorReset?: boolean;
    recovery?: { grant: string; identity: RecoveryIdentity };
  }
  | { status: 'rejected' | 'unavailable'; errorKey: string };

// This storage is a convenience for reloads, never recovery authority. The
// existing recovery action verifies the signed grant against the current token.
export const RECOVERY_GRANT_STORAGE_KEY = 'bubaly.auth.recovery.grant.v1';
