import { beforeEach, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
const m = vi.hoisted(() => ({ context: vi.fn(), server: vi.fn(), refresh: vi.fn(), activity: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: m.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: m.server }));
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: m.activity }));
vi.mock('next/cache', () => ({ revalidatePath: m.refresh }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
import { createReminderAction } from '@/app/(app)/dashboard/reminders/actions';
import { createReminder, type CreateReminderInput } from '@/lib/services/reminders';
import { scopeKey } from '@/lib/services/idempotency';
import type { ServiceScope } from '@/lib/services/types';
const family='aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const user='bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const member='cccccccc-cccc-4ccc-8ccc-000000000001';
const submission='dddddddd-dddd-4ddd-8ddd-000000000001';
const secondSubmission='dddddddd-dddd-4ddd-8ddd-000000000002';
const original={title:'Take out bins',notes:'Use the blue bin',remindAt:'2026-11-02T12:00:00.000Z',submissionId:submission};
let rows: Record<string,unknown>[], receipts: { method: string; table: string; payload?: Record<string,unknown> }[], mode:string;
let winnerPatch: Record<string, unknown>;
beforeEach(()=>{
 rows=[];receipts=[];mode='healthy';winnerPatch={};vi.clearAllMocks();m.activity.mockResolvedValue(undefined);
 m.context.mockResolvedValue({user:{id:user},active:{familyId:family,role:'parent',member:{id:member},family:{timezone:'UTC'}}});
 const db=createClient('https://synthetic-reminder-receipt.invalid','synthetic-not-a-secret',{
 auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
 global:{fetch:async(input,init)=>{
  const url=new URL(String(input));expect(url.origin).toBe('https://synthetic-reminder-receipt.invalid');
  const table=url.pathname.slice('/rest/v1/'.length);expect(url.pathname).toBe('/rest/v1/'+table);expect(table).toBe('family_reminders');
  const method=String(init?.method);expect(['GET','POST']).toContain(method);
  const payload=init?.body ? JSON.parse(String(init.body)) as Record<string,unknown> : undefined;
  receipts.push({method,table,payload});expect(receipts.length).toBeLessThanOrEqual(4);
  const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  if(method==='GET'){
   expect(table).toBe('family_reminders');expect(url.searchParams.get('family_id')).toBe('eq.'+family);expect(url.searchParams.get('limit')).toBe('1');
   const key=url.searchParams.get('idempotency_key');expect(key).toMatch(/^eq\.[a-f0-9]{64}$/);
   if(mode==='read-transport') throw new Error('Synthetic reminder read transport refused');
   if(mode==='probe-error')return reply({code:'42501',message:'Synthetic ordinary reminder read refused'},403);
   return reply(rows.filter(row=>row.family_id===family && 'eq.'+row.idempotency_key===key));
  }
  expect(payload?.family_id).toBe(family);
  expect(payload?.created_by).toBe(user);expect(payload?.idempotency_key === null || /^[a-f0-9]{64}$/.test(String(payload?.idempotency_key))).toBe(true);
  if(mode==='post-transport') throw new Error('Synthetic reminder write transport refused');
  if(mode==='race') { rows.push({...payload,...winnerPatch,id:'race-winner'}); return reply({code:'23505',message:'Synthetic keyed winner already exists'},409); }
  if(mode==='write-error')return reply({code:'42501',message:'Synthetic ordinary reminder write refused'},403);
  const stored={...payload,id:'reminder-'+(rows.length+1)};rows.push(stored);return reply(stored,201);
 }}});
 m.server.mockResolvedValue(db);
});
const writes=()=>receipts.filter(r=>r.method==='POST'&&r.table==='family_reminders');
const audits=()=>m.activity.mock.calls;
it('healthy ordinary create saves exactly requested scoped content and one inert activity call',async()=>{
 expect(await createReminderAction(original)).toEqual({ok:true,id:'reminder-1'});expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({family_id:family,title:original.title,notes:original.notes,remind_at:original.remindAt});expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);expect(m.refresh).toHaveBeenCalledWith('/dashboard/reminders');
});
it('identical keyed retry is one confirmed reminder and one inert activity call',async()=>{
 const first=await createReminderAction(original);expect(first).toEqual({ok:true,id:'reminder-1'});expect(await createReminderAction({...original})).toEqual(first);expect(rows).toHaveLength(1);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it.each([
 {name:'title',patch:{title:'Take out recycling'}},
 {name:'time',patch:{remindAt:'2026-11-03T12:00:00.000Z'}},
 {name:'notes',patch:{notes:'Use the green bin'}},
])('does not certify a changed $name under the settled submission as the requested save',async({patch})=>{
 expect(await createReminderAction(original)).toEqual({ok:true,id:'reminder-1'});
 const retry=await createReminderAction({...original,...patch});
 expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);expect(rows[0]).toMatchObject({title:original.title,notes:original.notes,remind_at:original.remindAt});
 expect(retry.ok,'a settled submission cannot certify content it did not save').toBe(false);
});
it('a new submission creates the changed content as a separate confirmed reminder',async()=>{
 expect(await createReminderAction(original)).toEqual({ok:true,id:'reminder-1'});
 expect(await createReminderAction({...original,title:'Take out recycling',submissionId:secondSubmission})).toEqual({ok:true,id:'reminder-2'});expect(rows).toHaveLength(2);expect(rows[1].title).toBe('Take out recycling');expect(writes()).toHaveLength(2);expect(audits()).toHaveLength(2);
});
it('failed keyed read refuses without a reminder write or inert activity call',async()=>{
 mode='probe-error';expect((await createReminderAction(original)).ok).toBe(false);expect(writes()).toHaveLength(0);expect(audits()).toHaveLength(0);expect(rows).toHaveLength(0);
});


// The seven original readonly assertions above remain byte-for-byte intact.
// Exercise persisted composition semantics through the actual SDK, without a backend.
const serviceOriginal: CreateReminderInput = {
  title: original.title, notes: original.notes, remindAt: original.remindAt,
  kind: 'time', recurrence: 'none', priority: 'medium', locationName: 'Garage',
  memberId: member, assignedToUserId: user, aiSuggested: false, tags: ['bin', 'weekly'],
};
async function directScope(extra: Partial<ServiceScope> = {}): Promise<ServiceScope> {
  return { db: await m.server(), familyId: family, userId: user, memberId: member,
    role: 'parent', actorKind: 'member', tz: 'UTC', idempotencyKey: 'a'.repeat(64), ...extra };
}
const differentMember='cccccccc-cccc-4ccc-8ccc-000000000002';
const differentUser='bbbbbbbb-bbbb-4bbb-8bbb-000000000002';
const fieldChanges: { name: string; patch: Partial<CreateReminderInput> }[] = [
  {name:'title',patch:{title:'Take out recycling'}},
  {name:'notes',patch:{notes:'Use the green bin'}},
  {name:'kind',patch:{kind:'school'}},
  {name:'remind_at',patch:{remindAt:'2026-11-03T12:00:00.000Z'}},
  {name:'location_name',patch:{locationName:'Shed'}},
  {name:'recurrence',patch:{recurrence:'weekly'}},
  {name:'priority',patch:{priority:'urgent'}},
  {name:'assigned_to_id',patch:{assignedToUserId:differentUser}},
  {name:'member_id',patch:{memberId:differentMember}},
  {name:'ai_suggested',patch:{aiSuggested:true}},
  {name:'ordered tags',patch:{tags:['weekly','bin']}},
];
it.each(fieldChanges)('opt-in service refuses changed persisted $name without another save',async({patch})=>{
  const scope=await directScope();
  expect((await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).ok).toBe(true);
  const stored={...rows[0]};
  const retry=await createReminder(scope,{...serviceOriginal,...patch},{rejectChangedRetry:true});
  expect(retry).toMatchObject({ok:false,code:'already_saved'});
  if(!retry.ok) expect(retry.error).toBe('An earlier try already saved this reminder. Nothing was added or changed this time.');
  expect(rows).toEqual([stored]);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it.each([
 {name:'kind',patch:{kind:'school'}},
 {name:'priority',patch:{priority:'urgent'}},
 {name:'member',patch:{memberId:differentMember}},
 {name:'ai flag',patch:{aiSuggested:true}},
])('action propagates settled-submission refusal for changed $name',async({patch})=>{
  expect(await createReminderAction(original)).toEqual({ok:true,id:'reminder-1'});
  const result=await createReminderAction({...original,...patch});
  expect(result).toMatchObject({ok:false,code:'already_saved'});
  expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);expect(m.refresh).toHaveBeenCalledTimes(1);
});
it('equivalent trimmed values, defaults, UUID case and timestamp offsets remain the same save',async()=>{
  const scope=await directScope();
  const first=await createReminder(scope,serviceOriginal,{rejectChangedRetry:true});
  rows[0].remind_at='2026-11-02T12:00:00+00:00';
  const retry=await createReminder(scope,{...serviceOriginal,
    title:'  '+serviceOriginal.title+'  ',notes:'  '+serviceOriginal.notes+'  ',locationName:' Garage ',
    remindAt:'2026-11-02T07:00:00-05:00',memberId:member.toUpperCase(),assignedToUserId:user.toUpperCase(),
    kind:'illegal-kind',recurrence:'illegal-recurrence',priority:'illegal-priority',aiSuggested:undefined,
  },{rejectChangedRetry:true});
  expect(retry).toEqual(first.ok ? {...first,data:{...first.data,remind_at:'2026-11-02T12:00:00+00:00'}} : first);
  expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it('blank optional text and nullable identifiers normalize without changing the confirmed save',async()=>{
  const scope=await directScope();
  const input={title:original.title,remindAt:original.remindAt};
  const first=await createReminder(scope,input,{rejectChangedRetry:true});
  const retry=await createReminder(scope,{...input,notes:' ',locationName:' ',memberId:null,assignedToUserId:null,tags:[]},{rejectChangedRetry:true});
  expect(retry).toEqual(first);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it('AI actor default true is equivalent to explicit true',async()=>{
  const scope=await directScope({actorKind:'ai'});const input={...serviceOriginal,aiSuggested:undefined};
  const first=await createReminder(scope,input,{rejectChangedRetry:true});
  expect(await createReminder(scope,{...input,aiSuggested:true},{rejectChangedRetry:true})).toEqual(first);
  expect(rows[0].ai_suggested).toBe(true);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it('AI actor default true does not certify an explicit false retry',async()=>{
  const scope=await directScope({actorKind:'ai'});
  expect((await createReminder(scope,{...serviceOriginal,aiSuggested:undefined},{rejectChangedRetry:true})).ok).toBe(true);
  expect(await createReminder(scope,{...serviceOriginal,aiSuggested:false},{rejectChangedRetry:true})).toMatchObject({ok:false,code:'already_saved'});
  expect(rows[0].ai_suggested).toBe(true);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it('lifecycle and creator changes alone do not change the saved composition',async()=>{
  const scope=await directScope();expect((await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).ok).toBe(true);
  Object.assign(rows[0],{status:'completed',completed_at:'2026-11-02T13:00:00.000Z',snoozed_until:'2026-11-02T14:00:00.000Z',created_by:differentUser,updated_at:'2026-11-02T15:00:00.000Z'});
  const stored={...rows[0]};
  expect(await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).toEqual({ok:true,data:stored});
  expect(rows).toEqual([stored]);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it('a row edited after saving is refused according to its current composition',async()=>{
  const scope=await directScope();expect((await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).ok).toBe(true);
  rows[0].notes='A later family edit';
  expect(await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).toMatchObject({ok:false,code:'already_saved'});
  expect(rows[0].notes).toBe('A later family edit');expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it.each([undefined,{rejectChangedRetry:false}])('default operation-key policy still returns its prior outcome (%s)',async opts=>{
  const scope=await directScope();const first=await createReminder(scope,serviceOriginal,opts);
  expect(await createReminder(scope,{...serviceOriginal,title:'Recomputed operation title',notes:'Recomputed details'},opts)).toEqual(first);
  expect(rows[0].title).toBe(serviceOriginal.title);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it('run-step default callers keep the original three-field key when notes change',async()=>{
  const scope=await directScope({idempotencyKey:null,runId:'ordinary-run',stepId:'ordinary-step'});
  const first=await createReminder(scope,serviceOriginal);
  const key=scopeKey(scope,'reminders.createReminder',{title:serviceOriginal.title,remindAt:serviceOriginal.remindAt,memberId:serviceOriginal.memberId??null});
  expect(rows[0].idempotency_key).toBe(key);
  expect(await createReminder(scope,{...serviceOriginal,notes:'Recomputed operation notes'})).toEqual(first);
  expect(rows[0].notes).toBe(serviceOriginal.notes);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(1);
});
it('unkeyed opt-in callers still create independently',async()=>{
  const scope=await directScope({idempotencyKey:null});
  expect((await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).ok).toBe(true);
  expect((await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).ok).toBe(true);
  expect(rows).toHaveLength(2);expect(writes()).toHaveLength(2);expect(audits()).toHaveLength(2);
});
it.each(['identical','changed'] as const)('losing insert re-probe compares the %s winner without claiming its activity',async variant=>{
  const scope=await directScope();mode='race';winnerPatch=variant==='changed'?{notes:'Winner used different notes'}:{};
  const result=await createReminder(scope,serviceOriginal,{rejectChangedRetry:true});
  if(variant==='changed')expect(result).toMatchObject({ok:false,code:'already_saved'});
  else expect(result).toMatchObject({ok:true,data:{id:'race-winner',notes:serviceOriginal.notes}});
  expect(rows).toHaveLength(1);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(0);
  expect(receipts.map(r=>r.method)).toEqual(['GET','POST','GET']);
});
it.each(['write-error','post-transport'] as const)('a genuine %s with no winner remains a database failure',async failure=>{
  const scope=await directScope();mode=failure;
  expect(await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).toMatchObject({ok:false,code:'db'});
  expect(rows).toHaveLength(0);expect(writes()).toHaveLength(1);expect(audits()).toHaveLength(0);
  expect(receipts.map(r=>r.method)).toEqual(['GET','POST','GET']);
});
it('a transport-refused initial read cannot fall through to a save',async()=>{
  const scope=await directScope();mode='read-transport';
  expect(await createReminder(scope,serviceOriginal,{rejectChangedRetry:true})).toMatchObject({ok:false,code:'db'});
  expect(rows).toHaveLength(0);expect(writes()).toHaveLength(0);expect(audits()).toHaveLength(0);expect(receipts).toHaveLength(4);expect(receipts.every(r=>r.method==='GET')).toBe(true);
});
it.each([
 {name:'blank title',patch:{title:' '}},
 {name:'invalid time',patch:{remindAt:'not-an-instant'}},
 {name:'missing location',patch:{kind:'location',locationName:null}},
])('validation of $name remains before any duplicate probe',async({patch})=>{
  const scope=await directScope();
  expect(await createReminder(scope,{...serviceOriginal,...patch},{rejectChangedRetry:true})).toMatchObject({ok:false,code:'invalid_input'});
  expect(receipts).toHaveLength(0);expect(writes()).toHaveLength(0);expect(audits()).toHaveLength(0);
});
