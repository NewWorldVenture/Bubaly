import { afterEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextRail, type UpcomingEvent } from '@/components/assistant/context-rail';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { localeOrDefault } from '@/lib/i18n/locales';
import { getMessages } from '@/lib/i18n/messages';

const hostZone = process.env.TZ;
afterEach(() => { if (hostZone === undefined) delete process.env.TZ; else process.env.TZ = hostZone; });
const zones = ['UTC', 'America/New_York', 'Asia/Tokyo'];
function rail(zone: string, event: Partial<UpcomingEvent> = {}, locale = 'en-US') {
  const props: Parameters<typeof LocaleProvider>[0] = {
    locale: localeOrDefault(locale), source: 'default', messages: getMessages(localeOrDefault(locale).code), timeZone: zone,
    children: createElement(ContextRail, { glance: [], activity: [], prompts: [], onAsk: () => {},
      upcoming: [{ id: 'synthetic', title: 'Synthetic calendar event', starts_at: '2026-10-05T00:00:00.000Z', all_day: true, ...event }],
    }),
  };
  return renderToStaticMarkup(createElement(LocaleProvider, props));
}

it.each(zones.flatMap(host => zones.map(family => [host, family])))('renders canonical DATE unchanged on host %s for family %s', (host, family) => {
  process.env.TZ = host;
  const html = rail(family);
  expect(html).toContain('Mon, Oct 5'); expect(html).not.toContain('Sun, Oct 4'); expect(html).not.toContain(' · ');
});
it.each(zones.flatMap(zone => [
  [zone, '2026-03-08T00:00:00.000Z', 'Sun, Mar 8'],
  [zone, '2026-11-01T00:00:00.000Z', 'Sun, Nov 1'],
  [zone, '2024-02-29T00:00:00.000Z', 'Thu, Feb 29'],
]))('preserves DATE %s %s across DST and leap-day labels', (zone, starts_at, expected) => {
  expect(rail(zone, { starts_at })).toContain(expected);
});
it.each([
  ['UTC', '2026-10-05T02:00:00Z', 'Mon, Oct 5 · 2:00 AM'],
  ['America/New_York', '2026-10-05T02:00:00Z', 'Sun, Oct 4 · 10:00 PM'],
  ['Asia/Tokyo', '2026-10-05T02:00:00Z', 'Mon, Oct 5 · 11:00 AM'],
  ['UTC', '2026-03-08T07:30:00Z', 'Sun, Mar 8 · 7:30 AM'],
  ['America/New_York', '2026-03-08T07:30:00Z', 'Sun, Mar 8 · 3:30 AM'],
  ['Asia/Tokyo', '2026-03-08T07:30:00Z', 'Sun, Mar 8 · 4:30 PM'],
  ['UTC', '2026-11-01T06:30:00Z', 'Sun, Nov 1 · 6:30 AM'],
  ['America/New_York', '2026-11-01T06:30:00Z', 'Sun, Nov 1 · 1:30 AM'],
  ['Asia/Tokyo', '2026-11-01T06:30:00Z', 'Sun, Nov 1 · 3:30 PM'],
])('keeps timed family clock %s %s unchanged', (zone, starts_at, expected) => {
  expect(rail(zone, { starts_at, all_day: false })).toContain(expected);
});
it.each(['2026-10-05', '2026-10-05T00:00:00', '2026-10-05T00:00:00+00:00'])('preserves civil DATE input representation %s', starts_at => {
  expect(rail('America/New_York', { starts_at })).toContain('Mon, Oct 5');
});
it('uses the reader locale through the real provider and formatter for civil dates', () => {
  expect(rail('America/New_York', {}, 'de-DE')).toContain('Mo., 5. Okt.');
});
