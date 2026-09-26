'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { stringFromBase64URL } from '@supabase/ssr';
import { completeCallbackAction } from '@/app/(auth)/auth/complete/actions';
import { Button } from '@/components/ui/button';
import { useTranslations } from '@/components/i18n/locale-provider';
import { RecoveryForm } from '@/components/auth/recovery-form';
import { createClient } from '@/lib/supabase/client';
import { captureBrowserSessionSnapshot } from '@/lib/auth/browser-session-storage';
import { adoptCallbackSession, assertAdmissionOwnership, assertInitiationOwnership, callbackVerifierFingerprint, captureCallbackOwnership, isAdoptedCallbackSessionCurrent,
  isCallbackOwnershipCurrent, type CallbackOwnership } from '@/lib/auth/callback-client';
import { parseCallbackAdmissionWitness } from '@/lib/auth/callback-witness';
import { RECOVERY_GRANT_STORAGE_KEY, type CallbackReceipt } from '@/lib/auth/callback';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { isRetryableAuthError } from '@/lib/auth/session';
import { authScreenHref } from '@/lib/billing/review-selection';
import { captureAnonymousId, resetAnonymousId } from '@/lib/marketing/visitor';

type Receipt = Extract<CallbackReceipt, { status: 'exchanged' }>;
type View = { phase: 'checking' | 'error' | 'retry' | 'recovery'; error?: string; grant?: string };
type Scope = { active: boolean; expired: boolean; owner: CallbackOwnership | null; job?: Promise<void>; receipt?: Receipt;
  timer?: ReturnType<typeof setTimeout>; storedGrant: string | null; visitorId: string | null; busy: boolean };
const DEADLINE_MS = 35_000;
function validRecoveryReceipt(receipt: Receipt): boolean {
  if (!receipt.recovery) return true;
  const { grant, identity } = receipt.recovery;
  if (typeof grant !== 'string' || grant.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(grant)
    || !identity || typeof identity.userId !== 'string' || typeof identity.sessionId !== 'string'
    || typeof identity.email !== 'string' || !identity.email || identity.email.length > 320
    || !Number.isFinite(identity.expiresAt) || identity.expiresAt <= Date.now()) return false;
  try {
    const claims = JSON.parse(stringFromBase64URL(receipt.tokens.access_token.split('.')[1]));
    return claims.sub === identity.userId && claims.session_id === identity.sessionId;
  } catch { return false; }
}
function readGrant(): string | null { try { return sessionStorage.getItem(RECOVERY_GRANT_STORAGE_KEY); } catch { return null; } }
function message(key: string): string {
  if (key === 'authRecovery.sessionChanged') return 'authCallback.sessionChanged';
  if (key === 'authRecovery.invalidLink' || key === 'authRecovery.expiredLink') return 'authCallback.invalidLink';
  return 'authCallback.temporarilyUnavailable';
}

