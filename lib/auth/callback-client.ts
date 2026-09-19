import { isChunkLike, serializeCookieHeader } from '@supabase/ssr';
import { AuthRetryableFetchError, type AuthTokenResponsePassword, type Session } from '@supabase/supabase-js';
import { captureBrowserSessionSnapshot, type BrowserSessionSnapshot } from './browser-session-storage';
import { isPasswordSessionCurrent, signInWithOwnedSessionTokens } from './password-client';
import { durableCookieOptions, isSecureOrigin } from './session';
import type { CallbackTokens } from './callback';
import { callbackAdmissionMaterial, encodeCallbackAdmissionWitness, parseCallbackAdmissionCookies, parseCallbackAdmissionWitness,
  type CallbackAdmissionMaterial, type CallbackAdmissionWitness } from './callback-witness';
import { isPkceInitiationNonce, pkceInitiationCookieName, readPkceInitiationSlot, type PkceInitiationRecord } from './pkce-initiation';

type Cookie = { name: string; value: string };
declare const callbackOwnership: unique symbol;
/** Opaque, page-local operation state. Cookie bytes never authorize a user. */
export type CallbackOwnership = { readonly [callbackOwnership]: true };
type State = {
  key: string; generation: string; verifier: Cookie[]; sessionCookies: Cookie[];
  session: BrowserSessionSnapshot | null; capturedAt: number;
  admission: CallbackAdmissionMaterial;
  initiation: string | null; record: PkceInitiationRecord | null; attemptVerified: boolean;
  phase: 'pending' | 'installing' | 'adopted' | 'complete' | 'retired';
};
const owners = new WeakMap<CallbackOwnership, State>();
const interrupted = () => new AuthRetryableFetchError('Sign-in changed before it could be completed. Please try again.', 0);
const canonical = (cookies: Cookie[]) => JSON.stringify(cookies);
const isSession = (name: string, key: string) => isChunkLike(name, key) || isChunkLike(name, `${key}-user`);

function readState(): Omit<State, 'phase' | 'capturedAt' | 'attemptVerified'> {
  const key = `sb-${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]}-auth-token`;
  const cookies = parseCallbackAdmissionCookies(document.cookie);
  if (!cookies) throw interrupted();
  const select = (matches: (name: string) => boolean) => cookies.filter(cookie => matches(cookie.name)).sort((a, b) => a.name.localeCompare(b.name));
  const verifier = select(name => isChunkLike(name, `${key}-code-verifier`));
  const sessionCookies = select(name => isSession(name, key));
  const generations = select(name => name === `${key}-logout-generation`);
  for (const parts of [verifier, sessionCookies]) {
    if (parts.length > 128 || parts.reduce((size, cookie) => size + cookie.value.length, 0) > 256 * 1024
      || new Set(parts.map(cookie => cookie.name)).size !== parts.length) throw interrupted();
  }
  if (generations.length > 1 || (generations[0]?.value.length ?? 0) > 1024) throw interrupted();
  if (verifier.length) {
    const whole = verifier.find(cookie => cookie.name === `${key}-code-verifier`);
    if (whole ? verifier.length !== 1 || !whole.value : verifier.some((_, index) =>
      !verifier.some(cookie => cookie.name === `${key}-code-verifier.${index}` && cookie.value))) throw interrupted();
  }
  const admission = callbackAdmissionMaterial(cookies, key);
  const initiation = readPkceInitiationSlot(cookies, key);
  if (!admission || !initiation) throw interrupted();
  return { key, generation: generations[0]?.value ?? '', verifier, sessionCookies, session: captureBrowserSessionSnapshot(), admission,
    initiation: initiation.raw, record: initiation.record };
}

/** Capture synchronously, including the logout marker when no session exists. */
export function captureCallbackOwnership(): CallbackOwnership | null {
  try {
    const owner = Object.freeze({}) as CallbackOwnership;
    owners.set(owner, { ...readState(), phase: 'pending', capturedAt: Date.now(), attemptVerified: false });
    return owner;
  } catch { return null; }
}

export function isCallbackOwnershipCurrent(owner: CallbackOwnership): boolean {
  try {
    const state = owners.get(owner);
    if (!state || state.phase === 'retired' || (state.phase !== 'complete' && Date.now() - state.capturedAt > 60_000)) return false;
    const current = readState();
    if (state.key !== current.key || state.generation !== current.generation || state.initiation !== current.initiation
      || canonical(state.verifier) !== canonical(current.verifier)) return false;
    if (state.session?.userId && state.session.sessionId) return state.session.userId === current.session?.userId
      && state.session.sessionId === current.session.sessionId;
    return canonical(state.sessionCookies) === canonical(current.sessionCookies);
  } catch { return false; }
}

