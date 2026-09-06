'use client';

// components/i18n/language-picker.tsx — the bottom-left language control.
//
// Sits above the mobile tab bar rather than behind it: the app shell pins a
// fixed bottom nav on small screens, so the same offset the toast stack uses
// (5rem + the home-indicator inset) keeps this reachable on a phone, and it
// drops to a normal bottom margin once the nav goes away at lg.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Globe, Loader2 } from 'lucide-react';

import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { setLocale } from '@/lib/i18n/actions';
import { LOCALES, type LocaleCode } from '@/lib/i18n/locales';

export function LanguagePicker() {
  const active = useLocale();
  const t = useTranslations();
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<LocaleCode | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on Escape and on any click outside — a language menu should never be
  // the thing standing between someone and the page underneath it.
  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
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
  }, [open]);

  // Bring the current language into view when the menu opens — with eleven
  // entries in a scrolling list, the selected one is often below the fold.
  useEffect(() => {
    if (!open) return;
    const selected = listRef.current?.querySelector('[aria-selected="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const choose = useCallback(
    async (code: LocaleCode) => {
      if (code === active.code) {
        setOpen(false);
        return;
      }
      setPending(code);
      try {
        const result = await setLocale(code);
        if (result.ok) {
          setOpen(false);
          // Server components hold the translated markup, so a refresh is what
          // actually repaints the page in the new language.
          router.refresh();
        }
      } finally {
        setPending(null);
      }
    },
    [active.code, router],
  );

  return (
    <div
      ref={rootRef}
      className="fixed bottom-[calc(5rem+var(--safe-bottom))] left-4 z-[90] lg:bottom-6"
      data-testid="language-picker"
    >
      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={t('language.menuLabel')}
          className="glass absolute bottom-full left-0 mb-2 max-h-[min(60dvh,26rem)] w-[17rem] overflow-y-auto overscroll-contain rounded-2xl border border-border p-1.5 shadow-2xl"
        >
          {LOCALES.map((locale) => {
            const isActive = locale.code === active.code;
            const isPending = pending === locale.code;
            return (
              <button
                key={locale.code}
                type="button"
                role="option"
                aria-selected={isActive}
                disabled={pending !== null}
                onClick={() => void choose(locale.code)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition coarse:min-h-11 focus-ring disabled:opacity-60 ${
                  isActive ? 'bg-elevated' : 'hover:bg-elevated'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="w-6 shrink-0 text-[0.68rem] font-bold uppercase tracking-wider text-muted"
                >
                  {locale.region}
                </span>
                <span className={`flex-1 text-sm ${isActive ? 'font-semibold text-brand' : 'text-fg'}`}>
                  {locale.nativeLanguage}{' '}
                  <span className={isActive ? 'text-brand' : 'text-muted'}>({locale.nativeRegion})</span>
                </span>
                {isPending ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted" />
                ) : isActive ? (
                  <Check className="h-4 w-4 shrink-0 text-brand" />
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
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={t('language.change')}
        className="glass flex items-center gap-2 rounded-full border border-border px-3.5 py-2 text-xs font-medium text-fg shadow-lg transition hover:bg-elevated coarse:min-h-11 focus-ring"
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden="true" />
        <span aria-hidden="true" className="text-[0.68rem] font-bold uppercase tracking-wider text-muted">
          {active.region}
        </span>
        <span className="whitespace-nowrap">
          {active.nativeRegion} <span className="text-muted">·</span> {active.nativeLanguage}
        </span>
      </button>
    </div>
  );
}
