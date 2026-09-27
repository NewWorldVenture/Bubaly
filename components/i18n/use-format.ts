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
//
// Bind displayed dates to one zone during SSR and hydration. Once hydration
// finishes, React adopts the browser snapshot and dates use the reader's zone.
import { useMemo, useSyncExternalStore } from 'react';

import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { createFormat, type Format } from '@/lib/utils/format';

const subscribe = () => () => {};
const serverTimeZone = () => 'UTC';
const browserTimeZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
};

// Only timestamps with a stated zone name or offset identify an instant.
// Other strings keep the formatter's existing local parse, including legacy
// native-Date inputs such as "2026/07/14 00:30". Converting those to UTC after
// parsing them locally would itself create a hydration mismatch. Requiring a
// clock also avoids reading the final "-14" in a DATE as a zone offset.
const EXPLICIT_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?|\b(?:UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT))(?:\s*\([^)]*\))?\s*$/i;
const hasExplicitZone = (value: string) => /\d{1,2}:\d{2}/.test(value) && EXPLICIT_ZONE.test(value);

export function useFormat(): Format {
  const locale = useLocale();
  const t = useTranslations();
  const timeZone = useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone);
  return useMemo<Format>(() => {
    const zoned = createFormat(locale.code, t, timeZone);
    const wallClock = createFormat(locale.code, t);
    const forValue = (value: string | Date | null | undefined) =>
      typeof value === 'string' && !hasExplicitZone(value) ? wallClock : zoned;
    return {
      ...zoned,
      fmtDate: (value, pattern) => forValue(value).fmtDate(value, pattern),
      fmtTime: value => forValue(value).fmtTime(value),
      fmtDateTime: value => forValue(value).fmtDateTime(value),
      fmtRelative: value => forValue(value).fmtRelative(value),
      fmtTimeAgo: (value, options) => forValue(value).fmtTimeAgo(value, options),
    };
  }, [locale.code, t, timeZone]);
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
