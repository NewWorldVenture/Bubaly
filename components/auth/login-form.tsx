'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { createClient } from '@/lib/supabase/client';
import { signInSchema, fieldErrors } from '@/lib/validation';
import { GoogleIcon } from '@/components/auth/google-icon';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = new FormData(e.currentTarget);
    const input = { email: String(form.get('email') ?? ''), password: String(form.get('password') ?? '') };
    const parsed = signInSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword(parsed.data);
      if (error) throw error;
      const redirect = params.get('redirect') || '/dashboard';
      router.push(redirect);
      router.refresh();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setLoading(false);
    }
  }

  async function signInWithGoogle() {
    setGoogleLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
    if (error) {
      toastError(error.message);
      setGoogleLoading(false);
    }
  }

  return (
    <div className="glass-card p-7 animate-fade-in">
      <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
      <p className="mt-1 text-sm text-muted">Sign in to your family.</p>

      <button
        onClick={signInWithGoogle}
        disabled={googleLoading}
        className="mt-6 flex w-full items-center justify-center gap-3 rounded-xl border border-border bg-surface/60 px-4 py-2.5 text-sm font-medium transition hover:bg-elevated disabled:opacity-60"
      >
        <GoogleIcon />
        {googleLoading ? 'Redirecting…' : 'Continue with Google'}
      </button>

      <div className="relative my-5 flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-muted">or</span>
        <div className="flex-1 border-t border-border" />
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" error={errors.email} required>
          {(id) => <Input id={id} name="email" type="email" autoComplete="email" placeholder="you@example.com" />}
        </Field>
        <Field label="Password" error={errors.password} required>
          {(id) => <Input id={id} name="password" type="password" autoComplete="current-password" placeholder="••••••••" />}
        </Field>
        <Button type="submit" loading={loading} className="w-full">Sign in</Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted">
        New here?{' '}
        <Link href="/signup" className="font-medium text-brand hover:underline">Create an account</Link>
      </p>
    </div>
  );
}
