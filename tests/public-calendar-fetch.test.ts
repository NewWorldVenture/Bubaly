import { describe, expect, it } from 'vitest';
import { fetchPublicCalendarText, validatePublicCalendarUrl } from '@/lib/server/public-calendar-fetch';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.7', family: 4 }];

describe('public calendar fetch boundary', () => {
  it('rejects loopback, private, link-local, and metadata targets', async () => {
    expect(await validatePublicCalendarUrl('http://127.0.0.1/calendar.ics')).toBeNull();
    expect(await validatePublicCalendarUrl('http://10.0.0.1/calendar.ics')).toBeNull();
    expect(await validatePublicCalendarUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(await validatePublicCalendarUrl('http://localhost/calendar.ics')).toBeNull();
    expect(await validatePublicCalendarUrl('https://calendar.example.test/feed', privateLookup)).toBeNull();
  });

  it('allows a public HTTPS host and preserves webcal normalization', async () => {
    expect(await validatePublicCalendarUrl('https://calendar.example.test/feed', publicLookup))
      .toBe('https://calendar.example.test/feed');
    expect(await validatePublicCalendarUrl('webcal://calendar.example.test/feed', publicLookup))
      .toBe('https://calendar.example.test/feed');
  });

  it('rejects non-http schemes and credential-bearing URLs', async () => {
    expect(await validatePublicCalendarUrl('ftp://calendar.example.test/feed', publicLookup)).toBeNull();
    expect(await validatePublicCalendarUrl('https://user:pass@calendar.example.test/feed', publicLookup)).toBeNull();
  });

  it('does not follow redirects into private networks and caps response size', async () => {
    const privateRedirect = async () => new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/metadata' },
    });
    const redirected = await fetchPublicCalendarText('https://calendar.example.test/feed', privateRedirect, publicLookup);
    expect(redirected).toMatchObject({ ok: false, status: 400 });

    const oversized = async () => new Response('calendar', {
      status: 200,
      headers: { 'content-length': '1048577' },
    });
    const tooLarge = await fetchPublicCalendarText('https://calendar.example.test/feed', oversized, publicLookup);
    expect(tooLarge).toMatchObject({ ok: false, status: 413 });
  });
});
