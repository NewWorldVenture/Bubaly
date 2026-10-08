import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const nativeRequire=createRequire(import.meta.url);
const sourceRoot=process.env.BUBALY_CALENDAR_ASSIGNEE_SOURCE_ROOT??process.cwd();
const sourcePaths={calendar:'lib/services/calendar/index.ts',idempotency:'lib/services/idempotency.ts',types:'lib/services/types.ts',errors:'lib/supabase/errors.ts',eventDates:'lib/calendar/event-dates.ts',calendarWindow:'lib/briefing/calendar-window.ts',occurrences:'lib/calendar/occurrences.ts',recurrence:'lib/calendar/recurrence.ts',zoned:'lib/time/zoned.ts', calendarDay: 'lib/calendar/day.ts', sourceCapability: 'lib/calendar/source-capability.ts', exactInstant: 'lib/calendar/exact-instant.ts', icsTime: 'lib/onboarding/ics-time.ts'};
const sources=Object.fromEntries(Object.entries(sourcePaths).filter(([name]) => !['sourceCapability', 'exactInstant', 'icsTime'].includes(name)).map(([name,file])=>[name,ts.transpileModule(fs.readFileSync(path.join(sourceRoot,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText]));
// Historical source roots may predate this import. Read the exact real module
// only when their occurrences reader requests it; a missing requested file
// remains a hard ENOENT failure, never a fabricated or disabled capability.
function sourceFor(name: string): string {
  if (name === 'sourceCapability' || name === 'exactInstant' || name === 'icsTime') return ts.transpileModule(fs.readFileSync(path.join(sourceRoot, sourcePaths[name]), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  if (!Object.hasOwn(sources, name)) throw new Error('Unknown finite source ' + name);
  return sources[name];
}

const A='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',B='bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const ownA='aaaaaaaa-aaaa-4aaa-8aaa-000000000002',ownB='bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const eventId='cccccccc-cccc-4ccc-8ccc-000000000001',userId='dddddddd-dddd-4ddd-8ddd-000000000001';
const traces:any[]=[];let trace:any;
beforeEach(()=>{trace={name:expect.getState().currentTestName,requests:[],forbidden:[],transportErrors:[],settled:0,activity:[],logs:[]};for(const method of ['error','warn'] as const)vi.spyOn(console,method).mockImplementation((...args)=>trace.logs.push({method,args}));});
afterEach(()=>{traces.push(trace);expect(trace.forbidden).toEqual([]);expect(trace.transportErrors).toEqual([]);expect(trace.requests.length).toBeLessThanOrEqual(4);expect(trace.settled).toBe(trace.requests.length);expect(trace.requests.every((r:any)=>['family_members','calendar_events'].includes(r.table)&&['GET','POST'].includes(r.method))).toBe(true);for(const request of trace.requests.filter((r:any)=>r.table==='family_members')){expect(request.method).toBe('GET');expect(request.query).toEqual({select:'id,family_id',family_id:'eq.'+trace.memberWire.family,id:'eq.'+trace.memberWire.assignee});}expect(trace.logs.every((l:any)=>String(l.args[0]).startsWith('[service:calendar] create failed')||String(l.args[0]).startsWith('[service:idempotency] a retried calendar.createEvent'))).toBe(true);vi.restoreAllMocks();});
afterAll(()=>{if(process.env.BUBALY_CALENDAR_ASSIGNEE_TRACE)fs.writeFileSync(process.env.BUBALY_CALENDAR_ASSIGNEE_TRACE,JSON.stringify(traces,null,2)+'\n',{flag:'wx'});});
type Options={family?:string;assignee?:string|null;omitAssignee?:boolean;key?:string;existing?:boolean;rejectChanged?:boolean;writeDenied?:boolean;memberBody?:unknown;memberDenied?:boolean;memberUndefined?:boolean;memberDataError?:boolean};
function fixture(options:Options={}){
 const family=options.family??A,own=family.toLowerCase()===A?ownA:ownB;
 const assignee=options.omitAssignee?undefined:options.assignee;
 const input:any={title:'Neutral calendar event',startsAt:'2026-01-02T10:00:00Z',endsAt:'2026-01-02T11:00:00Z',location:' Neutral room ',description:' Neutral description ',allDay:false,category:'general',recurrence:'none',recurrenceUntil:null,...(options.omitAssignee?{}:{assigneeId:assignee})};
 const saved={id:eventId,family_id:family,title:'Neutral calendar event',starts_at:'2026-01-02T10:00:00.000Z',ends_at:'2026-01-02T11:00:00.000Z',location:'Neutral room',description:'Neutral description',all_day:false,category:'general',recurrence:'none',recurrence_until:null,assignee_id:options.existing?own:assignee??null,created_by:userId,idempotency_key:options.key??null};
 const deny=(reason:string):never=>{trace.forbidden.push(reason);throw new Error(reason);};
 const transport:typeof fetch=async(resource,init)=>{try{
   const url=new URL(String(resource)),method=init?.method??'GET',table=url.pathname.split('/').at(-1)!;
   if(url.origin!=='https://calendar-assignee.invalid'||!['family_members','calendar_events'].includes(table)||!['GET','POST'].includes(method)||trace.requests.length>=4)deny('Outside finite Calendar proof');
   const query=Object.fromEntries(url.searchParams),payload=init?.body?JSON.parse(String(init.body)):undefined;
   trace.requests.push({method,table,query,payload});
   if(table==='family_members'){
     if(method!=='GET'||query.family_id!=='eq.'+family||query.id!=='eq.'+assignee)deny('Member lookup lacks exact server family and requested member');
     // Existing foreign members remain valid single-column FK references, but are not members of this scoped family.
     trace.memberWire={query,family,assignee};
     const members=Object.hasOwn(options,'memberBody')?options.memberBody:assignee?.toLowerCase()===own?[{id:own,family_id:family.toLowerCase()}]:[];
     return new Response(JSON.stringify(options.memberDenied?{code:'42501',message:'Synthetic member lookup denied'}:members),{status:options.memberDenied?403:200,headers:{'content-type':'application/json'}});
   }
   if(method==='GET'){
     if(!options.key||query.family_id!=='eq.'+family||query.idempotency_key!=='eq.'+options.key||query.limit!=='1')deny('Unexpected keyed event probe');
     return new Response(JSON.stringify(options.existing?[saved]:[]),{status:200,headers:{'content-type':'application/json'}});
   }
   if(payload.family_id!==family||payload.created_by!==userId||payload.assignee_id!==(assignee??null))deny('Insert did not preserve caller scope and composition');
   return new Response(JSON.stringify(options.writeDenied?{code:'42501',message:'Synthetic event write refused'}:{...saved,...payload,family_id:payload.family_id.toLowerCase(),assignee_id:payload.assignee_id?.toLowerCase()??null}),{status:options.writeDenied?403:201,headers:{'content-type':'application/json'}});
 }catch(e){trace.transportErrors.push(String(e));throw e;}finally{trace.settled++;}};
 const sdk=createClient('https://calendar-assignee.invalid','synthetic-key',{accessToken:async()=>null,auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:transport}});
 let db:any=sdk;
 if(options.memberUndefined||options.memberDataError){db={from:(table:string)=>{if(table!=='family_members')return sdk.from(table);let current:any=sdk.from(table);const proxy:any=new Proxy({},{get(_target,key){if(key==='then')return(resolve:any,reject:any)=>current.then((reply:any)=>{trace.adapter=options.memberDataError?'Actual healthy member receipt → explicit data+error precedence adapter':'Actual null member receipt → typed legacy undefined data';resolve(options.memberDataError?{...reply,error:{code:'42501',message:'Synthetic member lookup denied with data'}}:{...reply,data:undefined});},reject);const value=Reflect.get(current,key,current);return typeof value==='function'?(...args:any[])=>{const result=value.apply(current,args);if(result&&typeof result==='object')current=result;return proxy;}:value;}});return proxy;}};}
 const scope:any={db,familyId:family,userId,memberId:own,role:'parent',actorKind:'member',tz:'UTC',now:new Date('2026-01-01T00:00:00Z'),idempotencyKey:options.key};
 const loaded:any={};
 const unused=(name:string)=>new Proxy({},{get:()=>()=>deny('Unused seam '+name)});
 function load(name:string):any{if(loaded[name])return loaded[name];const entry={exports:{}};loaded[name]=entry.exports;const require=(id:string):any=>{
   if (id === './exact-instant' || id === '../calendar/exact-instant' || id === '@/lib/calendar/exact-instant') return load('exactInstant');
    if (id === '../onboarding/ics-time' || id === '@/lib/onboarding/ics-time') return load('icsTime');
    const dependency:Record<string,string>={'@/lib/calendar/event-dates':'eventDates','@/lib/briefing/calendar-window':'calendarWindow','@/lib/calendar/occurrences':'occurrences','@/lib/calendar/recurrence':'recurrence','@/lib/time/zoned':'zoned','../time/zoned':'zoned', '@/lib/calendar/day': 'calendarDay', './source-capability': 'sourceCapability'};if(dependency[id])return load(dependency[id]);
   if (id === '@/lib/calendar/availability') return { readCalendarAvailability: () => deny('Unused mutation read seam readCalendarAvailability') };
   if (id === '@/lib/calendar/conflict-advisories') return {
     buildConflictAdvisories: () => deny('Unused mutation read seam buildConflictAdvisories'),
     conflictSubject: () => deny('Unused mutation read seam conflictSubject'),
   };
if (id === '@/lib/calendar/source-capability') return { CALENDAR_SOURCE_ARCHIVE_ENABLED: false };
    if (id === '@/lib/calendar/display-spans') return { calendarDisplayDay: () => deny('Unused read seam calendarDisplayDay') };
    if(id==='server-only')return{};if(id==='node:crypto')return nativeRequire(id);
   if(id==='../types'||id==='./types')return load('types');if(id==='../idempotency')return load('idempotency');if(id==='@/lib/supabase/errors')return load('errors');
   if(id==='../activity')return{recordActivitySafely:async(_scope:any,descriptor:any)=>trace.activity.push(descriptor)};
   if(id==='@/lib/i18n/server')return{getTranslations:async()=>()=> 'An earlier try already saved this event.'};
   if(['@/lib/home/conflicts','@/lib/calendar/scheduling','@/lib/supabase/settle','../scope','@/lib/supabase/escape-like'].includes(id))return unused(id);
   return deny('Forbidden import '+id);
 };new Function('require','module','exports',sourceFor(name))(require,entry,entry.exports);loaded[name]=entry.exports;return entry.exports;}
 return{run:()=>load('calendar').createEvent(scope,input,{rejectChangedRetry:options.rejectChanged??false}),saved};
}
const posts=()=>trace.requests.filter((r:any)=>r.method==='POST');
describe('original scoped Calendar assignee admission',()=>{
 it('refuses an existing family-B assignee before a new family-A event write',async()=>{const f=fixture({assignee:ownB});expect(await f.run()).toMatchObject({ok:false});expect(posts()).toEqual([]);expect(trace.activity).toEqual([]);});
 it('refuses an existing family-A assignee before a new family-B event write',async()=>{const f=fixture({family:B,assignee:ownA});expect(await f.run()).toMatchObject({ok:false});expect(posts()).toEqual([]);expect(trace.activity).toEqual([]);});
 it('preserves a same-family assignee and normalized composition',async()=>{const f=fixture({assignee:ownA});expect(await f.run()).toEqual({ok:true,data:f.saved});expect(posts()).toHaveLength(1);expect(trace.activity).toHaveLength(1);expect(posts()[0].payload).toMatchObject({family_id:A,assignee_id:ownA,title:'Neutral calendar event',location:'Neutral room',description:'Neutral description',created_by:userId});});
 it('preserves an explicit null unassigned event without member lookup',async()=>{const f=fixture({assignee:null});expect(await f.run()).toEqual({ok:true,data:f.saved});expect(trace.requests.filter((r:any)=>r.table==='family_members')).toEqual([]);expect(posts()).toHaveLength(1);});
 it('preserves an omitted assignee as null without member lookup',async()=>{const f=fixture({omitAssignee:true});expect(await f.run()).toEqual({ok:true,data:f.saved});expect(trace.requests.filter((r:any)=>r.table==='family_members')).toEqual([]);expect(posts()[0].payload.assignee_id).toBeNull();});
 it('preserves a settled keyed retry without revalidating or writing its changed assignee',async()=>{const f=fixture({assignee:ownB,key:'synthetic-settled-key',existing:true});expect(await f.run()).toEqual({ok:true,data:f.saved});expect(trace.requests).toHaveLength(1);expect(posts()).toEqual([]);expect(trace.activity).toEqual([]);});
 it('preserves changed-retry refusal before new member validation',async()=>{const f=fixture({assignee:ownB,key:'synthetic-changed-key',existing:true,rejectChanged:true});expect(await f.run()).toMatchObject({ok:false,code:'already_saved'});expect(trace.requests).toHaveLength(1);expect(posts()).toEqual([]);expect(trace.activity).toEqual([]);});
 it('preserves an absent-key probe then a same-family new event write',async()=>{const f=fixture({assignee:ownA,key:'synthetic-new-key'});expect(await f.run()).toEqual({ok:true,data:f.saved});expect(trace.requests[0]).toMatchObject({method:'GET',table:'calendar_events'});expect(posts()).toHaveLength(1);expect(trace.activity).toHaveLength(1);});
 it('preserves actual SDK event-write denial without activity or saved success',async()=>{const f=fixture({assignee:ownA,writeDenied:true});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(posts()).toHaveLength(1);expect(trace.activity).toEqual([]);});
});

describe('new-event member lookup receipt controls',()=>{
 async function refused(options:Options){const f=fixture({assignee:ownA,...options});const result=await f.run();expect(result).toMatchObject({ok:false});expect(posts()).toEqual([]);expect(trace.activity).toEqual([]);return result;}
 it('refuses actual SDK member lookup403 before a new event POST',async()=>{expect(await refused({memberDenied:true})).toMatchObject({code:'db'});});
 it('refuses a successful empty member lookup before POST',async()=>{await refused({memberBody:[]});});
 it('refuses a successful null member lookup before POST',async()=>{await refused({memberBody:null});});
 for(const [label,body] of [
  ['plain object',{}],['string','neutral member receipt'],['number',7],['boolean',true],
  ['missing member id',{family_id:A}],['missing family id',{id:ownA}],
  ['numeric member id',{id:7,family_id:A}],['numeric family id',{id:ownA,family_id:7}],
  ['boolean member id',{id:false,family_id:A}],['boolean family id',{id:ownA,family_id:false}],
 ] as const){it('refuses a successful malformed member receipt '+label+' before POST',async()=>{await refused({memberBody:body});});}
 it('refuses a returned different member even when the receipt family is right',async()=>{await refused({memberBody:[{id:ownB,family_id:A}]});});
 it('refuses a returned wrong family even when the receipt member is right',async()=>{await refused({memberBody:[{id:ownA,family_id:B}]});});
 it('preserves actual SDK multiple-row lookup refusal before POST',async()=>{expect(await refused({memberBody:[{id:ownA,family_id:A},{id:ownA,family_id:A}]})).toMatchObject({code:'db'});});
 it('refuses explicitly adapted legacy undefined member receipt before POST',async()=>{await refused({memberBody:null,memberUndefined:true});expect(trace.adapter).toBe('Actual null member receipt → typed legacy undefined data');});
 it('preserves explicit member data+error adapter error precedence before POST',async()=>{expect(await refused({memberDataError:true})).toMatchObject({code:'db'});expect(trace.adapter).toBe('Actual healthy member receipt → explicit data+error precedence adapter');});
 it('admits an uppercase requested UUID through a normalized same-member receipt',async()=>{const f=fixture({assignee:ownA.toUpperCase()});const result=await f.run();expect(result).toMatchObject({ok:true,data:{family_id:A,assignee_id:ownA}});expect(posts()).toHaveLength(1);expect(posts()[0].payload.assignee_id).toBe(ownA.toUpperCase());});
 it('admits an uppercase server family UUID through a normalized same-family receipt',async()=>{const f=fixture({family:A.toUpperCase(),assignee:ownA});expect(await f.run()).toMatchObject({ok:true,data:{family_id:A,assignee_id:ownA}});expect(posts()).toHaveLength(1);expect(posts()[0].payload.family_id).toBe(A.toUpperCase());});
 it('refuses a foreign assignee after an absent keyed probe without a POST',async()=>{const f=fixture({assignee:ownB,key:'synthetic-foreign-new-key'});expect(await f.run()).toMatchObject({ok:false});expect(posts()).toEqual([]);expect(trace.requests.filter((r:any)=>r.table==='family_members')).toHaveLength(1);expect(trace.requests.every((r:any)=>r.method==='GET')).toBe(true);expect(trace.activity).toEqual([]);});
});
