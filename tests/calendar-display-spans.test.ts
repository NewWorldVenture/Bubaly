import { describe, expect, it } from 'vitest';
import { bucketCalendarDisplaySpans, calendarDisplayDay } from '@/lib/calendar/display-spans';
import type { CalendarDisplayOccurrence } from '@/lib/calendar/display-occurrences';

function source(start:string,end:string|null,dates?:[string,string]):CalendarDisplayOccurrence {
  return {kind:'source',reference:{kind:'source',feedId:'synthetic-feed',uid:'synthetic-uid',revisionId:'synthetic-revision',original:{kind:'utc',value:'20261008T000000Z'}},
    occurrenceKey:'original-key',readOnly:true,title:'Synthetic',description:null,location:null,category:null,assignee_id:null,
    starts_at:start,ends_at:end,actualStartsAt:start,actualEndsAt:end,all_day:!!dates,startDate:dates?.[0]??null,endDate:dates?.[1]??null};
}
describe('bounded display spans retain occurrence identity and actual civil-day occupancy',()=>{
  it.each(['UTC','America/Los_Angeles','Asia/Tokyo'])('DATE exclusive end is stable in %s and clips earlier grid start',zone=>{
    const row=source('2026-10-07T00:00:00Z','2026-10-10T00:00:00Z',['2026-10-07','2026-10-10']);
    const bins=bucketCalendarDisplaySpans([row],'2026-10-08','2026-10-12',zone);
    expect([...bins].filter(([,spans])=>spans.length).map(([day])=>day)).toEqual(['2026-10-08','2026-10-09']);
    for(const spans of bins.values())for(const span of spans){expect(span.occurrence).toBe(row);expect(span.elapsedStartMinutes).toBe(0);expect(span.elapsedEndMinutes).toBe(span.dayMinutes);}
  });
  it('clips overnight actual intervals on both days without changing source reference',()=>{
    const row=source('2026-10-08T23:30:00Z','2026-10-09T01:15:00Z');
    const bins=bucketCalendarDisplaySpans([row],'2026-10-08','2026-10-10','UTC');
    expect(bins.get('2026-10-08')?.[0]).toMatchObject({actualStartsAt:'2026-10-08T23:30:00.000Z',actualEndsAt:'2026-10-09T00:00:00.000Z',elapsedStartMinutes:1410,elapsedEndMinutes:1440});
    expect(bins.get('2026-10-09')?.[0]).toMatchObject({actualStartsAt:'2026-10-09T00:00:00.000Z',actualEndsAt:'2026-10-09T01:15:00.000Z',elapsedStartMinutes:0,elapsedEndMinutes:75});
    expect(bins.get('2026-10-09')?.[0].occurrence.reference).toBe(row.reference);
    expect(bins.get('2026-10-09')?.[0].segmentKey).not.toBe(bins.get('2026-10-08')?.[0].segmentKey);
  });
  it.each([['2026-03-08',1380],['2026-11-01',1500]] as const)('uses actual %s New York day duration %i', (day,minutes)=>{
    expect(calendarDisplayDay(day,'America/New_York').minutes).toBe(minutes);
  });
  it('handles a thirty-minute DST change without rounding the day to whole hours',()=>{
    expect(calendarDisplayDay('2026-10-04','Australia/Lord_Howe').minutes).toBe(1410);
    expect(calendarDisplayDay('2026-04-05','Australia/Lord_Howe').minutes).toBe(1470);
  });
  it('DATE occupancy follows civil dates while each day keeps its actual DST length',()=>{
    const row=source('2026-10-31T04:00:00Z','2026-11-02T05:00:00Z',['2026-10-31','2026-11-02']);
    const bins=bucketCalendarDisplaySpans([row],'2026-10-31','2026-11-03','America/New_York');
    expect([...bins.values()].flat().map(span=>span.elapsedEndMinutes-span.elapsedStartMinutes)).toEqual([1440,1500]);
    expect(bins.get('2026-11-02')).toEqual([]);
  });
  it('preserves Apia vanished-date annotation with zero actual time, while timed intervals skip it',()=>{
    const annotation=source('2011-12-29T10:00:00Z','2011-12-31T10:00:00Z',['2011-12-29','2012-01-01']);
    const timed={...source('2011-12-29T10:00:00Z','2011-12-31T10:00:00Z'),occurrenceKey:'timed'};
    const bins=bucketCalendarDisplaySpans([annotation,timed],'2011-12-29','2012-01-01','Pacific/Apia');
    expect([...bins.keys()]).toEqual(['2011-12-29','2011-12-30','2011-12-31']);
    const skipped=bins.get('2011-12-30')!;expect(skipped).toHaveLength(1);expect(skipped[0].occurrence).toBe(annotation);expect(skipped[0]).toMatchObject({dayMinutes:0,elapsedStartMinutes:0,elapsedEndMinutes:0,actualStartsAt:'2011-12-30T10:00:00.000Z',actualEndsAt:'2011-12-30T10:00:00.000Z'});
    expect(bins.get('2011-12-29')).toHaveLength(2);expect(bins.get('2011-12-31')).toHaveLength(2);
  });
  it('fold repetitions retain distinct elapsed positions despite equal wall labels',()=>{
    const first=source('2026-11-01T05:15:00Z','2026-11-01T05:45:00Z');
    const second={...source('2026-11-01T06:15:00Z','2026-11-01T06:45:00Z'),occurrenceKey:'second-key'};
    const spans=bucketCalendarDisplaySpans([first,second],'2026-11-01','2026-11-02','America/New_York').get('2026-11-01')!;
    expect(spans.map(span=>span.elapsedStartMinutes)).toEqual([75,135]);expect(spans.map(span=>span.elapsedEndMinutes-span.elapsedStartMinutes)).toEqual([30,30]);
  });
  it('point on midnight belongs only to that day with zero duration; ending midnight does not occupy next day',()=>{
    const point=source('2026-10-09T00:00:00Z','2026-10-09T00:00:00Z');
    const ended={...source('2026-10-08T23:00:00Z','2026-10-09T00:00:00Z'),occurrenceKey:'ended'};
    const bins=bucketCalendarDisplaySpans([point,ended],'2026-10-08','2026-10-10','UTC');
    expect(bins.get('2026-10-08')?.map(span=>span.occurrence.occurrenceKey)).toEqual(['ended']);
    expect(bins.get('2026-10-09')?.map(span=>span.occurrence.occurrenceKey)).toEqual(['original-key']);
    expect(bins.get('2026-10-09')?.[0]).toMatchObject({elapsedStartMinutes:0,elapsedEndMinutes:0});
  });
  it('refuses invalid interval, invalid date/zone, oversized input and overlong window',()=>{
    expect(()=>bucketCalendarDisplaySpans([source('invalid',null)],'2026-10-08','2026-10-09','UTC')).toThrow();
    expect(()=>bucketCalendarDisplaySpans([source('2026-10-09T00:00:00Z','2026-10-08T00:00:00Z')],'2026-10-08','2026-10-09','UTC')).toThrow();
    expect(()=>bucketCalendarDisplaySpans([source('2026-10-08T00:00:00Z','2026-10-09T00:00:00Z',['2026-10-08','2026-10-08'])],'2026-10-08','2026-10-09','UTC')).toThrow();
    expect(()=>calendarDisplayDay('2026-02-30','UTC')).toThrow();expect(()=>calendarDisplayDay('2026-10-08','invalid-zone')).toThrow();
    expect(()=>bucketCalendarDisplaySpans([],'2026-01-01','2028-01-01','UTC')).toThrow();
    expect(()=>bucketCalendarDisplaySpans(Array(20_001).fill(source('2026-10-08T00:00:00Z',null)),'2026-10-08','2026-10-09','UTC')).toThrow();
  });
  it('empty windows still validate canonical dates and explicit IANA zones',()=>{
    expect(bucketCalendarDisplaySpans([],'2026-10-08','2026-10-08','UTC').size).toBe(0);
    expect(()=>bucketCalendarDisplaySpans([],'2026-02-30','2026-02-30','UTC')).toThrow();
    expect(()=>bucketCalendarDisplaySpans([],'2026-10-08','2026-10-08','Invalid/Zone')).toThrow();
    expect(()=>bucketCalendarDisplaySpans([],'2026-10-08','2026-10-08','')).toThrow();
  });
});
