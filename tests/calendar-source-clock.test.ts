import {describe,expect,it} from 'vitest';
import {createSourceClock,SourceClockError} from '@/lib/calendar/source-clock';
import {expandSourceRule} from '@/lib/calendar/source-rule';
import {parseICSSource} from '@/lib/sync/ics-source';
import type {ImportedSourceTimezone,SourceTime} from '@/lib/calendar/imported-source';
import fidelity from './fixtures/calendar-source-fidelity.json';

const horizon=Date.parse('2026-12-31T23:59:59Z');
const local=(tzid:string,value:string):SourceTime=>({kind:'zoned',tzid,value});
const iso=(instant:number|null)=>instant===null?null:new Date(instant).toISOString();
const fixed=(tzid='Custom/Seconds',from='+013045',to=from):ImportedSourceTimezone=>({tzid,raw:`BEGIN:VTIMEZONE\nTZID:${tzid}\nBEGIN:STANDARD\nDTSTART:20200101T000000\nTZOFFSETFROM:${from}\nTZOFFSETTO:${to}\nEND:STANDARD\nEND:VTIMEZONE\n`});
function fixtureCalendar(id:string):string {
  const value=fidelity.cases.find(item=>item.id===id)?.ical;
  if(typeof value!=='string')throw new Error(`Missing calendar fixture ${id}`);
  return value;
}

