import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseICS } from '@/lib/sync/ics';
import { mapIcsEventToRow } from '@/lib/calendar/feeds';
import { expandForFamily } from '@/lib/calendar/recurrence';

/**
 * AN IMPORTED SERIES IS STEPPED ON THE FAMILY'S CLOCK, NOT ITS PUBLISHER'S.
 *
 * A known limit, pinned so that it is said and not discovered. A subscribed
 * calendar's DTSTART;TZID decides a series' first instant, and the row keeps
 * that instant and the frequency; this legacy row carries no source TZID. Every
 * later occurrence is expanded on the family's wall clock. A weekly 09:00
 * America/New_York class followed by a family in Europe/London starts 14:00
 * London time (13:00Z, BST) and stays 14:00 London time; in the week between
 * Europe's clock change (25 October 2026) and America's (1 November) the
 * publisher's 09:00 EDT is 13:00Z, and the family's calendar says 14:00Z.
 *
 * The limit is documented beside mapIcsEventToRow (lib/calendar/feeds.ts) and
 * in the held 0490 migration's header; this test fails if either stops saying
 * it. Held0490 now adds a preservation slot, but neither its new endpoint nor
 * a source-clock engine is enabled. A column alone does not repair this path.
 */

const ROOT = join(__dirname, '..');
const FEED_ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//school//EN',
  'BEGIN:VEVENT', 'UID:class', 'SUMMARY:Coding class',
  'DTSTART;TZID=America/New_York:20260907T090000', 'DTEND;TZID=America/New_York:20260907T100000',
  'RRULE:FREQ=WEEKLY', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

describe('an imported series is stepped on the family\'s clock', () => {
  const [ev] = parseICS(FEED_ICS);
  const row = { ...mapIcsEventToRow(ev, 'fam', 'feed'), id: 'class', recurrence_until: null };

  it('the first instant is the publisher\'s (09:00 EDT), and the row keeps no zone', () => {
    expect(row.starts_at).toBe('2026-09-07T13:00:00.000Z');
    expect(row.recurrence).toBe('weekly');
    expect(Object.keys(row).filter((key) => /tz|zone/i.test(key))).toEqual([]);
  });

  it('a London family sees it at 14:00 London time every week, the week between the two clock changes included', () => {
    // Monday 26 October: London is on GMT, New York still on EDT.
    const [between] = expandForFamily([row], '2026-10-26', '2026-10-27', 'Europe/London');
    expect(between.starts_at).toBe('2026-10-26T14:00:00.000Z');
    // The publisher's 09:00 EDT that Monday would be 13:00Z: the stated limit.
    expect(between.starts_at).not.toBe('2026-10-26T13:00:00.000Z');
    // Once both zones have changed, the two agree again (09:00 EST = 14:00Z).
    const [after] = expandForFamily([row], '2026-11-02', '2026-11-03', 'Europe/London');
    expect(after.starts_at).toBe('2026-11-02T14:00:00.000Z');
  });

  it('the limit is said beside mapIcsEventToRow and in the held 0490 migration', () => {
    const feeds = readFileSync(join(ROOT, 'lib/calendar/feeds.ts'), 'utf8').replaceAll('\r\n', '\n');
    const doc = feeds.slice(feeds.lastIndexOf('/**', feeds.indexOf('export function mapIcsEventToRow(')), feeds.indexOf('export function mapIcsEventToRow('));
    expect(doc).toContain("AN IMPORTED SERIES IS STEPPED ON THE FAMILY'S CLOCK, NOT\n * ITS PUBLISHER'S.");
    expect(doc).toContain('no column carries the source TZID');
    const migration = readFileSync(join(ROOT, 'supabase/reserved/0490_a_calendar_feed_sync_writes_only_while_it_holds_its_claim.sql'), 'utf8').replaceAll('\r\n', '\n');
    const header = migration.slice(0, migration.search(/^(?!--)/m));
    expect(header).toContain('Current app imports/readers still use the family clock for legacy series.');
    expect(header).toContain('source_recurrence is a preservation foundation, not an enabled source-clock engine.');
    expect(migration).toMatch(/alter table public\.calendar_events add column if not exists source_recurrence jsonb/i);
  });
});
