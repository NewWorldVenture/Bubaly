import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import type {Database,Tables} from '@/lib/database.types';
import type {ImportedSourceComponent,ImportedSourceOverride} from '@/lib/calendar/imported-source';
import {parseICSSource} from '@/lib/sync/ics-source';
import {orPredicate} from './helpers/in-memory-supabase';
const h=vi.hoisted(()=>({enabled:true}));
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
import {searchCalendarOccurrences,validateCalendarSearchWindow} from '@/lib/services/calendar/search-occurrences';
beforeEach(()=>{h.enabled=true;});
const FAMILY = '10000000-0000-4000-8000-000000000001', FEED = '20000000-0000-4000-8000-000000000001';
const REVISION = '30000000-0000-4000-8000-000000000001', MEMBER = '50000000-0000-4000-8000-000000000001';
const day = '2026-10-08';
function native(index = 1, patch: Partial<Tables<'calendar_events'>> = {}) {
  return { id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`, family_id: FAMILY, title: `Native ${index}`, description: null, location: null, category: 'general',
    starts_at: `${day}T09:00:00Z`, ends_at: `${day}T10:00:00Z`, all_day: false, recurrence: 'none', recurrence_until: null, assignee_id: null, feed_id: null, external_uid: null,
    created_by: null, onboarding_key: null, idempotency_key: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', source_recurrence: null, ...patch } as Tables<'calendar_events'> & { source_recurrence: null };
}
function source(events = ['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nSUMMARY:Synthetic source'], uid = 'synthetic-source') {
  return parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic availability//EN\r\n${events.map(body => `BEGIN:VEVENT\r\nUID:${uid}\r\n${body}\r\nEND:VEVENT\r\n`).join('')}END:VCALENDAR\r\n`)[0];
}
function group(document = source(), feedId = FEED) {
  const components: (ImportedSourceComponent | ImportedSourceOverride)[] = [...(document.master ? [document.master] : []), ...document.overrides];
  return { feedId, uid: document.uid, revisionId: REVISION, materializationState: 'ready', document,
    masterCancellationRevisionId: document.master?.status === 'cancelled' ? REVISION : null,
    watermarks: components.map(component => ({ componentKey: 'recurrenceId' in component
      ? JSON.stringify(['override', component.recurrenceId.kind, component.recurrenceId.kind === 'zoned' ? component.recurrenceId.tzid : null, component.recurrenceId.value]) : 'master',
    versionComponent: structuredClone(component), versionRevisionId: REVISION, cancelledComponent: component.status === 'cancelled' ? structuredClone(component) : null,
    cancellationRevisionId: component.status === 'cancelled' ? REVISION : null })) };
}
function snapshot(groups = [group()], nativeRows = [native()]) {
  return { version: 1, familyId: FAMILY, nativeRows, nativeCount: nativeRows.length, sourceGroups: groups, sourceCount: groups.length, watermarkCount: groups.reduce((sum, item) => sum + item.watermarks.length, 0) };
}