describe('qualified imported source clocks',()=>{
  it.each([
    ['America/New_York','20260308T023000','2026-03-08T07:30:00.000Z'],
    ['Australia/Lord_Howe','20241006T021500','2024-10-05T15:45:00.000Z'],
    ['Pacific/Apia','20111230T120000','2011-12-30T22:00:00.000Z'],
  ])('IANA explicit %s gap uses the pre-gap offset and generated gap disappears',(tzid,value,expected)=>{
    const clock=createSourceClock({through:horizon});
    expect(iso(clock.resolve(local(tzid,value),'explicit'))).toBe(expected);
    expect(clock.resolve(local(tzid,value),'generated')).toBeNull();
  });
  it.each([
    ['America/New_York','20261101T013000','2026-11-01T05:30:00.000Z'],
    ['Australia/Lord_Howe','20240407T014500','2024-04-06T14:45:00.000Z'],
    ['Europe/London','20261025T013000','2026-10-25T00:30:00.000Z'],
  ])('fold %s resolves its first occurrence',(tzid,value,expected)=>{
    const clock=createSourceClock({through:horizon});
    expect(iso(clock.resolve(local(tzid,value)))).toBe(expected);
    expect(iso(clock.resolve(local(tzid,value),'generated'))).toBe(expected);
  });
  it('UTC exact fold instant stays exact and years below100 retain their year',()=>{
    const clock=createSourceClock({through:horizon});
    expect(iso(clock.resolve({kind:'utc',value:'20261101T063000Z'}))).toBe('2026-11-01T06:30:00.000Z');
    expect(iso(clock.resolve({kind:'utc',value:'00991231T235959Z'}))).toBe('0099-12-31T23:59:59.000Z');
  });
  it.each([
    ['20260308T015959','2026-03-08T06:59:59.000Z',false],
    ['20260308T020000','2026-03-08T07:00:00.000Z',true],
    ['20260308T025959','2026-03-08T07:59:59.000Z',true],
    ['20260308T030000','2026-03-08T07:00:00.000Z',false],
    ['20261101T005959','2026-11-01T04:59:59.000Z',false],
    ['20261101T010000','2026-11-01T05:00:00.000Z',false],
    ['20261101T015959','2026-11-01T05:59:59.000Z',false],
    ['20261101T020000','2026-11-01T07:00:00.000Z',false],
  ])('second-precise transition boundary %s is half-open',(value,expected,gap)=>{
    const clock=createSourceClock({through:horizon});
    expect(iso(clock.resolve(local('America/New_York',value)))).toBe(expected);
    expect(iso(clock.resolve(local('America/New_York',value),'generated'))).toBe(gap?null:expected);
  });
  it('DATE and floating clocks require explicit contexts',()=>{
    const clock=createSourceClock({through:horizon});
    expect(()=>clock.resolve({kind:'date',value:'20260101'})).toThrow(/explicit timezone context/);
    expect(()=>clock.resolve({kind:'floating',value:'20260101T090000'})).toThrow(/explicit timezone context/);
    const contextual=createSourceClock({through:horizon,dateTimezone:'Asia/Tokyo',floatingTimezone:'America/New_York'});
    expect(iso(contextual.resolve({kind:'date',value:'20260101'}))).toBe('2025-12-31T15:00:00.000Z');
    expect(iso(contextual.resolve({kind:'floating',value:'20260101T090000'}))).toBe('2026-01-01T14:00:00.000Z');
  });
  it.each(['ny-gap','lord-howe-gap','apia-gap'])('embedded retained %s generated gaps do not consume COUNT',id=>{
    const fixture=fidelity.cases.find(item=>item.id===id)!;
    const doc=parseICSSource(fixtureCalendar(id))[0],start=doc.master!.dtstart!;
    const clock=createSourceClock({through:horizon,timezones:doc.timezones});
    const occurrences=expandSourceRule({start,rule:doc.master!.rrule!,through:horizon,resolve:p=>clock.resolve({...start,value:`${String(p.year).padStart(4,'0')}${String(p.month).padStart(2,'0')}${String(p.day).padStart(2,'0')}T${String(p.hour).padStart(2,'0')}${String(p.minute).padStart(2,'0')}${String(p.second).padStart(2,'0')}`} as SourceTime,'generated')});
    expect(occurrences.map(item=>item.original.value)).toEqual(fixture.expected.recurrenceIds);
    expect(occurrences.map(item=>iso(item.instant))).toEqual(fixture.expected.utcInstants);
  });
  it('embedded publisher timezone takes precedence even over a known IANA identity',()=>{
    const clock=createSourceClock({through:horizon,timezones:[fixed('America/New_York')]});
    expect(iso(clock.resolve(local('America/New_York','20260101T090000')))).toBe('2026-01-01T07:29:15.000Z');
  });
  it.each([
    ['ny-gap','America/New_York','20250309T023000','2025-03-09T07:30:00.000Z'],
    ['lord-howe-gap','Australia/Lord_Howe','20241006T021500','2024-10-05T15:45:00.000Z'],
    ['apia-gap','Pacific/Apia','20111230T120000','2011-12-30T22:00:00.000Z'],
  ])('embedded explicit %s gap differs from generated candidate admission',(id,tzid,value,expected)=>{
    const doc=parseICSSource(fixtureCalendar(id))[0];
    const clock=createSourceClock({through:horizon,timezones:doc.timezones});
    expect(iso(clock.resolve(local(tzid,value)))).toBe(expected);
    expect(clock.resolve(local(tzid,value),'generated')).toBeNull();
  });
  it('embedded NY fold chooses its first instant without changing exact UTC seed identity',()=>{
    const doc=parseICSSource(fixtureCalendar('ny-gap'))[0];
    const clock=createSourceClock({through:horizon,timezones:doc.timezones});
    expect(iso(clock.resolve(local('America/New_York','20251102T013000')))).toBe('2025-11-02T05:30:00.000Z');
    expect(iso(clock.resolve({kind:'utc',value:'20251102T063000Z'}))).toBe('2025-11-02T06:30:00.000Z');
  });
  it('embedded full RRULE observances and RDATE keep second precision',()=>{
    const timezone={tzid:'Publisher/Rules',raw:'BEGIN:VTIMEZONE\nTZID:Publisher/Rules\nBEGIN:STANDARD\nDTSTART:20200101T000000\nTZOFFSETFROM:+013045\nTZOFFSETTO:+013045\nRRULE:FREQ=YEARLY;BYYEARDAY=1;BYMONTH=1;UNTIL=20250101T000000Z\nRDATE:20260101T000000,20270101T000000\nEND:STANDARD\nEND:VTIMEZONE\n'};
    const clock=createSourceClock({through:horizon,timezones:[timezone]});
    expect(iso(clock.resolve(local(timezone.tzid,'20260701T120015')))).toBe('2026-07-01T10:29:30.000Z');
  });
  it('explicit standard observance VALUE parameters preserve their default types',()=>{
    const timezone=fixed();timezone.raw=timezone.raw.replace('DTSTART:','DTSTART;VALUE="DATE-TIME":').replace('TZOFFSETFROM:','TZOFFSETFROM;VALUE=UTC-OFFSET:').replace('TZOFFSETTO:','TZOFFSETTO;VALUE=UTC-OFFSET:').replace('END:STANDARD','RRULE;VALUE=RECUR:FREQ=YEARLY;COUNT=2\nRDATE;VALUE=DATE-TIME:20250101T000000\nEND:STANDARD');
    expect(iso(createSourceClock({through:horizon,timezones:[timezone]}).resolve(local(timezone.tzid,'20260701T120015')))).toBe('2026-07-01T10:29:30.000Z');
  });
  it.each([
    fixed('Custom/Bad','+2400'),fixed('Custom/Bad','-0000'),
    {tzid:'America/New_York',raw:fixed('America/New_York').raw.replace('TZOFFSETFROM:+013045','TZOFFSETFROM:wrong')},
    {tzid:'Custom/Bad',raw:fixed('Custom/Bad').raw.replace('END:STANDARD','EXDATE:20200101T000000\nEND:STANDARD')},
  ])('invalid embedded definition refuses without IANA fallback',timezone=>{
    expect(()=>createSourceClock({through:horizon,timezones:[timezone]}).resolve(local(timezone.tzid,'20260101T090000'))).toThrow();
  });
  it('conflicting simultaneous observances and broken offset chains refuse',()=>{
    const first='BEGIN:STANDARD\nDTSTART:20200101T000000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0100\nEND:STANDARD\n';
    for(const second of ['BEGIN:DAYLIGHT\nDTSTART:20200101T000000\nTZOFFSETFROM:+0000\nTZOFFSETTO:+0200\nEND:DAYLIGHT\n','BEGIN:DAYLIGHT\nDTSTART:20210101T000000\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0300\nEND:DAYLIGHT\n']){
      const timezones=[{tzid:'Custom/Conflict',raw:`BEGIN:VTIMEZONE\nTZID:Custom/Conflict\n${first}${second}END:VTIMEZONE\n`}];
      expect(()=>createSourceClock({through:horizon,timezones}).resolve(local('Custom/Conflict','20260101T090000'))).toThrow(/conflicting|inconsistent/);
    }
  });
  it('unknown zones, duplicate zones, malformed times and leap seconds refuse',()=>{
    const clock=createSourceClock({through:horizon});
    expect(()=>clock.resolve(local('Unknown/Publisher','20260101T090000'))).toThrow(SourceClockError);
    expect(()=>createSourceClock({through:horizon,timezones:[fixed(),fixed()]})).toThrow(/duplicate/);
    for(const value of ['20260230T090000','20260101T240000','20260101T090060'])expect(()=>clock.resolve(local('UTC',value))).toThrow();
  });
  it('bounds source coverage and cumulative clock work instead of returning an unproved prefix',()=>{
    const clock=createSourceClock({through:horizon,maxWork:2});
    expect(clock.resolve({kind:'utc',value:'20260101T090000Z'})).toBe(Date.parse('2026-01-01T09:00Z'));
    expect(clock.resolve({kind:'utc',value:'20260102T090000Z'})).toBe(Date.parse('2026-01-02T09:00Z'));
    expect(()=>clock.resolve({kind:'utc',value:'20260103T090000Z'})).toThrow(/work/);
    expect(()=>createSourceClock({through:horizon}).resolve(local('UTC','20280101T090000'))).toThrow(/coverage/);
  });
  it('shares the work budget across lazily compiled timezone definitions',()=>{
    const zones=[fixed('Custom/First'),fixed('Custom/Second')];
    const clock=createSourceClock({through:horizon,timezones:zones,maxWork:20});
    expect(iso(clock.resolve(local('Custom/First','20260101T090000')))).toBe('2026-01-01T07:29:15.000Z');
    expect(()=>clock.resolve(local('Custom/Second','20260101T090000'))).toThrow(/work limit/);
  });
  it('includes actual observance recurrence work in the shared clock budget',()=>{
    const zones=['Custom/A','Custom/B'].map(id=>{const zone=fixed(id,'+0000');zone.raw=zone.raw.replace('DTSTART:20200101T000000','DTSTART:20250101T000000').replace('END:STANDARD','RRULE:FREQ=DAILY;COUNT=3\nEND:STANDARD');return zone;});
    const clock=createSourceClock({through:horizon,timezones:zones,maxWork:50});
    expect(iso(clock.resolve(local('Custom/A','20260101T090000')))).toBe('2026-01-01T09:00:00.000Z');
    expect(()=>clock.resolve(local('Custom/B','20260101T090000'))).toThrow(/work limit/);
  });
  it('propagates an enclosing event-set budget across clock calls',()=>{
    let remaining=1;
    const clock=createSourceClock({through:horizon,consumeWork:amount=>{remaining-=amount;if(remaining<0)throw new Error('Enclosing work budget');}});
    expect(clock.resolve({kind:'utc',value:'20260101T090000Z'})).toBe(Date.parse('2026-01-01T09:00Z'));
    expect(()=>clock.resolve({kind:'utc',value:'20260102T090000Z'})).toThrow('Enclosing work budget');
  });
});