/** Match the original initiating decision, not merely the later callback request. */
export async function assertInitiationOwnership(owner: CallbackOwnership, attempt: string | null, recovery: boolean): Promise<boolean> {
  const state = owners.get(owner), record = state?.record;
  if (!state || !record || state.phase !== 'pending' || !isCallbackOwnershipCurrent(owner)
    || !isPkceInitiationNonce(attempt) || record.nonce !== attempt || (record.kind === 'recovery') !== recovery) return false;
  const matches = await assertAdmissionOwnership(owner, { v: 1, project: record.project, generation: record.generation,
    verifier: record.verifier, session: record.session });
  if (!matches || !isCallbackOwnershipCurrent(owner)) return false;
  state.attemptVerified = true;
  return true;
}

/** Compare request-time evidence before exchange or fallback; never recapture it. */
export async function assertAdmissionOwnership(owner: CallbackOwnership, witness: CallbackAdmissionWitness): Promise<boolean> {
  try {
    const state = owners.get(owner);
    if (!state || state.phase !== 'pending' || !isCallbackOwnershipCurrent(owner)
      || !witness || Object.keys(witness).length !== 5) return false;
    const expected = parseCallbackAdmissionWitness(encodeCallbackAdmissionWitness(witness));
    if (!expected) return false;
    const fields = ['project', 'generation', 'verifier', 'session'] as const;
    const hashes = await Promise.all(fields.map(async field => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state.admission[field]));
      return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    }));
    if (state.phase !== 'pending' || !isCallbackOwnershipCurrent(owner)) return false;
    const current = readState().admission;
    return fields.every((field, index) => hashes[index] === expected[field] && current[field] === state.admission[field]);
  } catch { return false; }
}

/** Guard recovery grant persistence and navigation after verifier consumption. */
export function isAdoptedCallbackSessionCurrent(session: Session, owner: CallbackOwnership): boolean {
  return owners.get(owner)?.phase === 'complete' && isCallbackOwnershipCurrent(owner) && isPasswordSessionCurrent(session);
}

export async function callbackVerifierFingerprint(owner: CallbackOwnership): Promise<string> {
  const state = owners.get(owner);
  if (!state?.verifier.length || !state.attemptVerified || state.phase !== 'pending' || !isCallbackOwnershipCurrent(owner)) throw interrupted();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(state.verifier)));
  if (!isCallbackOwnershipCurrent(owner)) throw interrupted();
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Adopt verified tokens, then consume only this operation's exact verifier. */
export async function adoptCallbackSession(tokens: CallbackTokens, owner: CallbackOwnership, canCommit: () => boolean): Promise<AuthTokenResponsePassword> {
  const state = owners.get(owner);
  if (!state?.verifier.length || !state.attemptVerified || state.phase !== 'pending' || !canCommit() || !isCallbackOwnershipCurrent(owner)) throw interrupted();
  state.phase = 'installing';
  try {
    const result = await signInWithOwnedSessionTokens(async () => tokens, canCommit, {
      isCurrent: () => isCallbackOwnershipCurrent(owner),
      didAdopt: () => {
        const current = readState();
        state.session = current.session;
        state.sessionCookies = current.sessionCookies;
        state.phase = 'adopted';
      },
    });
    if (result.error) { state.phase = 'pending'; return result; }
    if (!result.data.session || !isPasswordSessionCurrent(result.data.session) || !canCommit() || !isCallbackOwnershipCurrent(owner)) throw interrupted();
    const options = durableCookieOptions(isSecureOrigin(window.location.origin));
    // No await between the final ownership check, compare-consume, and readback.
    for (const cookie of state.verifier) document.cookie = serializeCookieHeader(cookie.name, '', { ...options, maxAge: 0 });
    document.cookie = serializeCookieHeader(pkceInitiationCookieName(state.key), '', { ...options, maxAge: 0 });
    const consumed = readState();
    if (consumed.verifier.length || consumed.initiation !== null) throw interrupted();
    state.verifier = [];
    state.initiation = null; state.record = null;
    state.phase = 'complete';
    if (!canCommit() || !isCallbackOwnershipCurrent(owner)) throw interrupted();
    return result;
  } catch (error) {
    state.phase = 'retired';
    throw error;
  }
}
