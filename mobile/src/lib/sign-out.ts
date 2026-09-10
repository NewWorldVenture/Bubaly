import { isRetryableAuthError } from './auth-core';

class DeviceSignOutChangedError extends Error {
  constructor() { super('The active session changed during sign-out.'); this.name = 'DeviceSignOutChangedError'; }
}

/** An explicit device sign-out can clear unreadable storage or survive an
 * unavailable auth server. Automatic refresh never calls this recovery path. */
export function createDeviceSignOut(deps: {
  signOut: () => Promise<{ error: unknown }>;
  subscribe: (listener: (event: string) => void) => () => void;
  removeSession: (stillCurrent: () => boolean) => Promise<boolean>;
  writeRevision: () => number;
  blockWrites: () => () => void;
}) {
  let pending: Promise<void> | null = null;
  const run = async () => {
    const started = deps.writeRevision();
    let changed = false;
    let resumeWrites = () => {};
    const unsubscribe = deps.subscribe(event => {
      if (['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY'].includes(event)) changed = true;
    });
    try {
      let error: unknown;
      try { error = (await deps.signOut()).error; } catch (failure) { error = failure; }
      if (!error) return;
      if (!isRetryableAuthError(error)) throw error;
      if (changed || deps.writeRevision() !== started) throw new DeviceSignOutChangedError();
      // Only block after the first attempt: an expired session may need the
      // SDK to save a refresh during that attempt. Overlapping logins receive
      // a retryable failure until the SDK has finished signing out the store.
      resumeWrites = deps.blockWrites();
      if (!await deps.removeSession(() => !changed && deps.writeRevision() === started) || changed) throw new DeviceSignOutChangedError();
      // The SDK now sees an empty store and emits its normal SIGNED_OUT event.
      // State and subscribers change only after durable removal succeeded.
      const result = await deps.signOut();
      if (result.error) throw result.error;
    } finally { resumeWrites(); unsubscribe(); }
  };
  return () => {
    if (!pending) pending = run().finally(() => { pending = null; });
    return pending;
  };
}

/** Matches the SDK's existing default, including projects with custom domains. */
export function sessionStorageKey(supabaseUrl: string): string {
  return `sb-${new URL(supabaseUrl).hostname.split('.')[0]}-auth-token`;
}
