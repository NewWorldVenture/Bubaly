import {beforeEach,describe,it,expect,vi} from 'vitest';
import type { SearchCalendarOccurrencesResult } from '@/lib/services/calendar/search-occurrences';
type SearchOutput = SearchCalendarOccurrencesResult & {window:{from:string;to:string;bounded:true;defaultedFrom:boolean;defaultedTo:boolean}};

import {createClient} from '@supabase/supabase-js';
import type {Database,Tables} from '@/lib/database.types';
import type {ImportedSourceComponent,ImportedSourceOverride} from '@/lib/calendar/imported-source';
import {parseICSSource} from '@/lib/sync/ics-source';
const h=vi.hoisted(()=>({enabled:true}));
vi.mock('@/lib/calendar/source-capability',()=>({get CALENDAR_SOURCE_ARCHIVE_ENABLED(){return h.enabled;}}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=> (key:string)=>key}));
import {calendarTools} from '@/lib/ai/tools/calendar';
import {searchEvents} from '@/lib/services/calendar';
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
const tool=calendarTools.find(t=>t.name==='calendar.searchEvents')!;
function parseOutput(value:unknown){return tool.output.parse(JSON.parse(JSON.stringify(value))) as SearchOutput;}

function setup(value:unknown=snapshot(),options:{cap?:number;missingCount?:boolean;laterError?:boolean}={}){
 const calls:URL[]=[];const rows=(value as ReturnType<typeof snapshot>).nativeRows;
 const db=createClient<Database>('https://conflict.synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));calls.push(url);expect(url.origin).toBe('https://conflict.synthetic.invalid');
  if(url.pathname==='/rest/v1/rpc/calendar_read_occurrence_inputs'){
   expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toEqual({p_family_id:FAMILY});return Response.json(value);
  }
  // resolveAssigneeId checks a supplied assignee id belongs to this family.
  if(url.pathname==='/rest/v1/family_members'){expect(url.searchParams.get('family_id')).toBe('eq.'+FAMILY);const found=url.searchParams.get('id')==='eq.'+MEMBER?[{id:MEMBER}]:[];return String(new Headers(init?.headers).get('accept')).includes('vnd.pgrst.object')?(found.length?Response.json(found[0]):Response.json({code:'PGRST116',message:'none'},{status:406})):Response.json(found);}
  expect(init?.method??'GET').toBe('GET');expect(url.pathname).toBe('/rest/v1/calendar_events');expect(url.searchParams.get('family_id')).toBe('eq.'+FAMILY);
  const offset=Number(url.searchParams.get('offset')??0);if(offset&&options.laterError)return Response.json({message:'Synthetic denied'},{status:403});
  const selected=rows.filter(row=>url.searchParams.get('recurrence')==='neq.none'?row.recurrence!=='none':row.recurrence==='none');const page=selected.slice(offset,offset+(options.cap??1000));
  return Response.json(page,{headers:options.missingCount?{}:{'Content-Range':`${offset}-${Math.max(offset,offset+page.length-1)}/${selected.length}`}});
 }}});
 const scope={db,familyId:FAMILY,userId:null,memberId:null,role:'system' as const,actorKind:'system' as const,tz:'UTC',now:new Date('2026-10-08T08:00:00Z')};return{scope,calls};
}
async function execute(value=snapshot(),options:Parameters<typeof setup>[1]={}){const f=setup(value,options);return {...f,result:await tool.execute(f.scope,window)};}

