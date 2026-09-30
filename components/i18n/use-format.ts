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
// WHOSE ZONE (TIME-003). On a family surface — anything under a provider that
// carries `families.timezone` — every clock and every day is the FAMILY's, on the
// server render, the hydrating render and every render after it. That is what
// the owner decided, and it is also what makes hydration trivially safe there:
// the server already renders in the family's zone (TIME-002), so the two sides
// draw the same text by construction.
//
// Where there is no family (a public link, a marketing page), displayed dates
// bind to UTC during SSR and hydration, and once hydration finishes React adopts
// the browser snapshot and dates use the reader's zone.
import { useMemo, useSyncExternalStore } from 'react';

import { useFamilyTimeZone, useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { createFormat, type Format } from '@/lib/utils/format';
import { asWallClockIn, dayKeyIn, localPartsAt, wallClockToInstant } from '@/lib/time/zoned';
import { localDayKey } from '@/lib/time/local-day';

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
  const familyZone = useFamilyTimeZone();
  const readerZone = useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone);
  const timeZone = familyZone ?? readerZone;
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
  const familyZone = useFamilyTimeZone();
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  // On a family surface the family's zone on every render: server, hydration and
  // after. Only where there is no family does the reader's zone take over, once
  // hydration is done.
  return useMemo(
    () => createFormat(locale.code, t, familyZone ?? (hydrated ? undefined : 'UTC')),
    [locale.code, t, familyZone, hydrated],
  );
}

/**
 * The family's clock, for a client component that buckets by DAY or reads the
 * HOUR rather than printing a timestamp.
 *
 * `new Date().getHours()`, `d.setHours(0, 0, 0, 0)` and
 * `new Date().toISOString().slice(0, 10)` each answer about some clock other
 * than the family's — the device's for the first two, Greenwich's for the third
 * — so "today", "tomorrow" and "good morning" moved with whoever was holding the
 * phone. These answer about the family's zone (or, with no family, the
 * reader's, UTC until hydration so the first render matches the server's).
 *
 *   todayKey()        the family's `YYYY-MM-DD` right now
 *   dayKeyOf(value)   the family's day for an instant; a DATE string as written
 *   hourNow()         the family's wall-clock hour, 0–23
 *   wallNow()         a Date whose LOCAL fields read the family's wall clock —
 *                     for grid arithmetic (`setDate`, `getDay`) only; never store
 *                     it, turn it back with `toInstant`
 *   wallToday()       `wallNow()` at the family's midnight
 *   wallOf(value)     an instant as family wall clock
 *   toInstant(wall)   the real instant a wall-clock Date names
 *   wallKey(wall)     the `YYYY-MM-DD` a wall-clock Date reads
 */
export type FamilyClock = {
  timeZone: string;
  todayKey: (now?: Date) => string;
  dayKeyOf: (value: string | Date) => string;
  hourNow: (now?: Date) => number;
  wallNow: (now?: Date) => Date;
  wallToday: (now?: Date) => Date;
  wallOf: (value: string | Date) => Date;
  toInstant: (wall: Date) => Date;
  wallKey: (wall: Date) => string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function useFamilyClock(): FamilyClock {
  const familyZone = useFamilyTimeZone();
  const readerZone = useSyncExternalStore(subscribe, browserTimeZone, serverTimeZone);
  const timeZone = familyZone ?? readerZone;
  return useMemo<FamilyClock>(() => {
    const instant = (value: string | Date) => (typeof value === 'string' ? new Date(value) : value);
    // An unparseable value stays unparseable rather than throwing inside Intl:
    // a bad row renders blank, never takes the surface down.
    const wallOf = (value: string | Date) => {
      const d = instant(value);
      return Number.isNaN(d.getTime()) ? new Date(Number.NaN) : asWallClockIn(d, timeZone);
    };
    const wallToday = (now: Date = new Date()) => {
      const p = localPartsAt(now, timeZone);
      return new Date(p.year, p.month - 1, p.day);
    };
    return {
      timeZone,
      todayKey: (now = new Date()) => dayKeyIn(now, timeZone),
      dayKeyOf: (value) => {
        if (typeof value === 'string' && DATE_ONLY.test(value)) return value;
        const d = instant(value);
        return Number.isNaN(d.getTime()) ? '' : dayKeyIn(d, timeZone);
      },
      hourNow: (now = new Date()) => localPartsAt(now, timeZone).hour,
      wallNow: (now = new Date()) => asWallClockIn(now, timeZone),
      wallToday,
      wallOf,
      toInstant: (wall) => wallClockToInstant(wall, timeZone),
      wallKey: localDayKey,
    };
  }, [timeZone]);
}
