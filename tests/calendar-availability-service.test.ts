import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { orPredicate } from './helpers/in-memory-supabase';
import type { Database, Tables } from '@/lib/database.types';
import type { ImportedSourceComponent, ImportedSourceOverride } from '@/lib/calendar/imported-source';
import { parseICSSource } from '@/lib/sync/ics-source';
import { readCalendarAvailability } from '@/lib/calendar/availability';
import { readDisplayCalendarOccurrences } from '@/lib/calendar/display-occurrences';
import { briefingCalendarBounds } from '@/lib/briefing/calendar-window';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { readAssistantRailCalendar } from '@/lib/calendar/assistant-rail';
import { readCompleteCalendarOccurrences } from '@/lib/services/calendar/search-occurrences';

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
import {findFreeSlots,busyEvenings,findConflicts} from '@/lib/services/calendar';
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

describe('actual SDK PostgreSQL microsecond calendar admission', () => {
  it.each([
    ['2026-10-08T09:00:00.000001', '2026-10-08T13:00:00.000001Z'],
    ['2026-03-08T02:30:42.000001', '2026-03-08T07:30:42.000001Z'],
    ['2026-11-01T01:30:42.000001', '2026-11-01T05:30:42.000001Z'],
  ])('resolves floating household input %s through actual SDK with exact UTC clock %s', async (floating, utc) => {
    capability.enabled = true;
    const rows = [native(1, { starts_at: utc, ends_at: utc.replace('000001Z', '000009Z') }),
      native(2, { starts_at: utc.replace('000001Z', '000009Z'), ends_at: utc.replace('000001Z', '000009Z') }),
      native(3, { starts_at: utc.replace('000001Z', '000010Z'), ends_at: utc.replace('000001Z', '000010Z') })];
    const probe = sdk({ value: snapshot([], rows) });
    const result = await findConflicts(scope(probe.db, 'America/New_York'), { from: floating, to: floating.replace('000001', '000009') });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error);
    expect(Object.keys(result.data.events)).toEqual([rows[0].id, rows[1].id]);
    expect(Object.values(result.data.subjects)[0]).toMatchObject({ actualStartsAt: utc, actualEndsAt: utc.replace('000001Z', '000009Z') });
    expect(probe.calls[0].body).toEqual({ p_family_id: FAMILY });
    expect(probe.calls).toHaveLength(1); expect(probe.calls[0].url.pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs');
  });
  it('refuses invalid floating input before SDK and still refuses naive stored event clocks', async () => {
    const invalid = sdk();
    expect(await findConflicts(scope(invalid.db, 'America/New_York'), { from: '2026-10-08T09:90:00.000001', to: '2026-10-08T10:00:00.000009' })).toMatchObject({ ok: false });
    expect(invalid.calls).toEqual([]);
    capability.enabled = true;
    const rows = [native(1, { starts_at: '2026-10-08T09:00:00.000001', ends_at: '2026-10-08T10:00:00.000009' })], stored = sdk({ value: snapshot([], rows) });
    expect(await readCompleteCalendarOccurrences(scope(stored.db, 'America/New_York'), { from: '2026-10-08T00:00:00Z', to: '2026-10-08T23:59:59.999999Z' })).toMatchObject({ ok: false });
    expect(stored.calls).toHaveLength(1);
  });
  it('retains a source-enabled native row starting inside a nonoverlap microsecond display window', async () => {
    capability.enabled = true;
    const starts_at = `${day}T09:00:00.000005Z`, ends_at = `${day}T09:00:00.000006Z`;
    const rows = [native(1, { starts_at, ends_at })], probe = sdk({ value: snapshot([], rows) });
    const bounds = { ...briefingCalendarBounds(day, 'UTC', 0, 1), timedFrom: `${day}T09:00:00.000003Z`, timedTo: `${day}T09:00:00.000007Z` };
    const result = await readDisplayCalendarOccurrences(probe.db, FAMILY, bounds, 'UTC', { overlap: false });
    expect(result.error).toBeNull(); expect(result.count).toBe(1);
    expect(result.data?.[0]).toMatchObject({ kind: 'native', starts_at, ends_at, actualStartsAt: starts_at, actualEndsAt: ends_at, reference: { kind: 'native', eventId: rows[0].id } });
    expect(probe.calls).toHaveLength(1); expect(probe.calls[0].url.pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs');
  });
  it.each([
    ['2026-10-08T23:59:59.999999Z', '2026-10-09T00:00:00.000Z'],
    ['2026-10-08T23:59:59.999999999Z', '2026-10-09T00:00:00.000Z'],
    ['2026-10-08T23:59:59.999Z', '2026-10-09T00:00:00.000Z'],
    ['2026-10-08T09:00:00.000000Z', '2026-10-08T09:00:00.000001Z'],
    ['2026-10-08T09:00:00.000000000Z', '2026-10-08T09:00:00.000000001Z'],
    ['2026-10-08T09:00:00.0000Z', '2026-10-08T09:00:00.0001Z'],
    ['2026-10-08T09:00:00.000Z', '2026-10-08T09:00:00.001Z'],
    ['2026-10-08T09:00:00Z', '2026-10-08T09:00:00.001Z'],
  ])('inclusive endpoint %s advances only its declared precision to %s', (last, exclusive) => {
    const bounds = instantCalendarBounds(`${day}T00:00:00Z`, last, 'UTC');
    expect(bounds.timedTo).toBe(exclusive);
    expect(bounds.allDayFromDay).toBe(day); expect(bounds.allDayToDay).toBe('2026-10-09');
  });
  it('rejects reversed same-millisecond inclusive bounds rather than rounding them equal', () => {
    expect(() => instantCalendarBounds(`${day}T09:00:00.000009Z`, `${day}T09:00:00.000001Z`, 'UTC')).toThrow();
  });
  it('retains raw trailing-zero microsecond resolution through the actual complete SDK reader', async () => {
    capability.enabled = true;
    const point = `${day}T09:00:00.000000Z`, outside = `${day}T09:00:00.000002Z`;
    const rows = [native(1, { starts_at: point, ends_at: point }), native(2, { starts_at: outside, ends_at: outside })];
    const probe = sdk({ value: snapshot([], rows) });
    const result = await readCompleteCalendarOccurrences(scope(probe.db), { from: point, to: point });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error);
    expect(result.data.totalVisibleCount).toBe(1); expect(result.data.occurrences[0].reference).toEqual({ kind: 'native', eventId: rows[0].id });
    expect(probe.calls).toHaveLength(1); expect(probe.calls[0].url.pathname).toBe('/rest/v1/rpc/calendar_read_occurrence_inputs');
  });
  it('admits exactly 366 elapsed days at microsecond resolution and refuses the next inclusive quantum before transport', async () => {
    const probe = sdk();
    const result = await readCompleteCalendarOccurrences(scope(probe.db), { from: '2024-01-01T00:00:00Z', to: '2024-12-31T23:59:59.999999Z' });
    expect(result).toMatchObject({ ok: true, data: { occurrences: [], totalVisibleCount: 0 } });
    const rejected = sdk();
    expect(await readCompleteCalendarOccurrences(scope(rejected.db), { from: '2024-01-01T00:00:00Z', to: '2025-01-01T00:00:00.000000Z' })).toMatchObject({ ok: false });
    expect(rejected.calls).toEqual([]);
  });
  it.each([false, true])('rejects malformed DATE clocks and reversed submillisecond intervals with source capability=%s', async enabled => {
    capability.enabled = enabled;
    for (const patch of [
      { all_day: true, starts_at: `${day}T00:00:00.000001Z`, ends_at: '2026-10-09T00:00:00Z' },
      { all_day: true, starts_at: `${day}T00:00:00Z`, ends_at: '2026-10-09T00:00:00.000001Z' },
      { starts_at: `${day}T09:00:00.000009Z`, ends_at: `${day}T09:00:00.000001Z` },
    ]) {
      const rows = [native(1, patch)], probe = sdk({ rows, value: snapshot([], rows) });
      const result = await readCalendarAvailability(probe.db, FAMILY, briefingCalendarBounds(day, 'UTC', 0, 1), 'UTC');
      expect(result.data).toBeNull(); expect(result.count).toBeNull(); expect(result.error).not.toBeNull();
    }
  });
  it('refuses a reversed microsecond request before SDK transport', async () => {
    const probe = sdk();
    const bounds = { ...briefingCalendarBounds(day, 'UTC', 0, 1), timedFrom: `${day}T09:00:00.000009Z`, timedTo: `${day}T09:00:00.000001Z` };
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.data).toBeNull(); expect(result.error).not.toBeNull(); expect(probe.calls).toEqual([]);
  });
  it.each([false, true])('preserves positive microsecond occupancy, raw endpoints and exact clipping with source capability=%s', async enabled => {
    capability.enabled = enabled;
    const rawStart = `${day}T09:00:00.000001Z`, rawEnd = `${day}T09:00:00.000009Z`;
    const rows = [native(1, { starts_at: rawStart, ends_at: rawEnd })], probe = sdk({ rows, value: snapshot([], rows) });
    const bounds = { ...briefingCalendarBounds(day, 'UTC', 0, 1), timedFrom: `${day}T09:00:00.000003Z`, timedTo: `${day}T09:00:00.000007Z` };
    const result = await readCalendarAvailability(probe.db, FAMILY, bounds, 'UTC');
    expect(result.error).toBeNull(); expect(result.count).toBe(1);
    expect(result.data?.[0]).toMatchObject({ starts_at: rawStart, ends_at: rawEnd, actualStartsAt: rawStart, actualEndsAt: rawEnd,
      occupied: true, point: false, exactInterval: { start: `${day}T09:00:00.000003Z`, end: `${day}T09:00:00.000007Z` } });
    expect(result.data?.[0].interval.start).toBe(result.data?.[0].interval.end);
    expect(JSON.parse(JSON.stringify(result.data))).toEqual(result.data);
  });
  it.each([false, true])('retains equal microsecond endpoints as a visible nonoccupying point with source capability=%s', async enabled => {
    capability.enabled = enabled;
    const instant = `${day}T09:00:00.000001Z`, rows = [native(1, { starts_at: instant, ends_at: instant })];
    const result = await readCalendarAvailability(sdk({ rows, value: snapshot([], rows) }).db, FAMILY, briefingCalendarBounds(day, 'UTC', 0, 1), 'UTC');
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(1);
    expect(result.data?.[0]).toMatchObject({ point: true, occupied: false, exactInterval: { start: instant, end: instant } });
  });
  it('orders same-millisecond native rail rows by actual instant before UUID', async () => {
    const rows = [native(1, { starts_at: `${day}T09:00:00.000009Z`, ends_at: `${day}T10:00:00Z` }),
      native(9, { starts_at: `${day}T09:00:00.000001Z`, ends_at: `${day}T10:00:00Z` })];
    const probe = sdk({ rows });
    const result = await readAssistantRailCalendar(probe.db, FAMILY, 'UTC', new Date(`${day}T00:00:00Z`), new Date('2026-10-09T00:00:00Z'), new Date('2026-10-22T00:00:00Z'), new AbortController().signal);
    expect(result.error).toBeNull(); expect(result.data?.today.map(row => row.id)).toEqual([rows[1].id, rows[0].id]);
  });
  it('does not recommend a five-minute grid slot crossing genuine microsecond occupancy', async () => {
    capability.enabled = true;
    const rows = [native(1, { starts_at: `${day}T17:00:00.000001Z`, ends_at: `${day}T17:00:00.000002Z` })];
    const result = await findFreeSlots(scope(sdk({ value: snapshot([], rows) }).db), { from: `${day}T17:00:00Z`, to: `${day}T17:10:00Z`, durationMin: 5, granularityMin: 1, limit: 1 });
    expect(result).toMatchObject({ ok: true, data: [{ startsAt: `${day}T17:01:00.000Z`, endsAt: `${day}T17:06:00.000Z` }] });
  });
});
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

