import { describe, expect, it } from 'vitest';
import {
  IMPORTED_SOURCE_LIMITS, ImportedSourceValidationError, parseImportedSource, validateImportedSource,
  type ImportedSourceComponent, type ImportedSourceDocument, type ImportedSourceOverride,
  type ImportedSourceRevision, type SourceTime,
} from '@/lib/calendar/imported-source';

const revision = (): ImportedSourceRevision => ({ sequence: 3, dtstamp: '20261001T120000Z', lastModified: null, etag: '"source-v3"' });
const utc = (value = '20261005T090000Z'): SourceTime => ({ kind: 'utc', value });
const date = (value = '20261005'): SourceTime => ({ kind: 'date', value });
const zoned = (tzid = 'America/New_York', value = '20261005T090000'): SourceTime => ({ kind: 'zoned', value, tzid });
function component(): ImportedSourceComponent {
  return { raw: null, uid: 'series@example.test', title: 'Class', description: 'Keep\\nraw text', location: null,
    status: 'confirmed', dtstart: utc(), end: { kind: 'dtend', value: utc('20261005T100000Z') },
    rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=12', rdates: [], exdates: [], revision: revision() };
}
function override(): ImportedSourceOverride {
  return { ...component(), rrule: null, recurrenceId: utc('20261019T090000Z'), range: 'none',
    dtstart: utc('20261020T110000Z'), end: { kind: 'duration', value: 'PT90M' } };
}
function document(): ImportedSourceDocument {
  return { version: 1, uid: 'series@example.test', master: component(), overrides: [override()], timezones: [], revision: revision(), rawProperties: ['VERSION:2.0', 'PRODID:-//Synthetic//EN'] };
}
const customZone = (tzid = 'Publisher/Custom') => ({ tzid, raw: [
  'BEGIN:VTIMEZONE', `TZID:${tzid}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0130', 'TZOFFSETTO:+0130', 'END:STANDARD', 'END:VTIMEZONE', '',
].join('\r\n') });

describe('imported source storage foundation (no expansion capability)', () => {
  it('preserves a complete UID group, raw rule spelling, periods, exclusions and original moved-slot identity', () => {
    const input = document();
    input.master!.rrule = 'freq=weekly;interval=02;byday=MO,WE;count=012';
    input.master!.rdates = [{ kind: 'time', value: utc('20261006T090000Z') },
      { kind: 'period', start: utc('20261007T090000Z'), end: { kind: 'dtend', value: utc('20261007T110000Z') } },
      { kind: 'period', start: utc('20261008T090000Z'), end: { kind: 'duration', value: '+PT3H' } }];
    input.master!.exdates = [utc('20261019T090000Z')];
    input.overrides.push({ ...override(), recurrenceId: utc('20261102T090000Z'), status: 'cancelled', dtstart: null, end: null });
    const output = parseImportedSource(input);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
    output.master!.rdates.length = 0;
    expect(input.master!.rdates).toHaveLength(3);
  });
  it.each(['date', 'utc', 'zoned', 'floating'] as const)('retains %s source clock without converting it to an instant', kind => {
    const input = document();
    const start: SourceTime = kind === 'date' ? date() : kind === 'utc' ? utc() : kind === 'zoned' ? zoned() : { kind, value: '20261005T090000' };
    input.master!.dtstart = start;
    input.master!.end = { kind: 'duration', value: kind === 'date' ? 'P2D' : 'P1DT30M' };
    input.overrides = [];
    expect(parseImportedSource(input).master!.dtstart).toEqual(start);
  });
  it('preserves exact custom timezone definitions and RANGE without claiming a usable engine', () => {
    const input = document();
    input.timezones = [customZone()];
    input.master!.dtstart = zoned('Publisher/Custom');
    input.master!.end = { kind: 'duration', value: 'P1D' };
    input.overrides[0].recurrenceId = zoned('Publisher/Custom', '20261019T090000');
    input.overrides[0].range = 'THISANDFUTURE';
    expect(parseImportedSource(input)).toEqual(input);
    expect(() => parseImportedSource(input, { externalUid: input.uid, startsAt: '20261005T07:30:00Z' })).toThrow(/source-clock resolver/);
  });
  it('retains bare master cancellations and detached cancellation groups', () => {
    const input = document();
    input.master = { ...component(), status: 'cancelled', dtstart: null, end: null, rrule: null };
    input.overrides = [];
    expect(validateImportedSource(input).ok).toBe(true);
    input.master = null;
    input.overrides = [{ ...override(), status: 'cancelled', dtstart: null, end: null }];
    expect(validateImportedSource(input).ok).toBe(true);
  });
  it.each([
    'FREQ=DAILY;UNTIL=20261231T090000Z', 'FREQ=MONTHLY;BYDAY=-1MO;COUNT=5',
    'FREQ=YEARLY;BYWEEKNO=2;BYDAY=MO;WKST=SU', 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    'FREQ=HOURLY;BYMINUTE=15,45;COUNT=10', 'FREQ=YEARLY;BYYEARDAY=-1;BYMONTH=12',
  ])('retains valid selector grammar %s without expanding it', raw => {
    const input = document(); input.master!.rrule = raw;
    expect(parseImportedSource(input).master!.rrule).toBe(raw);
  });
  it('accepts DATE UNTIL and floating UNTIL only with the matching source kind', () => {
    const input = document(); input.overrides = [];
    input.master!.dtstart = date(); input.master!.end = { kind: 'default' }; input.master!.rrule = 'FREQ=DAILY;UNTIL=20261231';
    expect(validateImportedSource(input).ok).toBe(true);
    input.master!.dtstart = { kind: 'floating', value: '20261005T090000' }; input.master!.rrule = 'FREQ=DAILY;UNTIL=20261231T090000';
    expect(validateImportedSource(input).ok).toBe(true);
  });
  it('proves UTC and DATE projection fields without changing their source', () => {
    const input = document();
    expect(parseImportedSource(input, { externalUid: input.uid, title: 'Class', allDay: false,
      startsAt: '2026-10-05T09:00:00.000Z', endsAt: '2026-10-05T10:00:00Z' })).toEqual(input);
    input.overrides = []; input.master!.dtstart = date(); input.master!.end = { kind: 'dtend', value: date('20261007') };
    expect(validateImportedSource(input, { externalUid: input.uid, allDay: true, startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-07T00:00:00Z' }).ok).toBe(true);
  });
  const invalid: [string, (input: ImportedSourceDocument) => void][] = [
    ['unknown version', input => Object.assign(input, { version: 2 })],
    ['unknown field', input => Object.assign(input, { extra: 'lost if normalized' })],
    ['missing field', input => Reflect.deleteProperty(input.master!, 'end')],
    ['UID crossover', input => { input.overrides[0].uid = 'other'; }],
    ['duplicate original slot with different replacement time', input => { input.overrides.push({ ...override(), dtstart: utc('20261021T090000Z') }); }],
    ['unknown RANGE', input => Object.assign(input.overrides[0], { range: 'THISANDPRIOR' })],
    ['DATE recurrence ID against timed master', input => { input.overrides[0].recurrenceId = date(); }],
    ['UTC recurrence ID against floating master', input => { input.master!.dtstart = { kind: 'floating', value: '20261005T090000' }; }],
    ['changed original TZID', input => { input.master!.dtstart = zoned(); input.overrides[0].recurrenceId = zoned('Europe/London'); }],
    ['override changes DATE value type', input => { input.overrides[0].dtstart = date(); input.overrides[0].end = { kind: 'default' }; }],
    ['EXDATE mismatches DATE value type', input => { input.master!.exdates = [date()]; }],
    ['RDATE mismatches DATE value type', input => { input.master!.rdates = [{ kind: 'time', value: date() }]; }],
    ['DATE used for period', input => { input.master!.rdates = [{ kind: 'period', start: date(), end: { kind: 'duration', value: 'P1D' } }]; }],
    ['period end precedes start', input => { input.master!.rdates = [{ kind: 'period', start: utc(), end: { kind: 'dtend', value: utc('20261004T090000Z') } }]; }],
    ['invalid Gregorian date', input => { input.master!.dtstart = utc('20260230T090000Z'); }],
    ['UTC token disguised as floating', input => { input.master!.dtstart = { kind: 'floating', value: '20261005T090000Z' }; }],
    ['unknown zone without retained definition', input => { input.master!.dtstart = zoned('Publisher/Missing'); }],
    ['duplicate timezone identity', input => { input.timezones = [customZone(), customZone()]; }],
    ['timezone identity conflicts with raw definition', input => { input.timezones = [{ ...customZone(), tzid: 'Other' }]; }],
    ['timezone definition contains second component', input => { const zone = customZone(); zone.raw += 'BEGIN:VTIMEZONE\r\n'; input.timezones = [zone]; }],
    ['timezone observance missing offset', input => { const zone = customZone(); zone.raw = zone.raw.replace('TZOFFSETTO:+0130\r\n', ''); input.timezones = [zone]; }],
    ['timezone invalid offset', input => { const zone = customZone(); zone.raw = zone.raw.replace('+0130', '+2500'); input.timezones = [zone]; }],
    ['live component without start', input => { input.master!.dtstart = null; input.master!.end = null; }],
    ['bare cancellation with unanchored end', input => { input.master!.status = 'cancelled'; input.master!.dtstart = null; }],
    ['empty source group', input => { input.master = null; input.overrides = []; }],
    ['negative duration', input => { input.master!.end = { kind: 'duration', value: '-P1D' }; }],
    ['zero duration', input => { input.master!.end = { kind: 'duration', value: 'PT0S' }; }],
    ['empty duration time', input => { input.master!.end = { kind: 'duration', value: 'P1DT' }; }],
    ['fractional sequence', input => { input.revision.sequence = 1.5; }],
    ['local revision timestamp', input => { input.revision.dtstamp = '20261001T120000'; }],
    ['too many overrides', input => { input.overrides = Array.from({ length: IMPORTED_SOURCE_LIMITS.overrides + 1 }, override); }],
    ['too many dates', input => { input.master!.exdates = Array.from({ length: IMPORTED_SOURCE_LIMITS.dates + 1 }, () => utc()); }],
  ];
  it.each(invalid)('refuses %s', (_name, mutate) => {
    const input = document(); mutate(input);
    expect(() => parseImportedSource(input)).toThrow(ImportedSourceValidationError);
    expect(validateImportedSource(input)).toMatchObject({ ok: false, error: expect.any(ImportedSourceValidationError) });
  });
  it.each([
    'FREQ=DAILY;COUNT=2;UNTIL=20261231T090000Z', 'FREQ=DAILY;COUNT=0', 'FREQ=WEEKLY;INTERVAL=0',
    'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=DAILY;BYDAY=0MO',
    'FREQ=WEEKLY;BYMONTHDAY=1', 'FREQ=MONTHLY;BYWEEKNO=2', 'FREQ=DAILY;BYMONTH=13',
    'FREQ=MONTHLY;BYSETPOS=1', 'FREQ=YEARLY;BYYEARDAY=0', 'FREQ=DAILY;UNTIL=20261231',
    'FREQ=DAILY;BYHOUR=24', 'FREQ=DAILY;INTERVAL=9007199254740992', 'FREQ=DAILY;UNKNOWN=1',
  ])('rejects malformed/incompatible RRULE %s', raw => {
    const input = document(); input.master!.rrule = raw;
    expect(validateImportedSource(input).ok).toBe(false);
  });
  it.each([
    { externalUid: 'different' }, { externalUid: 'series@example.test', title: 'Other' },
    { externalUid: 'series@example.test', allDay: true },
    { externalUid: 'series@example.test', startsAt: '2026-10-05T10:00:00Z' },
    { externalUid: 'series@example.test', endsAt: null },
  ])('refuses a conflicting projection %j', expected => {
    expect(validateImportedSource(document(), expected).ok).toBe(false);
  });
  it('refuses unproved duration and floating projections, retaining their source without projection', () => {
    const input = document(); input.overrides = []; input.master!.end = { kind: 'duration', value: 'P1D' };
    expect(validateImportedSource(input).ok).toBe(true);
    expect(validateImportedSource(input, { externalUid: input.uid, endsAt: '2026-10-06T09:00:00Z' }).ok).toBe(false);
    input.master!.dtstart = { kind: 'floating', value: '20261005T090000' };
    expect(validateImportedSource(input, { externalUid: input.uid, startsAt: '2026-10-05T09:00:00Z' }).ok).toBe(false);
  });
  it('retains leap seconds but refuses to prove their JS instant projection', () => {
    const input = document(); input.overrides = []; input.master!.dtstart = utc('20161231T235960Z'); input.master!.end = { kind: 'default' };
    expect(validateImportedSource(input).ok).toBe(true);
    expect(validateImportedSource(input, { externalUid: input.uid, startsAt: '2017-01-01T00:00:00Z' }).ok).toBe(false);
  });
  it('rejects cyclic/non-JSON/hidden input instead of coercing or invoking it', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    let invoked = false;
    const accessor = Object.defineProperty({}, 'version', { enumerable: true, get: () => { invoked = true; return 1; } });
    const sparse = Array(2);
    for (const value of [cyclic, accessor, new Date(), { value: undefined }, { value: NaN }, { value: -0 }, { value: BigInt(1) }, sparse]) {
      expect(validateImportedSource(value).ok).toBe(false);
    }
    expect(invoked).toBe(false);
  });
  it('bounds bytes and nesting before normalizing a supplied document', () => {
    const input = document(); input.master!.description = 'é'.repeat(IMPORTED_SOURCE_LIMITS.bytes);
    expect(validateImportedSource(input).ok).toBe(false);
    let nested: unknown = null;
    for (let level = 0; level < IMPORTED_SOURCE_LIMITS.depth + 2; level++) nested = { nested };
    expect(validateImportedSource(nested).ok).toBe(false);
  });
  it('rejects custom array prototypes and oversized arrays before visiting their elements', () => {
    const input = document();
    const custom = Object.setPrototypeOf([], Object.create(Array.prototype));
    input.overrides = custom;
    expect(() => parseImportedSource(input)).toThrow(/array prototype/);
    let invoked = false;
    const oversized = Array(IMPORTED_SOURCE_LIMITS.nodes + 1);
    Object.defineProperty(oversized, '0', { enumerable: true, get: () => { invoked = true; throw new Error('must not execute'); } });
    expect(() => parseImportedSource(oversized)).toThrow(/traversal bounds/);
    expect(invoked).toBe(false);
  });
  it.each(['\u0000', '\ud800', '\udfff', 'x\ud800y', '\ud800\ud800\udc00'])('rejects JSON strings that PostgreSQL JSONB cannot persist: %j', invalid => {
    const input = document(); input.master!.title = invalid;
    expect(() => parseImportedSource(input)).toThrow(/JSONB/);
    input.master!.title = 'Valid'; input.revision.etag = invalid;
    expect(() => parseImportedSource(input)).toThrow(/JSONB/);
  });
  it('preserves valid Unicode pairs and rejects unpersistable object keys before schema validation', () => {
    const input = document(); input.master!.title = 'Family 🧑🏽‍🍳 café'; input.revision.etag = '"😀"';
    expect(parseImportedSource(input)).toEqual(input);
    expect(() => parseImportedSource({ ['bad\ud800']: 1 })).toThrow(/JSONB/);
  });
  it('preserves cancelled masters with historical overrides without projecting a live master', () => {
    const input = document(); input.master!.status = 'cancelled';
    expect(parseImportedSource(input)).toEqual(input);
    expect(validateImportedSource(input, { externalUid: input.uid }).ok).toBe(false);
  });
  it('preserves exact folded raw text, unknown parameters and nested alarm identity', () => {
    const input = document();
    input.rawProperties.push('X-PUBLISHER;LABEL="a:b":first\r\n second');
    input.master!.raw = 'BEGIN:VEVENT\r\nUID;X-PUBLISHER="a:b":series@exa\r\n mple.test\r\nX-UNKNOWN:retained\r\nBEGIN:VALARM\r\nUID:alarm-only\r\nEND:VALARM\r\nEND:VEVENT\r\n';
    expect(parseImportedSource(input)).toEqual(input);
    // Framing is checked here; no claim that raw temporal semantics match the
    // typed fields. Future materialization must reparse and prove consistency.
  });
  it.each([
    'BEGIN:VEVENT\nUID:other\nEND:VEVENT',
    'BEGIN:VEVENT\nBEGIN:VALARM\nUID:series@example.test\nEND:VALARM\nEND:VEVENT',
    'BEGIN:VEVENT\nUID:series@example.test\nUID:series@example.test\nEND:VEVENT',
    'BEGIN:VEVENT\nUID:series@example.test\nEND:VEVENT\nBEGIN:VEVENT\nUID:series@example.test\nEND:VEVENT',
    'BEGIN:VEVENT\nUID:series@example.test\nBEGIN:VALARM\nEND:VEVENT',
    'BEGIN:VEVENT\nUID:series@example.test\nX-RAW:\u0000\nEND:VEVENT',
  ])('refuses raw component frame/UID corruption %j', raw => {
    const input = document(); input.master!.raw = raw;
    expect(validateImportedSource(input).ok).toBe(false);
  });
  it.each(['BEGIN:VEVENT', 'X-ONE:a\nX-TWO:b', 'VERSION:2.0\rBROKEN'])('refuses invalid raw envelope property %j', raw => {
    const input = document(); input.rawProperties.push(raw);
    expect(validateImportedSource(input).ok).toBe(false);
  });
  it('retains valid observance recurrence with UTC UNTIL and local RDATE', () => {
    const input = document(), zone = customZone();
    zone.raw = zone.raw.replace('END:STANDARD', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20301027T000000Z\r\nRDATE:19710101T000000,19720101T000000\r\nEND:STANDARD');
    input.timezones = [zone];
    expect(parseImportedSource(input).timezones[0].raw).toBe(zone.raw);
  });
  it.each([
    ['Publisher,Custom', 'Publisher\\,Custom'],
    ['Publisher;Custom', 'Publisher\\;Custom'],
    ['Publisher\\Custom', 'Publisher\\\\Custom'],
  ])('compares escaped raw TZID %s with its decoded source identity', (tzid, rawTzid) => {
    const input = document(), zone = customZone(tzid);
    zone.raw = zone.raw.replace(`TZID:${tzid}`, `TZID;X-LABEL="quoted:colon":${rawTzid}`);
    input.timezones = [zone]; input.overrides = [];
    input.master!.dtstart = zoned(tzid); input.master!.end = { kind: 'duration', value: 'P1D' };
    const output = parseImportedSource(input);
    expect(output.timezones[0].raw).toBe(zone.raw);
    expect(output.master!.dtstart).toEqual(zoned(tzid));
  });
  it.each([
    'RRULE:FREQ=YEARLY;UNTIL=20301027T000000', 'RRULE:FREQ=YEARLY;BYMONTH=13',
    'RRULE:FREQ=YEARLY\r\nRRULE:FREQ=DAILY', 'RDATE:20260230T090000', 'RDATE:20261001',
  ])('refuses invalid observance recurrence %j', property => {
    const input = document(), zone = customZone();
    zone.raw = zone.raw.replace('END:STANDARD', `${property}\r\nEND:STANDARD`);
    input.timezones = [zone];
    expect(validateImportedSource(input).ok).toBe(false);
  });
  it('refuses a rollover date even if JS Date.parse would match the projection instant', () => {
    const input = document(); input.master!.dtstart = utc('20260302T090000Z'); input.master!.end = { kind: 'default' };
    expect(validateImportedSource(input, { externalUid: input.uid, startsAt: '2026-02-30T09:00:00Z' }).ok).toBe(false);
  });
});
