import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { orPredicate } from './helpers/in-memory-supabase';
import type { Database, Tables } from '@/lib/database.types';
import type { ImportedSourceComponent, ImportedSourceOverride } from '@/lib/calendar/imported-source';
import { parseICSSource } from '@/lib/sync/ics-source';
import { readCalendarAvailability } from '@/lib/calendar/availability';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';

const capability = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return capability.enabled; } }));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=> (key:string)=>key}));
vi.mock('@/lib/services/documents',()=>({listDocuments:async()=>({ok:true,data:[]})}));
vi.mock('@/lib/services/family',()=>({getMembers:async()=>({ok:true,data:[]}),getPreferences:async()=>({ok:true,data:{familyId:'F',familyName:'Synthetic',timezone:'UTC'}})}));
vi.mock('@/lib/services/finances',()=>({listTransactions:async()=>({ok:true,data:{transactions:[]}})}));
vi.mock('@/lib/services/groceries',()=>({listOpen:async()=>({ok:true,data:{items:[]}})}));
vi.mock('@/lib/services/memory',()=>({listMemories:async()=>({ok:true,data:{facts:[]}})}));
vi.mock('@/lib/services/routines',()=>({listAllRoutines:async()=>({ok:true,data:[]})}));
vi.mock('@/lib/services/school',()=>({listClassRoster:async()=>({ok:true,data:[]}),listEventsBetween:async()=>({ok:true,data:[]})}));
vi.mock('@/lib/services/sports',()=>({listPracticesBetween:async()=>({ok:true,data:[]}),listTeams:async()=>({ok:true,data:[]})}));
vi.mock('@/lib/services/tasks',()=>({searchTodos:async()=>({ok:true,data:[]})}));
vi.mock('@/lib/services/trips',()=>({listTrips:async()=>({ok:true,data:[]})}));
import {findFreeSlots,busyEvenings} from '@/lib/services/calendar';
import {buildAssistantTools} from '@/lib/assistant/tools';
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
type BusyRow={id:string;family_id:string;starts_at:string;ends_at:string|null;member_id:string|null;recurrence:string;recurrence_until:string|null};
const secondary=(id:string,patch:Partial<BusyRow>={}):BusyRow=>({id,family_id:FAMILY,starts_at:`${day}T18:00:00Z`,ends_at:`${day}T19:00:00Z`,member_id:null,recurrence:'none',recurrence_until:null,...patch});
function sdk({rows=[],value=snapshot([],[]),cap=2,school=[],sports=[],failTable,missingCountTable,lateFailureTable}: {
  rows?:ReturnType<typeof native>[];value?:unknown;cap?:number;school?:BusyRow[];sports?:BusyRow[];failTable?:string;missingCountTable?:string;lateFailureTable?:string;
}={}){
  const calls:{url:URL;body:unknown}[]=[];
  const db=createClient<Database>('https://availability-sdk.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
    const url=new URL(String(input));calls.push({url,body:init?.body?JSON.parse(String(init.body)):null});expect(url.origin).toBe('https://availability-sdk.invalid');
    if(url.pathname.includes('/rpc/')){expect(url.pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs');expect(JSON.parse(String(init?.body))).toEqual({p_family_id:FAMILY});return Response.json(value);}
    const table=url.pathname.split('/').at(-1)!;expect(['calendar_events','school_events','sports_events']).toContain(table);expect(url.searchParams.get('family_id')).toBe(`eq.${FAMILY}`);expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');expect(url.searchParams.get('order')).toBe('starts_at.asc,id.asc');
    const offset=Number(url.searchParams.get('offset')??0);
    if(table===failTable||table===lateFailureTable&&offset>0)return Response.json({code:'42501',message:'Synthetic denied page'},{status:403});
    const inputRows=(table==='calendar_events'?rows:table==='school_events'?school:sports) as unknown as Record<string,unknown>[];
    const matched=inputRows.filter(row=>[...url.searchParams].every(([key,value])=>{
      if(['select','order','offset','limit'].includes(key))return true;
      if(key==='or')return orPredicate(value.slice(1,-1))(row);
      const field=row[key];if(value.startsWith('eq.'))return field===value.slice(3);if(value.startsWith('neq.'))return field!=null&&field!==value.slice(4);
      if(value.startsWith('lt.'))return String(field)<value.slice(3);if(value.startsWith('lte.'))return String(field)<=value.slice(4);if(value.startsWith('gte.'))return String(field)>=value.slice(4);
      throw new Error(`Unsupported synthetic SDK predicate ${key}=${value}`);
    })).sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at))||String(a.id).localeCompare(String(b.id)));
    const page=matched.slice(offset,offset+Math.min(cap,Number(url.searchParams.get('limit')??cap)));
    return Response.json(page,{headers:table===missingCountTable?{}:{'content-range':`${offset}-${offset+page.length-1}/${matched.length}`}});
  }}});return{db,calls};
}
beforeEach(() => { capability.enabled = false; });
afterEach(() => vi.restoreAllMocks());


