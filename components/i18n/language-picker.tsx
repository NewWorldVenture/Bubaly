'use client';

// components/i18n/language-picker.tsx — the language control.
//
// Embedded in the bottom of the page, never floating. A fixed control that
// hovers over the page is a control sitting on top of whatever the page keeps
// at the bottom: the first version of this shipped 214px wide — 54% of a 393px
// phone — at z-90, and hit-testing the public routes found it covering the
// homepage CTA, the sign-up buttons, the login inputs and the cookie-consent
// buttons on 13 of 28 route/device combinations. In normal flow it takes up its
// own space and can cover nothing.
//
// Every layout puts one at its bottom, so language is reachable from every
// screen — marketing, auth, onboarding and the signed-in app alike.
//
// On phones the trigger collapses to the locale code, which is a fifth of the
// width of the endonym pair and still unambiguous; `region` alone would not be,
// since en-US and es-US share "US". The endonyms come back at sm.

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Globe, Loader2 } from 'lucide-react';

import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { setLocale } from '@/lib/i18n/actions';
import { LOCALES, type LocaleCode } from '@/lib/i18n/locales';

type ControlProps = {
  /** Positioning for the wrapper. Must establish a containing block: the menu
   *  is absolute and hangs off the top of it. */
  className: string;
};

function LanguageControl({ className }: ControlProps) {
  const active = useLocale();
  const t = useTranslations();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<LocaleCode | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const selectedIndex = Math.max(0, LOCALES.findIndex((locale) => locale.code === active.code));
  // The option that holds the tab stop inside the open list (roving tabindex).
  const [focusIndex, setFocusIndex] = useState(selectedIndex);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);
  // Read when a save completes, which can be long after the choice was made.
  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  // Close on Escape and on any click outside — a language menu should never be
  // the thing standing between someone and the page underneath it.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open, close]);

  // C2-B06: the list declares role="listbox", so it takes focus and answers the
  // listbox keys. It opens on the current language, which also brings it into
  // view — with eleven entries in a scrolling list it is often below the fold.
  useEffect(() => {
    if (!open) return;
    setFocusIndex(selectedIndex);
    const selected = optionRefs.current[selectedIndex];
    selected?.scrollIntoView({ block: 'nearest' });
    selected?.focus();
    // Only on opening: moving within the list must not snap back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const moveTo = (index: number) => {
    const next = (index + LOCALES.length) % LOCALES.length;
    setFocusIndex(next);
    optionRefs.current[next]?.focus();
  };
  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveTo(focusIndex + 1); break;
      case 'ArrowUp': e.preventDefault(); moveTo(focusIndex - 1); break;
      case 'Home': e.preventDefault(); moveTo(0); break;
      case 'End': e.preventDefault(); moveTo(LOCALES.length - 1); break;
      // Tab leaves the list; the trigger follows it in the page's order.
      case 'Tab': close(false); break;
      default: break;
    }
  };
  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const choose = useCallback(
    async (code: LocaleCode) => {
      if (code === active.code) {
        close(true);
        return;
      }
      setPending(code);
      try {
        const result = await setLocale(code);
        if (result.ok) {
          // Return focus to the trigger only while the picker still holds the
          // interaction: the list is open and focus is in it (or on nothing).
          // Someone who closed it and moved on to another field keeps their
          // place.
          const focused = document.activeElement;
          close(openRef.current && (!focused || focused === document.body || !!rootRef.current?.contains(focused)));
          // Server components hold the translated markup, so a refresh is what
          // actually repaints the page in the new language.
          router.refresh();
        }
      } finally {
        setPending(null);
      }
    },
    [active.code, router, close],
  );

  return (
    <div ref={rootRef} className={className} data-testid="language-picker">
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t('language.menuLabel')}
          onKeyDown={onListKeyDown}
          className="glass absolute bottom-full left-0 mb-2 max-h-[min(60dvh,26rem)] w-[17rem] overflow-y-auto overscroll-contain rounded-2xl border border-border p-1.5 shadow-2xl"
        >
          {LOCALES.map((locale, index) => {
            const isActive = locale.code === active.code;
            const isPending = pending === locale.code;
            return (
              <button
                key={locale.code}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={isActive}
                tabIndex={index === focusIndex ? 0 : -1}
                onFocus={() => setFocusIndex(index)}
                // While a save is pending the options refuse another choice but
                // stay focusable: disabling the focused option would drop
                // keyboard focus to <body>, stranding it if the save fails.
                aria-disabled={pending !== null || undefined}
                onClick={() => { if (pending === null) void choose(locale.code); }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition coarse:min-h-11 focus-ring aria-disabled:opacity-60 ${
                  isActive ? 'bg-elevated' : 'hover:bg-elevated'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="w-6 shrink-0 text-[0.68rem] font-bold uppercase tracking-wider text-muted"
                >
                  {locale.region}
                </span>
                <span className={`flex-1 text-sm ${isActive ? 'font-semibold text-brand-text' : 'text-fg'}`}>
                  {locale.nativeLanguage}{' '}
                  <span className={isActive ? 'text-brand-text' : 'text-muted'}>({locale.nativeRegion})</span>
                </span>
                {isPending ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" />
                ) : isActive ? (
                  <Check className="h-4 w-4 shrink-0 text-brand-text" />
                ) : null}
              </button>
            );
          })}
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-label={t('language.change')}
        className="glass flex items-center gap-2 rounded-full border border-border px-3.5 py-2 text-xs font-medium text-fg shadow-lg transition hover:bg-elevated coarse:min-h-11 focus-ring"
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span aria-hidden="true" className="text-[0.68rem] font-bold uppercase tracking-wider text-muted sm:hidden">
          {active.code}
        </span>
        <span aria-hidden="true" className="hidden text-[0.68rem] font-bold uppercase tracking-wider text-muted sm:inline">
          {active.region}
        </span>
        <span className="hidden whitespace-nowrap sm:inline">
          {active.nativeRegion} <span className="text-muted">·</span> {active.nativeLanguage}
        </span>
      </button>
    </div>
  );
}

/**
 * The language control, for the bottom of a layout. In normal flow, so it can
 * never cover the page it sits on.
 */
export function LanguageBar({ className = '' }: { className?: string } = {}) {
  return <LanguageControl className={`relative inline-block ${className}`.trim()} />;
}
