import { expect, it } from 'vitest';
import { expandEventsInZone, type RecurrableEvent } from '@/lib/calendar/recurrence';
import { mapIcsEventToRow } from '@/lib/calendar/feeds';
const event=(over:Partial<RecurrableEvent>={}):RecurrableEvent=>Object.freeze({id:'synthetic-series',starts_at:'2026-07-01T12:34:00.000Z',ends_at:'2026-07-01T13:34:00.000Z',recurrence:'daily',recurrence_until:null,...over});
const expand=(e:RecurrableEvent,from='2026-07-01T00:00:00Z',to='2026-07-02T00:00:00Z',zone='UTC')=>expandEventsInZone([e],new Date(from),new Date(to),zone);
it('preserves the accepted seed instant and exact duration with seconds and milliseconds',()=>{
 const e=event({starts_at:'2026-07-01T12:34:42.125Z',ends_at:'2026-07-01T13:34:52.375Z'});
 const out=expand(e);expect(out).toHaveLength(1);expect(out[0].id).toBe(e.id);
 expect(out[0].starts_at).toBe(e.starts_at);expect(out[0].ends_at).toBe(e.ends_at);
 expect(Date.parse(out[0].ends_at!)-Date.parse(out[0].starts_at)).toBe(Date.parse(e.ends_at!)-Date.parse(e.starts_at));
});
it('preserves seconds from a synthetic external calendar row accepted by the actual pure feed mapping',()=>{
 const row=mapIcsEventToRow({uid:'synthetic-feed-series',title:'Synthetic seconds',startsAt:'2026-07-01T12:34:42.000Z',endsAt:'2026-07-01T13:34:42.000Z',allDay:false,recurrenceRule:'FREQ=WEEKLY'},'synthetic-family','synthetic-feed');
 expect(row.starts_at).toBe('2026-07-01T12:34:42.000Z');expect(row.recurrence).toBe('weekly');
 const out=expand({...row,id:'synthetic-feed-event'},'2026-07-08T00:00:00Z','2026-07-09T00:00:00Z');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe('2026-07-08T12:34:42.000Z');expect(out[0].ends_at).toBe('2026-07-08T13:34:42.000Z');
});
it('retains an occurrence whose actual second-precision start is inside the half-open window',()=>{
 const e=event({starts_at:'2026-07-01T12:34:30.125Z',ends_at:null});
 const out=expand(e,'2026-07-01T12:34:30.000Z','2026-07-01T12:34:31.000Z');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe(e.starts_at);
});
it('does not admit a second-precision occurrence after the exclusive recurrence cutoff',()=>{
 const e=event({starts_at:'2026-07-01T12:34:30.125Z',ends_at:null,recurrence_until:'2026-07-02T12:34:15.000Z'});
 const out=expand(e,'2026-07-01T00:00:00Z','2026-07-03T00:00:00Z');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe(e.starts_at);
});
it('passes nonrecurring subminute rows through untouched',()=>{
 const e=event({starts_at:'2026-07-01T12:34:42.125Z',ends_at:null,recurrence:'none'});
 const out=expand(e);expect(out).toHaveLength(1);expect(out[0]).toBe(e);
});
it('retains minute-aligned duration and input identity fields',()=>{
 const e=event();const out=expand(e);expect(out).toHaveLength(1);expect(out[0]).toEqual(e);expect(e.starts_at).toBe('2026-07-01T12:34:00.000Z');
});
it('retains a minute-aligned wall clock across the documented fall-back',()=>{
 const e=event({starts_at:'2026-10-14T22:00:00.000Z',ends_at:null,recurrence:'weekly'});
 const out=expand(e,'2026-11-04T00:00:00Z','2026-11-05T00:00:00Z','America/New_York');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe('2026-11-04T23:00:00.000Z');
});
// RFC 5545 §3.3.5: a skipped time takes the offset in force BEFORE the gap.
// 02:30 at EST's -5 is 07:30Z, which New York's clock shows as 03:30 EDT (the
// walk-forward to 03:00, 07:00Z, was the old rule).
it('resolves a skipped spring-gap time with the offset in force before the gap',()=>{
 const e=event({starts_at:'2026-03-01T07:30:00.000Z',ends_at:null,recurrence:'weekly'});
 const out=expand(e,'2026-03-08T00:00:00Z','2026-03-09T00:00:00Z','America/New_York');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe('2026-03-08T07:30:00.000Z');
});
it('retains short-month skipping rather than calendar-date sliding',()=>{
 const e=event({starts_at:'2026-01-31T12:34:00.000Z',ends_at:null,recurrence:'monthly'});
 expect(expand(e,'2026-02-01T00:00:00Z','2026-03-01T00:00:00Z')).toEqual([]);
});
it('retains the bounded per-window generation cap',()=>{
 const out=expand(event(),'2026-07-01T00:00:00Z','2036-07-01T00:00:00Z');expect(out).toHaveLength(500);
 expect(out.every(e=>e.id==='synthetic-series')).toBe(true);expect(new Set(out.map(e=>e.starts_at)).size).toBe(500);
});
it('retains the unknown-frequency refusal',()=>{
 expect(expand(event({recurrence:'unsupported'}))).toEqual([]);
});

