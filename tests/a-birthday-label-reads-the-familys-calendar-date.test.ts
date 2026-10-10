// A synthetic birthday is a calendar DATE (#728 review 5374669346). Its
// `starts_at` is `YYYY-MM-DDT00:00:00` with no zone designator — the shape
// upcomingBirthdayEvents emits. Read as an instant, it lands on the DEVICE's
// midnight, and the family-zone Today/Tomorrow then shifts it a day: a UTC
// phone in a Los Angeles family showed tomorrow's birthday as "Today". Both
// moments wrappers (HomeMomentCard, MomentsView) go through useMomentWhen,
// which is rendered here under the real locale + family-zone providers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { FamilyTimeZoneProvider, LocaleProvider } from '@/components/i18n/locale-provider';
import { localeOrDefault } from '@/lib/i18n/locales';
import { getMessages } from '@/lib/i18n/messages';
import { momentWhen } from '@/lib/moments/prep';
import { useMomentWhen } from '@/components/moments/use-moment-when';

const HOST_ZONE = process.env.TZ;
afterEach(() => { process.env.TZ = HOST_ZONE; vi.useRealTimers(); });
const onDevice = (zone: string) => { process.env.TZ = zone; };

/** The label a moments wrapper renders for (startsAt, allDay), at `now`, for a family in `familyZone`. */
function wrapperLabel(familyZone: string, now: string, startsAt: string, allDay: boolean): string {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  let label = '';
  const Probe = () => { label = useMomentWhen()(startsAt, allDay); return null; };
  const zoneProps = { timeZone: familyZone, children: createElement(Probe) };
  const localeProps = {
    locale: localeOrDefault('en-US'), source: 'default' as const, messages: getMessages('en-US'),
    children: createElement(FamilyTimeZoneProvider, zoneProps),
  };
  renderToString(createElement(LocaleProvider, localeProps));
  vi.useRealTimers();
  return label;
}

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

describe('a birthday DATE is the family\'s calendar date, on any device', () => {
  it.each([
    // [device, family, now, birthday date, expected]
    ['UTC', LA, '2026-07-04T12:00:00Z', '2026-07-05', 'Tomorrow'], // the review's case
    ['UTC', LA, '2026-07-04T12:00:00Z', '2026-07-04', 'Today'],
    ['UTC', LA, '2026-07-04T12:00:00Z', '2026-07-08', 'Wed, Jul 8'],
    [TOKYO, LA, '2026-07-04T12:00:00Z', '2026-07-05', 'Tomorrow'], // opposite sides of UTC
    [LA, TOKYO, '2026-07-04T20:00:00Z', '2026-07-05', 'Today'], // already 5 July in Tokyo
    [LA, TOKYO, '2026-07-04T20:00:00Z', '2026-07-06', 'Tomorrow'],
    // DST boundaries in the family's zone
    ['UTC', LA, '2026-03-08T12:00:00Z', '2026-03-09', 'Tomorrow'], // spring-forward day
    ['UTC', LA, '2026-11-01T12:00:00Z', '2026-11-01', 'Today'], // fall-back day
    [TOKYO, LA, '2026-11-01T12:00:00Z', '2026-11-02', 'Tomorrow'],
    // same-zone controls
    [LA, LA, '2026-07-04T12:00:00Z', '2026-07-05', 'Tomorrow'],
    ['UTC', 'UTC', '2026-07-04T12:00:00Z', '2026-07-04', 'Today'],
  ])('a %s device, a %s family, at %s: the %s birthday reads %s', (device, family, now, day, expected) => {
    onDevice(device);
    expect(wrapperLabel(family, now, `${day}T00:00:00`, true)).toBe(expected);
  });
});

describe('a timed instant keeps its meaning; a stored all-day row is its date', () => {
  it('an all-day row stored with a zone is the date it is stored on, not that instant on the family\'s clock', () => {
    onDevice('UTC');
    // An all-day row is stored at its date's Greenwich midnight (lib/calendar/day.ts):
    // 00:00Z on 5 July is the 5th, though it is 4 July 17:00 in Los Angeles.
    expect(wrapperLabel(LA, '2026-07-04T12:00:00Z', '2026-07-05T00:00:00Z', true)).toBe('Tomorrow');
    expect(wrapperLabel(LA, '2026-07-04T12:00:00Z', '2026-07-05T00:00:00+00:00', true)).toBe('Tomorrow');
    expect(wrapperLabel(LA, '2026-07-04T12:00:00Z', '2026-07-04T00:00:00Z', true)).toBe('Today');
  });

  it('a timed event formats in the family\'s zone', () => {
    onDevice(TOKYO);
    expect(wrapperLabel(LA, '2026-07-04T12:00:00Z', '2026-07-05T16:00:00Z', false)).toBe('Tomorrow 9:00 AM');
  });

  it('a naive time that is not midnight is not treated as a date', () => {
    onDevice('UTC');
    expect(momentWhen('2026-07-05T09:30:00', true, new Date('2026-07-04T12:00:00Z'), 'en-US', undefined, LA))
      .toBe(momentWhen('2026-07-05T09:30:00Z', true, new Date('2026-07-04T12:00:00Z'), 'en-US', undefined, LA));
  });
});

describe('both moments wrappers use the shared label', () => {
  it.each(['components/moments/home-moment-card.tsx', 'components/moments/moments-view.tsx'])('%s', (file) => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    expect(src).toContain('const momentWhen = useMomentWhen();');
    expect(src).not.toMatch(/momentWhenIn\(/);
  });
});
