import {describe,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {wallAt,wallFromKey,wallKey,wallDaysInMonth,wallToInstant,wallWeekStart} from '@/lib/time/wall-clock';
import {toLocalInput,fromLocalInput} from '@/lib/time/local-input';
import {occurrenceDay} from '@/lib/calendar/day';
import {calendarOverlapWindowFilter,instantCalendarBounds} from '@/lib/briefing/calendar-window';
import {orPredicate} from './helpers/in-memory-supabase';
import {dayKeyInZone} from '@/lib/schedule/zoned';
import {parseExactInstant} from '@/lib/calendar/exact-instant';
import {findFreeSlots,createEvent} from '@/lib/services/calendar';
import {searchCalendarOccurrences} from '@/lib/services/calendar/search-occurrences';
vi.mock('@/lib/calendar/source-capability',()=>({CALENDAR_SOURCE_ARCHIVE_ENABLED:false}));
const FAMILY='10000000-0000-4000-8000-000000000001';
const MEMBER='50000000-0000-4000-8000-000000000001';
function sdk(rows: Record<string,Record<string,unknown>[]> = {}){
 const calls:URL[]=[];
 const db=createClient('https://calendar-boundary.synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));calls.push(url);
  expect(url.origin).toBe('https://calendar-boundary.synthetic.invalid');
  expect(init?.method??'GET').toBe('GET');
  expect(['calendar_events','school_events','sports_events']).toContain(url.pathname.split('/').at(-1));
  expect(url.searchParams.get('family_id')).toBe('eq.'+FAMILY);
  // Synthetic transport enforces the existing public AD1..9999 clock contract.
  // This is not an actual PostgreSQL/provider request.
  if([...url.searchParams.values()].some(value=>/0000-\d{2}-\d{2}T/.test(value)))return Response.json({code:'22008',message:'Synthetic refuses unsupported year-zero query literal'},{status:400});
    const table=url.pathname.split('/').at(-1)!;
  const selected=(rows[table]??[]).filter(row=>[...url.searchParams].every(([key,value])=>{
    if(['select','order','limit','offset'].includes(key))return true;
    return orPredicate(key==='or'?value.slice(1,-1):key+'.'+value)(row);
  }));
  const offset=Number(url.searchParams.get('offset')??0),limit=Number(url.searchParams.get('limit')??1000),page=selected.slice(offset,offset+limit);
  return Response.json(page,{headers:{'content-range':offset+'-'+(offset+page.length-1)+'/'+selected.length}});
 }}});
 return {db,calls};
}
function scope(db:ReturnType<typeof sdk>['db'],now:string,tz='UTC'){return {db,familyId:FAMILY,userId:MEMBER,memberId:MEMBER,role:'parent' as const,actorKind:'member' as const,tz,now:new Date(now)};}
describe('cross-caller lower domain contract review',()=>{
 it('wallAt preserves AD1 rather than Date.UTC remapping it to1901',()=>{
  const actual=wallAt(new Date('0001-01-01T12:30:00Z'),'UTC').toISOString();
  expect(actual).toBe('0001-01-01T12:30:00.000Z');
 });
 it('family local-input prefill remains a four-digit AD1 value',()=>{
  const actual=toLocalInput('0001-01-01T12:30:00Z','UTC');
  expect(actual).toBe('0001-01-01T12:30');
  expect(fromLocalInput(actual,'UTC')).toBe('0001-01-01T12:30:00.000Z');
 });
 it('minimum overlap filter never emits a clock its own admission parser refuses',()=>{
  const bounds=instantCalendarBounds('0001-01-01T00:00:00Z','0001-01-01T01:00:00Z','UTC'),filter=calendarOverlapWindowFilter(bounds);
  const literals=filter.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g)??[];
  expect(literals.length).toBeGreaterThan(0);
  for(const literal of literals)expect(()=>parseExactInstant(literal)).not.toThrow();
 });
 it.each(['0001-01-01T00:00:00Z','0001-01-01T01:00:00Z','2026-10-08T00:00:00Z'])('actual SDK free-slot query obeys existing AD domain / %s',async from=>{
  const probe=sdk(),to=new Date(Date.parse(from)+3600000).toISOString();
  const result=await findFreeSlots(scope(probe.db,from),{from,to,durationMin:15,workingHours:{startHour:0,endHour:23},limit:1});
  expect(probe.calls).not.toHaveLength(0);
  expect(probe.calls.some(url=>[...url.searchParams.values()].some(value=>/0000-\d{2}-\d{2}T/.test(value)))).toBe(false);
  expect(result).toMatchObject({ok:true,data:[{startsAt:new Date(from).toISOString(),endsAt:new Date(Date.parse(from)+900000).toISOString()}]});
 });
 it('all-day AD1 DATE retains its own day west of UTC',()=>{
  expect(occurrenceDay({starts_at:'0001-01-01T00:00:00Z',all_day:true},'America/New_York')).toBe('0001-01-01');
 });
 it('existing complete occurrence search refuses BCE projection before SDK',async()=>{
  const probe=sdk();
  const result=await searchCalendarOccurrences(scope(probe.db,'0001-01-01T00:00:00Z','America/New_York'),{from:'0001-01-01T00:00:00Z',to:'0001-01-01T00:30:00Z'});
  expect(result).toMatchObject({ok:false,code:'invalid_input'});expect(probe.calls).toEqual([]);
 });
});
describe('supported boundary callers preserve public clock contracts',()=>{
 it.each(['0001-01-01','0004-02-29','0099-12-31'])('native input constructor preserves the local year / %s',day=>{
  const local=day+'T12:30',resolved=fromLocalInput(local)!;
  expect(new Date(resolved).getFullYear()).toBe(Number(day.slice(0,4)));
  expect(toLocalInput(resolved)).toBe(local);
 });
 it('wall day/month arithmetic preserves the supported minimum and common-era leap day',()=>{
  expect(wallKey(wallFromKey('0001-01-01'))).toBe('0001-01-01');
  expect(wallKey(wallWeekStart(wallFromKey('0001-01-01')))).toBe('0001-01-01');
  expect(wallDaysInMonth(wallFromKey('0004-02-01'))).toBe(29);
 });
 it('keeps astronomical arithmetic internal and refuses unsupported public wall keys/instants',()=>{
  expect(Number.isNaN(wallFromKey('0000-01-01').getTime())).toBe(true);
  expect(wallKey(wallAt(new Date('0001-01-01T00:00:00Z'),'America/New_York'))).toBe('');
  expect(Number.isNaN(wallToInstant(wallFromKey('0001-01-01'),'Asia/Tokyo').getTime())).toBe(true);
  expect(toLocalInput('0001-01-01T00:00:00Z','America/New_York')).toBe('');
  expect(fromLocalInput('0000-01-01T12:00','UTC')).toBe('0000-01-01T12:00');
 });
 it('actual calendar write refuses an unrepresentable local conversion before SDK',async()=>{
  const probe=sdk(),resolved=fromLocalInput('0001-01-01T00:00','Asia/Tokyo')!;
  expect(resolved).toMatch(/^0000-/);
  const result=await createEvent(scope(probe.db,'0001-01-01T00:00:00Z','Asia/Tokyo'),{title:'Synthetic boundary',startsAt:resolved,allDay:false});
  expect(result).toMatchObject({ok:false,code:'invalid_input'});expect(probe.calls).toEqual([]);
 });
 it.each([
  [Date.parse('0001-01-01T12:00:00Z'),'Mars/Olympus','0001-01-01'],
  [Date.parse('0000-12-31T12:00:00Z'),'Mars/Olympus',null],
  [Date.parse('+010000-01-01T12:00:00Z'),'Mars/Olympus',null],
  [8640000000000001,'UTC',null],
  [1e30,'Mars/Olympus',null],
 ] as const)('pure day key keeps its null domain even when zone fallback runs / %s', (ms,zone,expected)=>{
  expect(()=>dayKeyInZone(ms,zone)).not.toThrow();
  expect(dayKeyInZone(ms,zone)).toBe(expected);
 });
 const fields={family_id:FAMILY,id:'40000000-0000-4000-8000-000000000001',starts_at:'0001-01-01T00:00:00.000Z',ends_at:null,member_id:null,recurrence:'none',recurrence_until:null};
 const native={...fields,title:'Synthetic minimum',description:null,location:null,category:'general',all_day:false,assignee_id:null,feed_id:null,external_uid:null,created_by:null,onboarding_key:null,idempotency_key:null,created_at:'2026-10-01T00:00:00Z',updated_at:'2026-10-01T00:00:00Z'};
 it.each(['calendar_events','school_events','sports_events'].flatMap(table=>[
  [table,'0001-01-01T00:30:00Z',false],
  [table,'0001-01-01T00:59:59.999999Z',false],
  [table,'0001-01-01T01:00:00Z',true],
 ] as const))('retains exact-minimum missing-end occupancy and exact-hour strictness / %s / %s',async(table,from,hasSlot)=>{
  const probe=sdk({[table]:[table==='calendar_events'?native:fields]});
  const to=hasSlot?'0001-01-01T01:30:00Z':from.includes('00:30')?'0001-01-01T00:45:00Z':'0001-01-01T01:00:00Z';
  const result=await findFreeSlots(scope(probe.db,from),{from,to,durationMin:30,workingHours:{startHour:0,endHour:23},limit:1});
  const filters=probe.calls.filter(url=>url.pathname.endsWith('/'+table)).flatMap(url=>url.searchParams.getAll('or')).filter(value=>value.includes('ends_at.is.null'));
  expect(filters).not.toHaveLength(0);
  const operator=hasSlot?'gt':'gte';
  for(const filter of filters)expect(filter).toContain('ends_at.is.null,starts_at.'+operator+'.0001-01-01T00:00:00.000Z');
  expect(probe.calls.some(url=>[...url.searchParams.values()].some(value=>/0000-\d{2}-\d{2}T/.test(value)))).toBe(false);
  expect(result).toMatchObject({ok:true,data:hasSlot?[{startsAt:'0001-01-01T01:00:00.000Z',endsAt:'0001-01-01T01:30:00.000Z'}]:[]});
 });
});