it('preserves nonzero precision across the spring gap',()=>{
 const e=event({starts_at:'2026-03-01T07:30:42.125Z',ends_at:null,recurrence:'weekly'});
 const out=expand(e,'2026-03-08T00:00:00Z','2026-03-09T00:00:00Z','America/New_York');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe('2026-03-08T07:30:42.125Z');
});
it.each([
 ['zero','2026-10-25T05:30:00.000Z','2026-11-01T05:30:00.000Z'],
 ['nonzero','2026-10-25T05:30:42.125Z','2026-11-01T05:30:42.125Z'],
] as const)('preserves resolver fold selection with %s subminute precision',(_label,seed,wanted)=>{
 const out=expand(event({starts_at:seed,ends_at:null,recurrence:'weekly'}),'2026-11-01T00:00:00Z','2026-11-02T00:00:00Z','America/New_York');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe(wanted);
});
it('retains the existing resolver fold choice even when a zero-second seed names the later fold',()=>{
 const e=event({starts_at:'2026-11-01T06:30:00.000Z',ends_at:null,recurrence:'weekly'});
 const out=expand(e,'2026-11-01T00:00:00Z','2026-11-02T00:00:00Z','America/New_York');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe('2026-11-01T05:30:00.000Z');
});
it.each([
 ['monthly','2026-01-15T12:34:42.125Z','2026-01-15T13:34:52.375Z','2026-02-15T00:00:00Z','2026-02-16T00:00:00Z','2026-02-15T12:34:42.125Z','2026-02-15T13:34:52.375Z'],
 ['yearly','2020-07-01T12:34:42.125Z','2020-07-01T13:34:52.375Z','2026-07-01T00:00:00Z','2026-07-02T00:00:00Z','2026-07-01T12:34:42.125Z','2026-07-01T13:34:52.375Z'],
] as const)('preserves %s timestamp precision and exact elapsed duration',(frequency,seed,end,from,to,wantedStart,wantedEnd)=>{
 const e=event({starts_at:seed,ends_at:end,recurrence:frequency});const out=expand(e,from,to);
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe(wantedStart);expect(out[0].ends_at).toBe(wantedEnd);
 expect(Date.parse(out[0].ends_at!)-Date.parse(out[0].starts_at)).toBe(Date.parse(end)-Date.parse(seed));
});
it('preserves a pre-epoch anniversary subminute offset when expanding a modern window',()=>{
 const out=expand(event({starts_at:'1965-07-01T12:34:42.125Z',ends_at:null,recurrence:'yearly'}));
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe('2026-07-01T12:34:42.125Z');
});
it('excludes the occurrence exactly at a subminute recurrence cutoff',()=>{
 const e=event({starts_at:'2026-07-01T12:34:42.125Z',ends_at:null,recurrence_until:'2026-07-02T12:34:42.125Z'});
 const out=expand(e,'2026-07-01T00:00:00Z','2026-07-03T00:00:00Z');
 expect(out).toHaveLength(1);expect(out[0].starts_at).toBe(e.starts_at);
});
it('excludes the occurrence exactly at the subminute window end',()=>{
 const e=event({starts_at:'2026-07-01T12:34:42.125Z',ends_at:null});
 expect(expand(e,'2026-07-01T12:34:00.000Z','2026-07-01T12:34:42.125Z')).toEqual([]);
});
it('retains invalid-start dropping before precision extraction',()=>{
 expect(expand(event({starts_at:'not-a-timestamp'}))).toEqual([]);
});
