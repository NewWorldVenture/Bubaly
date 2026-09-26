import type { AuthResponse, SignUpWithPasswordCredentials } from '@supabase/supabase-js';
import type { createClient } from '../supabase/client';
import { signUpWithInitiation } from './pkce-initiation-client';

/** Compatibility entrypoint; the initiation helper owns verifier and session writes. */
export function signUpWithOwnedVerifier(
  _sharedClient: ReturnType<typeof createClient>,
  credentials: SignUpWithPasswordCredentials,
  canCommitSession: () => boolean,
): Promise<AuthResponse> {
  return signUpWithInitiation(credentials, canCommitSession);
}
