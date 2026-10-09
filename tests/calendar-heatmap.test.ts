import { describe, it, expect } from 'vitest';
import { buildHeatmap, type HeatEvent } from '@/lib/calendar/heatmap';

const TODAY = new Date('2026-07-12T12:00:00Z');   // a Sunday

function ev(startsAt: string, minutes = 60, allDay = false): HeatEvent {
  const s = new Date(startsAt);
  return { startsAt, endsAt: allDay ? null : new Date(s.getTime() + minutes * 60000).toISOString(), allDay };
}

describe('buildHeatmap', () => {
  it('returns exactly weeks×7 days, oldest first, ending today', () => {
    const r = buildHeatmap([], TODAY, 8);
    expect(r.days).toHaveLength(56);
    expect(r.days[55].date).toBe('2026-07-12');
    expect(r.days[0].date).toBe('2026-05-18');
    expect(r.advice).toContain('quiet');
  });

  it('levels scale with scheduled minutes and event count', () => {
    const r = buildHeatmap([
      ev('2026-07-10T09:00:00Z', 30),                        // 1 short → level 1
      ev('2026-07-11T09:00:00Z', 90), ev('2026-07-11T14:00:00Z', 60),  // 150m/2 → level 2
      ev('2026-07-12T08:00:00Z', 120), ev('2026-07-12T11:00:00Z', 120),
      ev('2026-07-12T15:00:00Z', 120), ev('2026-07-12T18:00:00Z', 60),  // 420m/4 → level 4
    ], TODAY, 2);
    const byDate = new Map(r.days.map(d => [d.date, d]));
    expect(byDate.get('2026-07-10')!.level).toBe(1);
    expect(byDate.get('2026-07-11')!.level).toBe(2);
    expect(byDate.get('2026-07-12')!.level).toBe(4);
    expect(r.overloadedDates).toContain('2026-07-12');
  });

  it('all-day events count as an estimated heavy block; outside rows are ignored', () => {
    const r = buildHeatmap([
      ev('2026-07-12T00:00:00Z', 0, true),
      ev('2000-01-01T00:00:00Z'),           // outside window
    ], TODAY, 2);
    const today = r.days[r.days.length - 1];
    expect(today.minutes).toBe(480);
    expect(today.level).toBe(4);
    expect(r.days.reduce((s, d) => s + d.count, 0)).toBe(1);
  });

  it('names the chronically heaviest weekday and offers a calmer one', () => {
    const events: HeatEvent[] = [];
    for (let w = 0; w < 6; w++) {
      // Thursdays loaded (2026-07-09 is a Thursday)
      const thu = new Date(Date.UTC(2026, 6, 9) - w * 7 * 86400_000);
      events.push(ev(thu.toISOString(), 180), ev(new Date(thu.getTime() + 3600_000).toISOString(), 120));
    }
    const r = buildHeatmap(events, TODAY, 8);
    expect(r.busiestWeekday).toBe('Thursday');
    expect(r.advice).toMatch(/Thursday/);
  });
});
const timed = (startsAt: string, endsAt: string | null, occurrenceKey?: string): HeatEvent => ({startsAt,endsAt,allDay:false,...(occurrenceKey ? {occurrenceKey} : {})});
const load = (events: HeatEvent[], today: string, zone='UTC') => buildHeatmap(events,new Date(today),1,zone).days.filter(day=>day.count>0);
describe('heatmap per-day clipped occupancy',()=>{
  it('clips overnight intervals and excludes their exclusive end day',()=>{
    expect(load([timed('2026-10-07T23:30:00Z','2026-10-09T00:00:00Z')],'2026-10-10T12:00:00Z').map(({date,count,minutes})=>({date,count,minutes}))).toEqual([{date:'2026-10-07',count:1,minutes:30},{date:'2026-10-08',count:1,minutes:1440}]);
  });
  it('retains overlaps beginning before the bounded report',()=>{
    expect(load([timed('2026-09-01T00:00:00Z','2026-10-05T01:00:00Z')],'2026-10-10T12:00:00Z').map(day=>[day.date,day.minutes])).toEqual([['2026-10-04',1440],['2026-10-05',60]]);
  });
  it.each(['UTC','America/Los_Angeles','Asia/Tokyo'])('keeps DATE ranges exclusive and civil in %s',zone=>{
    expect(load([{startsAt:'2026-10-07',endsAt:'2026-10-09',allDay:true}],'2026-10-10T12:00:00Z',zone).map(day=>[day.date,day.count,day.minutes,day.estimated])).toEqual([['2026-10-07',1,480,true],['2026-10-08',1,480,true]]);
  });
  it.each([['2026-03-08','2026-03-08T08:00:00Z','2026-03-09T07:00:00Z',1380],['2026-11-01','2026-11-01T07:00:00Z','2026-11-02T08:00:00Z',1500]] as const)('measures actual elapsed minutes on DST day %s',(day,start,end,minutes)=>{
    expect(load([timed(start,end)],`${day}T20:00:00Z`,'America/Los_Angeles')).toMatchObject([{date:day,count:1,minutes,estimated:false}]);
  });
  it('counts an explicit point once with zero busy minutes and does not invent a preceding overlap',()=>{
    expect(load([timed('2026-10-08T00:00:00Z','2026-10-08T00:00:00Z'),timed('2026-10-03T23:59:00Z','2026-10-03T23:59:00Z')],'2026-10-10T12:00:00Z')).toMatchObject([{date:'2026-10-08',count:1,minutes:0,estimated:false}]);
  });
  it('clips an absent-end one-hour estimate across midnight',()=>{
    expect(load([timed('2026-10-07T23:30:00Z',null)],'2026-10-10T12:00:00Z').map(day=>[day.date,day.minutes,day.estimated])).toEqual([['2026-10-07',30,true],['2026-10-08',30,true]]);
  });
  it('deduplicates only explicit occurrence identity, not distinct equal-time commitments',()=>{
    const a=timed('2026-10-08T09:00:00Z','2026-10-08T10:00:00Z','source-a');
    expect(load([a,a,{...a,occurrenceKey:'native-b'}],'2026-10-10T12:00:00Z')).toMatchObject([{count:2,minutes:120}]);
    expect(load([timed(a.startsAt,a.endsAt),timed(a.startsAt,a.endsAt)],'2026-10-10T12:00:00Z')).toMatchObject([{count:2,minutes:120}]);
  });
  it('refuses invalid or reversed timed intervals',()=>{
    for (const event of [timed('bad','2026-10-08T10:00:00Z'),timed('2026-10-08T10:00:00Z','bad'),timed('2026-10-08T10:00:00Z','2026-10-08T09:00:00Z')]) expect(()=>load([event],'2026-10-10T12:00:00Z')).toThrow('Invalid heatmap occurrence');
  });
  it('refuses conflicting explicit occurrence identity and malformed civil dates',()=>{
    const a=timed('2026-10-08T09:00:00Z','2026-10-08T10:00:00Z','a');
    expect(()=>load([a,{...a,endsAt:'2026-10-08T11:00:00Z'}],'2026-10-10T12:00:00Z')).toThrow('Conflicting heatmap occurrence');
    for(const value of [{startsAt:'2026-02-30',endsAt:null,allDay:true},{startsAt:'2026-02-28',endsAt:'2026-02-30',allDay:true}]) expect(()=>load([value],'2026-10-10T12:00:00Z')).toThrow('Invalid heatmap occurrence');
  });
  it('does not invent timed occupancy on Apia’s skipped civil date',()=>{
    const days=buildHeatmap([timed('2011-12-29T10:00:00Z','2011-12-31T10:00:00Z')],new Date('2011-12-31T00:00:00Z'),1,'Pacific/Apia').days;
    expect(days.find(day=>day.date==='2011-12-30')).toMatchObject({count:0,minutes:0,estimated:false});
    expect(days.filter(day=>day.count>0).map(day=>[day.date,day.minutes])).toEqual([['2011-12-29',1440],['2011-12-31',1440]]);
  });
  it('keeps a skipped DATE workload as an explicit civil estimate without inventing timed minutes',()=>{
    const days=buildHeatmap([{startsAt:'2011-12-30',endsAt:'2011-12-31',allDay:true}],new Date('2011-12-31T00:00:00Z'),1,'Pacific/Apia').days;
    expect(days.find(day=>day.date==='2011-12-30')).toMatchObject({count:1,minutes:480,estimated:true});
  });
});


