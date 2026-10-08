import { describe, expect, it } from 'vitest';
import { parseICSSource } from '@/lib/sync/ics-source';
import { expandSourceOccurrences } from '@/lib/calendar/source-occurrences';
import type { ImportedSourceDocument } from '@/lib/calendar/imported-source';

const from = Date.parse('2025-01-01T00:00:00Z'), to = Date.parse('2026-01-01T00:00:00Z');
function source(events: string[], properties = ''): ImportedSourceDocument {
  return parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic tests//EN\r\n${properties}${events.map(event => `BEGIN:VEVENT\r\nUID:synthetic\r\n${event}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`)[0];
}
function expand(doc: ImportedSourceDocument, window = { from, to }) { return expandSourceOccurrences(doc, { ...window, dateTimezone: 'UTC' }); }
const master = 'DTSTART:20250101T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=4\r\nSUMMARY:Original';

describe('complete bounded source occurrence sets', () => {
  it('charges an enclosing budget and propagates its failure without returning a prefix', () => {
    let work = 0;
    const doc = source([master]);
    expect(expandSourceOccurrences(doc, { from, to, consumeWork: amount => { work += amount; } }).count).toBe(4);
    expect(work).toBeGreaterThan(4);
    let bounded = 0;
    expect(() => expandSourceOccurrences(doc, { from, to, consumeWork: amount => { bounded += amount; if (bounded > work - 1) throw new Error('outer budget'); } })).toThrow('outer budget');
  });
  it('unions DTSTART/RRULE/RDATE, dedupes identities and excludes after COUNT', () => {
    const result = expand(source([`${master}\r\nRDATE:20250102T090000Z,20250110T090000Z\r\nEXDATE:20250101T090000Z,20250103T090000Z`]));
    expect(result.count).toBe(3);
    expect(result.occurrences.map(c => c.startsAt)).toEqual(['2025-01-02T09:00:00.000Z', '2025-01-04T09:00:00.000Z', '2025-01-10T09:00:00.000Z']);
  });
  it('honors PERIOD duration on a duplicate ordinary RDATE', () => {
    const result = expand(source([`${master}\r\nRDATE:20250102T090000Z\r\nRDATE;VALUE=PERIOD:20250102T090000Z/20250102T120000Z`]));
    expect(result.occurrences[1].endsAt).toBe('2025-01-02T12:00:00.000Z');
  });
  it('rejects conflicting PERIOD end definitions', () => {
    expect(() => expand(source([`${master}\r\nRDATE;VALUE=PERIOD:20250102T090000Z/PT2H,20250102T090000Z/PT3H`]))).toThrow();
  });
  it('includes moved-in instances and excludes moved-out and cancelled instances, preserving original IDs', () => {
    const doc = source([master,
      'RECURRENCE-ID:20250101T090000Z\r\nDTSTART:20250103T100000Z\r\nDURATION:PT2H\r\nSUMMARY:Moved',
      'RECURRENCE-ID:20250103T090000Z\r\nDTSTART:20250203T090000Z\r\nDURATION:PT1H',
      'RECURRENCE-ID:20250104T090000Z\r\nSTATUS:CANCELLED']);
    const result = expand(doc, { from: Date.parse('2025-01-03'), to: Date.parse('2025-01-05') });
    expect(result.count).toBe(1);
    expect(result.occurrences[0]).toMatchObject({ original: { kind: 'utc', value: '20250101T090000Z' }, startsAt: '2025-01-03T10:00:00.000Z', endsAt: '2025-01-03T12:00:00.000Z', title: 'Moved' });
    expect(result.occurrences[0].id).toBe('["synthetic","utc",null,"20250101T090000Z"]');
  });
  it('uses the latest original RANGE noncumulatively and exempts explicit exceptions', () => {
    const result = expand(source([`${master.replace('COUNT=4', 'COUNT=5')}`,
      'RECURRENCE-ID;RANGE=THISANDFUTURE:20250102T090000Z\r\nDTSTART:20250102T100000Z\r\nDURATION:PT2H',
      'RECURRENCE-ID:20250103T090000Z\r\nDTSTART:20250103T070000Z\r\nDURATION:PT30M',
      'RECURRENCE-ID;RANGE=THISANDFUTURE:20250104T090000Z\r\nDTSTART:20250104T120000Z\r\nDURATION:PT3H']));
    expect(result.occurrences.map(c => [c.startsAt.slice(11, 16), c.endsAt.slice(11, 16)])).toEqual([['09:00', '10:00'], ['10:00', '12:00'], ['07:00', '07:30'], ['12:00', '15:00'], ['12:00', '15:00']]);
  });
  it('cancels future slots and permits a separately defined explicit exception', () => {
    const result = expand(source([master,
      'RECURRENCE-ID;RANGE=THISANDFUTURE:20250102T090000Z\r\nSTATUS:CANCELLED',
      'RECURRENCE-ID:20250103T090000Z\r\nDTSTART:20250103T120000Z\r\nDURATION:PT1H']));
    expect(result.occurrences.map(c => c.startsAt)).toEqual(['2025-01-01T09:00:00.000Z', '2025-01-03T12:00:00.000Z']);
  });
  it('treats DTEND as exact elapsed duration but P1D as nominal and PT24H as elapsed across DST', () => {
    const seed = 'DTSTART;TZID=America/New_York:20250308T090000\r\nRRULE:FREQ=DAILY;COUNT=2';
    const exact = expand(source([`${seed}\r\nDTEND;TZID=America/New_York:20250309T090000`]));
    const nominal = expand(source([`${seed}\r\nDURATION:P1D`]));
    const elapsed = expand(source([`${seed}\r\nDURATION:PT24H`]));
    expect(exact.occurrences.map(c => c.endsAt)).toEqual(['2025-03-09T13:00:00.000Z', '2025-03-10T12:00:00.000Z']);
    expect(nominal.occurrences.map(c => c.endsAt)).toEqual(['2025-03-09T13:00:00.000Z', '2025-03-10T13:00:00.000Z']);
    expect(elapsed.occurrences.map(c => c.endsAt)).toEqual(['2025-03-09T14:00:00.000Z', '2025-03-10T13:00:00.000Z']);
  });
  it('adds nominal days before exact hours', () => {
    const result = expand(source(['DTSTART;TZID=America/New_York:20250308T090000\r\nDURATION:P1DT2H']));
    expect(result.occurrences[0].endsAt).toBe('2025-03-09T15:00:00.000Z');
  });
  it('skips generated gaps before COUNT and applies EXDATE without replenishing', () => {
    const result = expand(source(['DTSTART;TZID=America/New_York:20250308T023000\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;TZID=America/New_York:20250308T023000']));
    expect(result.occurrences.map(c => c.startsAt)).toEqual(['2025-03-10T06:30:00.000Z', '2025-03-11T06:30:00.000Z']);
  });
  it('retains an explicit gap DTSTART as COUNT first', () => {
    const result = expand(source(['DTSTART;TZID=America/New_York:20250309T023000\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=2']));
    expect(result.occurrences.map(c => c.startsAt)).toEqual(['2025-03-09T07:30:00.000Z', '2025-03-10T06:30:00.000Z']);
  });
  it('uses half-open overlap, including zero duration starts and earlier long events', () => {
    const window = { from: Date.parse('2025-01-02'), to: Date.parse('2025-01-03') };
    expect(expand(source(['DTSTART:20250101T090000Z\r\nDURATION:P2D']), window).count).toBe(1);
    expect(expand(source(['DTSTART:20250102T000000Z']), window).count).toBe(1);
    expect(expand(source(['DTSTART:20250103T000000Z']), window).count).toBe(0);
    expect(expand(source(['DTSTART:20250101T000000Z\r\nDURATION:P1D']), window).count).toBe(0);
  });
  it('preserves detached events, tombstones and the unchanged document', () => {
    const doc = source(['RECURRENCE-ID:20250102T090000Z\r\nDTSTART:20250103T090000Z\r\nDURATION:PT1H', 'RECURRENCE-ID:20250104T090000Z\r\nSTATUS:CANCELLED']);
    const before = JSON.stringify(doc);
    expect(expand(doc).count).toBe(1);
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('rejects raw/typed conflict and unknown temporal parameters', () => {
    const doc = source([master]); doc.master!.title = 'Conflicting title';
    const before = JSON.stringify(doc);
    expect(() => expand(doc)).toThrow();
    expect(JSON.stringify(doc)).toBe(before);
    expect(() => expand(source([master.replace('DTSTART:', 'DTSTART;X-SHIFT=HIDDEN:')]))).toThrow(/parameter/);
  });
  it.each(['RRULE', 'DURATION'])('rejects unsupported TZID on raw %s rather than ignoring its meaning', property => {
    const doc = source([master]);
    doc.master!.raw = doc.master!.raw!.replace(`${property}:`, `${property};TZID=America/New_York:`);
    expect(() => expand(doc)).toThrow(/temporal parameter|parameter TZID/);
  });
  it('refuses unqualified scheduling, cross-clock RANGE and orphan exceptions', () => {
    expect(() => expand(source([master], 'METHOD:CANCEL\r\n'))).toThrow(/METHOD/);
    expect(() => expand(source([master, 'RECURRENCE-ID;RANGE=THISANDFUTURE:20250102T090000Z\r\nDTSTART;TZID=America/New_York:20250102T090000\r\nDURATION:PT1H']))).toThrow(/cross-clock/);
    expect(() => expand(source([master, 'RECURRENCE-ID:20250202T090000Z\r\nSTATUS:CANCELLED']))).toThrow(/original recurrence/);
  });
  it('throws on exhausted bounds rather than returning a prefix', () => {
    expect(() => expandSourceOccurrences(source([master]), { from, to, maxOccurrences: 2 })).toThrow(/bound/);
    expect(() => expandSourceOccurrences(source([master]), { from, to, maxWork: 1 })).toThrow();
  });
  it('requires explicit floating and DATE context', () => {
    expect(() => expandSourceOccurrences(source(['DTSTART:20250101T090000']), { from, to })).toThrow();
    const doc = source(['DTSTART;VALUE=DATE:20250101\r\nRRULE:FREQ=DAILY;COUNT=2']);
    expect(() => expandSourceOccurrences(doc, { from, to })).toThrow();
    expect(expand(doc).occurrences.map(c => c.endsAt)).toEqual(['2025-01-02T00:00:00.000Z', '2025-01-03T00:00:00.000Z']);
  });
  it('retains Gregorian DATE identities across Apia skipped date', () => {
    const doc = source(['DTSTART;VALUE=DATE:20111229\r\nRRULE:FREQ=DAILY;COUNT=4']);
    const before = JSON.stringify(doc);
    const result = expandSourceOccurrences(doc, { from: Date.parse('2011-12-28'), to: Date.parse('2012-01-03'), dateTimezone: 'Pacific/Apia' });
    expect(result.occurrences.map(c => c.original.value)).toEqual(['20111229', '20111230', '20111231', '20120101']);
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('accepts semicolons in quoted embedded TZID parameters', () => {
    const doc = source(['DTSTART;TZID="Synthetic;Zone":20250101T090000\r\nDURATION:PT1H'], 'BEGIN:VTIMEZONE\r\nTZID:Synthetic\\;Zone\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n');
    expect(expand(doc).occurrences[0].startsAt).toBe('2025-01-01T08:00:00.000Z');
  });
  it('charges aggregate traversal with many ranges under a small budget', () => {
    const base = 'DTSTART:20250101T000000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=HOURLY;COUNT=100';
    const ranges = Array.from({ length: 50 }, (_, i) => {
      const token = new Date(Date.parse('2025-01-01') + i * 3600_000).toISOString().replace(/[-:]/g, '').replace('.000', '');
      return `RECURRENCE-ID;RANGE=THISANDFUTURE:${token}\r\nDTSTART:${token}\r\nDURATION:PT1H`;
    });
    const doc = source([base, ...ranges]);
    expect(() => expandSourceOccurrences(doc, { from, to, maxWork: 350 })).toThrow(/bound/);
    expect(expandSourceOccurrences(doc, { from, to, maxWork: 5000 }).count).toBe(100);
  });
  it.each(['+PT1H', 'pt1h'])('accepts retained RFC duration spelling %s', spelling => {
    expect(expand(source([`DTSTART:20250101T090000Z\r\nDURATION:${spelling}`])).occurrences[0].endsAt).toBe('2025-01-01T10:00:00.000Z');
  });
  it('excludes only the original DATE identity when contextual zone skips a date', () => {
    const doc = source(['DTSTART;VALUE=DATE:20111229\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;VALUE=DATE:20111230']);
    expect(expandSourceOccurrences(doc, { from: Date.parse('2011-12-28'), to: Date.parse('2012-01-03'), dateTimezone: 'Pacific/Apia' }).occurrences.map(c => c.original.value)).toEqual(['20111229', '20111231', '20120101']);
  });
  it('does not fail prepared coverage for a retained future zoned RDATE outside query', () => {
    const doc = source(['DTSTART;TZID=America/New_York:20250101T090000\r\nDURATION:PT1H\r\nRDATE;TZID=America/New_York:20500101T090000']);
    expect(expand(doc).count).toBe(1);
  });
  it('prepares future RDATE clocks without extending an infinite RRULE scan to that date', () => {
    const doc = source(['DTSTART;TZID=America/New_York:20250101T090000\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY\r\nRDATE;TZID=America/New_York:20500101T090000']);
    const result = expandSourceOccurrences(doc, { from, to: Date.parse('2025-01-10'), maxOccurrences: 20 });
    expect(result.count).toBe(9);
  });
  it('prepares nominal end targets beyond the query and generated start horizon', () => {
    const doc = source(['DTSTART;TZID=America/New_York:20250101T090000\r\nDURATION:P1100D\r\nRRULE:FREQ=DAILY']);
    const result = expandSourceOccurrences(doc, { from, to: Date.parse('2025-01-03'), maxOccurrences: 20 });
    expect(result.occurrences.map(c => c.endsAt)).toEqual(['2028-01-06T14:00:00.000Z', '2028-01-07T14:00:00.000Z']);
  });
  it('keeps recurring DATE DTEND in the exclusive Gregorian date domain across DST', () => {
    const doc = source(['DTSTART;VALUE=DATE:20250308\r\nDTEND;VALUE=DATE:20250309\r\nRRULE:FREQ=DAILY;COUNT=3']);
    const result = expandSourceOccurrences(doc, { from, to, dateTimezone: 'America/New_York' });
    expect(result.occurrences.map(c => c.endsAt)).toEqual(['2025-03-09T05:00:00.000Z', '2025-03-10T04:00:00.000Z', '2025-03-11T04:00:00.000Z']);
  });
  it('keeps DATE DTEND day spans across a skipped contextual date', () => {
    const doc = source(['DTSTART;VALUE=DATE:20111229\r\nDTEND;VALUE=DATE:20111231\r\nRRULE:FREQ=DAILY;COUNT=3']);
    const result = expandSourceOccurrences(doc, { from: Date.parse('2011-12-28'), to: Date.parse('2012-01-04'), dateTimezone: 'Pacific/Apia' });
    expect(result.occurrences.map(c => [c.original.value, c.endsAt])).toEqual([['20111229', '2011-12-30T10:00:00.000Z'], ['20111230', '2011-12-31T10:00:00.000Z'], ['20111231', '2012-01-01T10:00:00.000Z']]);
  });
  it('retains concrete moved DATE boundaries independently of original identity and UTC day', () => {
    const doc = source(['DTSTART;VALUE=DATE:20250101\r\nDURATION:P2D\r\nRRULE:FREQ=DAILY;COUNT=2',
      'RECURRENCE-ID;VALUE=DATE:20250101\r\nDTSTART;VALUE=DATE:20250105\r\nDTEND;VALUE=DATE:20250108']);
    const result = expandSourceOccurrences(doc, { from, to, dateTimezone: 'Asia/Tokyo' });
    const moved = result.occurrences.find(c => c.original.value === '20250101')!;
    expect(moved).toMatchObject({ original: { kind: 'date', value: '20250101' }, sourceStart: { kind: 'date', value: '20250105' }, sourceEndDate: '20250108',
      startsAt: '2025-01-04T15:00:00.000Z', endsAt: '2025-01-07T15:00:00.000Z' });
    expect(result.occurrences.find(c => c.original.value === '20250102')).toMatchObject({ sourceStart: { kind: 'date', value: '20250102' }, sourceEndDate: '20250104' });
  });
  it('retains distinct concrete DATE slots when contextual projection collapses a skipped date', () => {
    const doc = source(['DTSTART;VALUE=DATE:20111230\r\nRRULE:FREQ=DAILY;COUNT=2']);
    const result = expandSourceOccurrences(doc, { from: Date.parse('2011-12-29'), to: Date.parse('2012-01-02'), dateTimezone: 'Pacific/Apia' });
    expect(result.occurrences.map(c => [c.sourceStart.value, c.sourceEndDate])).toEqual([['20111230', '20111231'], ['20111231', '20120101']]);
    expect(result.occurrences[0].startsAt).toBe(result.occurrences[1].startsAt);
    expect(result.occurrences[0].id).not.toBe(result.occurrences[1].id);
  });
  it('retains the concrete moved timed source clock without inventing an all-day end', () => {
    const result = expand(source([master, 'RECURRENCE-ID:20250101T090000Z\r\nDTSTART;TZID=America/New_York:20250103T100000\r\nDURATION:PT1H']));
    expect(result.occurrences.find(c => c.original.value === '20250101T090000Z')).toMatchObject({ sourceStart: { kind: 'zoned', tzid: 'America/New_York', value: '20250103T100000' }, sourceEndDate: null, startsAt: '2025-01-03T15:00:00.000Z' });
  });
});
