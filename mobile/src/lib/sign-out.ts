import { isRetryableAuthError } from './auth-core';
import type { SessionSignOut } from './chunked-storage';

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
  beginSessionSignOut?: () => Promise<SessionSignOut>;
}) {
  let pending: Promise<void> | null = null;
  const run = async () => {
    const transaction = deps.beginSessionSignOut ? await deps.beginSessionSignOut() : undefined;
    let changed = false;
    let signedOut = false;
    let resumeWrites = () => {};
    let unsubscribe = () => {};
    try {
      const started = deps.writeRevision();
      unsubscribe = deps.subscribe(event => {
        if (event === 'SIGNED_OUT') signedOut = true;
        if (['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED', 'PASSWORD_RECOVERY'].includes(event)) changed = true;
      });
      let error: unknown;
      try { error = (await deps.signOut()).error; } catch (failure) { error = failure; }
      if (!error) return;
      if (typeof error === 'object' && error !== null && 'code' in error
        && error.code === 'session_removal_changed') throw new DeviceSignOutChangedError();
      if (!isRetryableAuthError(error)) throw error;
      // Primary deletion can succeed before PKCE/user cleanup fails. Only the
      // genuine SDK notification completes logout; otherwise retry cleanup
      // once through the normal empty-store path or report its failure.
      if (transaction?.didRemove() && signedOut) return;
      const stillCurrent = () => transaction ? transaction.isCurrent() : !changed && deps.writeRevision() === started;
      if (!stillCurrent()) throw new DeviceSignOutChangedError();
      // Only block after the first attempt: an expired session may need the
      // SDK to save a refresh during that attempt. Overlapping logins receive
      // a retryable failure until the SDK has finished signing out the store.
      if (!transaction) resumeWrites = deps.blockWrites();
      if (!await deps.removeSession(stillCurrent) || !stillCurrent()) throw new DeviceSignOutChangedError();
      // The SDK now sees an empty store and emits its normal SIGNED_OUT event.
      // State and subscribers change only after durable removal succeeded.
      const result = await deps.signOut();
      if (result.error) throw result.error;
    } finally {
      try { resumeWrites(); unsubscribe(); } finally { transaction?.finish(); }
    }
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

/** The SDK reads storage again before its HTTP request. Bind that request to
 * the captured logout owner as well as guarding the later local deletion. */
export function createDeviceSignOutFetch(
  supabaseUrl: string,
  assertOwner: (accessToken: string) => void,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): typeof fetch {
  const endpoint = new URL(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/logout`);
  return (input, init) => {
    const url = new URL(typeof input === 'string' ? input : 'url' in input ? input.url : input.href);
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    if (method.toUpperCase() === 'POST' && url.origin === endpoint.origin && url.pathname === endpoint.pathname
      && url.searchParams.getAll('scope').length === 1 && url.searchParams.get('scope') === 'local') {
      const headers = new Headers(init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined));
      const bearer = /^Bearer\s+(.+)$/i.exec(headers.get('authorization') ?? '');
      assertOwner(bearer?.[1] ?? '');
    }
    // No asynchronous work can replace the owner between validation and the
    // exact existing transport call. Other requests keep their original args.
    return fetchImpl(input, init);
  };
}
