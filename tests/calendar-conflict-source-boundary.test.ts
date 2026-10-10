import {beforeEach,describe,it,expect,vi} from 'vitest';
import {z} from 'zod';
import {CalendarConflictSubjectSchema,CalendarConflictReferenceSchema,CalendarConflictAdvisorySchema} from '@/lib/ai/result-cards';
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
const tool=calendarTools.find(t=>t.name==='calendar.findConflicts')!;
const wireOutput=z.object({conflicts:z.array(z.object({kind:z.literal('personal'),member_id:z.string().nullable(),event_ids:z.array(z.string()),titles:z.array(z.string()),when:z.string(),occurrenceKeys:z.array(z.string()),references:z.array(CalendarConflictReferenceSchema),subjects:z.array(CalendarConflictSubjectSchema)}).strict()),advisories:z.array(CalendarConflictAdvisorySchema)}).strict();
function parseOutput(value:unknown){return wireOutput.parse(tool.output.parse(value));}

function setup(value:unknown=snapshot(),options:{cap?:number;missingCount?:boolean;laterError?:boolean}={}){
 const calls:URL[]=[];const rows=(value as ReturnType<typeof snapshot>).nativeRows;
 const db=createClient<Database>('https://conflict.synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));calls.push(url);expect(url.origin).toBe('https://conflict.synthetic.invalid');
  if(url.pathname==='/rest/v1/rpc/calendar_read_occurrence_inputs'){
   expect(init?.method).toBe('POST');expect(JSON.parse(String(init?.body))).toEqual({p_family_id:FAMILY});return Response.json(value);
  }
  expect(init?.method??'GET').toBe('GET');expect(url.pathname).toBe('/rest/v1/calendar_events');expect(url.searchParams.get('family_id')).toBe('eq.'+FAMILY);
  const offset=Number(url.searchParams.get('offset')??0);if(offset&&options.laterError)return Response.json({message:'Synthetic denied'},{status:403});
  const selected=url.searchParams.get('recurrence')==='neq.none'?[]:rows;const page=selected.slice(offset,offset+(options.cap??1000));
  return Response.json(page,{headers:options.missingCount?{}:{'Content-Range':`${offset}-${Math.max(offset,offset+page.length-1)}/${selected.length}`}});
 }}});
 const scope={db,familyId:FAMILY,userId:null,memberId:null,role:'system' as const,actorKind:'system' as const,tz:'UTC',now:new Date('2026-10-08T08:00:00Z')};return{scope,calls};
}
async function execute(value=snapshot(),options:Parameters<typeof setup>[1]={}){const f=setup(value,options);return {...f,result:await tool.execute(f.scope,window)};}
describe('actual SDK and strict AI wire preserve microsecond conflicts', () => {
 it('retains authoritative exact intervals through actual SDK search, strict AI output and JSON while rejecting a dropped interval', async () => {
  const starts_at = `${day}T09:00:00.000001Z`, ends_at = `${day}T09:00:00.000009Z`;
  const fixture = setup(snapshot([], [native(1, { starts_at, ends_at })]));
  const searchTool = calendarTools.find(candidate => candidate.name === 'calendar.searchEvents')!;
  const result = await searchTool.execute(fixture.scope, window); expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error);
  const parsed = searchTool.output.parse(result.data);
  expect(parsed).toMatchObject({ events: [{ starts_at, ends_at, actualStartsAt: starts_at, actualEndsAt: ends_at,
    occupied: true, point: false, exactInterval: { start: starts_at, end: ends_at } }] });
  expect(searchTool.output.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  const dropped = JSON.parse(JSON.stringify(parsed)) as { events: { exactInterval?: unknown }[] };
  delete dropped.events[0].exactInterval;
  expect(searchTool.output.safeParse(dropped).success).toBe(false); expect(fixture.calls).toHaveLength(1);
 });
 it('keeps genuine native overlaps smaller than a millisecond through tool output, strict schemas and JSON', async () => {
  const first = native(1, { assignee_id: MEMBER, starts_at: `${day}T09:00:00.000001Z`, ends_at: `${day}T09:00:00.000009Z` });
  const second = native(2, { assignee_id: MEMBER, starts_at: `${day}T09:00:00.000003Z`, ends_at: `${day}T09:00:00.000007Z` });
  const { result, calls } = await execute(snapshot([], [first, second]));
  expect(result.ok).toBe(true); if (!result.ok) throw Error(result.error);
  const data = parseOutput(result.data); expect(data.conflicts).toHaveLength(1); expect(data.conflicts[0].event_ids).toEqual([first.id, second.id]);
  expect(data.conflicts[0].subjects.map(subject => [subject.actualStartsAt, subject.actualEndsAt])).toEqual([[first.starts_at, first.ends_at], [second.starts_at, second.ends_at]]);
  expect(parseOutput(JSON.parse(JSON.stringify(data)))).toEqual(data); expect(calls).toHaveLength(1);
 });
 it('does not fabricate a microsecond conflict for touching intervals or explicit points', async () => {
  const rows = [native(1, { assignee_id: MEMBER, starts_at: `${day}T09:00:00.000001Z`, ends_at: `${day}T09:00:00.000003Z` }),
    native(2, { assignee_id: MEMBER, starts_at: `${day}T09:00:00.000003Z`, ends_at: `${day}T09:00:00.000007Z` }),
    native(3, { assignee_id: MEMBER, starts_at: `${day}T09:00:00.000002Z`, ends_at: `${day}T09:00:00.000002Z` })];
  const { result } = await execute(snapshot([], rows)); expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error); expect(parseOutput(result.data)).toMatchObject({ conflicts: [], advisories: [] });
 });
});
describe('actual installed SDK conflict tool source boundary',()=>{
 it('separates personal member clashes from conservative family source overlaps and preserves original identities',async()=>{
  const rows=[native(1,{assignee_id:MEMBER}),native(2,{assignee_id:MEMBER,starts_at:'2026-10-08T09:30:00Z',ends_at:'2026-10-08T10:30:00Z'})];
  const {result,calls}=await execute(snapshot([group()],rows));expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  const data=parseOutput(result.data);expect(data.conflicts).toHaveLength(1);expect(data.conflicts[0]).toMatchObject({kind:'personal',member_id:MEMBER,event_ids:rows.map(r=>r.id)});expect(data.advisories).toHaveLength(2);
  for(const advisory of data.advisories){expect(advisory).toMatchObject({kind:'family-source-overlap',scope:'family'});const imported=advisory.subjects.find(s=>s.kind==='source')!;expect(imported).toMatchObject({readOnly:true,mutable:false,reference:{kind:'source',feedId:FEED,revisionId:REVISION,uid:'synthetic-source',original:{kind:'utc',value:'20261008T090000Z'}}});expect(imported).not.toHaveProperty('eventId');}
  expect(calls).toHaveLength(1);expect(tool.summarize({},data)).toContain('family calendar overlap');
 });
 it('retains native positives after cap2 paging with genuine mutable IDs',async()=>{h.enabled=false;const rows=[native(1,{assignee_id:MEMBER}),native(2,{assignee_id:MEMBER}),native(3,{assignee_id:MEMBER})];const {result,calls}=await execute(snapshot([],rows),{cap:2});expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);const data=parseOutput(result.data);expect(data.conflicts[0].event_ids).toEqual(rows.map(r=>r.id));expect(data.conflicts[0].subjects.every(s=>s.kind==='native'&&s.mutable&&!s.readOnly)).toBe(true);expect(data.advisories).toEqual([]);expect(calls.some(c=>c.searchParams.get('offset')==='2')).toBe(true);});
 it('does not infer source attendees or turn unassigned natives into personal clashes',async()=>{const {result}=await execute();expect(result.ok).toBe(true);if(result.ok){const data=parseOutput(result.data);expect(data.conflicts).toEqual([]);expect(data.advisories).toHaveLength(1);}});
 it('reports source/source overlap without native action identities',async()=>{const {result}=await execute(snapshot([group(),group(source(undefined,'second'),'20000000-0000-4000-8000-000000000002')],[]));expect(result.ok).toBe(true);if(result.ok){const data=parseOutput(result.data);expect(data.advisories).toHaveLength(1);expect(data.advisories[0].subjects.every(s=>s.kind==='source'&&!('eventId'in s))).toBe(true);}});
 it.each(['TRANSP:TRANSPARENT\r\nDURATION:PT1H','TRANSP:OPAQUE'])('free and point sources do not clash: %s',async(details)=>{const document=source([`DTSTART:20261008T090000Z\r\n${details}\r\nSUMMARY:Annotation`]);const {result}=await execute(snapshot([group(document)]));expect(result.ok).toBe(true);if(result.ok)expect(parseOutput(result.data)).toMatchObject({conflicts:[],advisories:[]});});
 it('keeps legacy feed and external UID native subjects read only in both lanes',async()=>{const rows=[native(1,{assignee_id:MEMBER,feed_id:FEED}),native(2,{assignee_id:MEMBER,external_uid:'legacy'})];const {result}=await execute(snapshot([group()],rows));expect(result.ok).toBe(true);if(result.ok){const data=parseOutput(result.data);expect(data.conflicts[0].subjects.every(s=>s.readOnly&&!s.mutable)).toBe(true);for(const a of data.advisories)expect(a.subjects.every(s=>s.readOnly&&!s.mutable)).toBe(true);}});
 it('uses civil DATE actual occupancy on a fall DST day',async()=>{const document=source(['DTSTART;VALUE=DATE:20261101\r\nDTEND;VALUE=DATE:20261102']);const f=setup(snapshot([group(document)],[native(1,{starts_at:'2026-11-02T04:00:00Z',ends_at:'2026-11-02T04:30:00Z'})]));f.scope.tz='America/New_York';const result=await tool.execute(f.scope,{from:'2026-11-01T04:00:00Z',to:'2026-11-02T04:59:59.999Z'});expect(result.ok).toBe(true);if(result.ok){const a=parseOutput(result.data).advisories[0];expect(a.subjects.find(s=>s.kind==='source')).toMatchObject({actualStartsAt:'2026-11-01T04:00:00.000Z',actualEndsAt:'2026-11-02T05:00:00.000Z'});}});
 it('clips ongoing source overlaps but retains original subject clocks',async()=>{const {result}=await execute(snapshot([group(source(['DTSTART:20261007T230000Z\r\nDURATION:PT3H']))],[native(1,{starts_at:'2026-10-08T00:30:00Z',ends_at:'2026-10-08T01:00:00Z'})]));expect(result.ok).toBe(true);if(result.ok){const a=parseOutput(result.data).advisories[0];expect(a.startsAt).toBe('2026-10-08T00:30:00.000Z');expect(a.subjects.find(s=>s.kind==='source')?.actualStartsAt).toBe('2026-10-07T23:00:00.000Z');}});
 it.each(['missing-count','later-error'])('refuses native %s before calm output',async(kind)=>{h.enabled=false;const {result}=await execute(snapshot([],[native(1),native(2),native(3)]),{cap:2,missingCount:kind==='missing-count',laterError:kind==='later-error'});expect(result.ok).toBe(false);});
 it.each(['native-count','source-count','watermark-count','invalid-transparency','missing-provenance','contradictory-duplicate','cap'])('refuses malformed complete snapshot %s',async(kind)=>{const value=snapshot();if(kind==='native-count')value.nativeCount++;if(kind==='source-count')value.sourceCount++;if(kind==='watermark-count')value.watermarkCount++;if(kind==='invalid-transparency')(value.sourceGroups[0].document.master as unknown as Record<string,unknown>).transparency='unknown';if(kind==='missing-provenance')(value.sourceGroups[0].document.master as unknown as Record<string,unknown>).raw=null;if(kind==='contradictory-duplicate')value.nativeRows.push({...native(),title:'Contradiction'}),value.nativeCount++;if(kind==='cap')value.nativeCount=20001;expect((await execute(value)).result.ok).toBe(false);});
 it('retains one-hour native missing-end estimates and source original escaped long UID',async()=>{const uid='escaped\\uid,'+'x'.repeat(4000);const document=source(['DTSTART:20261008T093000Z\r\nDURATION:PT1H'],uid.replace('\\','\\\\').replace(',','\\,'));const {result}=await execute(snapshot([group(document)],[native(1,{ends_at:null})]));expect(result.ok).toBe(true);if(result.ok){const data=parseOutput(result.data);expect(data.advisories).toHaveLength(1);expect(data.advisories[0].subjects.find(s=>s.kind==='native')?.actualEndsAt).toBe('2026-10-08T10:00:00.000Z');expect(data.advisories[0].subjects.find(s=>s.kind==='source')?.reference).toMatchObject({uid});}});
 it('admits assistant source search while legacy search and raw stored export stay held',async()=>{
  const f=setup();const searchTool=calendarTools.find(t=>t.name==='calendar.searchEvents')!;
  const result=await searchTool.execute(f.scope,window);expect(result.ok).toBe(true);if(!result.ok)throw Error(result.error);
  const data=searchTool.output.parse(result.data) as {source_events:{kind:string;readOnly:boolean;mutable:boolean}[]};
  expect(data.source_events).toHaveLength(1);expect(data.source_events[0]).toMatchObject({kind:'source',readOnly:true,mutable:false});expect(data.source_events[0]).not.toHaveProperty('id');
  expect(f.calls).toHaveLength(1);expect(f.calls[0].pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs');
  expect((await searchEvents(f.scope,window)).ok).toBe(false);expect((await searchEvents(f.scope,{...window,expandSeries:false})).ok).toBe(false);expect(f.calls).toHaveLength(1);
 });
});