const clock={from:'2026-10-08T17:00:00Z',to:'2026-10-08T20:00:00Z'};
function scope(db:ReturnType<typeof sdk>['db'],tz='UTC'){return{db,familyId:FAMILY,userId:MEMBER,memberId:MEMBER,role:'parent' as const,actorKind:'member' as const,tz,now:new Date('2026-10-01T00:00:00Z')};}
async function assistant(probe:ReturnType<typeof sdk>,date=day,tz:string|undefined='UTC',assignee?:string){
  const tool=buildAssistantTools(probe.db,{familyId:FAMILY,userId:MEMBER,memberId:MEMBER,members:[{id:MEMBER,display_name:'Selected member'}],tz}).find(t=>t.name==='find_free_time')!;
  return await tool.execute({date,...(assignee?{assignee}:{})}) as {ok:boolean;busy?:{title:string;starts_at:string;ends_at:string;all_day:boolean}[];note?:string};
}
describe('actual SDK qualified availability across three entrypoints',()=>{
  it.each(['opaque','transparent'] as const)('uses source %s occupancy consistently without native fallback',async transparency=>{
    capability.enabled=true;const probe=sdk({value:snapshot([group(source([`DTSTART:20261008T180000Z\r\nDURATION:PT1H\r\nTRANSP:${transparency.toUpperCase()}\r\nSUMMARY:Source commitment`]))],[])});
    const slots=await findFreeSlots(scope(probe.db),{...clock,durationMin:60,granularityMin:60,limit:10,memberIds:[MEMBER]});
    expect(slots.ok).toBe(true);if(slots.ok)expect(slots.data.map(slot=>slot.startsAt)).toEqual(transparency==='opaque'?['2026-10-08T17:00:00.000Z','2026-10-08T19:00:00.000Z']:['2026-10-08T17:00:00.000Z','2026-10-08T18:00:00.000Z','2026-10-08T19:00:00.000Z']);
    expect(await busyEvenings(scope(probe.db),clock)).toMatchObject({ok:true,data:transparency==='opaque'?[day]:[]});
    const result=await assistant(probe,day,'UTC','Selected member');expect(result.ok).toBe(true);expect(result.busy).toHaveLength(transparency==='opaque'?1:0);if(transparency==='opaque')expect(result.busy?.[0]).toMatchObject({title:'Source commitment',starts_at:'2026-10-08T18:00:00.000Z',ends_at:'2026-10-08T19:00:00.000Z'});
    expect(probe.calls.filter(call=>call.url.pathname.includes('/rpc/'))).toHaveLength(3);expect(probe.calls.some(call=>call.url.pathname.endsWith('/calendar_events'))).toBe(false);
    if(transparency==='transparent'){expect(result.note).toBe('No busy blocks that day — the whole day is free.');const visible=await readCalendarAvailability(probe.db,FAMILY,briefingCalendarBounds(day,'UTC',0,1),'UTC');expect(visible.count).toBe(1);expect(visible.data?.[0]).toMatchObject({kind:'source',transparency:'transparent',occupied:false,readOnly:true,title:'Source commitment'});}
  });
});


