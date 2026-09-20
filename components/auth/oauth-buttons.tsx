'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { signInWithOwnedOAuth } from '@/lib/auth/pkce-initiation-client';
import { useToast } from '@/components/ui/toast';
import { GoogleIcon } from '@/components/auth/google-icon';
import { useTranslations } from '@/components/i18n/locale-provider';

// Shared style for every auth provider button (Google · phone · email) so the
// sign-in / sign-up screens are visually unified — a solid black pill with a
// white label.
export const authButtonClass =
  'flex w-full items-center justify-center gap-3 rounded-xl border border-white/10 bg-black px-4 py-3.5 text-sm font-semibold text-white transition hover:bg-zinc-900 disabled:opacity-60';

/**
 * Google sign-in button, shared by the login and signup screens.
 * `next` is where the OAuth callback should send the user after auth
 * (e.g. '/onboarding' for sign-up, '/dashboard' for sign-in).
 */
export function OAuthButtons({ next }: { next?: string }) {
  const t = useTranslations();
  const { error: toastError } = useToast();
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const busy = useRef(false);
  const attempt = useRef(0);
  const currentNext = useRef(next);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; attempt.current += 1; };
  }, []);
  useLayoutEffect(() => {
    if (currentNext.current !== next) {
      currentNext.current = next;
      attempt.current += 1;
      busy.current = false;
      setPending(false);
    }
  }, [next]);

  async function signInWithGoogle() {
    if (!mounted.current || currentNext.current !== next || busy.current) return;
    busy.current = true;
    const thisAttempt = ++attempt.current;
    const canCommit = () => mounted.current && currentNext.current === next && attempt.current === thisAttempt;
    setPending(true);
    try {
      await signInWithOwnedOAuth(next, canCommit);
      // On success the browser is redirected to the provider — keep the spinner.
    } catch (err) {
      if (!canCommit()) return;
      busy.current = false;
      setPending(false);
      if (err instanceof Error && err.name === 'AuthSessionInterruptedError') return;
      const msg = err instanceof Error ? err.message : 'Could not continue with Google';
      // Surface a clearer hint when the provider isn't enabled in Supabase yet.
      toastError(/provider is not enabled|unsupported provider/i.test(msg)
        ? "Google sign-in isn't enabled yet. Try email instead."
        : msg);
    }
  }

  return (
    <button
      type="button"
      onClick={signInWithGoogle}
      disabled={pending}
      className={authButtonClass}
    >
      {pending ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <GoogleIcon />}
      {t('oauthButtons.continueWithGoogle')}
    </button>
  );
}
