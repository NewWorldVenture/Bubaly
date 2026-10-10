import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import type {Database} from '@/lib/database.types';
import {generateFamilyNotifications} from '@/lib/server/notifications';
import {orPredicate} from './helpers/in-memory-supabase';
const family='10000000-0000-4000-8000-000000000001',member='20000000-0000-4000-8000-000000000001',user='30000000-0000-4000-8000-000000000001';
type Row=Record<string,unknown>;
let events:Row[],notices:Row[],requests:URL[],mode:'ok'|'error'|'reject'|'count'|'bound'|'dedupe-error'|'dedupe-count'|'dedupe-bound',db:ReturnType<typeof createClient<Database>>;
const event=(id:string,start:string,end:string,extra:Row={})=>({id,title:id,family_id:family,starts_at:start,ends_at:end,all_day:false,assignee_id:member,recurrence:'none',recurrence_until:null,location:null,...extra});
beforeEach(()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));vi.spyOn(console,'error').mockImplementation(()=>{});events=[];notices=[];requests=[];mode='ok';
 db=createClient<Database>('https://synthetic-notification.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init)=>{
  const url=new URL(String(input));requests.push(url);const table=url.pathname.split('/').at(-1);
  if(init?.method==='POST'){expect(table).toBe('notifications');notices.push(...JSON.parse(String(init.body)).map((row:Row,index:number)=>({...row,id:`notice-${notices.length+index}`})));return new Response(null,{status:201});}
  const dedupe=table==='notifications';if(dedupe&&mode==='dedupe-error')return Response.json({message:'Synthetic dedupe unavailable'},{status:400});
  const conflict=table==='calendar_events'&&url.searchParams.get('assignee_id')==='not.is.null';
  if(conflict&&mode==='reject')throw new Error('Synthetic conflict transport unavailable');
  if(conflict&&mode==='error')return Response.json({message:'Synthetic conflict unavailable'},{status:400});
  let rows:Row[]=table==='families'?[{id:family,timezone:'UTC'}]:table==='family_members'?[{id:member,family_id:family,is_active:true,user_id:user,display_name:'Synthetic parent',role:'parent',birthday:null}]:table==='calendar_events'?[...events]:table==='notifications'?[...notices]:[];
  for(const raw of url.searchParams.getAll('or'))rows=rows.filter(orPredicate(raw.slice(1,-1)));
  for(const [key,raw] of url.searchParams){if(['or','select','order','offset','limit'].includes(key))continue;const i=raw.indexOf('.'),op=raw.slice(0,i),v=raw.slice(i+1);rows=rows.filter(row=>op==='eq'?String(row[key])===v:op==='neq'?row[key]!=null&&String(row[key])!==v:op==='not'&&v==='is.null'?row[key]!=null:op==='gte'?String(row[key])>=v:op==='lte'?String(row[key])<=v:op==='in'?v.slice(1,-1).split(',').includes(String(row[key])):true);}
  rows.sort((a,b)=>String(a.starts_at??'').localeCompare(String(b.starts_at??''))||String(a.id).localeCompare(String(b.id)));
  const total=conflict&&mode==='bound'||dedupe&&mode==='dedupe-bound'?20001:rows.length,offset=Number(url.searchParams.get('offset')??0);rows=rows.slice(offset,offset+Math.min(2,Number(url.searchParams.get('limit')??2)));
  const headers:Record<string,string>=conflict&&mode==='count'||dedupe&&mode==='dedupe-count'?{}:{'content-range':`${offset}-${Math.max(offset,offset+rows.length-1)}/${total}`};
  if(new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object'))return Response.json(rows[0]??null,{headers});
  return Response.json(rows,{headers});
 }}});
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
const conflicts=()=>notices.filter(row=>row.title==='Schedule conflict');
describe('actual SDK → full notification generator complete conflict window',()=>{
 it('retains an ongoing native interval beside a future appointment, with original permanent key and audience',async()=>{
  events=[event('ongoing','2026-10-08T11:30:00Z','2026-10-08T13:00:00Z'),event('appointment','2026-10-08T12:30:00Z','2026-10-08T13:30:00Z'),event('foreign','2026-10-08T12:30:00Z','2026-10-08T13:30:00Z',{family_id:'other'})];
  await generateFamilyNotifications(db,family);expect(conflicts()).toHaveLength(1);expect(conflicts()[0]).toMatchObject({family_id:family,user_id:user,related_id:'conflict:appointment-ongoing'});expect(JSON.stringify(notices)).not.toContain('foreign');
  await generateFamilyNotifications(db,family);expect(conflicts()).toHaveLength(1);
 });
 it('completes more than200 rows at server cap2 before detecting the later pair',async()=>{
  events=Array.from({length:200},(_,i)=>event(`early-${i}`,new Date(Date.parse('2026-10-11T00:00:00Z')+i*3600_000).toISOString(),new Date(Date.parse('2026-10-11T00:00:00Z')+i*3600_000+600_000).toISOString()));
  events.push(event('lateA','2026-10-20T10:00:00Z','2026-10-20T11:00:00Z'),event('lateB','2026-10-20T10:30:00Z','2026-10-20T11:30:00Z'));
  await generateFamilyNotifications(db,family);expect(conflicts()).toHaveLength(1);expect(conflicts()[0].related_id).toBe('conflict:lateA-lateB');
  expect(requests.some(url=>url.searchParams.get('offset')==='200'&&url.searchParams.get('assignee_id')==='not.is.null')).toBe(true);
 });
 it('expands an older weekly master into an ongoing occurrence and retains its original family-date dedupe',async()=>{
  events=[event('weekly','2026-09-24T11:30:00Z','2026-09-24T13:00:00Z',{recurrence:'weekly'}),event('appointment','2026-10-08T12:30:00Z','2026-10-08T13:30:00Z')];
  await generateFamilyNotifications(db,family);expect(conflicts()[0]).toMatchObject({related_id:'conflict:appointment-weekly:2026-10-08',user_id:user});await generateFamilyNotifications(db,family);expect(conflicts().filter(row=>row.related_id==='conflict:appointment-weekly:2026-10-08')).toHaveLength(1);
 });
 it.each(['dedupe-error','dedupe-count','dedupe-bound'] as const)('refuses incomplete %s dedupe without inserting duplicates and retries next sweep',async failure=>{
  events=[event('ongoing','2026-10-08T11:30:00Z','2026-10-08T13:00:00Z'),event('appointment','2026-10-08T12:30:00Z','2026-10-08T13:30:00Z')];
  await generateFamilyNotifications(db,family);const before=structuredClone(notices);mode=failure;expect(await generateFamilyNotifications(db,family)).toBe(0);expect(notices).toEqual(before);expect(console.error).toHaveBeenCalledWith('[notifications] dedup read failed',expect.objectContaining({familyId:family}));mode='ok';await generateFamilyNotifications(db,family);expect(notices).toEqual(before);
 });
 it.each(['error','reject','count','bound'] as const)('logs independent conflict %s refusal, preserves another category and recovers on the next sweep',async failure=>{
  mode=failure;events=[event('ongoing','2026-10-08T11:30:00Z','2026-10-08T13:00:00Z'),event('appointment','2026-10-08T12:30:00Z','2026-10-08T13:30:00Z')];
  await generateFamilyNotifications(db,family);expect(conflicts()).toEqual([]);expect(notices.some(row=>row.type==='calendar_event'&&row.related_id==='appointment')).toBe(true);expect(console.error).toHaveBeenCalledWith('[notifications] conflict read failed',expect.objectContaining({familyId:family,error:expect.anything()}));
  mode='ok';await generateFamilyNotifications(db,family);expect(conflicts()).toHaveLength(1);expect(notices.filter(row=>row.type==='calendar_event'&&row.related_id==='appointment')).toHaveLength(1);
 });
});
