'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff, Loader2, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { normalizePin } from '@/lib/onboarding/pin';
import { normalizeUsername } from '@/lib/onboarding/child-login';
import { childSignInAction } from '@/app/(auth)/actions';

export function KidLoginForm() {
  const router = useRouter();
  const { error: toastError } = useToast();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const res = await childSignInAction({ username: normalizeUsername(username), pin });
    setLoading(false);
    if (!res.ok) { toastError(res.error); return; }
    router.push('/home');
    router.refresh();
  }

  return (
    <div className="glass-card p-7 animate-fade-in sm:p-8">
      <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-brand/15 text-brand-text">
        <Sparkles className="h-6 w-6" />
      </div>
      <h1 className="text-center text-2xl font-bold tracking-tight">Kid sign in</h1>
      <p className="mt-1 text-center text-sm text-muted">Enter your username and PIN — no email needed.</p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4" noValidate>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder="e.g. emma"
            className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-base focus-visible:focus-ring"
          />
        </label>
        <div className="block">
          <label htmlFor="kid-login-pin" className="mb-1 block text-sm font-medium">4-digit PIN</label>
          <div className="relative">
            <input
              id="kid-login-pin"
              value={pin}
              onChange={(e) => setPin(normalizePin(e.target.value))}
              inputMode="numeric" type={showPin ? 'text' : 'password'} placeholder="••••"
              className="h-12 w-full rounded-xl border border-border bg-bg px-12 text-center text-lg tracking-[0.5em] focus-visible:focus-ring"
            />
            <button type="button" onClick={() => setShowPin((v) => !v)} aria-label={showPin ? 'Hide PIN' : 'Show PIN'}
              className="focus-visible:focus-ring absolute right-1 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-fg">
              {showPin ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>
        <Button type="submit" disabled={loading || username.trim().length < 3 || pin.length !== 4} className="w-full">
          {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null} Sign in
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-muted">
        Grown-up?{' '}
        <Link href="/login" className="font-medium text-brand-text hover:underline">Sign in here</Link>
      </p>
    </div>
  );
}
