import { describe, expect, it } from 'vitest';
import { parseICSSource, ICS_SOURCE_LIMITS } from '@/lib/sync/ics-source';
import { ImportedSourceValidationError } from '@/lib/calendar/imported-source';
import fidelity from './fixtures/calendar-source-fidelity.json';

const envelope = (body: string, extra = '') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic source tests//EN\r\n${extra}${body}END:VCALENDAR\r\n`;
const event = (extra = '', uid = 'series') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=America/New_York:20250308T023000\r\n${extra}END:VEVENT\r\n`;
const simple = (extra = '') => envelope(event(extra));
const zone = 'BEGIN:VTIMEZONE\r\nTZID:Custom/Source\r\nX-ORIGINAL:kept\r\nBEGIN:STANDARD\r\nDTSTART:20250101T000000\r\nTZOFFSETFROM:+0230\r\nTZOFFSETTO:+0230\r\nRRULE:FREQ=YEARLY;UNTIL=20300101T000000Z\r\nRDATE:20260101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n';

describe('source-preserving ICS admission', () => {
  it('retains source clock and raw rule spelling without generating an instant', () => {
    const rule = 'FREQ=YEARLY;BYYEARDAY=1;BYMONTH=1;COUNT=2';
    const input = simple(`RRULE:${rule}\r\nSUMMARY:Source title\r\nSEQUENCE:3\r\nDTSTAMP:20250101T010000Z\r\nLAST-MODIFIED:20250102T010000Z\r\n`);
    const [doc] = parseICSSource(input, { etag: '"revision-3"' });
    expect(doc.master?.dtstart).toEqual({ kind: 'zoned', tzid: 'America/New_York', value: '20250308T023000' });
    expect(doc.master?.rrule).toBe(rule);
    expect(doc.master?.revision).toEqual({ sequence: 3, dtstamp: '20250101T010000Z', lastModified: '20250102T010000Z', etag: '"revision-3"' });
    expect(doc.revision).toEqual(doc.master?.revision);
    expect(doc.master).not.toHaveProperty('startsAt');
  });
  it('groups all UID masters and detached overrides independently of input order', () => {
    const override = 'BEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID;RANGE=THISANDFUTURE;TZID=America/New_York:20250310T023000\r\nDTSTART;TZID=America/New_York:20250310T033000\r\nEND:VEVENT\r\n';
    const other = event('SUMMARY:Unrelated\r\n', 'other');
    const [doc, second] = parseICSSource(envelope(override + other + event('RRULE:FREQ=DAILY;COUNT=3\r\n')));
    expect(doc.uid).toBe('series'); expect(second.uid).toBe('other');
    expect(doc.master?.rrule).toBe('FREQ=DAILY;COUNT=3');
    expect(doc.overrides).toHaveLength(1);
    expect(doc.overrides[0].recurrenceId).toEqual({ kind: 'zoned', value: '20250310T023000', tzid: 'America/New_York' });
    expect(doc.overrides[0].range).toBe('THISANDFUTURE');
    expect(doc.overrides[0].dtstart?.value).toBe('20250310T033000');
    expect(second.overrides).toEqual([]);
  });
  it('retains detached-only and bare cancellation revisions', () => {
    const input = envelope('BEGIN:VEVENT\r\nUID:series\r\nRECURRENCE-ID;VALUE=DATE:20250310\r\nSTATUS:CANCELLED\r\nSEQUENCE:4\r\nEND:VEVENT\r\n');
    const [doc] = parseICSSource(input);
    expect(doc.master).toBeNull(); expect(doc.overrides[0]).toMatchObject({ dtstart: null, end: null, status: 'cancelled', recurrenceId: { kind: 'date', value: '20250310' } });
    expect(doc.overrides[0].revision.sequence).toBe(4);
  });
  it('preserves cancelled master history with its older overrides', () => {
    const input = envelope(event('STATUS:CANCELLED\r\n') + event('RECURRENCE-ID;TZID=America/New_York:20250309T023000\r\n'));
    const [doc] = parseICSSource(input); expect(doc.master?.status).toBe('cancelled'); expect(doc.overrides).toHaveLength(1);
  });
  it('retains DATE, UTC and floating types with their distinct default ends', () => {
    const make = (start: string, uid: string) => `BEGIN:VEVENT\nUID:${uid}\nDTSTART${start}\nEND:VEVENT\n`;
    const docs = parseICSSource(envelope(make(';VALUE=DATE:20250308', 'date') + make(':20250308T023000Z', 'utc') + make(':20250308T023000', 'floating')));
    expect(docs.map(doc => doc.master?.dtstart?.kind)).toEqual(['date', 'utc', 'floating']);
    expect(docs.map(doc => doc.master?.end)).toEqual([{ kind: 'default' }, { kind: 'default' }, { kind: 'default' }]);
  });
  it('keeps individual RDATE PERIOD ends and durations plus EXDATE and RDATE clocks', () => {
    const [doc] = parseICSSource(simple('RDATE;TZID=America/New_York:20250312T023000,20250313T023000\r\nEXDATE;TZID=America/New_York:20250309T023000\r\nRDATE;VALUE=PERIOD:20250314T090000Z/20250314T120000Z,20250315T090000Z/PT2H\r\n'));
    expect(doc.master?.rdates).toEqual([
      { kind: 'time', value: { kind: 'zoned', tzid: 'America/New_York', value: '20250312T023000' } },
      { kind: 'time', value: { kind: 'zoned', tzid: 'America/New_York', value: '20250313T023000' } },
      { kind: 'period', start: { kind: 'utc', value: '20250314T090000Z' }, end: { kind: 'dtend', value: { kind: 'utc', value: '20250314T120000Z' } } },
      { kind: 'period', start: { kind: 'utc', value: '20250315T090000Z' }, end: { kind: 'duration', value: 'PT2H' } },
    ]);
    expect(doc.master?.exdates).toEqual([{ kind: 'zoned', tzid: 'America/New_York', value: '20250309T023000' }]);
  });
  it('retains exact folded source, unknown semantic parameters, calendar properties and nested alarm', () => {
    const content = event('SUMMARY;ALTREP="cid:part:one";LANGUAGE=en:Folded ' + String.fromCharCode(92) + '\r\n' + ' ,title\r\nX-CUSTOM;X-PARAM="a;b:c":opaque\r\nATTENDEE;CN="Someone: One":mailto:synthetic@example.invalid\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT5M\r\nDESCRIPTION:Alarm\r\nEND:VALARM\r\n');
    const input = envelope(content, 'X-WR-CALNAME;LANGUAGE=en:Original\r\n continuation\r\n');
    const [doc] = parseICSSource(input);
    expect(doc.master?.raw).toBe(content);
    expect(doc.master?.title).toBe('Folded ,title');
    expect(doc.rawProperties).toContain('X-WR-CALNAME;LANGUAGE=en:Original\r\n continuation\r\n');
    expect(doc.master?.raw).toContain('ATTENDEE;CN="Someone: One":mailto:synthetic@example.invalid');
  });
  it('decodes TEXT escapes with backslash parity and rejects even-run unescaped delimiters', () => {
    expect(parseICSSource(simple('SUMMARY:one\\,two\\;three\\nnext\\\\end\r\n'))[0].master?.title).toBe('one,two;three\nnext\\end');
    expect(() => parseICSSource(simple('SUMMARY:one\\\\,two\r\n'))).toThrow(/TEXT delimiter/);
    expect(parseICSSource(simple('SUMMARY:one\\\\\\,two\r\n'))[0].master?.title).toBe('one\\,two');
  });
  it('preserves unknown RFC6868 parameter pairs and decodes only defined pairs', () => {
    for (const parameter of ['abc^z', 'trailing^', 'literal^N']) {
      const original = `SUMMARY;X-PUBLISHER=${parameter}:Class\r\n`;
      const [doc] = parseICSSource(simple(original)); expect(doc.master?.title).toBe('Class'); expect(doc.master?.raw).toContain(original);
    }
    for (const [rawId, parameter] of [['Publisher^Zone', 'Publisher^^Zone'], ['Publisher^N', 'Publisher^N'], ['Publisher"Zone', "Publisher^'Zone"]]) {
      const custom = zone.replace('TZID:Custom/Source', `TZID:${rawId}`);
      const [doc] = parseICSSource(envelope(custom + event().replace('TZID=America/New_York', `TZID="${parameter}"`)));
      expect(doc.master?.dtstart).toMatchObject({ kind: 'zoned', tzid: rawId });
    }
  });
  it('retains exact embedded VTIMEZONE for otherwise unknown TZID without resolving an instant', () => {
    const input = envelope(zone + event().replace('America/New_York', 'Custom/Source'));
    const [doc] = parseICSSource(input); expect(doc.timezones).toEqual([{ tzid: 'Custom/Source', raw: zone }]);
    expect(doc.master?.dtstart).toEqual({ kind: 'zoned', tzid: 'Custom/Source', value: '20250308T023000' });
  });
  it('preserves signed nonnegative SEQUENCE spelling and escaped timezone identity', () => {
    expect(parseICSSource(simple('SEQUENCE:+1\r\n'))[0].master?.revision.sequence).toBe(1);
    const escaped = zone.replace('TZID:Custom/Source', 'TZID:Publisher\\,Custom');
    const input = envelope(escaped + event().replace('TZID=America/New_York', 'TZID="Publisher,Custom"'));
    expect(parseICSSource(input)[0].master?.dtstart).toMatchObject({ kind: 'zoned', tzid: 'Publisher,Custom' });
  });
  it('admits generated-gap source values unchanged, leaving RFC expansion to a qualified engine', () => {
    const [doc] = parseICSSource(simple('RRULE:FREQ=DAILY;COUNT=3\r\n').replace('20250308T023000', '20250309T023000'));
    expect(doc.master?.dtstart?.value).toBe('20250309T023000'); expect(doc.master?.rrule).toBe('FREQ=DAILY;COUNT=3');
  });
  it('returns independent group data and preserves zero-event calendars', () => {
    expect(parseICSSource(envelope(''))).toEqual([]);
    const docs = parseICSSource(envelope(event('', 'A') + event('', 'B')));
    docs[0].rawProperties[0] = 'changed'; expect(docs[1].rawProperties[0]).toBe('VERSION:2.0\r\n');
  });
  it('unfolds many tiny physical lines with retained original source and bounded logical size', () => {
    const folded = `SUMMARY:x${'\r\n x'.repeat(19_000)}\r\n`;
    const [doc] = parseICSSource(simple(folded));
    expect(doc.master?.title).toBe('x'.repeat(19_001)); expect(doc.master?.raw).toContain(folded);
  });
  it('admits the recurrence qualification calendar inputs without treating defect outputs as expectations', () => {
    const cases = fidelity.cases.filter(item => item.kind !== 'harness-timeout');
    expect(cases).toHaveLength(13);
    for (const item of cases) {
      if (item.id === 'unknown-tzid') expect(() => parseICSSource(item.ical!)).toThrow(/TZID/);
      else expect(parseICSSource(item.ical!).length, item.id).toBeGreaterThan(0);
    }
  });
});

describe('explicit source refusals instead of hidden loss', () => {
  it.each([
    ['duplicate DTSTART', simple('DTSTART:20250101T000000Z\r\n')],
    ['duplicate master', envelope(event() + event())],
    ['duplicate override identity', envelope(event('RECURRENCE-ID;TZID=America/New_York:20250310T023000\r\n') + event('RECURRENCE-ID;TZID=America/New_York:20250310T023000\r\n'))],
    ['duplicate parameter', simple('').replace('DTSTART;TZID=', 'DTSTART;VALUE=DATE-TIME;VALUE=DATE-TIME;TZID=')],
    ['multiple parameter values', simple('').replace('TZID=America/New_York', 'TZID=America/New_York,Europe/Berlin')],
    ['UTC with TZID', simple('').replace('20250308T023000', '20250308T023000Z')],
    ['DATE without explicit VALUE', simple('').replace('DTSTART;TZID=America/New_York:20250308T023000', 'DTSTART:20250308')],
    ['DATE with TZID', simple('').replace('DTSTART;TZID=', 'DTSTART;VALUE=DATE;TZID=').replace('20250308T023000', '20250308')],
    ['impossible day', simple('').replace('20250308', '20250230')],
    ['invalid clock', simple('').replace('T023000', 'T250000')],
    ['unknown timezone', simple('').replace('America/New_York', 'Invented/Unknown')],
    ['unknown RANGE', simple('RECURRENCE-ID;RANGE=THISANDPRIOR;TZID=America/New_York:20250310T023000\r\n')],
    ['RANGE on DTSTART', simple('').replace('DTSTART;TZID=', 'DTSTART;RANGE=THISANDFUTURE;TZID=')],
    ['both end forms', simple('DTEND;TZID=America/New_York:20250308T033000\r\nDURATION:PT1H\r\n')],
    ['backwards PERIOD', simple('RDATE;VALUE=PERIOD:20250308T090000Z/20250308T080000Z\r\n')],
    ['malformed PERIOD', simple('RDATE;VALUE=PERIOD:20250308T090000Z/PT1H/extra\r\n')],
    ['untyped PERIOD', simple('RDATE:20250308T090000Z/PT1H\r\n')],
    ['unsupported rule', simple('RRULE:FREQ=YEARLY;BYEASTER=1\r\n')],
    ['duplicate rule part', simple('RRULE:FREQ=DAILY;COUNT=2;COUNT=3\r\n')],
    ['unsupported EXRULE', simple('EXRULE:FREQ=DAILY;COUNT=2\r\n')],
    ['non-UTC revision', simple('DTSTAMP:20250101T000000\r\n')],
    ['invalid sequence', simple('SEQUENCE:1.5\r\n')],
    ['negative sequence', simple('SEQUENCE:-1\r\n')],
    ['overflow sequence', simple('SEQUENCE:+2147483648\r\n')],
    ['unsupported status', simple('STATUS:COMPLETED\r\n')],
    ['invalid TEXT escape', simple('SUMMARY:bad\\q\r\n')],
    ['unescaped TEXT delimiter', simple('SUMMARY:bad,split\r\n')],
    ['unbalanced quote', simple('SUMMARY;ALTREP="cid:no-end:title\r\n')],
    ['mismatched nesting', simple('').replace('END:VEVENT', 'END:VTIMEZONE')],
    ['unknown calendar component', envelope('BEGIN:VTODO\r\nUID:task\r\nEND:VTODO\r\n')],
    ['unknown event child', simple('BEGIN:X-CHILD\r\nX:opaque\r\nEND:X-CHILD\r\n')],
    ['trailing property', simple('') + 'SUMMARY:outside\r\n'],
    ['second envelope', simple('') + simple('')],
    ['missing version', simple('').replace('VERSION:2.0\r\n', '')],
    ['unsupported scheduling envelope', envelope(event(), 'METHOD:CANCEL\r\n')],
    ['bare CR', simple('').replace('VERSION:2.0\r\n', 'VERSION:2.0\r')],
    ['orphan fold', ' orphan\r\n' + simple('')],
    ['blank content line', simple('').replace('VERSION:2.0\r\n', 'VERSION:2.0\r\n\r\n')],
    ['NUL', simple('X-OPAQUE:\u0000\r\n')],
    ['lone high surrogate even without events', envelope('', 'X-OPAQUE:\ud800\r\n')],
    ['lone low surrogate', simple('SUMMARY:\udfff\r\n')],
    ['invalid timezone observance', envelope(zone.replace('DTSTART:20250101T000000', 'DTSTART:20250230T000000'))],
    ['duplicate timezone rule', envelope(zone.replace('RDATE:', 'RRULE:FREQ=YEARLY\r\nRDATE:') + event().replace('America/New_York', 'Custom/Source'))],
    ['timezone UTC RDATE', envelope(zone.replace('RDATE:20260101T000000', 'RDATE:20260101T000000Z'))],
    ['duplicate unused timezones', envelope(zone + zone)],
  ])('rejects %s', (_name, input) => { expect(() => parseICSSource(input)).toThrow(ImportedSourceValidationError); });
  it('bounds physical/unfolded lines, input bytes and duplicated grouped output', () => {
    expect(() => parseICSSource(simple(`X-LONG:${'x'.repeat(ICS_SOURCE_LIMITS.lineBytes)}\r\n`))).toThrow(/line exceeds/);
    expect(() => parseICSSource('x'.repeat(ICS_SOURCE_LIMITS.bytes + 1))).toThrow(/byte bound/);
    expect(() => parseICSSource(simple(`SUMMARY:x\r\n ${'x'.repeat(ICS_SOURCE_LIMITS.lineBytes - 1)}\r\n`))).toThrow(/unfolded line exceeds/);
    expect(() => parseICSSource(simple('X:A\r\n'.repeat(ICS_SOURCE_LIMITS.lines)))).toThrow(/line bound/);
    const largeZone = zone.replace('X-ORIGINAL:kept', Array.from({ length: 20 }, () => `X-LARGE:${'x'.repeat(2000)}`).join('\r\n'));
    const many = Array.from({ length: 40 }, (_, index) => event('', `id-${index}`)).join('');
    expect(() => parseICSSource(envelope(largeZone + many))).toThrow(/grouped output exceeds/);
  });
});