describe('availability complete domain, attribution and clock controls',()=>{
  it.each([false,true])('honors native assignment and family attribution with source capability=%s',async enabled=>{
    capability.enabled=enabled;const rows=[native(1,{title:'Other member',assignee_id:'50000000-0000-4000-8000-000000000002',starts_at:`${day}T17:00:00Z`,ends_at:`${day}T18:00:00Z`}),native(2,{title:'Family',starts_at:`${day}T18:00:00Z`,ends_at:`${day}T19:00:00Z`}),native(3,{title:'Selected member',assignee_id:MEMBER,starts_at:`${day}T19:00:00Z`,ends_at:`${day}T20:00:00Z`})];
    const probe=sdk({rows,value:snapshot([],rows)});const result=await assistant(probe,day,'UTC','Selected member');expect(result.ok).toBe(true);expect(result.busy?.map(row=>row.title)).toEqual(['Family','Selected member']);
    const slots=await findFreeSlots(scope(probe.db),{...clock,durationMin:60,granularityMin:60,memberIds:[MEMBER]});expect(slots).toMatchObject({ok:true,data:[{startsAt:`${day}T17:00:00.000Z`,endsAt:`${day}T18:00:00.000Z`}]});
    if(!enabled)expect(probe.calls.some(call=>call.url.searchParams.get('offset')==='2')).toBe(true);
  });
  it('does not infer source attendees as member assignments',async()=>{
    capability.enabled=true;const probe=sdk({value:snapshot([group(source(['DTSTART:20261008T180000Z\r\nDURATION:PT1H\r\nATTENDEE:mailto:unselected@example.invalid']))],[])});
    expect((await assistant(probe,day,'UTC','Selected member')).busy).toHaveLength(1);expect(await findFreeSlots(scope(probe.db),{...clock,durationMin:60,granularityMin:60,memberIds:[MEMBER]})).toMatchObject({ok:true,data:[{startsAt:`${day}T17:00:00.000Z`},{startsAt:`${day}T19:00:00.000Z`}]});
  });
  it.each([false,true])('preserves explicit points and native missing-end estimates with source capability=%s',async enabled=>{
    capability.enabled=enabled;const rows=[native(1,{title:'Native point',starts_at:`${day}T17:00:00Z`,ends_at:`${day}T17:00:00Z`}),native(2,{title:'Estimated hour',starts_at:`${day}T18:00:00Z`,ends_at:null})];
    const probe=sdk({rows,value:snapshot([group(source(['DTSTART:20261008T190000Z\r\nSUMMARY:Source point']))],rows)});const result=await assistant(probe);expect(result.ok).toBe(true);expect(result.busy).toMatchObject([{title:'Estimated hour',starts_at:`${day}T18:00:00.000Z`,ends_at:`${day}T19:00:00.000Z`}]);expect(result.busy).toHaveLength(1);
    expect(await busyEvenings(scope(probe.db),clock)).toMatchObject({ok:true,data:[day]});
  });
  it.each([['2026-03-08','20260308','2026-03-08T08:00:00Z','2026-03-09T07:00:00Z'],['2026-11-01','20261101','2026-11-01T07:00:00Z','2026-11-02T08:00:00Z']] as const)('keeps source DATE on its actual household DST day %s',async(date,ics,from,to)=>{
    capability.enabled=true;const probe=sdk({value:snapshot([group(source([`DTSTART;VALUE=DATE:${ics}\r\nDURATION:P1D`]))],[])});
    const result=await assistant(probe,date,'America/Los_Angeles');expect(result.ok).toBe(true);expect(result.busy).toMatchObject([{all_day:true,starts_at:date}]);expect(result.busy?.[0].ends_at).toBe(to.slice(0,10));
    expect(await findFreeSlots(scope(probe.db,'America/Los_Angeles'),{from,to,durationMin:30})).toMatchObject({ok:true,data:[]});expect(await busyEvenings(scope(probe.db,'America/Los_Angeles'),{from,to})).toMatchObject({ok:true,data:[date]});
  });
  it('uses exact moved and cancelled source instances while keeping separate feed identities',async()=>{
    capability.enabled=true;const document=source(['DTSTART:20261001T180000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=3','RECURRENCE-ID:20261008T180000Z\r\nDTSTART:20261008T190000Z\r\nDURATION:PT30M']);const probe=sdk({value:snapshot([group(document),group(document,'20000000-0000-4000-8000-000000000002')],[])});
    const result=await assistant(probe);expect(result.ok).toBe(true);expect(result.busy).toHaveLength(2);expect(result.busy?.map(row=>row.starts_at)).toEqual([`${day}T19:00:00.000Z`,`${day}T19:00:00.000Z`]);
    const cancelled=source(['DTSTART:20261001T180000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=WEEKLY;COUNT=3','RECURRENCE-ID:20261008T180000Z\r\nSTATUS:CANCELLED']);const empty=sdk({value:snapshot([group(cancelled)],[])});expect((await assistant(empty)).busy).toEqual([]);expect(await busyEvenings(scope(empty.db),clock)).toMatchObject({ok:true,data:[]});
  });
  it.each(['school_events','sports_events'])('refuses later %s denial with no partial busy/free result',async table=>{
    capability.enabled=true;const busy=Array.from({length:3},(_,index)=>secondary('secondary-'+index));const probe=sdk({school:busy,sports:busy,lateFailureTable:table});
    const result=await assistant(probe);expect(result.ok).toBe(false);expect(result.busy).toBeUndefined();expect(result.note).toBeUndefined();expect(await findFreeSlots(scope(probe.db),{...clock,durationMin:30})).toMatchObject({ok:false});if(table==='sports_events')expect(await busyEvenings(scope(probe.db),clock)).toMatchObject({ok:false});
    expect(probe.calls.some(call=>call.url.pathname.endsWith('/'+table)&&call.url.searchParams.get('offset')==='2')).toBe(true);
  });
  it.each(['school_events','sports_events'])('refuses missing exact %s count rather than a free-day note',async table=>{
    capability.enabled=true;const probe=sdk({missingCountTable:table});const result=await assistant(probe);expect(result.ok).toBe(false);expect(result.note).toBeUndefined();expect(result.busy).toBeUndefined();expect(await findFreeSlots(scope(probe.db),{...clock,durationMin:30})).toMatchObject({ok:false});if(table==='sports_events')expect(await busyEvenings(scope(probe.db),clock)).toMatchObject({ok:false});
  });
  it.each(['foreign-family','count-mismatch','held','invalid-transparency'])('refuses source snapshot %s without quiet availability',async mode=>{
    capability.enabled=true;const value=snapshot([group(source([`DTSTART:20261008T180000Z\r\nDURATION:PT1H${mode==='invalid-transparency'?'\r\nTRANSP:UNKNOWN':''}`]))],[]);
    if(mode==='foreign-family')value.familyId='10000000-0000-4000-8000-000000000002';if(mode==='count-mismatch')value.sourceCount=2;if(mode==='held')value.sourceGroups[0].materializationState='held';
    const probe=sdk({value});const result=await assistant(probe);expect(result.ok).toBe(false);expect(result.busy).toBeUndefined();expect(result.note).toBeUndefined();expect(await findFreeSlots(scope(probe.db),{...clock,durationMin:30})).toMatchObject({ok:false});expect(await busyEvenings(scope(probe.db),clock)).toMatchObject({ok:false});expect(probe.calls.some(call=>call.url.pathname.endsWith('/calendar_events'))).toBe(false);
  });
  it.each([undefined,'','Mars/Olympus'])('refuses explicit invalid zone %s before any transport',async tz=>{
    const probe=sdk();const tool=buildAssistantTools(probe.db,{familyId:FAMILY,userId:MEMBER,memberId:MEMBER,members:[],tz}).find(t=>t.name==='find_free_time')!;expect(await tool.execute({date:day})).toMatchObject({ok:false});
    const badScope={...scope(probe.db),tz} as unknown as Parameters<typeof findFreeSlots>[0];expect(await findFreeSlots(badScope,{...clock,durationMin:30})).toMatchObject({ok:false});expect(await busyEvenings(badScope,clock)).toMatchObject({ok:false});expect(probe.calls).toEqual([]);
  });
});