/** Provider receipts stay in memory until this browser verifies and owns adoption. */
export function CallbackCompletion({ code, next, admission, attempt }: { code: string | null; next: string; admission: string | null; attempt: string | null }) {
  const t = useTranslations();
  const router = useRouter();
  const [view, setView] = useState<View>({ phase: 'checking' });
  const scopeRef = useRef<Scope | null>(null);
  const destination = safeInternalRedirect(next, '/home');
  const recovery = destination === '/auth/recovery';
  const current = (scope: Scope) => scope.active && scopeRef.current === scope && !scope.expired;
  const owns = (scope: Scope) => current(scope) && !!scope.owner && isCallbackOwnershipCurrent(scope.owner)
    && (!recovery || readGrant() === scope.storedGrant);
  function finish(scope: Scope, value: View) {
    if (!current(scope)) return;
    if (scope.timer) clearTimeout(scope.timer);
    scope.busy = false;
    setView(value);
  }
  function begin(scope: Scope) {
    scope.busy = true; scope.expired = false;
    setView({ phase: 'checking' });
    scope.timer = setTimeout(() => {
      if (!current(scope)) return;
      scope.expired = true; scope.receipt = undefined; scope.busy = false;
      setView({ phase: 'error', error: 'authCallback.temporarilyUnavailable' });
    }, DEADLINE_MS);
  }
  function changed(scope: Scope) { scope.receipt = undefined; finish(scope, { phase: 'error', error: 'authCallback.sessionChanged' }); }

  async function install(scope: Scope) {
    if (!owns(scope)) { changed(scope); return; }
    const receipt = scope.receipt;
    if (!receipt || !scope.owner) return;
    const target = safeInternalRedirect(receipt.destination, '');
    if (!target || (recovery !== !!receipt.recovery) || (receipt.recovery && target !== '/auth/recovery') || !validRecoveryReceipt(receipt)) {
      scope.receipt = undefined; finish(scope, { phase: 'error', error: 'authCallback.invalidLink' }); return;
    }
    try {
      const result = await adoptCallbackSession(receipt.tokens, scope.owner, () => owns(scope) && scope.busy);
      if (!current(scope)) return;
      if (result.error || !result.data.session) {
        if (!owns(scope)) { changed(scope); return; }
        const retry = result.error && isRetryableAuthError(result.error);
        if (!retry) scope.receipt = undefined;
        finish(scope, { phase: retry ? 'retry' : 'error', error: retry ? 'authCallback.temporarilyUnavailable' : 'authCallback.invalidLink' }); return;
      }
      if (!isAdoptedCallbackSessionCurrent(result.data.session, scope.owner)) { changed(scope); return; }
      scope.receipt = undefined;
      if (receipt.visitorReset) { try { resetAnonymousId(scope.visitorId); } catch { /* Optional attribution cannot block an adopted login. */ } }
      if (receipt.recovery) {
        // Compare immediately before writing. An older completion must not erase
        // or replace a newer recovery grant in this tab.
        if (readGrant() !== scope.storedGrant) { changed(scope); return; }
        let persisted = false;
        try {
          sessionStorage.setItem(RECOVERY_GRANT_STORAGE_KEY, receipt.recovery.grant);
          persisted = sessionStorage.getItem(RECOVERY_GRANT_STORAGE_KEY) === receipt.recovery.grant;
        } catch { /* The verified recovery form can continue with an in-memory grant. */ }
        if (!persisted) { finish(scope, { phase: 'recovery', grant: receipt.recovery.grant }); return; }
      }
      finish(scope, { phase: 'checking' });
      router.replace(target);
    } catch {
      if (!current(scope)) return;
      if (!owns(scope)) { changed(scope); return; }
      finish(scope, { phase: 'retry', error: 'authCallback.temporarilyUnavailable' });
    }
  }

  async function fallback(scope: Scope, error = 'authCallback.invalidLink') {
    if (!owns(scope)) { changed(scope); return; }
    if (recovery) { finish(scope, { phase: 'error', error }); return; }
    try {
      // An expired existing login may renew only through the guarded browser
      // adapter. Neither admission nor the action publishes ambient cookies.
      const before = captureBrowserSessionSnapshot();
      const result = await createClient().auth.getUser();
      if (!current(scope)) return;
      if (!owns(scope)) { changed(scope); return; }
      if (result.data.user || (before?.accessToken && result.error && isRetryableAuthError(result.error))) {
        finish(scope, { phase: 'checking' }); router.replace(destination); return;
      }
      finish(scope, { phase: 'error', error });
    } catch { if (owns(scope)) finish(scope, { phase: 'error', error: 'authCallback.temporarilyUnavailable' }); else changed(scope); }
  }

  useLayoutEffect(() => {
    let scope = scopeRef.current;
    if (!scope) {
      // Capture even an empty session slot before the first asynchronous step.
      scope = { active: true, expired: false, owner: captureCallbackOwnership(), storedGrant: readGrant(), visitorId: captureAnonymousId(), busy: false };
      scopeRef.current = scope;
      const url = new URL(window.location.href);
      // Direct visits can bypass admission. Retain only the sanitized return
      // path, never arbitrary credential or provider-error query parameters.
      url.search = new URLSearchParams({ next: destination }).toString(); url.hash = '';
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    }
    const opening = scope;
    opening.active = true;
    async function run() {
      begin(opening);
      if (!opening.owner) { finish(opening, { phase: 'error', error: 'authCallback.sessionChanged' }); return; }
      const witness = parseCallbackAdmissionWitness(admission);
      let admitted = false;
      try { admitted = !!witness && await assertAdmissionOwnership(opening.owner, witness); } catch { /* Invalid request context cannot authorize completion. */ }
      if (!admitted || !owns(opening)) { changed(opening); return; }
      if (!code) { await fallback(opening); return; }
      let initiated = false;
      try { initiated = await assertInitiationOwnership(opening.owner, attempt, recovery); } catch { /* Missing or retired initiation must not adopt this code. */ }
      if (!owns(opening)) { changed(opening); return; }
      if (!initiated || !attempt) { finish(opening, { phase: 'error', error: 'authCallback.invalidLink' }); return; }
      let fingerprint: string;
      try { fingerprint = await callbackVerifierFingerprint(opening.owner); }
      catch { if (owns(opening)) finish(opening, { phase: 'error', error: 'authCallback.temporarilyUnavailable' }); else changed(opening); return; }
      if (!owns(opening)) { changed(opening); return; }
      try {
        const receipt = await completeCallbackAction({ code, next: destination, verifierFingerprint: fingerprint, attempt });
        if (!current(opening)) return;
        if (!owns(opening)) { changed(opening); return; }
        if (receipt.status !== 'exchanged') { finish(opening, { phase: 'error', error: message(receipt.errorKey) }); return; }
        opening.receipt = receipt;
        await install(opening);
      } catch { if (owns(opening)) finish(opening, { phase: 'error', error: 'authCallback.temporarilyUnavailable' }); else changed(opening); }
    }
    // Development Strict Mode replays effects; one code gets one exchange.
    opening.job ??= run();
    return () => {
      opening.active = false;
      queueMicrotask(() => { if (!opening.active) { opening.receipt = undefined; if (opening.timer) clearTimeout(opening.timer); } });
    };
    // This page is keyed by its server-parsed admission; history cleanup must
    // not turn the consumed code into a second completion attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function retry() {
    const scope = scopeRef.current;
    if (!scope || scope.busy || !scope.receipt || !owns(scope)) { if (scope) changed(scope); return; }
    begin(scope); void install(scope);
  }
  if (view.phase === 'recovery' && view.grant) return <RecoveryForm initialGrant={view.grant} />;
  return <div className="glass-card p-7 sm:p-8">
    <h1 className="text-2xl font-bold">{t('authCallback.title')}</h1>
    {view.phase === 'checking' && <p role="status" className="mt-4 text-sm text-muted">{t('authCallback.checking')}</p>}
    {view.error && <p role="alert" className="mt-4 text-sm text-danger">{t(view.error)}</p>}
    {view.phase === 'retry' && <Button onClick={retry} className="mt-5 w-full">{t('authCallback.retry')}</Button>}
    {view.phase !== 'checking' && <Link href={authScreenHref('/login', { next: destination, reviewPlan: null }, true)} className="mt-5 block text-sm text-brand-text underline">{t('signup.backToSignIn')}</Link>}
  </div>;
}
