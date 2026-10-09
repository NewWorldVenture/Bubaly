import {beforeEach,describe,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import type {Database,Tables} from '@/lib/database.types';
import type {ImportedSourceComponent,ImportedSourceOverride} from '@/lib/calendar/imported-source';
import {parseICSSource} from '@/lib/sync/ics-source';
import {orPredicate} from './helpers/in-memory-supabase';
const h=vi.hoisted(()=>({enabled:true}));
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
import {commitmentConflicts} from '@/lib/services/trips';
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

const TRIP = '60000000-0000-4000-8000-000000000001';
type Row = Record<string, unknown>;
const trip = { id: TRIP, family_id: FAMILY, title: 'Synthetic trip', start_date: day, end_date: day, timezone: 'UTC' };
const school = (i:number):Row => ({id:`school-${i}`,family_id:FAMILY,title:`School ${i}`,member_id:null,starts_at:day+'T09:00:00Z',ends_at:null});
const sports = (i:number):Row => ({...school(i),id:`sports-${i}`,recurrence:'none',recurrence_until:null});
const homework = (i:number):Row => ({id:`homework-${i}`,family_id:FAMILY,title:`Homework ${i}`,member_id:null,due_at:day+'T09:00:00Z',status:'assigned'});
const bill = (i:number):Row => ({id:`bill-${i}`,family_id:FAMILY,name:`Bill ${i}`,due_date:day,status:'upcoming'});
type Options={cap?:number;missingCount?:string;laterError?:string;drift?:string;ignoreFilters?:string;trip?:Row;tz?:string;groups?:ReturnType<typeof group>[];enabled?:boolean};
function setup(seed:Record<string,Row[]>={},options:Options={}) {
 h.enabled=options.enabled??true;
 const tables:Record<string,Row[]>={vacations:[{...trip,...options.trip}],calendar_events:[],...seed}; const calls:URL[]=[];
 const db=createClient<Database>('https://trip.synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));calls.push(url);expect(url.origin).toBe('https://trip.synthetic.invalid');
  if(url.pathname==='/rest/v1/rpc/calendar_read_occurrence_inputs') {expect(init?.method).toBe('POST');return Response.json(snapshot(options.groups??[],tables.calendar_events as ReturnType<typeof native>[]));}
  expect(init?.method??'GET').toBe('GET');const table=url.pathname.split('/').at(-1)!;
  expect(url.searchParams.get('family_id')).toBe('eq.'+FAMILY);
  let selected=[...(tables[table]??[])];
  if(options.ignoreFilters!==table)for(const [key,value] of url.searchParams)if(!['select','order','offset','limit'].includes(key))selected=value==='not.is.null'?selected.filter(row=>row[key]!==null&&row[key]!==undefined):selected.filter(orPredicate(key==='or'?value.slice(1,-1):`${key}.${value}`));
  if(table==='vacations')return Response.json(selected[0]??null);
  const offset=Number(url.searchParams.get('offset')??0);
  if(offset&&options.laterError===table)return Response.json({message:'Synthetic later page denied'},{status:403});
  const requested=Number(url.searchParams.get('limit')??1000);const page=selected.slice(offset,offset+Math.min(requested,options.cap??1000));
  return Response.json(page,{headers:options.missingCount===table?{}:{'Content-Range':`${offset}-${Math.max(offset,offset+page.length-1)}/${selected.length+(offset&&options.drift===table?1:0)}`}});
 }}});
 const scope={db,familyId:FAMILY,userId:null,memberId:null,role:'system' as const,actorKind:'system' as const,tz:options.tz??'UTC',now:new Date(day+'T08:00:00Z')};
 return {calls,scope,execute:()=>commitmentConflicts(scope,TRIP)};
}
async function success(f:ReturnType<typeof setup>){const result=await f.execute();if(!result.ok)throw Error(JSON.stringify(result));expect(result.ok).toBe(true);return result.data;}

