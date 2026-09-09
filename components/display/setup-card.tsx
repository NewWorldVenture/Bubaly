'use client';

// components/display/setup-card.tsx — the dismissible "Set up this tablet" card.
//
// Shown once, at the top of the wall, until somebody dismisses it. The dismissal
// is stored in `display_layouts.settings.setupDismissed` (the same jsonb blob
// the rest of the display preferences already live in, normalized through
// `normalizeSettings`), so it is per FAMILY and survives the tablet being
// reloaded, re-installed or replaced — not a localStorage flag that comes back
// the first time somebody clears the browser.
//
// The wake-lock line is a MEASUREMENT, not a promise: it says "keeping this
// screen awake" only while a sentinel is actually held, and says so plainly
// when the browser has no Wake Lock API at all.

import Link from 'next/link';
import { Check, ExternalLink, Loader2, Monitor, X } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import type { WakeLockState } from '@/lib/display/wake-lock';

/** Matches `<AutoRefresh seconds={120} />` in app/(app)/display/page.tsx. */
export const DISPLAY_REFRESH_SECONDS = 120;

function wakeLockLine(state: WakeLockState): string {
  switch (state) {
    case 'active': return 'displaySetupCard.wakeLockActive';
    case 'blocked': return 'displaySetupCard.wakeLockBlocked';
    case 'unsupported': return 'displaySetupCard.wakeLockUnsupported';
    default: return 'displaySetupCard.wakeLockIdle';
  }
}

export function DisplaySetupCard({
  wakeLock,
  onDismiss,
  dismissing = false,
}: {
  wakeLock: WakeLockState;
  onDismiss: () => void;
  dismissing?: boolean;
}) {
  const t = useTranslations();
  const steps = [
    t('displaySetupCard.stepHomeScreen'),
    t('displaySetupCard.stepFullscreen'),
    t('displaySetupCard.stepPinning'),
    t('displaySetupCard.stepRefresh', { seconds: DISPLAY_REFRESH_SECONDS }),
  ];

  return (
    <section
      aria-label={t('displaySetupCard.setUpThisTablet')}
      className="relative mt-4 shrink-0 rounded-3xl border border-white/12 bg-white/[0.07] p-5 backdrop-blur-xl"
    >
      <button
        type="button"
        onClick={onDismiss}
        disabled={dismissing}
        aria-label={t('displaySetupCard.dismiss')}
        className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full text-white/60 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
      >
        {dismissing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
      </button>

      <div className="flex items-start gap-3 pr-10">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-white/10">
          <Monitor className="h-5 w-5 text-white" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-white">{t('displaySetupCard.setUpThisTablet')}</h2>
          <p className="mt-1 text-sm text-white/60">{t('displaySetupCard.intro')}</p>

          <ul className="mt-3 space-y-1.5 text-sm text-white/75">
            {steps.map((step) => (
              <li key={step} className="flex items-start gap-2">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-300" aria-hidden />
                <span>{step}</span>
              </li>
            ))}
          </ul>

          <p className="mt-3 text-xs font-medium text-white/55">{t(wakeLockLine(wakeLock))}</p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Link
              href="/display/setup"
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/25"
            >
              {t('displaySetupCard.openTheGuide')} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={onDismiss}
              disabled={dismissing}
              className="inline-flex min-h-11 items-center rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10 disabled:opacity-50"
            >
              {t('displaySetupCard.gotIt')}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
