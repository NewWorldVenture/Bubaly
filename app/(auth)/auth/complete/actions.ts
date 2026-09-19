'use server';

import type { CallbackInput, CallbackReceipt } from '@/lib/auth/callback';
import { completeCallback } from '@/lib/auth/callback-server';

// Next's Server Action transport retains its same-origin and action-ID checks.
// This is a public sign-in completion: the owned PKCE evidence authenticates the
// operation, without refreshing or trusting an ambient browser account.
export async function completeCallbackAction(input: CallbackInput): Promise<CallbackReceipt> {
  return completeCallback(input);
}
