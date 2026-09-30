// TIME-003: every family surface reads in the FAMILY's zone — behaviour, not
// source text. The ratchet beside this (a-client-clock-reads-the-familys-zone)
// holds the call sites; this proves the shared pieces they now call give the
// family's answer when the device is somewhere else, at the edges where a
// zone bug shows: midnight, a DST change, a date with no time, a bad zone.
//
// Run it with the process in more than one zone (CI runs the suite in UTC,
// America/Los_Angeles and Asia/Tokyo): nothing here may depend on the host's
// zone, which is the point.
import { describe, expect, it } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { FamilyTimeZoneProvider, LocaleProvider } from '@/components/i18n/locale-provider';
import { useFamilyClock, useFormat, useHydrationSafeFormat } from '@/components/i18n/use-format';
import { localeOrDefault } from '@/lib/i18n/locales';
import { createFormat } from '@/lib/utils/format';
import { dayKeyIn, wallClockToInstant } from '@/lib/time/zoned';
import { fromLocalInput, toLocalInput } from '@/lib/time/local-input';
import { parseDueDateInZone, parseEvent, parseEventInZone } from '@/lib/capture/parse';
import { buildHeatmap } from '@/lib/calendar/heatmap';
import { groupByDay as groupCareByDay } from '@/lib/care/log';
import { groupByDay as groupWalletByDay } from '@/lib/wallet/activity';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const BERLIN = 'Europe/Berlin';

/** Render `probe` under the (app) layout's providers, as the server does. */
function render(timeZone: string | undefined, probe: () => ReactNode, code = 'en-US'): string {
  const Probe = () => createElement('output', null, probe());
  const zoned = createElement(FamilyTimeZoneProvider, { timeZone, children: createElement(Probe) });
  return renderToString(
    createElement(LocaleProvider, { locale: localeOrDefault(code), source: 'default', messages: {}, children: zoned }),
  ).replace(/<\/?output>/g, '').replace(/ /g, ' ');
}

describe('a family in one zone, a reader in another', () => {
  // 15:00 Saturday in Los Angeles is 23:00 UTC and 08:00 Sunday in Tokyo.
  const GAME = '2026-09-12T22:00:00.000Z';

  it('the shared formatter prints the family\'s clock, not the device\'s', () => {
    expect(render(LA, () => useFormat().fmtDateTime(GAME))).toBe('Sat, Sep 12, 3:00 PM');
    expect(render(TOKYO, () => useFormat().fmtDateTime(GAME))).toBe('Sun, Sep 13, 7:00 AM');
  });

  it('hydration-safe formatting renders the family\'s zone on the server too, so both renders agree', () => {
    // Before TIME-003 the server rendered UTC and the client swapped to the
    // device's zone after hydration; with a family zone both draw this text.
    expect(render(LA, () => useHydrationSafeFormat().fmtTime(GAME))).toBe('3:00 PM');
    // No family (a public page): the server keeps UTC until hydration, as before.
    expect(render(undefined, () => useHydrationSafeFormat().fmtTime(GAME))).toBe('10:00 PM');
  });

  it('"today" is the family\'s day', () => {
    // 06:30 UTC on the 13th is still the 12th in Los Angeles and already the 13th in Tokyo.
    const now = new Date('2026-09-13T06:30:00Z');
    expect(render(LA, () => useFamilyClock().todayKey(now))).toBe('2026-09-12');
    expect(render(TOKYO, () => useFamilyClock().todayKey(now))).toBe('2026-09-13');
    expect(render(LA, () => String(useFamilyClock().hourNow(now)))).toBe('23');
  });

  it('formats in the reader\'s language, on the family\'s clock', () => {
    expect(render(BERLIN, () => useFormat().fmtDate(GAME, 'EEEE, MMMM d'), 'de-DE')).toBe('Sonntag, 13. September');
    expect(render(LA, () => useFormat().fmtDate(GAME, 'EEEE, MMMM d'), 'de-DE')).toBe('Samstag, 12. September');
  });
});

describe('midnight', () => {
  it('the day turns at the family\'s midnight', () => {
    // Los Angeles is UTC-8 in January.
    expect(dayKeyIn(new Date('2026-01-15T07:59:59Z'), LA)).toBe('2026-01-14');
    expect(dayKeyIn(new Date('2026-01-15T08:00:00Z'), LA)).toBe('2026-01-15');
  });

  it('a family wall-clock midnight maps back to the right instant', () => {
    const midnight = wallClockToInstant(new Date(2026, 0, 15), LA);
    expect(midnight.toISOString()).toBe('2026-01-15T08:00:00.000Z');
  });
});

