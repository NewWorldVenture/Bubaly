'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { GoogleIcon } from '@/components/auth/google-icon';
import { AppleIcon } from '@/components/auth/apple-icon';

type Provider = 'google' | 'apple';

/**
 * Google + Apple sign-in buttons, shared by the login and signup screens.
 * `next` is where the OAuth callback should send the user after auth
 * (e.g. '/onboarding' for sign-up, '/dashboard' for sign-in).
 */
export function OAuthButtons({ next }: { next?: string }) {
  const { error: toastError } = useToast();
  const [pending, setPending] = useState<Provider | null>(null);

  async function signInWith(provider: Provider) {
    if (pending) return;
    setPending(provider);
    try {
      const supabase = createClient();
      const nextParam = next ? `?next=${encodeURIComponent(next)}` : '';
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: `${window.location.origin}/auth/callback${nextParam}`,
          // Google benefits from offline access for calendar sync; Apple ignores these.
          ...(provider === 'google'
            ? { queryParams: { access_type: 'offline', prompt: 'consent' } }
            : {}),
        },
      });
      if (error) throw error;
      // On success the browser is redirected to the provider — keep the spinner.
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Could not continue with ${provider}`;
      // Surface a clearer hint when the provider isn't enabled in Supabase yet.
      toastError(/provider is not enabled|unsupported provider/i.test(msg)
        ? `${provider === 'apple' ? 'Apple' : 'Google'} sign-in isn't enabled yet. Try email instead.`
        : msg);
      setPending(null);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => signInWith('google')}
        disabled={pending !== null}
        className="flex w-full items-center justify-center gap-3 rounded-xl border border-border bg-surface/60 px-4 py-3 text-sm font-semibold transition hover:bg-elevated disabled:opacity-60"
      >
        {pending === 'google' ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <GoogleIcon />}
        Continue with Google
      </button>
      <button
        type="button"
        onClick={() => signInWith('apple')}
        disabled={pending !== null}
        className="flex w-full items-center justify-center gap-3 rounded-xl border border-border bg-fg px-4 py-3 text-sm font-semibold text-bg transition hover:opacity-90 disabled:opacity-60"
      >
        {pending === 'apple' ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <AppleIcon className="h-[18px] w-[18px]" />}
        Continue with Apple
      </button>
    </div>
  );
}