describe('actual installed SDK assistant search source boundary', () => {
 it('preserves native action IDs, full fields and source provenance through schema and JSON', async () => {
  const row = native(1, { description: 'Original details', feed_id: FEED });
  const { result, calls } = await execute(snapshot([group()], [row]));
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error);
  const data = parseOutput(result.data);
  expect(data.events[0]).toMatchObject({ ...row,
    starts_at: new Date(row.starts_at).toISOString(), ends_at: new Date(row.ends_at!).toISOString(),
    created_at: new Date(row.created_at).toISOString(), updated_at: new Date(row.updated_at).toISOString(),
    kind: 'native', eventId: row.id, reference: { kind: 'native', eventId: row.id }, readOnly: true, mutable: false });
  expect(data.source_events[0]).toMatchObject({kind: 'source',readOnly:true,mutable:false,reference:{feedId:FEED,uid:'synthetic-source',revisionId:REVISION,original:{kind:'utc',value:'20261008T090000Z'}}});
  for (const field of ['id','eventId','assignee_id','member_id','category']) expect(data.source_events[0]).not.toHaveProperty(field);
  expect(calls).toHaveLength(1); expect(tool.readOnly).toBe(true);
 });
 it('orders both namespaces together and applies one cap with exact disclosures', async () => {
  const f=setup(snapshot([group(source(['DTSTART:20261008T080000Z\r\nDURATION:PT1H']))],[native()]));
  const result=await tool.execute(f.scope,{...window,limit:1});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  const data=parseOutput(result.data);expect(data).toMatchObject({events:[],matchedCount:2,totalVisibleCount:2,returnedCount:1,truncated:true});
  expect(data.source_events[0].displayOrder).toBe(0);expect(tool.summarize({limit:1},data)).toContain('Showing 1 of 2');
 });
 it('uses literal case-insensitive title matching while native filters leave sources explicitly unmapped', async () => {
  const f=setup(snapshot([group(source(['DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nSUMMARY:100%_Match']))],[native(1,{title:'100%_MATCH',category:'sports',assignee_id:MEMBER})]));
  const input={...window,query:' 100%_match ',assignee_id:MEMBER,category:'school'};
  const result=await tool.execute(f.scope,input);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  const data=parseOutput(result.data);expect(data.events).toEqual([]);expect(data.source_events).toHaveLength(1);
  expect(data.filterScope).toMatchObject({sources:'unmapped-family-context',sourceMemberCategoryMatched:false});
  expect(tool.summarize(input,data)).toContain('person/category unmapped');
 });
 it.each(['TRANSP:TRANSPARENT\r\nDURATION:PT1H','TRANSP:OPAQUE'])('shows free or point source annotations without busy claims: %s', async details => {
  const {result}=await execute(snapshot([group(source([`DTSTART:20261008T090000Z\r\n${details}`]))],[]));
  expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);const data=parseOutput(result.data);
  expect(data.source_events).toHaveLength(1);expect(data.source_events[0].occupied).toBe(false);
  const summary=tool.summarize({},data);expect(summary).toContain('do not occupy time');expect(summary).not.toMatch(/Nothing|busy|clear/);
 });
 it('retains exact escaped UID4096 and original source clock',async()=>{
  const uid='escaped\\uid,'+'x'.repeat(4084);expect(uid.length).toBe(4096);
  const {result}=await execute(snapshot([group(source(undefined,uid.replace('\\','\\\\').replace(',','\\,')))],[]));
  expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);expect(parseOutput(result.data).source_events[0].reference).toMatchObject({uid,original:{kind:'utc',value:'20261008T090000Z'}});
 });
 it('retains ongoing original clocks and exposes clipping',async()=>{
  const {result}=await execute(snapshot([group(source(['DTSTART:20261007T230000Z\r\nDURATION:PT3H']))],[]));
  expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);expect(parseOutput(result.data).source_events[0]).toMatchObject({actualStartsAt:'2026-10-07T23:00:00.000Z',interval:{start:Date.parse(window.from),end:Date.parse('2026-10-08T02:00:00Z')}});
 });
 it('preserves civil DATE and household DST clocks',async()=>{
  const f=setup(snapshot([group(source(['DTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102']))],[]));f.scope.tz='America/New_York';
  const result=await tool.execute(f.scope,{from:'2026-11-01T04:00:00Z',to:'2026-11-02T04:59:59.999Z'});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  const data=parseOutput(result.data);expect(data.source_events[0]).toMatchObject({startDate:'2026-11-01',endDate:'2026-11-02',actualStartsAt:'2026-11-01T04:00:00.000Z',actualEndsAt:'2026-11-02T05:00:00.000Z'});expect(tool.summarize({},data)).toContain('all day');
 });
 it('discloses the finite omitted horizon',async()=>{
  const f=setup(snapshot([],[]));const result=await tool.execute(f.scope,{});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  const data=parseOutput(result.data);expect(data.window).toMatchObject({bounded:true,defaultedFrom:true,defaultedTo:true});expect(Date.parse(data.horizonEndsAt)-Date.parse(data.window.from)+1).toBe(366*86_400_000);expect(tool.summarize({},data)).toContain('Bounded search');
 });
 it.each(['bad','2026-02-30T00:00:00Z','2026-10-08T25:00:00Z','2026-10-08T00:00:00'])('refuses invalid explicit clocks before member lookup: %s',async from=>{
  const f=setup();const result=await tool.execute(f.scope,{from,to:window.to,assignee:'Anyone'});expect(result.ok).toBe(false);expect(f.calls).toEqual([]);
 });
 it('refuses invalid zones and reversed windows before transport',async()=>{
  const f=setup();f.scope.tz='Invalid/Zone';expect((await tool.execute(f.scope,{...window,assignee:'Anyone'})).ok).toBe(false);f.scope.tz='UTC';expect((await tool.execute(f.scope,{from:window.to,to:window.from})).ok).toBe(false);expect(f.calls).toEqual([]);
 });
 it.each(['native-count','source-count','watermark-count','invalid-transparency','missing-provenance','contradictory-duplicate','cap'])('qualifies the whole domain before query/cap: %s',async kind=>{
  const value=snapshot();if(kind==='native-count')value.nativeCount++;if(kind==='source-count')value.sourceCount++;if(kind==='watermark-count')value.watermarkCount++;if(kind==='invalid-transparency')(value.sourceGroups[0].document.master as unknown as Record<string,unknown>).transparency='unknown';if(kind==='missing-provenance')(value.sourceGroups[0].document.master as unknown as Record<string,unknown>).raw=null;if(kind==='contradictory-duplicate')value.nativeRows.push({...native(),title:'Contradiction'}),value.nativeCount++;if(kind==='cap')value.nativeCount=20001;
  const f=setup(value);expect((await tool.execute(f.scope,{...window,query:'no match',limit:1})).ok).toBe(false);
 });
 it.each(['missing-count','later-error'])('refuses incomplete native reads: %s',async kind=>{
  h.enabled=false;const {result}=await execute(snapshot([],[native(1),native(2),native(3)]),{cap:2,missingCount:kind==='missing-count',laterError:kind==='later-error'});expect(result.ok).toBe(false);
 });
 it('keeps native legacy search and raw export protectively held without transport',async()=>{
  const f=setup();expect((await searchEvents(f.scope,window)).ok).toBe(false);expect((await searchEvents(f.scope,{...window,expandSeries:false})).ok).toBe(false);expect(f.calls).toEqual([]);
 });
 it('rejects forged source action IDs and mismatched native provenance at the schema boundary',async()=>{
  const {result}=await execute();expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);const data=parseOutput(result.data);
  expect(tool.output.safeParse({...data,source_events:[{...data.source_events[0],id:native().id}]}).success).toBe(false);
  expect(tool.output.safeParse({...data,events:[{...data.events[0],eventId:native(2).id}]}).success).toBe(false);
 });
 it('reads all capped native pages and retains genuine IDs plus separate recurring keys',async()=>{
  h.enabled=false;const rows=[native(1),native(2),native(3),native(4,{recurrence:'daily',recurrence_until:'2026-10-11T00:00:00Z'})];
  const f=setup(snapshot([],rows),{cap:2});
  // Native transport separates masters from singles, as PostgREST does.
  const result=await tool.execute(f.scope,window);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  const data=parseOutput(result.data);expect(data.events.map(row=>row.id)).toContain(rows[2].id);expect(f.calls.some(call=>call.searchParams.get('offset')==='2')).toBe(true);
 });
 it('retains native and source recurring identity across moved and cancelled source occurrences',async()=>{
  const document=source([
   'DTSTART:20261008T090000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=DAILY;COUNT=3',
   'RECURRENCE-ID:20261009T090000Z\r\nDTSTART:20261009T130000Z\r\nDURATION:PT1H',
   'RECURRENCE-ID:20261010T090000Z\r\nSTATUS:CANCELLED',
  ]);
  const row=native(1,{recurrence:'daily',recurrence_until:'2026-10-11T00:00:00Z'});
  const f=setup(snapshot([group(document)],[row]));const result=await tool.execute(f.scope,{from:window.from,to:'2026-10-10T23:59:59Z'});
  expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);const data=parseOutput(result.data);
  expect(data.events).toHaveLength(3);expect(new Set(data.events.map(e=>e.id))).toEqual(new Set([row.id]));expect(new Set(data.events.map(e=>e.occurrenceKey)).size).toBe(3);
  expect(data.source_events).toHaveLength(2);expect(data.source_events[1]).toMatchObject({actualStartsAt:'2026-10-09T13:00:00.000Z',reference:{original:{kind:'utc',value:'20261009T090000Z'}}});
 });
});

