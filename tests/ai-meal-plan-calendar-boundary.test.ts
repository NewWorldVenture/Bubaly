import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { orPredicate } from './helpers/in-memory-supabase';
const h=vi.hoisted(()=>({db:null as unknown,complete:vi.fn(),rows:[] as Record<string,unknown>[],urls:[] as URL[],returnedIds:[] as string[],client:0,enabled:false,snapshot:null as unknown,missingCount:false,drift:false,timezone:'UTC',cap:2,status:200}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=>(key:string)=>key}));
vi.mock('@/lib/supabase/auth',()=>({requireUserContext:async()=>({user:{id:'synthetic-user'},active:{familyId:'10000000-0000-4000-8000-000000000001',role:'parent',member:{id:'member'},family:{timezone:h.timezone}}})}));
vi.mock('@/lib/supabase/server',()=>({createServer:async()=>h.db}));
vi.mock('@/lib/ai/provider',()=>({isAIConfigured:async()=>true,resolveProvider:async()=>({complete:h.complete}),describeAIError:()=>({message:'synthetic error'})}));
vi.mock('@/lib/server/ai-rate-limit',()=>({enforceAIRateLimit:async()=>({ok:true})}));
vi.mock('@/lib/ai/observability',()=>({withAiRequest:(_scope:unknown,_feature:unknown,run:(o:{used:()=>void})=>Promise<string>)=>run({used:()=>{}})}));
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
import { parseICSSource } from '@/lib/sync/ics-source';
import { POST } from '@/app/api/ai/meals/plan/route';
const family='10000000-0000-4000-8000-000000000001';
// Fixture timestamps share the query's ISO millisecond spelling; the shared
// parser compares scalar strings and does not implement SQL timestamptz casts.
const row=(id:string,start:string,end:string,recurrence='none')=>({id,family_id:family,title:id,starts_at:new Date(start).toISOString(),ends_at:new Date(end).toISOString(),all_day:false,category:'general',recurrence,recurrence_until:null});
beforeEach(()=>{vi.spyOn(console,'error').mockImplementation(()=>{});h.rows=[];h.urls=[];h.returnedIds=[];h.enabled=false;h.snapshot=null;h.missingCount=false;h.drift=false;h.timezone='UTC';h.cap=2;h.status=200;h.complete.mockReset();h.complete.mockResolvedValue({text:JSON.stringify({assignments:[{date:'2026-09-14',meal_type:'dinner',ref:'new',name:'Synthetic soup'}]})});h.db=createClient('https://synthetic-meal-review.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,storageKey:`review-${++h.client}`},global:{fetch:async(input,init)=>{const u=new URL(String(input));h.urls.push(u);if(u.pathname.includes('/rpc/calendar_read_occurrence_inputs')){expect(JSON.parse(String(init?.body))).toEqual({p_family_id:family});return Response.json(h.snapshot,{status:h.status});}
if(!u.pathname.endsWith('/calendar_events')){
  expect(['meals','family_recipes']).toContain(u.pathname.split('/').at(-1));
  expect(u.searchParams.get('family_id')).toBe(`eq.${family}`);
  expect(u.searchParams.get('order')).toBe('id.asc');
  expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
  return Response.json([],{headers:{'content-range':'*/0'}});
}
expect(u.searchParams.get('family_id')).toBe(`eq.${family}`);
expect(u.searchParams.get('order')).toBe('starts_at.asc,id.asc');
const isSeries=u.searchParams.get('recurrence')==='neq.none';
let rows=h.rows.filter(row=>row.family_id===family && (isSeries ? row.recurrence!=='none' && row.recurrence!==null : !row.recurrence || row.recurrence==='none'));
// Actual SDK query strings are evaluated by the existing strict fixture parser.
// This is synthetic PostgREST semantics, not a database/SQL execution claim.
for (const expression of u.searchParams.getAll('or')) {
  expect(expression.startsWith('(') && expression.endsWith(')')).toBe(true);
  rows=rows.filter(orPredicate(expression.slice(1,-1)));
}
for (const expression of u.searchParams.getAll('starts_at')) rows=rows.filter(orPredicate(`starts_at.${expression}`));
rows.sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at)) || String(a.id).localeCompare(String(b.id)));
const offset=Number(u.searchParams.get('offset')??0),requested=Number(u.searchParams.get('limit')??1000),page=rows.slice(offset,offset+Math.min(h.cap,requested));
h.returnedIds.push(...page.map(row=>String(row.id)));
const count=h.drift && offset>0 ? rows.length+1 : rows.length;
return Response.json(page,{headers:h.missingCount?{}:{'content-range':page.length?`${offset}-${offset+page.length-1}/${count}`:`*/${count}`}});}}});});
function request(weekStart='2026-09-14'){return new Request('https://synthetic.invalid/api/ai/meals/plan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({weekStart,write:false,useExpiring:false})});}
afterEach(()=>vi.restoreAllMocks());
async function result(weekStart='2026-09-14'){h.complete.mockResolvedValue({text:JSON.stringify({assignments:[{date:weekStart,meal_type:'dinner',ref:'new',name:'Synthetic soup'}]})});const response=await POST(request(weekStart));expect(response.status).toBe(200);return response.json();}
describe('actual SDK and meal planner complete calendar',()=>{
 it.each(['count','drift','interval','zone'])('refuses %s uncertainty before invoking the provider',async kind=>{
   h.rows=Array.from({length:3},(_,i)=>row(`row-${i}`,'2026-09-14T18:00:00Z','2026-09-14T19:00:00Z'));
   if(kind==='count')h.missingCount=true;if(kind==='drift')h.drift=true;if(kind==='interval')h.rows[0].ends_at='invalid';if(kind==='zone')h.timezone='Invalid/Timezone';
   expect((await POST(request())).status).toBe(503);expect(h.complete).not.toHaveBeenCalled();
 });
 it('uses stable exact-count pages under a two-row server cap and includes the last commitment',async()=>{
   h.rows=Array.from({length:6},(_,i)=>row(`early-${i}`,'2026-09-14T09:00:00Z','2026-09-14T09:01:00Z'));h.rows.push(row('last','2026-09-15T18:00:00Z','2026-09-15T19:00:00Z'));
   h.rows.push(row('ends-at-window-start','2026-09-13T18:00:00Z','2026-09-14T00:00:00Z'),row('starts-at-exclusive-end','2026-09-21T00:00:00Z','2026-09-21T01:00:00Z'));
   const body=await result();expect(body.busyNights).toContainEqual(expect.objectContaining({date:'2026-09-15',reason:'last'}));
   const calls=h.urls.filter(u=>u.pathname.endsWith('/calendar_events')&&!u.searchParams.has('recurrence'));expect(calls.map(u=>Number(u.searchParams.get('offset')??0))).toEqual([0,2,4,6]);expect(calls.every(u=>u.searchParams.getAll('or').some(value=>value.includes('ends_at.gt.')))).toBe(true);
   expect(h.returnedIds).not.toContain('ends-at-window-start');expect(h.returnedIds).not.toContain('starts-at-exclusive-end');expect(h.returnedIds).toContain('last');
 });
 it('recurring Tuesday18:00 series created months ago must make Tuesday busy',async()=>{h.rows=[row('Weekly swim','2026-06-02T18:00:00Z','2026-06-02T19:00:00Z','weekly'),row('Future master','2026-09-28T18:00:00Z','2026-09-28T19:00:00Z','weekly')];expect((await result()).busyNights).toContainEqual(expect.objectContaining({date:'2026-09-15'}));expect(h.returnedIds).toContain('Weekly swim');expect(h.returnedIds).not.toContain('Future master');});
 it('401st selected calendar row must not disappear from cooking constraints',async()=>{h.rows=Array.from({length:400},(_,i)=>row(`morning-${i}`,'2026-09-14T09:00:00Z','2026-09-14T09:01:00Z'));h.rows.push(row('Tuesday away game','2026-09-15T18:00:00Z','2026-09-15T19:00:00Z'));expect((await result()).busyNights).toContainEqual(expect.objectContaining({date:'2026-09-15'}));});
 it('trip beginning before week occupies Monday dinner',async()=>{h.rows=[row('Away trip','2026-09-12T09:00:00Z','2026-09-15T19:00:00Z'),row('Ended earlier','2026-09-12T09:00:00Z','2026-09-14T00:00:00Z'),row('Later week','2026-09-21T18:00:00Z','2026-09-21T19:00:00Z')];expect((await result()).busyNights).toContainEqual(expect.objectContaining({date:'2026-09-14'}));expect(h.returnedIds).toEqual(['Away trip']);});
 it('explicit zero-duration point must not invent60busyminutes',async()=>{h.rows=[row('Point','2026-09-14T18:00:00Z','2026-09-14T18:00:00Z')];expect((await result()).busyNights).toEqual([]);});
 it('native weekly recurrence stays at18:00 on a23-hour Sunday and excludes another family',async()=>{h.timezone='America/New_York';h.rows=[row('Weekly dinner practice','2026-03-01T23:00:00Z','2026-03-02T00:00:00Z','weekly'),{...row('Other private event','2026-03-04T23:00:00Z','2026-03-05T00:00:00Z'),family_id:'other-family'}];expect((await result('2026-03-02')).busyNights).toEqual([{date:'2026-03-08',weekday:'Sunday',reason:'Weekly dinner practice'}]);expect(JSON.stringify(h.complete.mock.calls)).not.toContain('Other private event');});
});

function sourceSnapshot(lines:string){
 const doc=parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic meal planner//EN\r\nBEGIN:VEVENT\r\nUID:meal-source\r\nSUMMARY:Source practice\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];
 const revisionId='30000000-0000-4000-8000-000000000001';
 return{version:1,familyId:family,nativeRows:[],nativeCount:0,sourceCount:1,watermarkCount:1,sourceGroups:[{feedId:'20000000-0000-4000-8000-000000000001',uid:doc.uid,revisionId,materializationState:'ready',document:doc,masterCancellationRevisionId:null,watermarks:[{componentKey:'master',versionComponent:structuredClone(doc.master),versionRevisionId:revisionId,cancelledComponent:null,cancellationRevisionId:null}]}]};
}
describe('enabled coherent source calendar in actual SDK meal planning',()=>{
 it('expands an original source weekly rule created before the requested week',async()=>{
   h.enabled=true;h.snapshot=sourceSnapshot('DTSTART:20260602T180000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=20');
   const body=await result();expect(body.busyNights).toEqual([{date:'2026-09-15',weekday:'Tuesday',reason:'Source practice'}]);expect(h.urls.filter(u=>u.pathname.endsWith('/calendar_events'))).toEqual([]);
   const prompt=JSON.stringify(h.complete.mock.calls[0]);expect(prompt).toContain('Tuesday 2026-09-15 (Source practice)');
 });
 it('clips source overnight travel on every occupied dinner',async()=>{h.enabled=true;h.snapshot=sourceSnapshot('DTSTART:20260913T230000Z\r\nDTEND:20260915T183000Z');expect((await result()).busyNights.map((n:{date:string})=>n.date)).toEqual(['2026-09-14','2026-09-15']);});
 it('keeps source DATE annotations out of cooking occupancy',async()=>{h.enabled=true;h.snapshot=sourceSnapshot('DTSTART;VALUE=DATE:20260914\r\nDURATION:P3D');expect((await result()).busyNights).toEqual([]);});
 it('source no-end point does not become a fictitious one-hour commitment',async()=>{h.enabled=true;h.snapshot=sourceSnapshot('DTSTART:20260914T180000Z');expect((await result()).busyNights).toEqual([]);});
 it('a fully witnessed source cancellation does not constrain meal choices',async()=>{h.enabled=true;const snapshot=sourceSnapshot('DTSTART:20260914T180000Z\r\nSTATUS:CANCELLED');const group=snapshot.sourceGroups[0];Object.assign(group,{masterCancellationRevisionId:group.revisionId});Object.assign(group.watermarks[0],{cancelledComponent:structuredClone(group.document.master),cancellationRevisionId:group.revisionId});h.snapshot=snapshot;expect((await result()).busyNights).toEqual([]);});
 it('source timezone weekly recurrence remains at18:00 through spring DST',async()=>{h.enabled=true;h.timezone='America/New_York';h.snapshot=sourceSnapshot('DTSTART;TZID=America/New_York:20260301T180000\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=3');expect((await result('2026-03-02')).busyNights).toEqual([{date:'2026-03-08',weekday:'Sunday',reason:'Source practice'}]);});
 it('one coherent snapshot combines native and original source commitments without fake native IDs',async()=>{
   h.enabled=true;const snapshot=sourceSnapshot('DTSTART:20260914T180000Z\r\nDURATION:PT1H');
   Object.assign(snapshot,{nativeRows:[{...row('40000000-0000-4000-8000-000000000001','2026-09-15T18:00:00Z','2026-09-15T19:00:00Z'),title:'Native practice',description:null,location:null,assignee_id:null,feed_id:null,external_uid:null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2026-09-01T00:00:00Z',updated_at:'2026-09-01T00:00:00Z',source_recurrence:null}],nativeCount:1});h.snapshot=snapshot;
   expect((await result()).busyNights).toEqual([{date:'2026-09-14',weekday:'Monday',reason:'Source practice'},{date:'2026-09-15',weekday:'Tuesday',reason:'Native practice'}]);expect(h.urls.filter(u=>u.pathname.includes('/rpc/'))).toHaveLength(1);
 });
 it.each(['missing','review','short'])('refuses source %s without native fallback or model execution',async kind=>{h.enabled=true;h.snapshot=sourceSnapshot('DTSTART:20260914T180000Z\r\nDURATION:PT1H');if(kind==='missing'){h.status=400;h.snapshot={code:'PGRST202',message:'synthetic missing RPC'};}else if(kind==='review')(h.snapshot as ReturnType<typeof sourceSnapshot>).sourceGroups[0].materializationState='revision_review';else(h.snapshot as ReturnType<typeof sourceSnapshot>).sourceCount=2;expect((await POST(request())).status).toBe(503);expect(h.complete).not.toHaveBeenCalled();expect(h.urls.filter(u=>u.pathname.endsWith('/calendar_events'))).toEqual([]);});
});