describe('counted native and secondary completeness integration',()=>{
  it('refuses a later native calendar page failure in all three entrypoints',async()=>{
    const rows=Array.from({length:3},(_,i)=>native(i+1,{starts_at:`${day}T18:00:00Z`,ends_at:`${day}T19:00:00Z`}));const probe=sdk({rows,lateFailureTable:'calendar_events'});
    const result=await assistant(probe);expect(result.ok).toBe(false);expect(result.busy).toBeUndefined();expect(result.note).toBeUndefined();expect(await findFreeSlots(scope(probe.db),{...clock,durationMin:30})).toMatchObject({ok:false});expect(await busyEvenings(scope(probe.db),clock)).toMatchObject({ok:false});expect(probe.calls.filter(call=>call.url.pathname.endsWith('/calendar_events')&&call.url.searchParams.get('offset')==='2')).toHaveLength(3);
  });
  it('keeps late capped native and school/sports commitments but excludes actual foreign scope and out-of-window rows',async()=>{
    const rows=[native(1,{starts_at:`${day}T17:00:00Z`,ends_at:`${day}T18:00:00Z`}),native(2,{starts_at:`${day}T18:00:00Z`,ends_at:`${day}T19:00:00Z`}),native(3,{title:'Late native',starts_at:`${day}T19:00:00Z`,ends_at:`${day}T20:00:00Z`}),native(4,{family_id:'10000000-0000-4000-8000-000000000002'}),native(5,{starts_at:'2026-09-01T18:00:00Z',ends_at:'2026-09-01T19:00:00Z'})];
    const secondaryRows=[secondary('first'),secondary('second'),secondary('late'),secondary('foreign',{family_id:'10000000-0000-4000-8000-000000000002'}),secondary('outside',{starts_at:'2026-09-01T18:00:00Z',ends_at:'2026-09-01T19:00:00Z'})];
    const probe=sdk({rows,school:secondaryRows,sports:secondaryRows});const result=await assistant(probe);expect(result.ok).toBe(true);expect(result.busy).toHaveLength(9);expect(result.busy?.some(row=>row.title==='Late native')).toBe(true);expect(result.note).not.toContain('whole day is free');
    expect(await findFreeSlots(scope(probe.db),{...clock,durationMin:30})).toMatchObject({ok:true,data:[]});expect(await busyEvenings(scope(probe.db),clock)).toMatchObject({ok:true,data:[day]});
    for(const table of ['calendar_events','school_events','sports_events'])expect(probe.calls.some(call=>call.url.pathname.endsWith('/'+table)&&call.url.searchParams.get('offset')==='2')).toBe(true);
  });
});
