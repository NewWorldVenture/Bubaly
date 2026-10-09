import { describe, expect, it } from 'vitest';
import { parseICSSource } from '@/lib/sync/ics-source';
import { exportICSSource } from '@/lib/sync/ics-source-export';
import type { ImportedSourceDocument } from '@/lib/calendar/imported-source';
import fidelity from './fixtures/calendar-source-fidelity.json';

const envelope = (body: string, properties = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic export tests//EN\r\n${properties}${body}END:VCALENDAR\r\n`;
const event = (body = '', uid = 'source') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:20250308T023000Z\r\n${body}END:VEVENT\r\n`;
const parse = (source = envelope(event())) => parseICSSource(source, { etag: '"synthetic-v1"' })[0];

describe('faithful single UID source export', () => {
  it('round trips complete raw source clocks, rules, periods, exclusions, range overrides and cancellations', () => {
    const zone = 'BEGIN:VTIMEZONE\r\nTZID:Publisher\\,Custom\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0230\r\nTZOFFSETTO:+0230\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';
    const master = event('RRULE:FREQ=DAILY;COUNT=5\r\nRDATE;VALUE=PERIOD:20250315T090000Z/PT2H\r\nEXDATE:20250310T023000Z\r\nSUMMARY;LANGUAGE=en:Family\\, lunch\r\nDESCRIPTION:folded\r\n continuation\\nnext\r\nX-OPAQUE;X-PARAM="a;b:c":retained\r\nSEQUENCE:+3\r\nDTSTAMP:20250101T000000Z\r\n')
      .replace('DTSTART:20250308T023000Z', 'DTSTART;TZID="Publisher,Custom":20250308T023000');
    const override = event('RECURRENCE-ID;RANGE=THISANDFUTURE;TZID="Publisher,Custom":20250311T023000\r\nDURATION:P1D\r\n').replace('DTSTART:20250308T023000Z', 'DTSTART;TZID="Publisher,Custom":20250311T033000');
    const cancellation = 'BEGIN:VEVENT\r\nUID:source\r\nRECURRENCE-ID;TZID="Publisher,Custom":20250312T023000\r\nSTATUS:CANCELLED\r\nEND:VEVENT\r\n';
    const source = envelope(zone + master + override + cancellation, 'X-WR-CALNAME:Family\r\n calendar\r\n');
    const document = parse(source), snapshot = structuredClone(document);
    const output = exportICSSource(document);
    expect(output).toBe(source);
    expect(parseICSSource(output, { etag: document.revision.etag })).toEqual([document]);
    expect(document).toEqual(snapshot);
  });

  it.each(fidelity.cases.filter(item => item.ical && item.id !== 'unknown-tzid'))('round trips qualified source fixture $id without claiming expansion results', item => {
    for (const document of parseICSSource(item.ical!, { etag: '"fixture"' })) {
      expect(parseICSSource(exportICSSource(document), { etag: '"fixture"' })).toEqual([document]);
    }
  });

  it('exports only the selected UID from a multi-group source', () => {
    const documents = parseICSSource(envelope(event('', 'A') + event('', 'B')));
    expect(parseICSSource(exportICSSource(documents[1]))).toEqual([documents[1]]);
    expect(exportICSSource(documents[1])).not.toContain('UID:A');
  });

  it('preserves detached-only cancellations and escaped UID/text', () => {
    const input = envelope('BEGIN:VEVENT\r\nUID:source\\,escaped\r\nRECURRENCE-ID;VALUE=DATE:20250308\r\nSTATUS:CANCELLED\r\nSUMMARY:one\\;two\\nthree\\\\four\r\nEND:VEVENT\r\n');
    const document = parse(input);
    expect(document.master).toBeNull();
    expect(exportICSSource(document)).toBe(input);
  });

  it('keeps existing LF folds and adds only necessary terminal fragment separators', () => {
    const source = envelope(event('SUMMARY:folded\r\n continuation\r\n')).replace(/\r\n/g, '\n');
    const document = parse(source);
    expect(exportICSSource(document)).toContain(document.master!.raw!);
    document.master!.raw = document.master!.raw!.replace(/\n$/, '');
    document.rawProperties = document.rawProperties.map(raw => raw.replace(/\n$/, ''));
    const output = exportICSSource(document);
    expect(parseICSSource(output, { etag: document.revision.etag })[0].master!.title).toBe('foldedcontinuation');
  });

  const mutations: [string, (document: ImportedSourceDocument) => void][] = [
    ['typed-only master', document => { document.master!.raw = null; }],
    ['typed title differs', document => { document.master!.title = 'fabricated'; }],
    ['raw title differs', document => { document.master!.raw = document.master!.raw!.replace('END:VEVENT', 'SUMMARY:injected\r\nEND:VEVENT'); }],
    ['raw time differs', document => { document.master!.raw = document.master!.raw!.replace('T023000Z', 'T033000Z'); }],
    ['typed rule differs', document => { document.master!.rrule = 'FREQ=DAILY;COUNT=2'; }],
    ['inconsistent component etag', document => { document.master!.revision.etag = '"other"'; }],
    ['inconsistent group sequence', document => { document.revision.sequence = 99; }],
    ['duplicate envelope injection', document => { document.rawProperties.push('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'); }],
    ['second raw event', document => { document.master!.raw += event(); }],
    ['missing original calendar properties', document => { document.rawProperties = []; }],
  ];
  it.each(mutations)('refuses %s without exporting fabricated semantics', (_name, mutate) => {
    const document = parse(); mutate(document);
    expect(() => exportICSSource(document)).toThrow();
  });

  it('refuses a typed-only override even when its master has complete raw data', () => {
    const document = parse(envelope(event() + event('RECURRENCE-ID:20250309T023000Z\r\n')));
    document.overrides[0].raw = null;
    expect(() => exportICSSource(document)).toThrow(/requires original raw/);
  });
});
