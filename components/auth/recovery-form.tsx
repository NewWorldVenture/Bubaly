'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { createBrowserClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { useTranslations } from '@/components/i18n/locale-provider';
import { createClient } from '@/lib/supabase/client';
import { emailSchema } from '@/lib/validation';
import { durableCookieOptions, isRetryableAuthError, isSecureOrigin } from '@/lib/auth/session';
import type { RecoveryIdentity } from '@/lib/auth/recovery-server';
import { consumeRecoveryAction, inspectRecoveryAction, prepareRecoveryAction, saveRecoveryAction } from '@/app/(auth)/auth/recovery/actions';

const STORAGE_KEY = 'bubaly.auth.recovery.grant.v1';
const DEADLINE_MS = 35_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GRANT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ERROR_KEYS = new Set(['invalidLink', 'expiredLink', 'sessionChanged', 'temporarilyUnavailable', 'setupRequired', 'invalidPassword',
  'passwordRejected', 'weakPassword', 'samePassword', 'mfaRequired', 'reauthenticationRequired', 'currentPasswordRequired', 'rateLimited', 'saveUncertain'].map(key => `authRecovery.${key}`));
type Phase = 'checking' | 'request' | 'sending' | 'sent' | 'requestUncertain' | 'ready' | 'saving' | 'updated' | 'uncertain' | 'error';
type View = { phase: Phase; error?: string; email?: string };
type Entry = { kind: 'request' } | { kind: 'error'; error?: string } | { kind: 'implicit'; access: string; refresh: string }
  | { kind: 'handoff'; handoff: string } | { kind: 'stored'; grant: string };
type Scope = { key: string; active: boolean; phase: Phase; entry: Entry; job?: Promise<void>; db?: ReturnType<typeof createClient>;
  unsubscribe?: () => void; timer?: ReturnType<typeof setTimeout>; revision: number; authKey?: string; installingKey?: string;
  identity?: RecoveryIdentity; grant?: string; persistedGrant: string | null };
