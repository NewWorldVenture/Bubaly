'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { X } from 'lucide-react';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useDialogBehavior } from '@/lib/a11y/use-dialog-behavior';
import { detectGPC, initialConsent, readLocalConsent } from '@/lib/marketing/visitor';

type Offer = {
  id: string;
  headline: string;
  body: string | null;
  cta_label: string | null;
  cta_href: string | null;
  trigger: { mode: 'mouseleave' | 'scroll'; delayMs: number; scrollPercent: number };
};

/** An offer, and whether visit history went into choosing it (it was asked for with `returning`). */
type Resolved = { offer: Offer; byHistory: boolean };

const SEEN_KEY = 'bubaly-ei-seen'; // at most one exit-intent per visitor per window
const VISITED_KEY = 'bubaly-visited'; // returning-visitor marker; written only with personalisation consent
const SEEN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function recentlySeen(): boolean {
  try {
    const ts = Number(localStorage.getItem(SEEN_KEY) ?? '0');
    return ts > 0 && Date.now() - ts < SEEN_WINDOW_MS;
  } catch { return false; }
}

/**
 * Whether visit history may be kept and used: personalisation consent
 * (lib/marketing/consent.ts), opt-in and off under GPC. Read afresh at every
 * decision, never cached for the life of the page: the consent banner can
 * withdraw it at any moment, and it writes the choice before anything else.
 */
function historyAllowed(): boolean {
  return (readLocalConsent()?.state ?? initialConsent(detectGPC())).personalization;
}

function forgetVisits() {
  try { localStorage.removeItem(VISITED_KEY); } catch { /* ignore */ }
}

/**
 * Mounts on the public marketing site. Resolves the best exit-intent offer for
 * this visitor, then shows it once (per 7-day window) on mouseleave or after a
 * scroll threshold. Records an impression on show and a conversion on CTA click
 * via /api/exit-intent/track.
 */
export function ExitIntent() {
  const t = useTranslations();
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [open, setOpen] = useState(false);
  // Bumped each time an offer chosen with visit history is dropped because
  // personalisation consent was withdrawn after it was asked for; the resolve
  // effect below then asks again from the page and its link alone.
  const [withdrawals, setWithdrawals] = useState(0);
  const offer = resolved?.offer ?? null;

  // Lock background scroll while the offer modal is showing (mobile scroll-bleed).
  useLockBodyScroll(Boolean(offer) && open);

  // ESC, plus the focus trap and focus restore the markup already promised with
  // `aria-modal="true"`. Scroll lock stays with useLockBodyScroll above.
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeOffer = useCallback(() => setOpen(false), []);
  // `open` alone, not `Boolean(offer) && open`: this banner is ALWAYS mounted
  // and returns null below, so the hook must not act while there is no offer to
  // show. main gates it with lockScroll: false for the same reason — a banner
  // is not a modal and must not freeze the page behind it.
  useDialogBehavior(dialogRef, Boolean(offer) && open, { onClose: closeOffer, lockScroll: false });

  // Resolve once on mount (skip entirely if we've shown one recently), and
  // again — without visit history — after a withdrawal dropped the offer.
  useEffect(() => {
    // Whether this browser has been here before is visit history, and choosing
    // an offer by it is personalisation — opt-in (lib/marketing/consent.ts) and
    // off under GPC. Without that consent the device is not marked and the
    // offer is chosen from the page and its link alone; a marker left by an
    // earlier visit is cleared rather than kept for later. Cleared BEFORE the
    // recently-seen return below: a visitor who declined is not marked for a
    // week because an offer happened to have been shown to them.
    const personalize = historyAllowed();
    if (!personalize) forgetVisits();
    if (recentlySeen()) return;
    let cancelled = false;
    const params = new URLSearchParams(window.location.search);
    let isReturning = false;
    if (personalize) {
      try { isReturning = localStorage.getItem(VISITED_KEY) === '1'; } catch { /* ignore */ }
      try { localStorage.setItem(VISITED_KEY, '1'); } catch { /* ignore */ }
    }

    fetch('/api/exit-intent/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: window.location.pathname,
        source: params.get('utm_source'),
        medium: params.get('utm_medium'),
        campaign: params.get('utm_campaign'),
        ...(personalize ? { returning: isReturning } : {}),
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        // Consent can be withdrawn while the answer is in flight. Then the
        // marker written above goes, and an offer chosen with the history it
        // carried is not armed: the page asks again without it.
        if (personalize && !historyAllowed()) {
          forgetVisits();
          if (d?.offer) setWithdrawals((n) => n + 1);
          return;
        }
        if (d?.offer) setResolved({ offer: d.offer as Offer, byHistory: personalize });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [withdrawals]);

  // Arm the trigger once we have an offer.
  useEffect(() => {
    if (!resolved) return;
    const { offer, byHistory } = resolved;
    const armedAt = Date.now();
    let done = false;

    const fire = () => {
      if (done || recentlySeen()) return;
      done = true;
      // Consent withdrawn while the offer was armed: an offer chosen by visit
      // history is not shown and not counted, the marker goes, and the page
      // asks again from its context alone. An offer chosen without history
      // never depended on it and shows as it would have.
      if (byHistory && !historyAllowed()) {
        forgetVisits();
        setResolved(null);
        setWithdrawals((n) => n + 1);
        return;
      }
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
  }, [resolved]);

  if (!offer || !open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      {/* The scrim is its own element, aria-hidden, exactly as components/ui/
          modal.tsx writes one. Clicking it dismisses the offer; it is not a tab
          stop and announces nothing, because the keyboard's equivalent is
          Escape, which useDialogBehavior handles above.

          It used to be the WRAPPER holding the dialog, which made a mouse-only
          dismissal out of an element containing the close button and the CTA —
          scripts/audit-keyboard-operable.mjs reads that as a click target a
          keyboard cannot operate, and it could only tell it was a dismissal
          while the file still hand-rolled its own Escape listener. */}
      <div className="absolute inset-0 bg-black/50" onClick={closeOffer} aria-hidden />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="exit-intent-title"
        className="relative z-10 max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl bg-bg p-8 text-center shadow-2xl"
      >
        <button onClick={closeOffer} aria-label={t('exitIntent.close')} className="absolute right-3 top-3 text-muted hover:text-fg">
          <X className="h-5 w-5" />
        </button>
        <h2 id="exit-intent-title" className="text-2xl font-bold">{offer.headline}</h2>
        {offer.body && <p className="mt-3 text-muted">{offer.body}</p>}
        {offer.cta_href && (
          <a
            href={offer.cta_href}
            onClick={() => track(offer.id, 'conversion')}
            className="mt-6 inline-flex rounded-xl bg-brand px-6 py-3 font-semibold text-brand-fg hover:brightness-95"
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
