'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { normalizePin } from '@/lib/onboarding/pin';
import { isValidUsername, normalizeUsername } from '@/lib/onboarding/child-login';
import { childSignInAction } from '@/app/(auth)/actions';
import { useTranslations } from '@/components/i18n/locale-provider';
import { isPasswordSessionCurrent, signInWithOwnedSessionTokens } from '@/lib/auth/password-client';

export function KidLoginForm() {
  const t = useTranslations();
  const router = useRouter();
  const { error: toastError } = useToast();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(false);
  const attempt = useRef(0);
  const phase = useRef<'idle' | 'pending' | 'complete'>('idle');
  useLayoutEffect(() => {
    const lifetime = attempt;
    mounted.current = true;
    return () => { mounted.current = false; lifetime.current++; };
  }, []);

  function retire(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    attempt.current++;
    phase.current = 'complete';
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!mounted.current || phase.current !== 'idle') return;
    const form = new FormData(e.currentTarget);
    const normalized = normalizeUsername(String(form.get('username') ?? ''));
    const submittedPin = String(form.get('pin') ?? '');
    if (!isValidUsername(normalized) || !/^\d{4}$/.test(submittedPin)) {
      toastError(t('actions.checkTheUsernameAndPin'));
      return;
    }
    phase.current = 'pending';
    const id = ++attempt.current;
    const current = () => mounted.current && attempt.current === id && phase.current === 'pending';
    setLoading(true);
    let actionError: string | null = null;
    try {
      const { data, error } = await signInWithOwnedSessionTokens(async () => {
        if (!current()) throw new Error(t('actions.kidSignInIsTemporarily'));
        const result = await childSignInAction({ username: normalized, pin: submittedPin });
        if (!current()) throw new Error(t('actions.kidSignInIsTemporarily'));
        if (!result.ok) { actionError = result.error; throw new Error(result.error); }
        return result.tokens;
      }, current);
      if (!current()) return;
      if (error) throw error;
      if (!data.session || !data.user || data.session.user.id !== data.user.id || !isPasswordSessionCurrent(data.session)) {
        throw new Error(t('actions.kidSignInIsTemporarily'));
      }
      phase.current = 'complete';
      router.push('/home');
      if (mounted.current && attempt.current === id && isPasswordSessionCurrent(data.session)) router.refresh();
    } catch {
      if (current()) toastError(actionError ?? t('actions.kidSignInIsTemporarily'));
    } finally {
      if (current()) { phase.current = 'idle'; setLoading(false); }
    }
  }

  return (
    <div className="glass-card p-7 animate-fade-in sm:p-8">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 text-brand-text">
        <Sparkles className="h-6 w-6" />
      </div>
      <h1 className="text-center text-2xl font-bold tracking-tight">{t('kidLogin.kidSignIn')}</h1>
      <p className="mt-1 text-center text-sm text-muted">{t('kidLogin.enterYourUsernameAndPinNo')}</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <label htmlFor="kid-login-username" className="block">
          <span className="mb-1 block text-sm font-medium">{t('kidLogin.username')}</span>
          <input
            id="kid-login-username" name="username" autoComplete="username"
            value={username}
            onChange={(e) => { if (phase.current === 'idle') setUsername(e.target.value); }}
            disabled={loading}
            autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder={t('kidLogin.eGEmma')}
            className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-base focus-visible:focus-ring"
          />
        </label>
        <div className="block">
          <label htmlFor="kid-login-pin" className="mb-1 block text-sm font-medium">{t('kidLogin.4DigitPin')}</label>
          <div className="relative">
            <input
              id="kid-login-pin"
              name="pin" autoComplete="current-password"
              value={pin}
              onChange={(e) => { if (phase.current === 'idle') setPin(normalizePin(e.target.value)); }}
              disabled={loading}
              inputMode="numeric" type={showPin ? 'text' : 'password'} placeholder="••••"
              className="h-12 w-full rounded-xl border border-border bg-bg px-12 text-center text-lg tracking-[0.5em] focus-visible:focus-ring"
            />
            <button type="button" disabled={loading} onClick={() => setShowPin((v) => !v)} aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
              className="focus-visible:focus-ring absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg">
              {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <Button type="submit" disabled={loading || username.trim().length < 3 || pin.length !== 4} className="w-full">
          {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} {t('kidLogin.signIn')}
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-muted">
        Grown-up?{' '}
        <Link href="/login" onClick={retire} className="font-medium text-brand-text hover:underline">{t('kidLogin.signInHere')}</Link>
      </p>
    </div>
  );
}
