import { describe, it, expect } from 'vitest';
import {
  normalizeFeedUrl, icsRruleToRecurrence, mapIcsEventToRow, buildFeedRows, FEED_COLORS,
} from '@/lib/calendar/feeds';
import type { IcsEvent } from '@/lib/sync/ics';

const ev = (over: Partial<IcsEvent> = {}): IcsEvent => ({
  uid: 'evt-1', title: 'Soccer', description: null, location: null,
  startsAt: '2026-06-22T15:00:00.000Z', endsAt: '2026-06-22T16:00:00.000Z',
  allDay: false, recurrenceRule: null, ...over,
});

describe('normalizeFeedUrl', () => {
  it('converts webcal:// to https://', () => {
    expect(normalizeFeedUrl('webcal://example.com/cal.ics')).toBe('https://example.com/cal.ics');
  });
  it('passes through https URLs', () => {
    expect(normalizeFeedUrl('  https://example.com/a.ics  ')).toBe('https://example.com/a.ics');
  });
  it('rejects empty or non-http schemes', () => {
    expect(normalizeFeedUrl('')).toBeNull();
    expect(normalizeFeedUrl('ftp://example.com/a.ics')).toBeNull();
    expect(normalizeFeedUrl('not a url')).toBeNull();
  });
});

describe('icsRruleToRecurrence', () => {
  it('maps known frequencies', () => {
    expect(icsRruleToRecurrence('FREQ=DAILY')).toBe('daily');
    expect(icsRruleToRecurrence('FREQ=WEEKLY;BYDAY=MO')).toBe('weekly');
    expect(icsRruleToRecurrence('FREQ=MONTHLY')).toBe('monthly');
    expect(icsRruleToRecurrence('FREQ=YEARLY')).toBe('yearly');
  });
  it('falls back to none', () => {
    expect(icsRruleToRecurrence(null)).toBe('none');
    expect(icsRruleToRecurrence('')).toBe('none');
    expect(icsRruleToRecurrence('FREQ=HOURLY')).toBe('none');
  });
});

describe('mapIcsEventToRow', () => {
  it('shapes a feed-scoped calendar_events row', () => {
    const row = mapIcsEventToRow(ev({ recurrenceRule: 'FREQ=WEEKLY' }), 'fam-1', 'feed-1');
    expect(row).toMatchObject({
      family_id: 'fam-1', feed_id: 'feed-1', external_uid: 'evt-1',
      title: 'Soccer', recurrence: 'weekly', category: 'general', all_day: false,
    });
  });
  it('defaults a missing title', () => {
    expect(mapIcsEventToRow(ev({ title: '' }), 'f', 'd').title).toBe('Untitled');
  });
});

describe('buildFeedRows', () => {
  it('dedups by UID (last write wins) so re-sync upserts cleanly', () => {
    const rows = buildFeedRows(
      [ev({ uid: 'a', title: 'Old' }), ev({ uid: 'a', title: 'New' }), ev({ uid: 'b' })],
      'fam', 'feed',
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.external_uid === 'a')!.title).toBe('New');
  });
  it('skips events missing uid or start', () => {
    const rows = buildFeedRows(
      [ev({ uid: '' }), ev({ uid: 'c', startsAt: '' as unknown as string })],
      'fam', 'feed',
    );
    expect(rows).toHaveLength(0);
  });
});

describe('FEED_COLORS', () => {
  it('offers a palette for labelling feeds', () => {
    expect(FEED_COLORS).toContain('blue');
    expect(FEED_COLORS.length).toBeGreaterThanOrEqual(4);
  });
});
