import { describe, it, expect } from 'vitest';
import {
  CALENDAR_PROVIDERS, getCalendarProvider, webcalUrl, httpsUrl, addToCalendarLinks,
} from '@/lib/calendar/providers';

describe('CALENDAR_PROVIDERS', () => {
  it('covers the major providers with steps + placeholders', () => {
    const ids = CALENDAR_PROVIDERS.map((p) => p.id);
    for (const id of ['google', 'apple', 'microsoft', 'schoology', 'classroom', 'canvas', 'teamsnap', 'ics']) {
      expect(ids).toContain(id);
    }
    for (const p of CALENDAR_PROVIDERS) {
      expect(p.steps.length).toBeGreaterThan(0);
      expect(p.placeholder).toBeTruthy();
    }
  });

  it('Google is the only OAuth (two-way) provider and has a connect URL', () => {
    const oauth = CALENDAR_PROVIDERS.filter((p) => p.connect === 'oauth');
    expect(oauth.map((p) => p.id)).toEqual(['google']);
    expect(getCalendarProvider('google')!.connectUrl).toBe('/api/sync/google/auth');
  });

  it('getCalendarProvider returns undefined for unknown ids', () => {
    expect(getCalendarProvider('nope')).toBeUndefined();
  });
});

describe('webcalUrl / httpsUrl', () => {
  it('round-trips between https and webcal', () => {
    expect(webcalUrl('https://x.com/a.ics')).toBe('webcal://x.com/a.ics');
    expect(webcalUrl('http://x.com/a.ics')).toBe('webcal://x.com/a.ics');
    expect(httpsUrl('webcal://x.com/a.ics')).toBe('https://x.com/a.ics');
  });
});

describe('addToCalendarLinks', () => {
  it('builds google/outlook/apple subscribe links from a feed URL', () => {
    const links = addToCalendarLinks('https://www.bubaly.com/api/sync/feeds/tok.ics');
    expect(links.google).toContain('calendar.google.com');
    expect(links.google).toContain(encodeURIComponent('https://www.bubaly.com/api/sync/feeds/tok.ics'));
    expect(links.outlook).toContain('outlook.live.com');
    expect(links.apple).toBe('webcal://www.bubaly.com/api/sync/feeds/tok.ics');
  });

  it('normalizes a webcal feed URL to https for google/outlook', () => {
    const links = addToCalendarLinks('webcal://www.bubaly.com/f.ics');
    expect(links.google).toContain(encodeURIComponent('https://www.bubaly.com/f.ics'));
    expect(links.apple).toBe('webcal://www.bubaly.com/f.ics');
  });
});
