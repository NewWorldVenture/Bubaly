'use client';

import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from '@/components/i18n/locale-provider';
import { captureSignOutIntent, isBrowserSignedOut, signOutBrowserSession, type SignOutIntent } from '@/lib/auth/browser-signout';

type State = 'ready' | 'signed-out' | 'session-changed' | 'unavailable' | 'reviewed';

/** The decision belongs to the session shown when this control was opened. */
export function SignOutForm({ className, children }: {
  className?: string;
  children: ReactNode | ((state: { signingOut: boolean }) => ReactNode);
}) {
  const t = useTranslations();
  const router = useRouter();
  const mounted = useRef(false);
  const initialized = useRef(false);
  const intent = useRef<SignOutIntent | null>(null);
  const submitted = useRef(false);
  const currentGeneration = useRef(0);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<State>('ready');

  useLayoutEffect(() => {
    mounted.current = true;
    if (!initialized.current) {
      initialized.current = true;
      intent.current = captureSignOutIntent();
    }
    return () => { mounted.current = false; };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!mounted.current || generation !== currentGeneration.current || submitted.current) return;
    submitted.current = true;
    const result = intent.current ? signOutBrowserSession(intent.current) : { status: 'unavailable' as const };
    if (!mounted.current) return;
    if (result.status !== 'signed-out') {
      setState(result.status);
      return;
    }
    // Local removal is synchronous. A later provider response must never move
    // a newly signed-in account away from its page.
    setState('signed-out');
    if (isBrowserSignedOut()) {
      router.replace('/login');
      router.refresh();
    } else {
      setState('session-changed');
    }
  }

  function review() {
    if (!mounted.current || generation !== currentGeneration.current) return;
    intent.current = captureSignOutIntent();
    submitted.current = false;
    currentGeneration.current += 1;
    setGeneration(currentGeneration.current);
    setState(intent.current ? 'reviewed' : 'unavailable');
  }

  const signingOut = state === 'signed-out';
  const notice = state === 'session-changed' ? 'signOutButton.sessionChanged'
    : state === 'unavailable' ? 'signOutButton.sessionUnavailable'
      : state === 'reviewed' ? 'signOutButton.sessionReviewed' : null;

  return (
    <form action="/auth/signout" method="post" onSubmit={submit} className={className} aria-busy={signingOut}>
      {typeof children === 'function' ? children({ signingOut }) : children}
      {notice && (
        <div className="basis-full text-sm text-muted" role={state === 'reviewed' ? 'status' : 'alert'}>
          <p>{t(notice)}</p>
          {state !== 'reviewed' && (
            <button type="button" onClick={review} className="mt-2 text-sm font-medium text-brand-text underline focus-ring">
              {t('signOutButton.reviewSession')}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