describe('complete trip commitment boundary through actual installed SDK',()=>{
 it.each([{title:'Flight unrelated'},{title:trip.title,all_day:true,starts_at:day+'T00:00:00Z',ends_at:'2026-10-09T00:00:00Z'}])('retains unrelated native title coincidence: %j',async patch=>{
  const row=native(1,patch);const data=await success(setup({calendar_events:[row]}));expect(data.calendar[0]).toMatchObject({id:row.id,reference:{kind:'native',eventId:row.id}});expect(data.total).toBe(1);expect(data.ownership).toBe('unverified-included');
 });
 it('keeps source provenance and UID4096 separate from native action identity',async()=>{
  const uid='x'.repeat(4096);const data=await success(setup({calendar_events:[native()]},{groups:[group(source(undefined,uid))]}));
  expect(data.counts).toMatchObject({review:2,native:1,source:1,occupied:2,annotation:0,calendarDomain:2});
  expect(data.source_calendar[0]).toMatchObject({readOnly:true,mutable:false,reference:{feedId:FEED,uid,revisionId:REVISION,original:{kind:'utc',value:'20261008T090000Z'}}});
  for(const field of ['id','assignee_id','member_id','category'])expect(data.source_calendar[0]).not.toHaveProperty(field);
 });
 it.each(['TRANSP:TRANSPARENT\r\nDURATION:PT1H','TRANSP:OPAQUE'])('keeps source annotations visible with zero occupancy: %s',async details=>{
  const data=await success(setup({}, {groups:[group(source([`DTSTART:20261008T090000Z\r\n${details}`]))]}));expect(data.counts).toMatchObject({review:1,occupied:0,annotation:1});
 });
 it('includes ongoing and missing native-end estimates plus legacy readonly rows',async()=>{
  const rows=[native(1,{starts_at:'2026-10-07T23:00:00Z',ends_at:day+'T01:00:00Z'}),native(2,{ends_at:null}),native(3,{feed_id:FEED})];
  const data=await success(setup({calendar_events:rows}));expect(data.calendar).toHaveLength(3);expect(data.calendar.find(r=>r.id===rows[1].id)?.estimatedEnd).toBe(true);expect(data.calendar.find(r=>r.id===rows[2].id)?.readOnly).toBe(true);
 });
 it.each([['2026-03-08',23,'2026-03-08T05:00:00.000Z','2026-03-09T03:59:59.999Z'],['2026-11-01',25,'2026-11-01T04:00:00.000Z','2026-11-02T04:59:59.999Z']] as const)('preserves civil DATE %s across DST (%i hours)',async(date,hours,from,to)=>{
  const end=new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString();
  const data=await success(setup({calendar_events:[native(1,{all_day:true,starts_at:date+'T00:00:00Z',ends_at:end})]}, {trip:{start_date:date,end_date:date,timezone:'America/New_York'},tz:'America/New_York'}));
  expect(data.window).toEqual({from,to,timezone:'America/New_York'});expect(data.calendar[0].startDate).toBe(date);const actualEnd=data.calendar[0].actualEndsAt;expect(actualEnd).not.toBeNull();if(actualEnd===null)throw Error('A DATE interval requires an exclusive end');expect(Date.parse(actualEnd)-Date.parse(data.calendar[0].actualStartsAt)).toBe(hours*3600000);
 });
 it('uses valid explicit trip zone while calendar attribution uses family clock',async()=>{
  const data=await success(setup({}, {tz:'America/Los_Angeles',trip:{timezone:'Asia/Tokyo'}}));expect(data.window).toEqual({from:'2026-10-07T15:00:00.000Z',to:'2026-10-08T14:59:59.999Z',timezone:'Asia/Tokyo'});
 });
 it.each([{start_date:'2026-02-30'},{end_date:'2026-10-07'},{timezone:'Invalid/Zone'},{timezone:''},{end_date:'2027-10-09'}])('refuses invalid trip clock before commitment transport %j',async patch=>{
  const f=setup({}, {trip:patch});expect(await f.execute()).toMatchObject({ok:false,code:'invalid_input'});expect(f.calls.some(u=>['calendar_events','school_events','bills'].some(t=>u.pathname.endsWith('/'+t)))).toBe(false);
 });
 it('refuses invalid family timezone even with a valid trip clock',async()=>{expect(await setup({}, {tz:'Invalid/Zone'}).execute()).toMatchObject({ok:false,code:'invalid_input'});});
 it('refuses noncanonical historic local-instant DATE rows without normalization',async()=>{expect(await setup({calendar_events:[native(1,{all_day:true,starts_at:day+'T04:00:00Z',ends_at:null})]}).execute()).toMatchObject({ok:false});});
 it('reads 201 school, homework, sports and 101 bills before presentation',async()=>{
  const data=await success(setup({school_events:Array.from({length:201},(_,i)=>school(i)),homework_assignments:Array.from({length:201},(_,i)=>homework(i)),sports_events:Array.from({length:201},(_,i)=>sports(i)),bills:Array.from({length:101},(_,i)=>bill(i))},{cap:2}));
  expect(data.counts).toMatchObject({school:201,homework:201,sports:201,bills:101,review:704});
 });
 it('reads the complete native calendar beyond200 under server cap2',async()=>{const f=setup({calendar_events:Array.from({length:201},(_,i)=>native(i+1))},{enabled:false,cap:2});const data=await success(f);expect(data.calendar).toHaveLength(201);expect(data.counts.calendarDomain).toBe(201);});
 it.each(['school_events','homework_assignments','sports_events'])('refuses unsupported overflow instead of a500 prefix: %s',async table=>{const make=table==='school_events'?school:table==='sports_events'?sports:homework;expect(await setup({[table]:Array.from({length:501},(_,i)=>make(i))}).execute()).toMatchObject({ok:false});});
 it('expands sports recurrence completely and keeps repeated original IDs',async()=>{const data=await success(setup({sports_events:[{...sports(1),starts_at:'2026-10-01T09:00:00Z',recurrence:'daily'}]},{trip:{end_date:'2026-10-10'}}));expect(data.sports).toHaveLength(3);expect(new Set(data.sports.map(r=>r.id)).size).toBe(1);});
 it.each(['bills','school_events','calendar_events'])('refuses missing counts and later-page failure: %s',async table=>{const make=table==='bills'?bill:table==='school_events'?school:native;const seed={[table]:Array.from({length:3},(_,i)=>make(i+1))};for(const options of [{missingCount:table},{laterError:table,cap:2},{drift:table,cap:2}])expect(await setup(seed,{...options,enabled:false}).execute()).toMatchObject({ok:false});});
 it.each(['bills','school_events','homework_assignments','sports_events'])('qualifies row201 even beyond presentation: %s',async table=>{const make=table==='bills'?bill:table==='school_events'?school:table==='sports_events'?sports:homework;const rows=Array.from({length:201},(_,i)=>make(i));rows[200].family_id='wrong-family';expect(await setup({[table]:rows},{ignoreFilters:table}).execute()).toMatchObject({ok:false});});
 it('qualifies malformed native row201 before any display cap',async()=>{const rows=Array.from({length:201},(_,i)=>native(i+1));rows[200].idempotency_key=undefined as unknown as null;expect(await setup({calendar_events:rows}).execute()).toMatchObject({ok:false});});
 it('preserves distinct native occurrence keys sharing original recurring ID',async()=>{const data=await success(setup({calendar_events:[native(1,{starts_at:'2026-10-01T09:00:00Z',ends_at:'2026-10-01T10:00:00Z',recurrence:'daily'})]},{trip:{end_date:'2026-10-10'}}));expect(data.calendar).toHaveLength(3);expect(new Set(data.calendar.map(r=>r.id)).size).toBe(1);expect(new Set(data.calendar.map(r=>r.occurrenceKey)).size).toBe(3);});
 it('accepts exactly500 school/homework/sports rows with complete exact counts',async()=>{
  const data=await success(setup({school_events:Array.from({length:500},(_,i)=>school(i)),homework_assignments:Array.from({length:500},(_,i)=>homework(i)),sports_events:Array.from({length:500},(_,i)=>sports(i))}));expect(data.counts).toMatchObject({school:500,homework:500,sports:500,review:1500});
 });
 it('refuses expanded501 sports occurrences before presentation',async()=>{
  const masters=Array.from({length:167},(_,i)=>({...sports(i),starts_at:'2026-10-01T09:00:00Z',recurrence:'daily'}));expect(await setup({sports_events:masters},{trip:{end_date:'2026-10-10'}}).execute()).toMatchObject({ok:false});
 });
 it('refuses out-of-window sports singles even when transport returns them',async()=>{expect(await setup({sports_events:[{...sports(1),starts_at:'2026-10-07T09:00:00Z'}]},{ignoreFilters:'sports_events'}).execute()).toMatchObject({ok:false});});
 it('refuses sports master cutoff before its original start',async()=>{expect(await setup({sports_events:[{...sports(1),recurrence:'daily',recurrence_until:'2026-10-07T12:00:00Z'}]},{ignoreFilters:'sports_events'}).execute()).toMatchObject({ok:false});});
 it('refuses original sports IDs repeated between singles and masters',async()=>{expect(await setup({sports_events:[sports(1),{...sports(1),recurrence:'daily'}]}).execute()).toMatchObject({ok:false});});
 it('includes moved source recurrence while respecting cancelled instances',async()=>{
  const document=source(['DTSTART:20261007T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=4','RECURRENCE-ID:20261008T090000Z\r\nDTSTART:20261008T120000Z\r\nDURATION:PT1H','RECURRENCE-ID:20261009T090000Z\r\nDTSTART:20261009T090000Z\r\nSTATUS:CANCELLED']);
  const data=await success(setup({}, {groups:[group(document)],trip:{end_date:'2026-10-10'}}));expect(data.source_calendar).toHaveLength(2);expect(data.source_calendar.map(r=>r.actualStartsAt)).toEqual(['2026-10-08T12:00:00.000Z','2026-10-10T09:00:00.000Z']);expect(data.source_calendar[0].reference.original).toEqual({kind:'utc',value:'20261008T090000Z'});
 });

});