describe('daylight saving', () => {
  // Saturday 7 March 2026, noon in Los Angeles; clocks go forward at 02:00 on the 8th.
  const SAT_NOON = new Date('2026-03-07T20:00:00Z');

  it('"tomorrow at 3pm" is 3pm Pacific DAYLIGHT time', () => {
    expect(parseEventInZone('Soccer tomorrow at 3pm', SAT_NOON, LA).startsAt.toISOString()).toBe('2026-03-08T22:00:00.000Z');
  });

  it('a time the zone skips moves to the first minute that exists, not off the calendar', () => {
    expect(parseEventInZone('Feed the cat tomorrow at 2:30am', SAT_NOON, LA).startsAt.toISOString()).toBe('2026-03-08T10:00:00.000Z');
  });

  it('the datetime box round-trips across the change', () => {
    const iso = '2026-03-08T17:30:00.000Z'; // 10:30 PDT
    expect(toLocalInput(iso, LA)).toBe('2026-03-08T10:30');
    expect(fromLocalInput('2026-03-08T10:30', LA)).toBe(iso);
    // A box value in the skipped hour resolves to 03:00 PDT.
    expect(fromLocalInput('2026-03-08T02:30', LA)).toBe('2026-03-08T10:00:00.000Z');
  });
});

describe('date-only values are dates, not instants', () => {
  it('a DATE renders as written in every zone', () => {
    for (const zone of [LA, TOKYO, BERLIN, 'UTC']) {
      expect(createFormat('en-US', undefined, zone).fmtDate('2026-03-08', 'MMM d, yyyy'), zone).toBe('Mar 8, 2026');
    }
  });

  it('a due date resolves on the family\'s day', () => {
    // 23:30 Friday in Los Angeles is already Saturday in UTC.
    const lateFriday = new Date('2026-03-07T07:30:00Z');
    expect(parseDueDateInZone('Pay rent tomorrow', lateFriday, LA).dueDate).toBe('2026-03-07');
    expect(parseDueDateInZone('Pay rent tomorrow', lateFriday, TOKYO).dueDate).toBe('2026-03-08');
  });

  it('a family-day key for a DATE string is the date itself', () => {
    expect(render(TOKYO, () => useFamilyClock().dayKeyOf('2026-03-08'))).toBe('2026-03-08');
  });
});

describe('a missing or unusable zone falls back, never throws', () => {
  it('the provider ignores an unusable zone and the reader keeps their own', () => {
    const GAME = '2026-09-12T22:00:00.000Z';
    expect(() => render('Not/AZone', () => useFormat().fmtDateTime(GAME))).not.toThrow();
    expect(render('Not/AZone', () => useFamilyClock().timeZone)).toBe(render(undefined, () => useFamilyClock().timeZone));
  });

  it('the zoned parse is the plain parse without a zone', () => {
    const now = new Date('2026-03-07T20:00:00Z');
    for (const zone of [undefined, '', 'Not/AZone']) {
      expect(parseEventInZone('Dentist tomorrow at 9am', now, zone).startsAt.getTime())
        .toBe(parseEvent('Dentist tomorrow at 9am', now).startsAt.getTime());
    }
  });

  it('the formatter keeps working with a bad zone', () => {
    expect(() => createFormat('en-US', undefined, 'Not/AZone').fmtDate('2026-09-12T22:00:00Z')).not.toThrow();
  });
});

describe('day buckets are the family\'s days', () => {
  // 17:00 Pacific on the 12th is 00:00 UTC on the 13th.
  const EVENING = '2026-09-13T00:00:00.000Z';

  it('the busyness heat map files an evening event under the family\'s day', () => {
    const today = new Date('2026-09-13T06:00:00Z'); // still the 12th in Los Angeles
    const report = buildHeatmap([{ startsAt: EVENING, endsAt: null, allDay: false }], today, 1, LA);
    const day = report.days.find((d) => d.count > 0);
    expect(day?.date).toBe('2026-09-12');
  });

  it('the care log and the wallet statement group by the family\'s day', () => {
    const care = groupCareByDay([{ occurred_at: EVENING } as never], LA);
    expect(care.map(([k]) => k)).toEqual(['2026-09-12']);
    const wallet = groupWalletByDay([{ created_at: EVENING } as never], TOKYO);
    expect(wallet.map((g) => g.date)).toEqual(['2026-09-13']);
  });
});