function errorKey(value: unknown): string { return typeof value === 'string' && ERROR_KEYS.has(value) ? value : 'authRecovery.temporarilyUnavailable'; }
function storedGrant(value?: string) { try { if (value) sessionStorage.setItem(STORAGE_KEY, value); else sessionStorage.removeItem(STORAGE_KEY); } catch { /* Reload storage is optional; authority remains on the server. */ } }
function readStoredGrant(): string | null { try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; } }
function persistGrant(scope: Scope, value?: string): boolean {
  try {
    if (sessionStorage.getItem(STORAGE_KEY) !== scope.persistedGrant) return false;
    if (value) sessionStorage.setItem(STORAGE_KEY, value); else sessionStorage.removeItem(STORAGE_KEY);
    scope.persistedGrant = value ?? null;
  } catch { /* Continue in memory when this browser disables reload storage. */ }
  return true;
}
function authCookies(): string {
  return JSON.stringify(parseCookieHeader(document.cookie).filter(cookie => /^sb-.+-auth-token(?:-code-verifier)?(?:\.\d+)?$/.test(cookie.name))
    .sort((a, b) => a.name.localeCompare(b.name)));
}
function validGrant(value: unknown): value is string { return typeof value === 'string' && value.length <= 2048 && GRANT.test(value); }
function validIdentity(value: RecoveryIdentity): boolean {
  return !!value && UUID.test(value.userId) && UUID.test(value.sessionId) && typeof value.email === 'string'
    && value.email.length > 0 && value.email.length <= 320 && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now();
}
function identityKey(value: RecoveryIdentity): string { return `${value.userId}:${value.sessionId}`; }
function preparedSession(value: unknown): { access_token: string; refresh_token: string } | null {
  if (!value || typeof value !== 'object' || !('access_token' in value) || !('refresh_token' in value)
    || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16_384
    || typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > 8192) return null;
  return { access_token: value.access_token, refresh_token: value.refresh_token };
}
function sessionKey(session: { access_token: string; user: { id: string } } | null): string {
  if (!session) return 'signed-out';
  try {
    const payload = JSON.parse(atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.sub === session.user.id && UUID.test(payload.sub) && UUID.test(payload.session_id)) return `${payload.sub}:${payload.session_id}`;
  } catch { /* An unverified local session is never recovery authority. */ }
  return `invalid:${session.user?.id ?? ''}`;
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Recovery deadline')), DEADLINE_MS); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function captureEntry(request: boolean): Entry {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const hadFragment = !!url.hash;
  const queryTokens = url.searchParams.has('access_token') || url.searchParams.has('refresh_token');
  // Never let the singleton's automatic URL detection consume an unverified
  // recovery fragment. Token values live only in this in-memory entry.
  if (hadFragment || queryTokens) {
    url.hash = ''; url.searchParams.delete('access_token'); url.searchParams.delete('refresh_token');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
  }
  if (hadFragment || queryTokens || url.searchParams.has('handoff') || url.searchParams.has('error')) storedGrant();
  if (queryTokens || ['error', 'error_code', 'error_description'].some(key => fragment.has(key) || url.searchParams.has(key))) return { kind: 'error', error: 'authRecovery.invalidLink' };
  if (hadFragment) {
    if (url.searchParams.has('handoff') || fragment.getAll('type').length !== 1 || fragment.get('type') !== 'recovery'
      || fragment.getAll('access_token').length !== 1 || fragment.getAll('refresh_token').length !== 1) return { kind: 'error', error: 'authRecovery.invalidLink' };
    const access = fragment.get('access_token')!, refresh = fragment.get('refresh_token')!;
    if (!access || access.length > 16_384 || !refresh || refresh.length > 8192 || /[\s\x00-\x1f\x7f]/.test(refresh)) return { kind: 'error', error: 'authRecovery.invalidLink' };
    return { kind: 'implicit', access, refresh };
  }
  if (url.searchParams.has('handoff')) return url.searchParams.getAll('handoff').length === 1 && /^[a-f0-9]{64}$/.test(url.searchParams.get('handoff')!)
    ? { kind: 'handoff', handoff: url.searchParams.get('handoff')! } : { kind: 'error', error: 'authRecovery.invalidLink' };
  if (request) { storedGrant(); return { kind: 'request' }; }
  try { const grant = sessionStorage.getItem(STORAGE_KEY); if (validGrant(grant)) return { kind: 'stored', grant }; } catch { /* A missing grant cannot be replaced by an existing session. */ }
  return { kind: 'error', error: 'authRecovery.invalidLink' };
}

