import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {writeFileSync} from 'node:fs';
import {listPracticesBetween, type SportsEventRow} from '@/lib/services/sports';
import type {ServiceScope} from '@/lib/services/types';
import {orPredicate} from './helpers/in-memory-supabase';
// Only explicit bounds are exercised; never load the school module's scope/Auth/default-clock graph.
vi.mock('@/lib/services/school', () => ({
  resolveWindow(_scope: ServiceScope, input?: {from?: string|null;to?: string|null}) {
    if (!input?.from || !input?.to) throw new Error('explicit bounds required; default-date lane forbidden');
    const fromMs=Date.parse(input.from), toMs=Date.parse(input.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return {ok:false as const,error:'Invalid explicit window.',code:'invalid_input'};
    return {ok:true as const,data:{from:new Date(fromMs).toISOString(),to:new Date(toMs).toISOString()}};
  },
}));
const FAMILY='synthetic-family', MEMBER='synthetic-member';
type Receipt={method:string;path:string;query:[string,string][]};
let receipts:Receipt[]=[];
let fixtureErrors:string[]=[];
const traces:unknown[]=[];
let caseName='';
beforeEach(ctx=>{receipts=[];fixtureErrors=[];caseName=ctx.task.name;});
afterEach(()=>{
  traces.push({caseName,receipts:structuredClone(receipts),fixtureErrors:[...fixtureErrors]});
  if(process.env.BUBALY_SPORTS_TIMEZONE_TRACE) writeFileSync(process.env.BUBALY_SPORTS_TIMEZONE_TRACE,JSON.stringify(traces,null,2)+'\n');
  expect(fixtureErrors,'transport assertions are checked outside the SDK').toEqual([]);
  expect(receipts.length).toBe(2);
  expect(receipts.map(r=>r.method)).toEqual(['GET','GET']);
  vi.restoreAllMocks();
});
function event(starts_at:string,over:Partial<SportsEventRow>={}):SportsEventRow {
  return {id:'series',family_id:FAMILY,member_id:MEMBER,sport:'soccer',team:'Synthetic',title:'Practice',event_type:'practice',location:null,
    starts_at,ends_at:new Date(Date.parse(starts_at)+3600000).toISOString(),recurrence:'weekly',recurrence_until:null,created_by:null,created_at:'',updated_at:'',...over};
}
function scope(tz:string,rows:SportsEventRow[],errorBranch?:'single'|'series'):ServiceScope {
  for(const row of rows) {expect(new Date(row.starts_at).getUTCSeconds()).toBe(0);expect(new Date(row.starts_at).getUTCMilliseconds()).toBe(0);}
  const inertFetch:typeof fetch=async (input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    const method=init?.method??(input instanceof Request?input.method:'GET');
    receipts.push({method,path:url.pathname,query:[...url.searchParams]});
    // The transport contract of the shared series-aware read (lib/calendar/
    // occurrences.ts): two GETs, both family-scoped, ordered by start then id,
    // each asking for an exact count (so a response the server cut short is a
    // failed read, not a prefix). The one-off read carries the window as an
    // `or` of one `and(...)` clause plus the no-series clause and the service's
    // own cap; the series read selects every series that started by the
    // window's end and has not ended before its start, in pages of 1,000 from
    // offset 0 — one page here, since this stand-in answers fewer than that
    // and sends no count.
    const series=url.searchParams.get('recurrence')==='neq.none';
    try {
      expect(url.origin).toBe('https://sports-proof.invalid');expect(url.pathname).toBe('/rest/v1/sports_events');expect(method).toBe('GET');expect(receipts.length).toBeLessThanOrEqual(2);
      expect(url.searchParams.get('family_id')).toBe('eq.'+FAMILY);expect(url.searchParams.get('select')).toBe('*');expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      const ors=url.searchParams.getAll('or');
      if(series) {
        expect(url.searchParams.get('limit')).toBe('1000');expect(url.searchParams.get('offset')).toBe('0');
        expect(url.searchParams.get('starts_at')).toMatch(/^lte\./);
        expect(ors).toEqual([expect.stringMatching(/^\(recurrence_until\.is\.null,recurrence_until\.gte\..+\)$/)]);
      } else {
        expect(url.searchParams.get('limit')).toBe('500');expect(url.searchParams.get('offset')).toBeNull();
        expect(url.searchParams.get('recurrence')).toBeNull();expect(url.searchParams.get('starts_at')).toBeNull();
        expect(ors).toEqual([expect.stringMatching(/^\(and\(starts_at\.gte\..+,starts_at\.lt\..+\)\)$/),'(recurrence.is.null,recurrence.eq.none)']);
      }
    } catch(cause) {fixtureErrors.push(String(cause));throw cause;}
    if(errorBranch===(series?'series':'single')) return new Response(JSON.stringify({code:'42501',message:'synthetic denied'}),{status:403,headers:{'content-type':'application/json'}});
    const data=rows.filter(row=>{
      for(const [key,predicate] of url.searchParams) {
        if(key==='select'||key==='limit'||key==='offset'||key==='order') continue;
        // PostgREST wraps an `or` in parentheses; the in-memory helper's parser reads what is inside.
        if(key==='or') {if(!orPredicate(predicate.slice(1,-1))(row)) return false; continue;}
        const dot=predicate.indexOf('.'),op=predicate.slice(0,dot),wanted=predicate.slice(dot+1);
        const value=String(row[key as keyof SportsEventRow]);
        if(op==='eq'&&value!==wanted)return false;if(op==='neq'&&value===wanted)return false;
        if(op==='gte'&&Date.parse(value)<Date.parse(wanted))return false;if(op==='lte'&&Date.parse(value)>Date.parse(wanted))return false;
      }
      return true;
    });
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  const db=createClient('https://sports-proof.invalid','synthetic-anon-not-a-secret',{accessToken:async()=>null,global:{fetch:inertFetch},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  return {db:db as ServiceScope['db'],familyId:FAMILY,userId:null,memberId:MEMBER,role:'parent',actorKind:'member',tz};
}
const window=(from:string,to:string)=>({from,to});
function successful(result:Awaited<ReturnType<typeof listPracticesBetween>>) {expect(result.ok).toBe(true);if(!result.ok)throw Error('expected success');return result.data;}
function localClock(instant:string,tz:string) {
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
 const p=Object.fromEntries(parts.map(v=>[v.type,v.value]));return p.year+'-'+p.month+'-'+p.day+' '+p.hour+':'+p.minute;
}
describe('sports family timezone actual SDK original contract',()=>{
 it('keeps weekly New York 17:00 across fall-back with source id and duration',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-10-28T21:00:00.000Z')]),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z')));
  expect(rows.map(r=>[r.id,r.starts_at,r.ends_at,localClock(r.starts_at,'America/New_York')])).toEqual([['series','2026-11-04T22:00:00.000Z','2026-11-04T23:00:00.000Z','2026-11-04 17:00']]);
 });
 it('includes the weekly New York 00:30 occurrence in its family day after fall-back',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-10-28T04:30:00.000Z')]),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z')));
  expect(rows.map(r=>[r.id,r.starts_at,localClock(r.starts_at,'America/New_York')])).toEqual([['series','2026-11-04T05:30:00.000Z','2026-11-04 00:30']]);
 });
 it('keeps weekly New York 18:00 across spring-forward',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-03-01T23:00:00.000Z')]),window('2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z')));
  expect(rows.map(r=>[r.starts_at,localClock(r.starts_at,'America/New_York')])).toEqual([['2026-03-08T22:00:00.000Z','2026-03-08 18:00']]);
 });
 it('retains UTC family weekly times across the same calendar dates',async()=>{
  const rows=successful(await listPracticesBetween(scope('UTC',[event('2026-10-28T21:00:00.000Z')]),window('2026-11-04T00:00:00.000Z','2026-11-05T00:00:00.000Z')));
  expect(rows.map(r=>[r.id,r.starts_at,r.ends_at])).toEqual([['series','2026-11-04T21:00:00.000Z','2026-11-04T22:00:00.000Z']]);
 });
 it('retains New York weekly local time when the offset does not change',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-10-14T21:00:00.000Z')]),window('2026-10-21T04:00:00.000Z','2026-10-22T04:00:00.000Z')));
  expect(rows.map(r=>[r.starts_at,localClock(r.starts_at,'America/New_York')])).toEqual([['2026-10-21T21:00:00.000Z','2026-10-21 17:00']]);
 });
 it('retains a non-DST half-hour family zone weekly local time',async()=>{
  const rows=successful(await listPracticesBetween(scope('Asia/Kolkata',[event('2026-10-14T11:30:00.000Z')]),window('2026-10-20T18:30:00.000Z','2026-10-21T18:30:00.000Z')));
  expect(rows.map(r=>[r.starts_at,localClock(r.starts_at,'Asia/Kolkata')])).toEqual([['2026-10-21T11:30:00.000Z','2026-10-21 17:00']]);
 });
 it('passes through a one-off exactly at the inclusive window end',async()=>{
  const row=event('2026-11-05T05:00:00.000Z',{id:'one-off',recurrence:'none'});
  expect(successful(await listPracticesBetween(scope('America/New_York',[row]),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z')))).toEqual([row]);
 });
 it('retains explicit family member and event-type filters on both reads',async()=>{
  const base=event('2026-10-14T21:00:00.000Z');
  const rows=successful(await listPracticesBetween(scope('America/New_York',[base,{...base,id:'foreign',family_id:'other'},{...base,id:'other-child',member_id:'other-child'},{...base,id:'game',event_type:'game'}]),{...window('2026-10-21T04:00:00.000Z','2026-10-22T04:00:00.000Z'),memberId:MEMBER,eventType:'practice'}));
  expect(rows.map(r=>r.id)).toEqual(['series']);expect(receipts.every(r=>new URLSearchParams(r.query).get('member_id')==='eq.'+MEMBER&&new URLSearchParams(r.query).get('event_type')==='eq.practice')).toBe(true);
 });
 it('retains sort and caller limit after combining singles with recurring rows',async()=>{
  const rows=successful(await listPracticesBetween(scope('UTC',[event('2026-10-14T21:00:00.000Z'),event('2026-10-21T20:00:00.000Z',{id:'single',recurrence:'none'})]),{...window('2026-10-21T00:00:00.000Z','2026-10-22T00:00:00.000Z'),limit:1}));
  expect(rows.map(r=>[r.id,r.starts_at])).toEqual([['single','2026-10-21T20:00:00.000Z']]);
 });
 it('retains recurrence-until refusal at the exclusive cutoff',async()=>{
  const rows=successful(await listPracticesBetween(scope('UTC',[event('2026-10-14T21:00:00.000Z',{recurrence_until:'2026-10-21T21:00:00.000Z'})]),window('2026-10-21T00:00:00.000Z','2026-10-22T00:00:00.000Z')));
  expect(rows).toEqual([]);
 });
 it('returns a friendly database failure when the recurring GET is denied',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  const result=await listPracticesBetween(scope('America/New_York',[],'series'),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z'));
  expect(result).toMatchObject({ok:false,code:'db'});expect(result.ok).toBe(false);if(!result.ok)expect(result.error).toContain("You don't have permission");
 });
});

describe('sports named family-zone preservation controls',()=>{
 it('steps a daily New York practice on the family clock through fall-back',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-10-31T21:00:00.000Z',{recurrence:'daily'})]),window('2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z')));
  expect(rows.map(r=>[r.starts_at,r.ends_at,localClock(r.starts_at,'America/New_York')])).toEqual([['2026-11-01T22:00:00.000Z','2026-11-01T23:00:00.000Z','2026-11-01 17:00']]);
 });
 it('steps a monthly New York practice on the family clock through fall-back',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-10-04T21:00:00.000Z',{recurrence:'monthly'})]),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z')));
  expect(rows.map(r=>[r.starts_at,localClock(r.starts_at,'America/New_York')])).toEqual([['2026-11-04T22:00:00.000Z','2026-11-04 17:00']]);
 });
 it('uses a Los Angeles family zone independently of the UTC server',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/Los_Angeles',[event('2026-10-28T00:00:00.000Z')]),window('2026-11-03T08:00:00.000Z','2026-11-04T08:00:00.000Z')));
  expect(rows.map(r=>[r.starts_at,localClock(r.starts_at,'America/Los_Angeles')])).toEqual([['2026-11-04T01:00:00.000Z','2026-11-03 17:00']]);
 });
 it('preserves the named resolver first-valid-minute spring gap policy',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-03-01T07:30:00.000Z')]),window('2026-03-08T05:00:00.000Z','2026-03-09T04:00:00.000Z')));
  expect(rows.map(r=>[r.starts_at,r.ends_at,localClock(r.starts_at,'America/New_York')])).toEqual([['2026-03-08T07:00:00.000Z','2026-03-08T08:00:00.000Z','2026-03-08 03:00']]);
 });
 it('preserves the named resolver first-fold choice for zero-second timestamps',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-10-25T05:30:00.000Z')]),window('2026-11-01T04:00:00.000Z','2026-11-02T05:00:00.000Z')));
  expect(rows.map(r=>[r.starts_at,localClock(r.starts_at,'America/New_York')])).toEqual([['2026-11-01T05:30:00.000Z','2026-11-01 01:30']]);
 });
 it('applies the existing exclusive cutoff to the correctly zoned occurrence',async()=>{
  const rows=successful(await listPracticesBetween(scope('America/New_York',[event('2026-10-28T21:00:00.000Z',{recurrence_until:'2026-11-04T22:00:00.000Z'})]),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z')));
  expect(rows).toEqual([]);
 });
 it('retains empty collection success without creating an occurrence',async()=>{
  expect(successful(await listPracticesBetween(scope('America/New_York',[]),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z')))).toEqual([]);
 });
 it('retains refusal when the single-events GET is denied',async()=>{
  vi.spyOn(console,'error').mockImplementation(()=>{});
  const result=await listPracticesBetween(scope('America/New_York',[event('2026-10-28T21:00:00.000Z')],'single'),window('2026-11-04T05:00:00.000Z','2026-11-05T05:00:00.000Z'));
  expect(result).toMatchObject({ok:false,code:'db'});if(!result.ok)expect(result.error).toContain("You don't have permission");
 });
});
