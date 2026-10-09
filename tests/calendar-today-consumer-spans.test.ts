import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { Database } from '@/lib/database.types';
import type { DisplayData } from '@/components/display/display-grid';
import { orPredicate } from './helpers/in-memory-supabase';
import { parseICSSource } from '@/lib/sync/ics-source';
import { buildToday } from '@/lib/home/today';
import { kitchenToday, kitchenMemberStatus } from '@/lib/briefing/kitchen-agenda';
import { buildFirstBrief } from '@/lib/onboarding/first-brief';
import { buildBrief, briefSchema } from '@/lib/briefing/build';
import { createFormat } from '@/lib/utils/format';
import { calendarConsumerKey, calendarConsumerReference, calendarConsumerSpan, projectCalendarDay, projectCalendarWindow } from '@/lib/calendar/consumer-spans';
import { readDisplayCalendarOccurrences } from '@/lib/calendar/display-occurrences';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';

const h=vi.hoisted(()=>({db:null as unknown,enabled:false,timezone:'America/New_York',rows:[] as Record<string,unknown>[],requests:[] as URL[],failToday:false,missingCount:false,payload:null as unknown,wait:null as Promise<void>|null}));
const family='10000000-0000-4000-8000-000000000001',member='20000000-0000-4000-8000-000000000001',feed='40000000-0000-4000-8000-000000000001',revision='50000000-0000-4000-8000-000000000001';
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
vi.mock('@/lib/supabase/auth',()=>({requireFeature:async()=>context(),requireUserContext:async()=>context()}));
vi.mock('@/lib/supabase/server',()=>({createServer:async()=>h.db}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=>(key:string)=>key,getLocaleContext:async()=>({locale:{code:'en-US'},messages:{}})}));
vi.mock('@/lib/utils/format-server',()=>({getFormat:async(zone:string)=>createFormat('en-US',undefined,zone)}));
vi.mock('next/navigation',()=>({unstable_rethrow:()=>{}}));
vi.mock('@/components/display/auto-refresh',()=>({AutoRefresh:'AutoRefresh'}));
vi.mock('@/components/display/display-shell-client',()=>({DisplayShellClient:'DisplayShellClient'}));
import DisplayPage from '@/app/(app)/display/page';
import KidsPage from '@/app/(app)/kids/page';