export function RecoveryForm({ request = false }: { request?: boolean }) {
  const t = useTranslations();
  const params = useSearchParams();
  const [locationEpoch, setLocationEpoch] = useState(0);
  const [view, setView] = useState<View>({ phase: 'checking' });
  const scopeRef = useRef<Scope | null>(null);
  const search = params.toString();
  const renderedScope = scopeRef.current;
  const current = (scope: Scope) => scope.active && scopeRef.current === scope;
  const activePhase = (scope: Scope, phase: Phase) => current(scope) && scope.phase === phase;
  function publish(scope: Scope, value: View) { if (current(scope)) { scope.phase = value.phase; setView(value); } }
  function retire(scope: Scope, key: string) {
    if (!current(scope)) return;
    scope.grant = undefined; persistGrant(scope);
    publish(scope, { phase: 'error', error: errorKey(key) });
  }

  useLayoutEffect(() => {
    const key = `${request}:${search}:${locationEpoch}`;
    let scope = scopeRef.current;
    if (!scope || scope.key !== key) {
      scope = { key, active: true, phase: 'checking', entry: captureEntry(request), revision: 0, persistedGrant: readStoredGrant() };
      scopeRef.current = scope;
    }
    const opening = scope;
    opening.active = true;
    const isCurrent = () => opening.active && scopeRef.current === opening;
    const show = (value: View) => { if (isCurrent()) { opening.phase = value.phase; setView(value); } };
    const fail = (value: unknown) => { if (isCurrent()) { opening.grant = undefined; persistGrant(opening); show({ phase: 'error', error: errorKey(value) }); } };
    async function initialize() {
      show({ phase: 'checking' });
      const entry = opening.entry;
      if (entry.kind === 'request') { show({ phase: 'request' }); return; }
      if (entry.kind === 'error') { fail(entry.error); return; }
      try {
        if (!isCurrent()) return;
        const db = opening.db = createClient();
        let bootstrapping = true;
        const subscription = db.auth.onAuthStateChange((event, session) => {
          if (!isCurrent() || event === 'INITIAL_SESSION') return;
          const next = sessionKey(session);
          if (bootstrapping) { opening.authKey = next; opening.revision++; return; }
          if (next === opening.installingKey) { opening.authKey = next; return; }
          if (next === opening.authKey) return;
          opening.authKey = next; opening.revision++;
          fail('authRecovery.sessionChanged');
        });
        opening.unsubscribe = () => subscription.data.subscription.unsubscribe();
        let revision = opening.revision;
        const initial = await bounded(db.auth.getSession());
        if (!isCurrent()) return;
        if (initial.error) { fail('authRecovery.temporarilyUnavailable'); return; }
        const initialKey = sessionKey(initial.data.session);
        if (opening.revision !== revision && opening.authKey !== initialKey) { fail('authRecovery.sessionChanged'); return; }
        // A fresh singleton emits SIGNED_IN while recovering its existing
        // cookie. Accept that agreeing bootstrap, never a stale read that
        // disagrees with the latest event observed during the await.
        bootstrapping = false; revision = opening.revision; opening.authKey = initialKey;
        let expectedCookies = authCookies();
        const result = entry.kind === 'implicit' ? await bounded(prepareRecoveryAction(entry.access, entry.refresh))
          : entry.kind === 'handoff' ? await bounded(consumeRecoveryAction(entry.handoff)) : await bounded(inspectRecoveryAction(entry.grant));
        if (!isCurrent()) return;
        if (opening.revision !== revision) { fail('authRecovery.sessionChanged'); return; }
        if (!result.ok) { fail(result.errorKey); return; }
        const grant = 'grant' in result ? result.grant : entry.kind === 'stored' ? entry.grant : '';
        if (!validIdentity(result.identity) || !validGrant(grant)) { fail('authRecovery.invalidLink'); return; }
        const expected = identityKey(result.identity);
        if (entry.kind === 'implicit') {
          const session = 'session' in result ? preparedSession(result.session) : null;
          if (!session) { fail('authRecovery.invalidLink'); return; }
          if (authCookies() !== expectedCookies) { fail('authRecovery.sessionChanged'); return; }
          let installationStorage = false;
          const installer = createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
            isSingleton: false,
            cookieOptions: durableCookieOptions(isSecureOrigin(window.location.origin)),
            // This client performs exactly one explicit install. Even with
            // refresh disabled, SDK initialization otherwise reads and may
            // repair/remove the ambient session before that install.
            auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true, flowType: 'pkce' },
            cookies: {
              // Supabase also subscribes to INITIAL_SESSION in its constructor.
              // That subscription can refresh expired storage independently of
              // autoRefreshToken. Its bootstrap must see no ambient session.
              getAll: () => installationStorage ? parseCookieHeader(document.cookie).map(cookie => ({ name: cookie.name, value: cookie.value ?? '' })) : [],
              setAll: cookies => {
                // The SDK calls this only after its awaited user lookup. Fence
                // the actual cookie write, including changes whose auth event
                // has not reached this component yet.
                if (!installationStorage || !isCurrent() || opening.revision !== revision || opening.phase !== 'checking' || authCookies() !== expectedCookies) throw new Error('Recovery installation retired');
                for (const cookie of cookies) document.cookie = serializeCookieHeader(cookie.name, cookie.value, cookie.options);
                expectedCookies = authCookies();
              },
            },
          });
          opening.installingKey = expected;
          let installed;
          try {
            await bounded(new Promise<void>(resolve => {
              const initial = installer.auth.onAuthStateChange(event => {
                if (event === 'INITIAL_SESSION') { initial.data.subscription.unsubscribe(); resolve(); }
              });
            }));
            if (!isCurrent()) return;
            if (opening.revision !== revision || authCookies() !== expectedCookies) { fail('authRecovery.sessionChanged'); return; }
            installationStorage = true;
            installed = await bounded(installer.auth.setSession(session));
          }
          finally { opening.installingKey = undefined; await installer.auth.dispose(); }
          if (!isCurrent()) return;
          if (opening.revision !== revision || installed.error || installed.data.user?.id !== result.identity.userId) { fail('authRecovery.sessionChanged'); return; }
        }
        const installed = await bounded(db.auth.getSession());
        if (!isCurrent()) return;
        if (opening.revision !== revision || installed.error || sessionKey(installed.data.session) !== expected) { fail('authRecovery.sessionChanged'); return; }
        if (!persistGrant(opening, grant)) { fail('authRecovery.sessionChanged'); return; }
        if (entry.kind === 'handoff') {
          // The bridge cookie expires before the verified grant. Once its
          // grant is safely retained, reload must inspect that grant instead
          // of retrying the older bridge. Preserve unrelated URL parameters.
          const url = new URL(window.location.href);
          if (url.searchParams.getAll('handoff').length === 1 && url.searchParams.get('handoff') === entry.handoff) {
            url.searchParams.delete('handoff');
            window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
            opening.key = `${request}:${url.searchParams.toString()}:${locationEpoch}`;
          }
        }
        opening.authKey = expected; opening.identity = result.identity; opening.grant = grant;
        opening.timer = setTimeout(() => fail('authRecovery.expiredLink'), Math.max(0, result.identity.expiresAt - Date.now()));
        show({ phase: 'ready', email: result.identity.email });
      } catch { fail('authRecovery.temporarilyUnavailable'); }
    }
    // Strict-mode's setup/cleanup/setup shares the same in-memory preparation;
    // it must not consume the submitted refresh token twice.
    opening.job ??= initialize();
    const changed = () => setLocationEpoch(value => value + 1);
    window.addEventListener('hashchange', changed);
    return () => {
      opening.active = false;
      window.removeEventListener('hashchange', changed);
      queueMicrotask(() => { if (!opening.active) { opening.unsubscribe?.(); if (opening.timer) clearTimeout(opening.timer); } });
    };
  }, [request, search, locationEpoch]);

  async function sendEmail(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = renderedScope;
    if (!scope || !current(scope) || scope.phase !== 'request') return;
    const parsed = emailSchema.safeParse(String(new FormData(event.currentTarget).get('email') ?? ''));
    if (!parsed.success) { publish(scope, { phase: 'request', error: 'authRecovery.invalidEmail' }); return; }
    publish(scope, { phase: 'sending' });
    let dispatched = false;
    try {
      const db = createClient();
      dispatched = true;
      const result = await bounded(db.auth.resetPasswordForEmail(parsed.data, { redirectTo: `${window.location.origin}/auth/callback?next=/auth/recovery` }));
      if (!current(scope)) return;
      if (result.error) {
        const rejected = result.error.status !== undefined && result.error.status >= 400 && result.error.status < 500 && !isRetryableAuthError(result.error);
        publish(scope, { phase: rejected ? 'request' : 'requestUncertain', error: rejected ? 'authRecovery.requestFailed' : 'authRecovery.requestUncertain' }); return;
      }
      publish(scope, { phase: 'sent' });
    } catch { publish(scope, { phase: dispatched ? 'requestUncertain' : 'request', error: dispatched ? 'authRecovery.requestUncertain' : 'authRecovery.temporarilyUnavailable' }); }
  }

  async function savePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const scope = renderedScope;
    if (!scope || !current(scope) || scope.phase !== 'ready' || !scope.grant || !scope.identity || !scope.db) return;
    if (scope.identity.expiresAt <= Date.now()) { retire(scope, 'authRecovery.expiredLink'); return; }
    const fields = new FormData(event.currentTarget), password = String(fields.get('password') ?? ''), confirmation = String(fields.get('confirmation') ?? '');
    if (password.length < 8 || password.length > 72 || password !== confirmation) {
      publish(scope, { phase: 'ready', email: scope.identity.email, error: password !== confirmation ? 'authRecovery.passwordMismatch' : 'authRecovery.invalidPassword' }); return;
    }
    publish(scope, { phase: 'saving', email: scope.identity.email });
    const revision = scope.revision;
    let dispatched = false;
    try {
      const session = await bounded(scope.db.auth.getSession());
      if (!activePhase(scope, 'saving')) return;
      if (session.error || scope.revision !== revision || sessionKey(session.data.session) !== identityKey(scope.identity)) { retire(scope, 'authRecovery.sessionChanged'); return; }
      dispatched = true;
      const result = await bounded(saveRecoveryAction(scope.grant, password));
      if (!activePhase(scope, 'saving') || scope.revision !== revision) return;
      if (result.outcome === 'updated' || result.outcome === 'uncertain') {
        scope.grant = undefined; persistGrant(scope); if (scope.timer) clearTimeout(scope.timer);
        publish(scope, { phase: result.outcome === 'updated' ? 'updated' : 'uncertain', error: result.outcome === 'uncertain' ? 'authRecovery.saveUncertain' : undefined }); return;
      }
      const key = errorKey(result.errorKey);
      if (['authRecovery.invalidLink', 'authRecovery.expiredLink', 'authRecovery.sessionChanged'].includes(key)) { retire(scope, key); return; }
      publish(scope, { phase: 'ready', email: scope.identity.email, error: key });
    } catch {
      if (!activePhase(scope, 'saving')) return;
      if (dispatched) { scope.grant = undefined; persistGrant(scope); if (scope.timer) clearTimeout(scope.timer); }
      publish(scope, { phase: dispatched ? 'uncertain' : 'ready', email: scope.identity.email, error: dispatched ? 'authRecovery.saveUncertain' : 'authRecovery.temporarilyUnavailable' });
    }
  }

  const requesting = ['request', 'sending', 'sent', 'requestUncertain'].includes(view.phase);
  return (
    <div className="glass-card p-7 sm:p-8">
      <h1 className="text-2xl font-bold">{t(requesting ? 'authRecovery.requestTitle' : view.phase === 'updated' ? 'authRecovery.updatedTitle' : 'authRecovery.title')}</h1>
      {view.phase === 'checking' && <p role="status" className="mt-4 text-sm text-muted">{t('authRecovery.checking')}</p>}
      {view.error && <p role="alert" className="mt-4 text-sm text-danger">{t(view.error)}</p>}
      {(view.phase === 'request' || view.phase === 'sending') && <form onSubmit={sendEmail} className="mt-5 space-y-4" noValidate>
        <p className="text-sm text-muted">{t('authRecovery.requestDescription')}</p>
        <fieldset disabled={view.phase === 'sending'} className="min-w-0 space-y-4">
          <Field label={t('login.email')} required>{id => <Input id={id} name="email" type="email" autoComplete="email" />}</Field>
          <Button type="submit" loading={view.phase === 'sending'} className="w-full">{t('authRecovery.sendLink')}</Button>
        </fieldset>
      </form>}
      {(view.phase === 'ready' || view.phase === 'saving') && <form onSubmit={savePassword} className="mt-5 space-y-4" noValidate>
        <p className="text-sm text-muted">{t('authRecovery.account', { email: view.email ?? '' })}</p>
        <fieldset disabled={view.phase === 'saving'} className="min-w-0 space-y-4">
          <Field label={t('authRecovery.newPassword')} hint={t('signupForm.atLeast8Characters')} required>{id => <Input id={id} name="password" type="password" autoComplete="new-password" />}</Field>
          <Field label={t('authRecovery.confirmPassword')} required>{id => <Input id={id} name="confirmation" type="password" autoComplete="new-password" />}</Field>
          <Button type="submit" loading={view.phase === 'saving'} className="w-full">{t('authRecovery.savePassword')}</Button>
        </fieldset>
      </form>}
      {view.phase === 'sent' && <p role="status" className="mt-4 text-sm text-muted">{t('authRecovery.sent')}</p>}
      {view.phase === 'updated' && <p role="status" className="mt-4 text-sm text-muted">{t('authRecovery.updated')}</p>}
      {view.phase === 'error' && <Link href="/login?reset=1" className="mt-5 block text-sm text-brand-text underline">{t('authRecovery.requestAnother')}</Link>}
      <Link href="/login" className="mt-5 block text-sm text-brand-text underline">{t('signup.backToSignIn')}</Link>
    </div>
  );
}
