'use client';

// The shared formatters, bound to the locale the visitor is reading in.
//
// Same shape as `useTranslations()` next to it, deliberately: a client component
// that needs both writes
//
//   const t = useTranslations();
//   const { fmtDate, fmtMoney } = useFormat();
//
// and neither reaches for a locale itself. Importing `fmtDate` from
// '@/lib/utils/format' inside a rendered component is the defect this replaces —
// those bare exports are bound to en-US and are correct only where there is no
// reader whose language we know.
import { useMemo, useSyncExternalStore } from 'react';

import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { createFormat, type Format } from '@/lib/utils/format';

export function useFormat(): Format {
  const locale = useLocale();
  const t = useTranslations();
  // Memoised on the locale code: each formatter builds Intl objects, and a new
  // identity every render would defeat any useMemo downstream that depends on one.
  return useMemo(() => createFormat(locale.code, t), [locale.code, t]);
}

const noSubscribe = () => () => {};

/**
 * `useFormat()` for anything that renders a date or a time.
 *
 * `useFormat()` binds the locale but not the zone, so a timestamp drawn on the
 * server (UTC) and again in a browser in Berlin or New York is different text —
 * "0:30" against "2:30", or even a different day — and React throws #418 and
 * re-renders the whole root (review on #604, reproduced with the real
 * providers). Here the server render and the browser's first render both
 * format in UTC, so hydration sees the same text; the moment hydration is done
 * `useSyncExternalStore` hands back `true` and the component re-renders in the
 * reader's own zone. No `suppressHydrationWarning`: the two renders agree.
 */
export function useHydrationSafeFormat(): Format {
  const locale = useLocale();
  const t = useTranslations();
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  return useMemo(
    () => createFormat(locale.code, t, hydrated ? undefined : 'UTC'),
    [locale.code, t, hydrated],
  );
}