const window={from:'2026-10-08T00:00:00Z',to:'2026-10-08T23:59:59.999Z'};
type Options={cap?:number;missingCount?:boolean;laterError?:boolean;drift?:boolean;duplicate?:boolean;count?:number;snapshotError?:boolean};
function setup(value:unknown=snapshot(),options:Options={}){
 const calls:URL[]=[];
 const rows=typeof value==='object'&&value!==null&&'nativeRows'in value&&Array.isArray(value.nativeRows)?value.nativeRows:[];
 const db=createClient<Database>('https://search.synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));calls.push(url);expect(url.origin).toBe('https://search.synthetic.invalid');
  if(url.pathname==='/rest/v1/rpc/calendar_read_occurrence_inputs'){
   expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toEqual({p_family_id:FAMILY});
   return options.snapshotError?Response.json({message:'Synthetic denied'},{status:403}):Response.json(value);
  }
  expect(init?.method??'GET').toBe('GET');expect(url.pathname).toBe('/rest/v1/calendar_events');expect(url.searchParams.get('family_id')).toBe('eq.'+FAMILY);
  expect(url.searchParams.has('title')).toBe(false);expect(url.searchParams.has('assignee_id')).toBe(false);expect(url.searchParams.has('category')).toBe(false);
  const offset=Number(url.searchParams.get('offset')??0);if(offset&&options.laterError)return Response.json({message:'Synthetic denied'},{status:403});
  let selected=[...rows];
  for(const [key,value] of url.searchParams){if(['select','order','offset','limit'].includes(key))continue;selected=selected.filter(orPredicate(key==='or'?value.slice(1,-1):`${key}.${value}`));}
  selected.sort((a,b)=>a.starts_at.localeCompare(b.starts_at)||a.id.localeCompare(b.id));
  const page=selected.slice(options.duplicate&&offset?0:offset,(options.duplicate&&offset?0:offset)+(options.cap??1000));
  return Response.json(page,{headers:options.missingCount?{}:{'Content-Range':`${offset}-${Math.max(offset,offset+page.length-1)}/${options.count??(selected.length+(offset&&options.drift?1:0))}`}});
 }}});
 const scope={db,familyId:FAMILY,userId:null,memberId:null,role:'system' as const,actorKind:'system' as const,tz:'UTC',now:new Date('2026-10-08T08:00:00Z')};return{scope,calls};
}
async function execute(value=snapshot(),input:Parameters<typeof searchCalendarOccurrences>[1]=window,options:Options={}){const f=setup(value,options);return {...f,result:await searchCalendarOccurrences(f.scope,input)};}

