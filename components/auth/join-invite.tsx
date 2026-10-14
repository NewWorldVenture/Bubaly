'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PartyPopper, AlertTriangle, LogIn, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LoadingBlock } from '@/components/ui/states';
import { createClient } from '@/lib/supabase/client';
import { resolveLandingPathAction } from '@/app/(auth)/actions';
import { previewInviteAction, settleOtherInvitesAction } from '@/app/join/actions';
import { useTranslations } from '@/components/i18n/locale-provider';
import { isChildLoginEmail } from '@/lib/onboarding/child-login';

type State =
  | { phase: 'loading' }
  | { phase: 'needs-auth'; token: string }
  | { phase: 'confirm'; familyName: string; roleLabel: string }
  | { phase: 'accepting' }
  | { phase: 'done' }
  | { phase: 'error'; message: string };

export function JoinInvite() {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<State>({ phase: 'loading' });
  // Look the invite up exactly once per mount — guards the React strict-mode
  // double effect and any re-render race from clobbering a later state.
  const fired = useRef(false);
  // Accept exactly once per click, however fast it is pressed.
  const accepting = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    if (!token) {
      setState({ phase: 'error', message: t('joinInvite.missingToken') });
      return;
    }
    const supabase = createClient();
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) {
        setState({ phase: 'needs-auth', token });
        return;
      }
      // A kid login stays in the family that made it. Its address is guessable
      // from the username, so any household can invite it; refuse here, before
      // the database is asked, rather than enrol a child elsewhere because they
      // opened a link.
      if (isChildLoginEmail(auth.user.email)) {
        setState({ phase: 'error', message: t('joinInvite.aKidLoginCannotJoin') });
        return;
      }
      // Nothing is accepted on load. This page used to call accept_invite the
      // moment it rendered, so a site that redirected a signed-in person here
      // enrolled them in the inviting family without a click. It shows who is
      // inviting them, and as what, and waits for "Accept invitation".
      const preview = await previewInviteAction(token).catch(() => null);
      if (!preview) { setState({ phase: 'error', message: t('joinInvite.couldNotJoinTryAgain') }); return; }
      if (!preview.ok) {
        if (preview.reason === 'signed_out') { setState({ phase: 'needs-auth', token }); return; }
        setState({ phase: 'error', message: preview.reason === 'kid_login' ? t('joinInvite.aKidLoginCannotJoin')
          : preview.reason === 'different_email' ? t('joinInvite.inviteIsForADifferentEmail')
          : preview.reason === 'unavailable' ? t('joinInvite.couldNotJoinTryAgain')
          : t('joinInvite.inviteIsInvalidOrExpired') });
        return;
      }
      setState({ phase: 'confirm', familyName: preview.familyName, roleLabel: preview.roleLabel });
    })();
  }, [token, t]);

  async function accept() {
    if (accepting.current) return;
    accepting.current = true;
    setState({ phase: 'accepting' });
    const supabase = createClient();
    const { data, error } = await supabase.rpc('accept_invite', { p_token: token });
    if (error || !data) {
      accepting.current = false;
      // accept_invite raises two things a person can act on (P0001); they are
      // said in the reader's language rather than as the database's English.
      // Anything else never reached the function — a network or server fault.
      const raised = !error || error.code === 'P0001';
      const message = !raised ? t('joinInvite.couldNotJoinTryAgain')
        : /different email/i.test(error?.message ?? '') ? t('joinInvite.inviteIsForADifferentEmail')
        : /cannot join another family/i.test(error?.message ?? '') ? t('joinInvite.aKidLoginCannotJoin')
        : t('joinInvite.inviteIsInvalidOrExpired');
      setState({ phase: 'error', message });
      return;
    }
    // Any other invite to this address for this family is closed now that one
    // was accepted: left pending, it would let them back in after a removal.
    // Best-effort; the join stands either way.
    await settleOtherInvitesAction().catch(() => null);
    setState({ phase: 'done' });
    // M28: a guest — the role an extended-family invite uses — belongs on the
    // simplified Grandparent Portal rather than the full concierge Home. The
    // role is read on the server from the membership the RPC just created, so
    // the browser cannot choose its own landing.
    const landing = await resolveLandingPathAction().catch(() => '/home');
    setTimeout(() => {
      router.push(landing);
      router.refresh();
    }, 1400);
  }

  if (state.phase === 'loading' || state.phase === 'accepting') {
    return <div className="glass-card p-8"><LoadingBlock label={t('joinInvite.joiningYourFamily')} /></div>;
  }

  if (state.phase === 'confirm') {
    return (
      <div className="glass-card p-8 text-center animate-fade-in">
        <Users className="mx-auto h-12 w-12 text-brand-text" />
        <h1 className="mt-4 text-xl font-semibold">{t('joinInvite.youveBeenInvited')}</h1>
        <p className="mt-2 text-sm text-muted">
          {t('joinInvite.inviteToJoinAs', { family: state.familyName, role: state.roleLabel })}
        </p>
        <p className="mt-2 text-xs text-muted">{t('joinInvite.joiningSharesYourProfile')}</p>
        <div className="mt-6 flex flex-col gap-3">
          <Button className="w-full" onClick={accept}>{t('joinInvite.acceptInvitation')}</Button>
          <Link href="/dashboard" className="text-sm font-medium text-muted hover:text-fg">{t('joinInvite.notNow')}</Link>
        </div>
      </div>
    );
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