import {searchEvents as searchBoundaryEvents,findEventByTitle as findBoundaryTitle} from '@/lib/services/calendar';
describe('minimum supported year through actual SDK availability', () => {
  it('returns a genuine AD1 gap rather than a healthy empty result', async () => {
    const probe=sdk();const result=await findFreeSlots({...scope(probe.db),now:new Date('0001-01-01T00:00:00Z')},{from:'0001-01-01T00:00:00Z',to:'0001-01-01T01:00:00Z',durationMin:15,workingHours:{startHour:0,endHour:23},limit:1});
    expect(result).toMatchObject({ok:true,data:[{startsAt:'0001-01-01T00:00:00.000Z',endsAt:'0001-01-01T00:15:00.000Z'}]});
    expect(new Set(probe.calls.map(call=>call.url.pathname.split('/').at(-1)))).toEqual(new Set(['calendar_events','school_events','sports_events']));
  });
  it('retains genuine occupied absence at AD1', async () => {
    const rows=[native(1,{starts_at:'0001-01-01T00:00:00Z',ends_at:null})];const probe=sdk({rows});
    expect(await findFreeSlots({...scope(probe.db),now:new Date('0001-01-01T00:00:00Z')},{from:'0001-01-01T00:00:00Z',to:'0001-01-01T00:30:00Z',durationMin:15,workingHours:{startHour:0,endHour:23}})).toEqual({ok:true,data:[]});
  });
  it.each(['America/New_York','America/Los_Angeles'].flatMap(zone=>['free','search','title'].map(kind=>[zone,kind])))('refuses an unrepresentable family day before SDK dispatch / %s / %s', async (zone,kind) => {
    const probe=sdk(),s={...scope(probe.db,zone),now:new Date('0001-01-01T00:00:00Z')};const window={from:'0001-01-01T00:00:00Z',to:'0001-01-01T00:30:00Z'};
    const result=kind==='free'?findFreeSlots(s,{...window,durationMin:15}):kind==='search'?searchBoundaryEvents(s,window):findBoundaryTitle(probe.db,FAMILY,'Synthetic',window.from,zone);
    await expect(result).resolves.toMatchObject({ok:false,code:'invalid_input'});
    expect(probe.calls).toEqual([]);
  });
  it('keeps the supported minimum date when the bisection bracket crosses BC', () => {
    const bounds=briefingCalendarBounds('0001-01-01','America/New_York',0,1);
    expect(bounds).toMatchObject({allDayFromDay:'0001-01-01',allDayToDay:'0001-01-02'});
    for(const [instant,day]of [[bounds.timedFrom,'01'],[bounds.timedTo,'02']]){
      const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',era:'short',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).formatToParts(new Date(instant));
      const reading=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
      expect({...reading,hour:String(Number(reading.hour)%24)}).toMatchObject({era:'AD',year:'1',month:'01',day,hour:'0',minute:'00',second:'00'});
    }
  });
  it('retains supported upper DATE bounds and refuses BCE projection or UTC underflow', () => {
    expect(instantCalendarBounds('9999-12-30T12:00:00Z','9999-12-30T13:00:00Z','UTC')).toMatchObject({allDayFromDay:'9999-12-30',allDayToDay:'9999-12-31'});
    expect(()=>instantCalendarBounds('0001-01-01T00:00:00Z','0001-01-01T00:30:00Z','America/New_York')).toThrow(RangeError);
    expect(()=>briefingCalendarBounds('0001-01-01','Asia/Tokyo',0,1)).toThrow();
  });
});
