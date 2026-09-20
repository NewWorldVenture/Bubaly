'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SignOutForm } from './sign-out-form';
import { signOutBrowserSession, isBrowserSignedOut } from '@/lib/auth/browser-signout';
import type { SignOutBridge } from '@/lib/auth/signout-bridge';
import { useTranslations } from '@/components/i18n/locale-provider';
import { Button } from '@/components/ui/button';

export function SignOutCompletion({ bridge }: { bridge: SignOutBridge | null }) {
  const t = useTranslations();
  const router = useRouter();
  const attempted = useRef(false);
  const [status, setStatus] = useState<'session-changed' | 'unavailable' | null>(null);
  useLayoutEffect(() => {
    if (attempted.current || !bridge?.intent || bridge.expiresAt <= Date.now()) return;
    attempted.current = true;
    const result = signOutBrowserSession(bridge.intent, { revoke: false, revocation: bridge.revocation });
    if (result.status === 'signed-out' && isBrowserSignedOut()) {
      router.replace('/login');
      router.refresh();
    } else setStatus(result.status === 'session-changed' ? 'session-changed' : 'unavailable');
  }, [bridge, router]);
  return (
    <div className="glass-card p-8">
      <h1 className="text-xl font-semibold">{t('signOutButton.signOut')}</h1>
      {status && <p className="mt-3 text-sm text-muted" role="status">{t(status === 'session-changed' ? 'signOutButton.sessionChanged' : 'signOutButton.sessionUnavailable')}</p>}
      <SignOutForm className="mt-6">
        {({ signingOut }) => <Button type="submit" variant="danger" loading={signingOut}>{t('signOutButton.signOut')}</Button>}
      </SignOutForm>
      <Link className="mt-4 block text-sm text-brand-text" href="/home">{t('stepUp.continue')}</Link>
      <noscript><p className="mt-3 text-sm">{t('signOutButton.javascriptRequired')}</p></noscript>
    </div>
  );
}
