'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Cookie } from 'lucide-react';

const KEY = 'bubaly-cookie-consent';

/**
 * A lightweight, non-blocking cookie notice for the public marketing site.
 * Bubaly uses only essential + privacy-respecting analytics cookies (no ad
 * trackers), so this is an acknowledgement, not a consent gate. Shown once;
 * the choice is remembered in localStorage. Renders nothing until mounted to
 * avoid a hydration flash.
 */
export function CookieConsent() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(KEY)) setVisible(true);
    } catch {
      /* storage blocked — don't nag */
    }
  }, []);

  function dismiss() {
    try { localStorage.setItem(KEY, String(Date.now())); } catch { /* ignore */ }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Cookie notice"
      className="animate-fade-in-up fixed inset-x-3 bottom-3 z-50 mx-auto max-w-2xl rounded-2xl border border-border bg-surface/95 p-4 shadow-glass backdrop-blur sm:inset-x-auto sm:right-4 sm:bottom-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
          <Cookie className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">We value your privacy</p>
          <p className="mt-1 text-xs leading-5 text-muted">
            Bubaly uses essential cookies to keep you signed in, plus privacy-respecting
            analytics to improve the product. We don&apos;t use advertising trackers. See our{' '}
            <Link href="/cookies" className="font-medium text-brand hover:underline">Cookie Policy</Link>{' '}
            and{' '}
            <Link href="/privacy" className="font-medium text-brand hover:underline">Privacy Policy</Link>.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={dismiss}
              className="rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-brand-fg transition hover:opacity-90"
            >
              Got it
            </button>
            <Link
              href="/cookies"
              onClick={dismiss}
              className="rounded-lg border border-border px-4 py-2 text-xs font-semibold transition hover:bg-elevated"
            >
              Learn more
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