describe('complete bounded occurrence search through the actual installed SDK',()=>{
 it('keeps real action identities and source provenance in separate globally ordered arrays',async()=>{
  const {result,calls}=await execute(snapshot([group(source(['DTSTART:20261008T093000Z\r\nDURATION:PT1H']))],[native(1),native(2,{starts_at:'2026-10-08T10:00:00Z',ends_at:'2026-10-08T11:00:00Z'})]),{...window,limit:2});
  expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  expect(result.data).toMatchObject({totalVisibleCount:3,matchedCount:3,returnedCount:2,truncated:true,horizonEndsAt:window.to});
  expect(result.data.events[0]).toMatchObject({id:native().id,eventId:native().id,displayOrder:0,mutable:true,readOnly:false,reference:{kind:'native',eventId:native().id}});
  expect(result.data.source_events[0]).toMatchObject({displayOrder:1,mutable:false,readOnly:true,reference:{kind:'source',feedId:FEED,revisionId:REVISION,original:{kind:'utc',value:'20261008T093000Z'}}});
  for(const key of ['id','eventId','category','assignee_id'])expect(result.data.source_events[0]).not.toHaveProperty(key);
  expect(calls).toHaveLength(1);
 });
 it('applies member/category only to native rows and explicitly keeps unmapped family source context',async()=>{
  const {result}=await execute(snapshot([group()],[native(1,{assignee_id:MEMBER,category:'school'}),native(2)]),{...window,assigneeId:MEMBER,category:'sports'});
  expect(result).toMatchObject({ok:true,data:{events:[],totalVisibleCount:3,matchedCount:1,returnedCount:1,filterScope:{native:'requested-filters',sources:'unmapped-family-context',sourceMemberCategoryMatched:false}}});
  if(result.ok)expect(result.data.source_events).toHaveLength(1);
 });
 it.each([' %_ ',' a.b[ ',' MiXeD '])('matches trimmed case-insensitive literal titles: %s',async(query)=>{
  const title='Prefix '+query.trim().toUpperCase()+' Suffix';
  const {result}=await execute(snapshot([group(source([`DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nSUMMARY:${title}`]))],[native(1,{title}),native(2,{title:'different'})]),{...window,query});
  expect(result).toMatchObject({ok:true,data:{totalVisibleCount:3,matchedCount:2,returnedCount:2}});
 });
 it('keeps free and point annotations visible with no positive occupancy',async()=>{
  const {result}=await execute(snapshot([group(source(['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nTRANSP:TRANSPARENT'],'free')),group(source(['DTSTART:20261008T100000Z'],'point'))],[]));
  expect(result.ok).toBe(true);if(result.ok){expect(result.data.returnedCount).toBe(2);expect(result.data.source_events.map(r=>r.occupied)).toEqual([false,false]);expect(result.data.source_events.map(r=>r.point)).toEqual([false,true]);}
 });
 it('marks imported natives readonly and native missing ends estimated without rewriting original endpoints',async()=>{
  const {result}=await execute(snapshot([], [native(1,{feed_id:FEED,ends_at:null}),native(2,{external_uid:'original'})]));
  expect(result.ok).toBe(true);if(result.ok){expect(result.data.events.every(r=>r.readOnly&&!r.mutable)).toBe(true);expect(result.data.events[0]).toMatchObject({ends_at:null,actualEndsAt:'2026-10-08T10:00:00.000Z',estimatedEnd:true,occupied:true,interval:{start:Date.parse('2026-10-08T09:00:00Z'),end:Date.parse('2026-10-08T10:00:00Z')}});}
 });
 it('retains exact escaped4096UID through JSON roundtrip',async()=>{
  const uid='escaped\\uid,'+'x'.repeat(4084);expect(uid.length).toBe(4096);
  const {result}=await execute(snapshot([group(source(undefined,uid.replace('\\','\\\\').replace(',','\\,')))],[]));
  expect(result.ok).toBe(true);if(result.ok)expect(JSON.parse(JSON.stringify(result.data)).source_events[0].reference.uid).toBe(uid);
 });
 it('retains original ongoing clocks while exposing clipped occupancy',async()=>{
  const {result}=await execute(snapshot([group(source(['DTSTART:20261007T230000Z\r\nDURATION:PT3H']))],[]));
  expect(result).toMatchObject({ok:true,data:{source_events:[{actualStartsAt:'2026-10-07T23:00:00.000Z',interval:{start:Date.parse(window.from),end:Date.parse('2026-10-08T02:00:00Z')}}]}});
 });
 it.each([{from:'2026-03-08T05:00:00Z',to:'2026-03-09T03:59:59.999Z',date:'20260308',next:'20260309',hours:23},{from:'2026-11-01T04:00:00Z',to:'2026-11-02T04:59:59.999Z',date:'20261101',next:'20261102',hours:25}])('uses qualified civil DATE occupancy across DST $hours-hour days',async(input)=>{
  const f=setup(snapshot([group(source([`DTSTART;VALUE=DATE:${input.date}\r\nDTEND;VALUE=DATE:${input.next}`]))],[]));f.scope.tz='America/New_York';
  const result=await searchCalendarOccurrences(f.scope,input);expect(result.ok).toBe(true);if(result.ok){const row=result.data.source_events[0];expect(Date.parse(row.actualEndsAt!)-Date.parse(row.actualStartsAt)).toBe(input.hours*3600000);expect(row.reference.original.value).toBe(input.date);expect(row.occupied).toBe(true);}
 });
 it('moves one override and cancels another while preserving original occurrence references',async()=>{
  const document=source(['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=3','RECURRENCE-ID:20261009T090000Z\r\nDTSTART:20261009T120000Z\r\nDURATION:PT1H','RECURRENCE-ID:20261010T090000Z\r\nDTSTART:20261010T090000Z\r\nSTATUS:CANCELLED']);
  const {result}=await execute(snapshot([group(document)],[]),{from:window.from,to:'2026-10-10T23:59:59.999Z'});
  expect(result.ok).toBe(true);if(result.ok){expect(result.data.returnedCount).toBe(2);expect(result.data.source_events[1]).toMatchObject({actualStartsAt:'2026-10-09T12:00:00.000Z',reference:{original:{value:'20261009T090000Z'}}});}
 });
 it('pages every native row before literal filtering and global cap',async()=>{
  h.enabled=false;const {result,calls}=await execute(snapshot([],[native(1),native(2),native(3,{title:'Last match'})]),{...window,limit:1,query:'last'}, {cap:2});
  expect(result).toMatchObject({ok:true,data:{totalVisibleCount:3,matchedCount:1,returnedCount:1,truncated:false,events:[{id:native(3).id}]}});expect(calls.some(c=>c.searchParams.get('offset')==='2')).toBe(true);
 });
 it.each([{title:null},{category:null},{category:'invented'},{description:undefined},{location:123},{recurrence:'unknown'},{created_at:undefined},{updated_at:'junk'},{created_by:4},{idempotency_key:undefined},{onboarding_key:undefined}])('qualifies every native presentation field before a no-match filter %j',async(patch)=>{
  h.enabled=false;const f=setup(snapshot([],[{...native(),...patch}] as ReturnType<typeof native>[]));
  expect(await searchCalendarOccurrences(f.scope,{...window,query:'absent',limit:1})).toMatchObject({ok:false,code:'db'});
 });
 it('expands native recurrence without substituting occurrence keys for action IDs',async()=>{
  h.enabled=false;const {result}=await execute(snapshot([],[native(1,{recurrence:'daily'})]),{from:window.from,to:'2026-10-10T23:59:59.999Z'});
  expect(result.ok).toBe(true);if(result.ok){expect(result.data.events).toHaveLength(3);expect(new Set(result.data.events.map(r=>r.id))).toEqual(new Set([native().id]));expect(new Set(result.data.events.map(r=>r.occurrenceKey)).size).toBe(3);}
 });
 it.each(['missingCount','laterError','drift','duplicate','count'])('refuses incomplete native %s before a no-match filter or cap',async(kind)=>{
  h.enabled=false;const options:Options={cap:2,...(kind==='count'?{count:20001}:{[kind]:true})};
  const {result}=await execute(snapshot([],[native(1),native(2),native(3)]),{...window,query:'absent',limit:1},options);expect(result.ok).toBe(false);
 });
 it.each(['native-count','source-count','watermark-count','unknown-transparency','missing-provenance','duplicate','cap','uid-too-long','snapshot-error'])('refuses snapshot %s before title/member filtering',async(kind)=>{
  const value=snapshot();if(kind==='native-count')value.nativeCount++;if(kind==='source-count')value.sourceCount++;if(kind==='watermark-count')value.watermarkCount++;
  if(kind==='unknown-transparency')Object.assign(value.sourceGroups[0].document.master!,{transparency:'unknown'});if(kind==='missing-provenance')Object.assign(value.sourceGroups[0].document.master!,{raw:null});
  if(kind==='duplicate')value.nativeRows.push({...native(),title:'contradiction'}),value.nativeCount++;if(kind==='cap')value.nativeCount=20001;
  if(kind==='uid-too-long'){value.sourceGroups[0].uid='x'.repeat(4097);value.sourceGroups[0].document.uid='x'.repeat(4097);}
  const {result}=await execute(value,{...window,query:'absent',assigneeId:'unmatched',limit:1},{snapshotError:kind==='snapshot-error'});expect(result.ok).toBe(false);
 });
 it.each([{from:'2026-02-30T00:00:00Z',to:window.to},{from:'2026-10-08T00:00:00',to:window.to},{from:window.to,to:window.from},{from:window.from,to:'2028-10-08T00:00:00Z'},{from:'2026-10-08T24:00:00Z',to:window.to}])('refuses invalid explicit clocks before transport %j',async(input)=>{
  const f=setup();expect(()=>validateCalendarSearchWindow(f.scope,input)).toThrow();expect(await searchCalendarOccurrences(f.scope,input)).toMatchObject({ok:false,code:'invalid_input'});expect(f.calls).toEqual([]);
 });
 it.each(['','Unknown/Zone',undefined])('refuses invalid family zone %s before transport',async(tz)=>{
  const f=setup();Object.assign(f.scope,{tz});expect((await searchCalendarOccurrences(f.scope,window)).ok).toBe(false);expect(f.calls).toEqual([]);
 });
 it.each([{limit:0},{limit:201},{limit:1.5},{assigneeId:''},{category:'unknown'},{query:4}])('refuses invalid search options before transport %j',async(patch)=>{
  const f=setup();expect((await searchCalendarOccurrences(f.scope,{...window,...patch} as Parameters<typeof searchCalendarOccurrences>[1])).ok).toBe(false);expect(f.calls).toEqual([]);
 });
 it('accepts exactly366days and refuses a missing family scope before transport',async()=>{
  const f=setup(snapshot([],[]));expect((await searchCalendarOccurrences(f.scope,{from:window.from,to:new Date(Date.parse(window.from)+366*86400000-1).toISOString()})).ok).toBe(true);
  f.calls.length=0;f.scope.familyId=' ';expect((await searchCalendarOccurrences(f.scope,window)).ok).toBe(false);expect(f.calls).toEqual([]);
 });
});