function context(){return {user:{id:'synthetic-user'},active:{familyId:family,family:{name:'Synthetic family',timezone:h.timezone},member:{id:member,display_name:'Synthetic child',color:'blue',role:'child'}}};}
function native(starts_at='2026-10-07T23:00:00Z',ends_at:string|null='2026-10-08T06:00:00Z',extra:Record<string,unknown>={}) {
  return {id:'30000000-0000-4000-8000-000000000001',family_id:family,title:'Synthetic overnight',starts_at,ends_at,all_day:false,assignee_id:member,recurrence:'none',recurrence_until:null,description:null,location:null,category:'general',feed_id:null,external_uid:null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z',...extra};
}
function sourceSnapshot(lines:string){const doc=parseICSSource(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Synthetic consumer//EN\r\nBEGIN:VEVENT\r\nUID:synthetic-source\r\nSUMMARY:Synthetic source\r\n${lines}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`)[0];return {version:1,familyId:family,nativeRows:[],nativeCount:0,sourceCount:1,watermarkCount:1,sourceGroups:[{feedId:feed,uid:doc.uid,revisionId:revision,materializationState:'ready',document:doc,masterCancellationRevisionId:null,watermarks:[{componentKey:'master',versionComponent:structuredClone(doc.master),versionRevisionId:revision,cancelledComponent:null,cancellationRevisionId:null}]}]};}
function nodes(value:unknown):ReactElement<Record<string,unknown>>[]{if(Array.isArray(value))return value.flatMap(nodes);if(!value||typeof value!=='object'||!('props'in value))return [];const node=value as ReactElement<Record<string,unknown>>;return [node,...Object.values(node.props).flatMap(nodes)];}
async function display(){const tree=await DisplayPage();const data=nodes(tree).find(node=>node.type==='DisplayShellClient')?.props.data as DisplayData;expect(data).toBeDefined();return data;}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-08T04:30:00Z'));h.enabled=false;h.timezone='America/New_York';h.rows=[];h.requests=[];h.failToday=false;h.missingCount=false;h.payload=null;h.wait=null;vi.spyOn(console,'error').mockImplementation(()=>{});
  h.db=createClient<Database>('https://synthetic-today.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
    const url=new URL(String(input));h.requests.push(url);
    if(h.wait)await h.wait;
    if(url.pathname.includes('/rpc/')){expect(JSON.parse(String(init?.body))).toEqual({p_family_id:family});return Response.json(h.payload);}
    const table=url.pathname.split('/').at(-1);let rows=table==='calendar_events'?[...h.rows]:[];
    const filters=url.searchParams.getAll('or');if(h.failToday&&table==='calendar_events'&&filters.some(filter=>filter.includes('2026-10-08T04:00:00.000Z')))return Response.json({message:'Synthetic calendar unavailable'},{status:400});
    for(const filter of filters)rows=rows.filter(orPredicate(filter.slice(1,-1)));
    for(const [key,raw] of url.searchParams){if(['or','select','order','limit','offset'].includes(key))continue;const dot=raw.indexOf('.'),op=raw.slice(0,dot),value=raw.slice(dot+1);rows=rows.filter(row=>op==='eq'?String(row[key])===value:op==='neq'?row[key]!=null&&String(row[key])!==value:op==='lte'?String(row[key])<=value:op==='lt'?String(row[key])<value:op==='gte'?String(row[key])>=value:op==='gt'?String(row[key])>value:true);}
    rows.sort((a,b)=>String(a.starts_at).localeCompare(String(b.starts_at))||String(a.id).localeCompare(String(b.id)));
    const total=rows.length,offset=Number(url.searchParams.get('offset')??0);rows=rows.slice(offset,offset+Math.min(2,Number(url.searchParams.get('limit')??2)));
    const headers:Record<string,string>=h.missingCount&&table==='calendar_events'?{}:{'content-range':`${offset}-${Math.max(offset,offset+rows.length-1)}/${total}`};
    if(new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object'))return Response.json(rows[0]??null,{headers});
    return Response.json(rows,{headers});
  }}});
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

describe('actual SDK → server consumer rendering',()=>{
  it('Display and Kids retain ongoing weekly spans and original native identity, excluding another family',async()=>{
    h.rows=[native('2026-10-07T23:00:00Z','2026-10-08T06:00:00Z',{recurrence:'weekly'}),native(undefined,undefined,{id:'other',family_id:'other'})];
    const data=await display();expect(data.loadStatus?.events).toBe('ok');expect(data.events).toHaveLength(1);expect(data.events[0]).toMatchObject({kind:'native',reference:{kind:'native',eventId:h.rows[0].id},starts_at:'2026-10-07T23:00:00.000Z',displayStartsAt:'2026-10-08T04:00:00.000Z'});
    const markup=renderToStaticMarkup(await KidsPage());expect(markup).toContain('Synthetic overnight');expect(markup).toContain('12:00 AM');expect(markup).not.toContain('kids.nothingOnTheCalendarToday');
  });
  it('Display reads every server-capped page before its twelve-item upcoming presentation cap',async()=>{
    h.rows=Array.from({length:18},(_,i)=>native(`2026-10-09T${String(i).padStart(2,'0')}:00:00Z`,`2026-10-09T${String(i+1).padStart(2,'0')}:00:00Z`,{id:`event-${String(i).padStart(2,'0')}`}));
    const data=await display();expect(data.upcoming).toHaveLength(12);expect(h.requests.some(url=>Number(url.searchParams.get('offset'))>=12)).toBe(true);expect(data.upcoming[0]).toMatchObject({starts_at:'2026-10-09T04:00:00Z',displayStartsAt:'2026-10-09T04:00:00.000Z'});
  });
  it('keeps failed today independent from successful upcoming/month; Kids renders an unavailable state',async()=>{
    h.rows=[native('2026-10-09T09:00:00Z','2026-10-09T10:00:00Z')];h.failToday=true;const data=await display();expect(data.loadStatus).toMatchObject({events:'error',upcoming:'ok',monthEvents:'ok'});expect(data.events).toEqual([]);expect(data.upcoming).toHaveLength(1);
    const markup=renderToStaticMarkup(await KidsPage());expect(markup).toContain('kids.weCouldnTLoadYour');expect(markup).not.toContain('kids.nothingOnTheCalendarToday');
  });
  it('refuses missing exact counts rather than publishing a successful two-row prefix',async()=>{h.rows=[native()];h.missingCount=true;expect((await display()).loadStatus).toMatchObject({events:'error',upcoming:'error',monthEvents:'error'});});
  it('uses the same qualified missing-end occupancy for Today and month dots',async()=>{vi.setSystemTime(new Date('2026-02-01T05:15:00Z'));h.rows=[native('2026-02-01T04:30:00Z',null)];const data=await display();expect(data.events).toHaveLength(1);expect(data.calendar.eventDays).toContain(1);});
  it('Kids uses the captured family date when a read resolves across midnight',async()=>{h.rows=[native()];let release!:()=>void;h.wait=new Promise<void>(resolve=>{release=resolve;});const reading=KidsPage();for(let n=0;n<20;n++)await Promise.resolve();expect(h.requests.length).toBeGreaterThan(0);vi.setSystemTime(new Date('2026-10-09T04:30:00Z'));release();const html=renderToStaticMarkup(await reading);expect(html).toContain('Synthetic overnight');expect(html).not.toContain('kids.nothingOnTheCalendarToday');});
  it('adopts original source references without native IDs through SDK, Display and Today',async()=>{
    h.enabled=true;h.payload=sourceSnapshot('DTSTART;VALUE=DATE:20261007\r\nDTEND;VALUE=DATE:20261010');const data=await display();expect(data.events).toHaveLength(1);const event=data.events[0];expect(event).toMatchObject({kind:'source',startDate:'2026-10-07',endDate:'2026-10-10',displayDay:'2026-10-08',reference:{kind:'source',feedId:feed,revisionId:revision}});expect(event).not.toHaveProperty('id');
    const model=buildToday({events:data.events,todayKey:'2026-10-08',tz:h.timezone,now:new Date(),todos:[],chores:[],reminders:[],choreTitles:{}});expect(model.schedule[0]).toMatchObject({id:null,reference:calendarConsumerReference(event),occurrenceKey:calendarConsumerKey(event),allDay:true});
    expect(renderToStaticMarkup(await KidsPage())).toContain('Synthetic source');
  });
});

describe('strict occupied-day semantics and original references',()=>{
  it.each([false,true])('keeps native overnight/civil DATE occupants through kitchen and Home (DATE=%s)',allDay=>{
    const event=allDay?native('2026-10-07T00:00:00Z','2026-10-10T00:00:00Z',{all_day:true}):native();const before=structuredClone(event);const day=kitchenToday([event],'2026-10-08',h.timezone);expect(day).toHaveLength(1);expect(day[0].starts_at).toBe(event.starts_at);expect(kitchenMemberStatus(day,member,new Date()).kind).toBe(allDay?'allDay':'now');expect(event).toEqual(before);
    const model=buildToday({events:[event],todayKey:'2026-10-08',tz:h.timezone,now:new Date(),todos:[],chores:[],reminders:[],choreTitles:{}});expect(model.schedule).toHaveLength(1);expect(model.schedule[0].at).toBe(allDay?event.starts_at:'2026-10-08T04:00:00.000Z');
  });
  it('preserves source missing-end points, explicit points and native qualified missing-end duration',async()=>{
    h.enabled=true;h.payload=sourceSnapshot('DTSTART:20261008T043000Z');const result=await readDisplayCalendarOccurrences(h.db as Parameters<typeof readDisplayCalendarOccurrences>[0],family,briefingCalendarBounds('2026-10-08',h.timezone,0,1),h.timezone,{overlap:true});expect(result.error).toBeNull();const source=result.data![0];const point=calendarConsumerSpan(source,'2026-10-08',h.timezone)!;expect(point.actualStartsAt).toBe(point.actualEndsAt);expect(projectCalendarDay([source],'2026-10-09',h.timezone)).toEqual([]);
    expect(calendarConsumerSpan(native('2026-10-08T04:30:00Z',null),'2026-10-08',h.timezone)?.actualEndsAt).toBe('2026-10-08T05:30:00.000Z');expect(calendarConsumerSpan(native('2026-10-08T04:30:00Z','2026-10-08T04:30:00Z'),'2026-10-08',h.timezone)).toMatchObject({actualStartsAt:'2026-10-08T04:30:00.000Z',actualEndsAt:'2026-10-08T04:30:00.000Z'});
    const brief=buildFirstBrief([{title:'Source point',start:source.starts_at,end:source.ends_at,reference:source.reference,occurrenceKey:source.occurrenceKey,transparency:source.transparency},{title:'Later',start:'2026-10-08T05:00:00Z',end:'2026-10-08T05:30:00Z'}],new Date(),[],h.timezone);expect(brief.conflicts).toEqual([]);expect(brief.timeline[0]).toMatchObject({reference:source.reference,occurrenceKey:source.occurrenceKey});
  });
  it.each(['','Invalid/Zone'])('refuses unknown zone even for empty input: %s',zone=>{expect(()=>projectCalendarDay([],'2026-10-08',zone)).toThrow();expect(()=>projectCalendarWindow([],'2026-10-08','2026-10-08',zone)).toThrow();});
  it.each([['2026-02-30T00:00:00Z','2026-03-02T00:00:00Z'],['2026-10-09T00:00:00Z','2026-10-08T00:00:00Z']])('refuses malformed/reversed DATE boundaries %s', (start,end)=>{expect(()=>projectCalendarDay([native(start,end,{all_day:true})],'2026-10-08',h.timezone)).toThrow();});
  it.each([['2026-03-08','2026-03-07T23:00:00Z','2026-03-09T06:00:00Z',23],['2026-11-01','2026-10-31T23:00:00Z','2026-11-02T06:00:00Z',25]])('clips %s using actual DST instants', (day,start,end,hours)=>{const span=calendarConsumerSpan(native(start,end),day,h.timezone)!;expect((Date.parse(span.actualEndsAt)-Date.parse(span.actualStartsAt))/3_600_000).toBe(hours);});
  it('keeps a skipped civil DATE annotation while timed occupancy is empty',()=>{const day='2011-12-30',zone='Pacific/Apia';expect(projectCalendarDay([native('2011-12-30T00:00:00Z','2011-12-31T00:00:00Z',{all_day:true})],day,zone)).toHaveLength(1);expect(projectCalendarDay([native('2011-12-29T00:00:00Z','2012-01-01T00:00:00Z')],day,zone)).toEqual([]);});
  it('labels civil DATE month-boundary badges by date, with the original occurrence unchanged',()=>{const event=native('2026-11-01T00:00:00Z','2026-11-03T00:00:00Z',{all_day:true});const visible=projectCalendarWindow([event],'2026-11-02','2026-11-04','America/Los_Angeles')[0];const fmt=createFormat('en-US',undefined,'America/Los_Angeles');expect([fmt.fmtDate(visible.displayDay,'MMM'),fmt.fmtDate(visible.displayDay,'d')]).toEqual(['Nov','2']);expect(visible.starts_at).toBe(event.starts_at);});
  it('deterministic briefing includes ongoing overnight and civil DATE, counts each occurrence once and clips cross-midnight conflicts',()=>{const brief=buildFirstBrief([{title:'Overnight',start:'2026-10-07T23:00:00Z',end:'2026-10-08T06:00:00Z'},{title:'Date',start:'2026-10-07T00:00:00Z',end:'2026-10-10T00:00:00Z',allDay:true},{title:'Morning',start:'2026-10-08T05:00:00Z',end:'2026-10-08T07:00:00Z'}],new Date(),[],h.timezone);expect(brief.todayCount).toBe(3);expect(brief.weekCount).toBe(3);expect(brief.conflicts).toHaveLength(1);expect(brief.conflicts[0].display).toMatchObject({dayKey:'2026-10-08',overlapStart:'2026-10-08T05:00:00.000Z',overlapEnd:'2026-10-08T06:00:00.000Z'});expect(brief.timeline.find(item=>item.title==='Overnight')).toMatchObject({start:'2026-10-08T04:00:00.000Z',originalStart:'2026-10-07T23:00:00Z'});});
  it('round-trips original source references and point identities through the durable brief schema; rejects fabricated native IDs and clock kinds',()=>{
    const reference={kind:'source' as const,feedId:feed,uid:'synthetic-source',revisionId:revision,original:{kind:'utc' as const,value:'20261008T043000Z'}};
    const brief=buildBrief({kind:'daily',now:new Date(),events:[{title:'Source point',start:'2026-10-08T04:30:00Z',end:null,reference,occurrenceKey:'synthetic-source-key',transparency:'opaque'}],snapshot:{},completedRuns:[],activity:[]},h.timezone);
    const parsed=briefSchema.parse(brief);expect(parsed.calendar.timeline[0]).toMatchObject({reference,occurrenceKey:'synthetic-source-key',originalStart:'2026-10-08T04:30:00Z',originalEnd:null});expect(parsed.calendar.conflicts).toEqual([]);
    const fabricated=structuredClone(brief);Object.assign(fabricated.calendar.timeline[0].reference!,{eventId:'fabricated'});expect(briefSchema.safeParse(fabricated).success).toBe(false);
    const invalid=structuredClone(brief);Object.assign((invalid.calendar.timeline[0].reference as typeof reference).original,{kind:'device'});expect(briefSchema.safeParse(invalid).success).toBe(false);
  });
  it('refuses a conflict workload beyond its bound instead of publishing a partial calm brief',()=>{const events=Array.from({length:450},(_,i)=>({title:`Synthetic overlap ${i}`,start:'2026-10-08T04:00:00Z',end:'2026-10-08T06:00:00Z'}));expect(()=>buildFirstBrief(events,new Date(),[],h.timezone)).toThrow('bound exhausted');});
  it.each([{kind:'date',value:'20261008'},{kind:'utc',value:'20261008T043000Z'},{kind:'floating',value:'20261008T043000'},{kind:'zoned',value:'20261008T043000',tzid:'"'.repeat(4096)}] as const)('retains admitted long escaped UID and original $kind source clock through durable schema',original=>{
    const uid='"'.repeat(4096),reference={kind:'source' as const,feedId:feed,uid,revisionId:revision,original};const occurrenceKey=JSON.stringify(['source',feed,uid,original]);
    const brief=buildBrief({kind:'daily',now:new Date(),events:[{title:'Retained source identity',start:original.kind==='date'?'2026-10-08':'2026-10-08T04:30:00Z',end:original.kind==='date'?'2026-10-09':'2026-10-08T05:30:00Z',allDay:original.kind==='date',reference,occurrenceKey,transparency:'opaque'}],snapshot:{},completedRuns:[],activity:[]},h.timezone);
    expect(briefSchema.parse(brief).calendar.timeline[0]).toMatchObject({reference,occurrenceKey});
    const invalid=structuredClone(brief);(invalid.calendar.timeline[0].reference as {original:{value:string}}).original.value='20260230';expect(briefSchema.safeParse(invalid).success).toBe(false);
  });
});