describe('heatmap visible annotations versus qualified workload',()=>{
  const source:Omit<HeatEvent,'transparency'>&{transparency?:unknown}={kind:'source',occurrenceKey:'source-original',startsAt:'2026-10-08T09:00:00Z',endsAt:'2026-10-08T10:00:00Z',allDay:false};
  const report=(events:typeof source[])=>buildHeatmap(events as HeatEvent[],new Date('2026-10-08T12:00:00Z'),1,'UTC');
  it.each([1,6])('retains %s transparent visible events without minutes, workload count or packed advice',count=>{
    const result=report(Array.from({length:count},(_,index)=>({...source,occurrenceKey:'free-'+index,transparency:'transparent'})));
    expect(result.days.at(-1)).toMatchObject({count,workloadCount:0,minutes:0,estimated:false,level:0});expect(result.overloadedDates).toEqual([]);expect(result.busiestWeekday).toBeNull();expect(result.advice).not.toContain('nothing scheduled');expect(result.advice).not.toContain('packed');
  });
  it('uses workload count rather than visible count for mixed events and minute thresholds',()=>{
    const result=report([...Array.from({length:6},(_,i)=>({...source,occurrenceKey:'free-'+i,transparency:'transparent'})),{...source,occurrenceKey:'busy',transparency:'opaque'}]);expect(result.days.at(-1)).toMatchObject({count:7,workloadCount:1,minutes:60,level:1});expect(result.overloadedDates).toEqual([]);
  });
  it.each([undefined,null,'','unknown',false])('refuses source metadata %s before DATE, point or out-of-window handling',transparency=>{
    for(const patch of [{},{allDay:true},{endsAt:source.startsAt},{startsAt:'2027-01-01T09:00:00Z',endsAt:'2027-01-01T10:00:00Z'}])expect(()=>report([{...source,...patch,transparency}])).toThrow('transparency');
  });
  it.each([false,true])('refuses conflicting duplicate transparency in either order reversed=%s',reverse=>{
    const events=[{...source,transparency:'transparent'},{...source,transparency:'opaque'}];expect(()=>report(reverse?events.reverse():events)).toThrow('Conflicting heatmap occurrence');
  });
  it.each([false,true])('refuses conflicting duplicate kind/DATE/clocks before free skipping reversed=%s',reverse=>{
    for(const patch of [{kind:'native' as const},{allDay:true},{actualStartsAt:'2026-10-08T09:30:00Z',actualEndsAt:'2026-10-08T10:30:00Z'}]){
      const events=[{...source,transparency:'transparent'},{...source,...patch,transparency:'transparent'}];expect(()=>report(reverse?events.reverse():events)).toThrow('Conflicting heatmap occurrence');
    }
  });
  it('keeps transparent DATE/point records visible with no workload estimate and deduplicates their original keys',()=>{
    const date={...source,occurrenceKey:'DATE',startsAt:'2026-10-07',endsAt:'2026-10-09',allDay:true,transparency:'transparent'};
    const point={...source,occurrenceKey:'point',endsAt:source.startsAt,transparency:'transparent'};const result=report([date,date,point,point]);
    expect(result.days.filter(day=>day.count)).toMatchObject([{date:'2026-10-07',count:1,workloadCount:0,minutes:0,estimated:false,level:0},{date:'2026-10-08',count:2,workloadCount:0,minutes:0,estimated:false,level:0}]);
  });
  it('preserves opaque DATE eight-hour estimates and native legacy defaults',()=>{
    const native={startsAt:source.startsAt,endsAt:null,allDay:false};expect(report([native]).days.at(-1)).toMatchObject({count:1,workloadCount:1,minutes:60,estimated:true,level:1});
    expect(report([{...source,startsAt:'2026-10-08',endsAt:'2026-10-09',allDay:true,transparency:'opaque'}]).days.at(-1)).toMatchObject({count:1,workloadCount:1,minutes:480,estimated:true,level:4});
  });
  it('source implicit points and explicit native points remain visible without a workload count',()=>{
    expect(report([{...source,endsAt:null,transparency:'opaque'},{...source,kind:'native',occurrenceKey:'native-point',endsAt:source.startsAt,transparency:'opaque'}]).days.at(-1)).toMatchObject({count:2,workloadCount:0,minutes:0,estimated:false,level:0});
  });
  it('validates clocks even on transparent records before their free occupancy is ignored',()=>{
    expect(()=>report([{...source,endsAt:'invalid',transparency:'transparent'}])).toThrow('Invalid heatmap occurrence');
    expect(()=>report([{...source,kind:'native',transparency:'unknown'}])).toThrow('transparency');
  });
});


describe('native snapshot duration estimate disclosure',()=>{
  it('retains the original missing-end estimate when actual clocks supply its interval',()=>{
    const event:HeatEvent={kind:'native',transparency:'opaque',startsAt:'2026-10-08T23:30:00Z',endsAt:null,actualStartsAt:'2026-10-08T23:30:00Z',actualEndsAt:'2026-10-09T00:30:00Z',allDay:false};
    expect(load([event],'2026-10-10T12:00:00Z')).toMatchObject([{date:'2026-10-08',minutes:30,estimated:true},{date:'2026-10-09',minutes:30,estimated:true}]);
    expect(load([{...event,kind:'source',actualEndsAt:event.actualStartsAt}],'2026-10-10T12:00:00Z')).toMatchObject([{minutes:0,estimated:false,workloadCount:0}]);
  });
});
