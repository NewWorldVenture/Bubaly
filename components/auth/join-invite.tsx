'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PartyPopper, AlertTriangle, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/states';
import { createClient } from '@/lib/supabase/client';
import { useTranslations } from '@/components/i18n/locale-provider';

type State =
  | { phase: 'loading' }
  | { phase: 'needs-auth'; token: string }
  | { phase: 'accepting' }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

export function JoinInvite() {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<State>({ phase: 'loading' });
  // Accept exactly once per mount — guards the React strict-mode double effect
  // and any re-render race from clobbering a successful accept with an error.
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (!token) {
      setState({ phase: 'error', message: 'This invite link is missing its token.' });
      return;
    }
    const supabase = createClient();
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) {
        setState({ phase: 'needs-auth', token });
        return;
      }
      setState({ phase: 'accepting' });
      const { data, error } = await supabase.rpc('accept_invite', { p_token: token });
      if (error || !data) {
        setState({ phase: 'error', message: error?.message ?? 'This invite is invalid or expired.' });
        return;
      }
      setState({ phase: 'done' });
      setTimeout(() => {
        router.push('/home');
        router.refresh();
      }, 1400);
    })();
  }, [token, router]);

  if (state.phase === 'loading' || state.phase === 'accepting') {
    return <div className="glass-card p-8"><LoadingBlock label={t('joinInvite.joiningYourFamily')} /></div>;
  }

  if (state.phase === 'needs-auth') {
    const redirect = `/join?token=${encodeURIComponent(state.token)}`;
    return (
      <div className="glass-card p-8 text-center animate-fade-in">
        <LogIn className="mx-auto h-12 w-12 text-brand-text" />
        <h1 className="mt-4 text-xl font-semibold">{t('joinInvite.youveBeenInvited')}</h1>
        <p className="mt-2 text-sm text-muted">
          {t('joinInvite.signInOrCreateAnAccount')}
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Link href={`/login?redirect=${encodeURIComponent(redirect)}`}>
            <Button className="w-full">{t('joinInvite.signIn')}</Button>
          </Link>
          <Link href={`/signup?redirect=${encodeURIComponent(redirect)}`}>
            <Button variant="secondary" className="w-full">{t('joinInvite.createAccount')}</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (state.phase === 'done') {
    return (
      <div className="glass-card p-8 text-center animate-fade-in">
        <PartyPopper className="mx-auto h-12 w-12 text-success" />
        <h1 className="mt-4 text-xl font-semibold">{t('joinInvite.welcomeToTheFamily')}</h1>
        <p className="mt-2 text-sm text-muted">{t('joinInvite.takingYouToYourDashboard')}</p>
      </div>
    );
  }

  return (
    <div className="glass-card p-8 text-center animate-fade-in">
      <AlertTriangle className="mx-auto h-12 w-12 text-danger" />
      <h1 className="mt-4 text-xl font-semibold">{t('joinInvite.inviteProblem')}</h1>
      <p className="mt-2 text-sm text-muted">{state.message}</p>
      <Link href="/dashboard" className="mt-6 inline-block">
        <Button variant="secondary">{t('joinInvite.goToDashboard')}</Button>
      </Link>
    </div>
  );
}
