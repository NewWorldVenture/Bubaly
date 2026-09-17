'use client';

import { useEffect, useState } from 'react';
import { useDialogBehavior } from '@/lib/hooks/use-dialog-behavior';
import { X } from 'lucide-react';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';
import { useTranslations } from '@/components/i18n/locale-provider';

type Offer = {
  id: string;
  headline: string;
  body: string | null;
  cta_label: string | null;
  cta_href: string | null;
  trigger: { mode: 'mouseleave' | 'scroll'; delayMs: number; scrollPercent: number };
};

const SEEN_KEY = 'bubaly-ei-seen'; // at most one exit-intent per visitor per window
const SEEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function recentlySeen(): boolean {
  try {
    const ts = Number(localStorage.getItem(SEEN_KEY) ?? '0');
    return ts > 0 && Date.now() - ts < SEEN_WINDOW_MS;
  } catch { return false; }
}

/**
 * Mounts on the public marketing site. Resolves the best exit-intent offer for
 * this visitor, then shows it once (per 7-day window) on mouseleave or after a
 * scroll threshold. Records an impression on show and a conversion on CTA click
 * via /api/exit-intent/track.
 */
export function ExitIntent() {
  const t = useTranslations();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [open, setOpen] = useState(false);

  // Lock background scroll while the offer modal is showing (mobile scroll-bleed).
  useLockBodyScroll(Boolean(offer) && open);

  // ESC closes the offer (keyboard parity with the scrim click + close button).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Resolve once on mount (skip entirely if we've shown one recently).
  useEffect(() => {
    if (recentlySeen()) return;
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    const isReturning = (() => { try { return localStorage.getItem('bubaly-visited') === '1'; } catch { return false; } })();
    try { localStorage.setItem('bubaly-visited', '1'); } catch { /* ignore */ }

    fetch('/api/exit-intent/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: window.location.pathname,
        source: params.get('utm_source'),
        medium: params.get('utm_medium'),
        campaign: params.get('utm_campaign'),
        returning: isReturning,
      }),
    })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d?.offer) setOffer(d.offer as Offer); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Arm the trigger once we have an offer.
  useEffect(() => {
    if (!offer) return;
    const armedAt = Date.now();
    let done = false;

    const fire = () => {
      if (done || recentlySeen()) return;
      done = true;
      try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch { /* ignore */ }
      setOpen(true);
      track(offer.id, 'impression');
    };

    const onMouseOut = (e: MouseEvent) => {
      if (Date.now() - armedAt < offer.trigger.delayMs) return;
      if (e.clientY <= 0 && !e.relatedTarget) fire();
    };
    const onScroll = () => {
      if (Date.now() - armedAt < offer.trigger.delayMs) return;
      const h = document.documentElement;
      const pct = (h.scrollTop + window.innerHeight) / (h.scrollHeight || 1) * 100;
      if (pct >= offer.trigger.scrollPercent) fire();
    };

    if (offer.trigger.mode === 'scroll') {
      window.addEventListener('scroll', onScroll, { passive: true });
    } else {
      document.addEventListener('mouseout', onMouseOut);
      window.addEventListener('scroll', onScroll, { passive: true }); // mobile fallback
    }
    return () => {
      document.removeEventListener('mouseout', onMouseOut);
      window.removeEventListener('scroll', onScroll);
    };
  }, [offer]);

  // The REAL open condition, not a constant `true`.
  //
  // The other dialogs on this hook (NewRuleModal, ContactEditor, the photo
  // lightbox) are conditionally MOUNTED by their parent, so `true` is honest
  // there. This one is always mounted and returns null below, so passing `true`
  // would lock body scroll, bind Escape and try to move focus into a ref that
  // holds null — the whole time the banner is not showing. Hooks cannot go
  // after the early return, so the condition has to be in the argument.
  const dialogRef = useDialogBehavior<HTMLDivElement>(Boolean(offer) && open, () => setOpen(false));

  if (!offer || !open) return null;

  return (
    // The overlay only closes on its OWN click now, which retires the panel's
    // `onClick={(e) => e.stopPropagation()}` — a handler whose whole purpose was
    // to undo this one. Escape and the focus trap come from `useDialogBehavior`.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="exit-intent-title"
        tabIndex={-1}
        className="relative w-full max-w-md rounded-2xl bg-bg p-8 text-center shadow-2xl outline-none"
      >
        <button onClick={() => setOpen(false)} aria-label={t('exitIntent.close')} className="absolute right-3 top-3 text-muted hover:text-fg">
          <X className="h-5 w-5" />
        </button>
        <h2 id="exit-intent-title" className="text-2xl font-bold">{offer.headline}</h2>
        {offer.body && <p className="mt-3 text-muted">{offer.body}</p>}
        {offer.cta_href && (
          <a
            href={offer.cta_href}
            onClick={() => track(offer.id, 'conversion')}
            className="mt-6 inline-flex rounded-xl bg-brand px-6 py-3 font-semibold text-brand-fg hover:bg-brand/90"
          >
            {offer.cta_label || 'Get started'}
          </a>
        )}
      </div>
    </div>
  );
}

function track(id: string, kind: 'impression' | 'conversion') {
  try {
    fetch('/api/exit-intent/track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, kind }),
      keepalive: true,
    }).catch(() => {});
  } catch { /* ignore */ }
}
