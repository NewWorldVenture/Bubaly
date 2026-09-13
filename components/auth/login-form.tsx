'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import type { Session } from '@supabase/supabase-js';
import { isPasswordSessionCurrent, signInWithOwnedSession } from '@/lib/auth/password-client';
import { isRetryableAuthError } from '@/lib/auth/session';
import { signInSchema, fieldErrors } from '@/lib/validation';
import { Smartphone } from 'lucide-react';
import { OAuthButtons, authButtonClass } from '@/components/auth/oauth-buttons';
import { PhoneAuth } from '@/components/auth/phone-auth';
import { LegalConsent } from '@/components/auth/legal-consent';
import { resolveLandingPathAction, stitchIdentityAction } from '@/app/(auth)/actions';
import { describeDbError } from '@/lib/supabase/errors';
import { authScreenHref, resolveAuthSelection } from '@/lib/billing/review-selection';
import { useTranslations } from '@/components/i18n/locale-provider';
import { RecoveryForm } from '@/components/auth/recovery-form';

export function LoginForm() {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [showPhone, setShowPhone] = useState(false);
  const [recoveryLink, setRecoveryLink] = useState(false);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const phase = useRef<'idle' | 'pending' | 'complete'>('idle');
  useLayoutEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (fragment.get('type') === 'recovery' || fragment.has('access_token') || fragment.has('refresh_token')) setRecoveryLink(true);
  }, []);
  // A same-origin ?redirect= (e.g. an invite's /join?token=…) that OAuth + phone
  // sign-in must also honor — not just the password path below.
  const selection = resolveAuthSelection(params);
  const redirectDest = selection.next ?? undefined;
  const recovery = recoveryLink || params.get('reset') === '1';
  const intent = useMemo(() => ({ redirectDest, showPhone, recovery }), [redirectDest, showPhone, recovery]);
  const currentIntent = useRef(intent);
  useLayoutEffect(() => {
    if (currentIntent.current !== intent) {
      currentIntent.current = intent;
      attempt.current += 1;
      phase.current = 'idle';
      setLoading(false);
      setErrors({});
    }
  }, [intent]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current += 1; };
  }, []);
  // The /auth/callback route bounces failed OAuth / email-confirmation here.
  const authError = params.get('error') === 'auth';

  function retirePasswordAttempt() {
    if (!mounted.current || currentIntent.current !== intent) return false;
    attempt.current += 1;
    phase.current = 'idle';
    setLoading(false);
    return true;
  }

  function retireForNavigation(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    retirePasswordAttempt();
  }

  function retireForOAuth(event: React.MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    const button = (event.target as Element).closest('button');
    if (button && event.currentTarget.contains(button) && !button.disabled) retirePasswordAttempt();
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!mounted.current || currentIntent.current !== intent || intent.showPhone || intent.recovery || phase.current !== 'idle') return;
    setErrors({});
    const form = new FormData(e.currentTarget);
    const input = { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') };
    const parsed = signInSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    phase.current = 'pending';
    const thisAttempt = ++attempt.current;
    const isCurrentAttempt = () => mounted.current && currentIntent.current === intent && attempt.current === thisAttempt;
    let signedIn: Session | null = null;
    const ownsSession = () => isCurrentAttempt() && !!signedIn && isPasswordSessionCurrent(signedIn);
    setLoading(true);
    try {
      const { data, error } = await signInWithOwnedSession(parsed.data, isCurrentAttempt);
      if (!isCurrentAttempt()) return;
      if (error) throw error;
      if (!data?.user || !data.session || typeof data.user.id !== 'string' || !data.user.id || data.session.user?.id !== data.user.id
        || typeof data.session.access_token !== 'string' || !data.session.access_token.trim()
        || typeof data.session.refresh_token !== 'string' || !data.session.refresh_token.trim()) {
        throw new Error(t('loginForm.couldNotSignIn'));
      }
      signedIn = data.session;
      if (!ownsSession()) return;
      // Attribute the anonymous visitor spine to this now-known user (best-effort).
      void Promise.resolve().then(() => { if (ownsSession()) return stitchIdentityAction(); }).catch(() => {});
      // Resolve server-side so super admins (DB seed OR env/code allowlist)
      // land on the admin console even before migration 0008 is applied.
      const destination = redirectDest || (await resolveLandingPathAction());
      if (!ownsSession()) return;
      phase.current = 'complete';
      router.push(destination);
      if (ownsSession()) router.refresh();
    } catch (err) {
      if (!isCurrentAttempt() || (signedIn && !ownsSession())) return;
      phase.current = 'idle';
      toastError(isRetryableAuthError(err) ? t('loginForm.couldNotSignIn') : describeDbError(err, t('loginForm.couldNotSignIn')));
    } finally {
      if (isCurrentAttempt() && phase.current !== 'complete') {
        phase.current = 'idle';
        setLoading(false);
      }
    }
  }

  if (recovery) return <RecoveryForm request={!recoveryLink} />;

  return (
    <div className="glass-card p-7 animate-fade-in sm:p-8">
      <h1 className="text-2xl font-bold tracking-tight">{t('login.welcomeBack')}</h1>
      <p className="mt-1 text-sm text-muted">{t('login.signInToYourFamily')}</p>

      {authError && (
        <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger">
          {t('login.weCouldntFinishSigningYouIn')}
        </p>
      )}

      {showPhone ? (
        <div className="mt-6">
          <PhoneAuth next={redirectDest ?? '/dashboard'} onBack={() => { if (retirePasswordAttempt()) setShowPhone(false); }} />
        </div>
      ) : (
      <>
      {/* Phone-first: the number is the primary way in, then Google. */}
      <button
        type="button"
        onClick={() => { if (retirePasswordAttempt()) setShowPhone(true); }}
        className={`mt-6 ${authButtonClass}`}
      >
        <Smartphone className="h-[18px] w-[18px]" /> {t('login.continueWithPhone')}
      </button>

      <div className="mt-3" onClickCapture={retireForOAuth}>
        <OAuthButtons next={redirectDest} />
      </div>

      <div className="relative my-5 flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-muted">{t('login.orUseEmail')}</span>
        <div className="flex-1 border-t border-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <fieldset disabled={loading} className="min-w-0 space-y-4">
        <Field label={t('login.email')} error={errors.email} required>
          {(id) => <Input id={id} name="email" type="email" autoComplete="email" placeholder="you@example.com" />}
        </Field>
        <Field label={t('login.password')} error={errors.password} required>
          {(id) => <Input id={id} name="password" type="password" autoComplete="current-password" placeholder="••••••••" />}
        </Field>
        <Button type="submit" loading={loading} className="w-full">{t('login.signIn')}</Button>
        </fieldset>
      </form>
      <Link href="/login?reset=1" onClick={retireForNavigation} className="mt-3 block text-sm font-medium text-brand-text hover:underline">{t('authRecovery.forgotPassword')}</Link>
      </>
      )}

      <LegalConsent className="mt-5 text-center text-xs leading-5 text-muted" />

      <p className="mt-5 text-center text-sm text-muted">
        {t('login.newHere')}{' '}
        <Link href={authScreenHref('/signup', selection)} onClick={retireForNavigation} className="font-medium text-brand-text hover:underline">{t('login.createAnAccount')}</Link>
      </p>
      <p className="mt-2 text-center text-sm text-muted">
        {t('login.kidLoggingIn')}{' '}
        <Link href="/kid-login" onClick={retireForNavigation} className="font-medium text-brand-text hover:underline">{t('login.useYourUsernameAmpPin')}</Link>
      </p>
    </div>
  );
}
