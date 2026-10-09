import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { fromLocalInput, toLocalInput } from '@/lib/time/local-input';

const mocks=vi.hoisted(()=>({requireUserContext:vi.fn(),createServer:vi.fn(),revalidatePath:vi.fn()}));
vi.mock('@/lib/supabase/auth',()=>({requireUserContext:mocks.requireUserContext}));
vi.mock('@/lib/supabase/server',()=>({createServer:mocks.createServer}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidatePath}));
import {createCalendarEventAction,updateCalendarEventAction} from '@/app/(app)/dashboard/calendar/actions';

const instants=[
 ['New York first fold','2026-11-01T05:30:00.000Z','America/New_York'],
 ['New York second fold','2026-11-01T06:30:00.000Z','America/New_York'],
 ['London first fold','2026-10-25T00:30:00.000Z','Europe/London'],
 ['London second fold','2026-10-25T01:30:00.000Z','Europe/London'],
 ['Los Angeles first fold','2026-11-01T08:30:00.000Z','America/Los_Angeles'],
 ['Los Angeles second fold','2026-11-01T09:30:00.000Z','America/Los_Angeles'],
 ['Lord Howe first half-hour fold','2026-04-04T14:45:00.000Z','Australia/Lord_Howe'],
 ['Lord Howe second half-hour fold','2026-04-04T15:15:00.000Z','Australia/Lord_Howe'],
 ['UTC seconds and milliseconds','2026-10-09T12:30:29.456Z','UTC'],
 ['original offset spelling','2026-11-01T01:30:29.456-05:00','America/New_York'],
 ['PostgreSQL microseconds','2026-10-09T12:30:29.456789Z','UTC'],
 ['declared nanoseconds','2026-10-09T12:30:29.456789012Z','UTC'],
 ['AD1 exact original','0001-01-01T12:30:29.456789012Z','UTC'],
 ['AD9999 exact original','9999-12-31T12:30:29.456789012Z','UTC'],
] as const;

describe('unchanged minute boxes retain their own original instant',()=>{
 it.each(instants)('%s preserves exact original bytes through three saves',(_name,original,zone)=>{
  let stored:string=original;
  for(let save=0;save<3;save++){
   const box=toLocalInput(stored,zone);
   expect(box).not.toBe('');
   const next=fromLocalInput(box,zone,stored);
   expect(next).toBe(original);stored=next!;
  }
 });
 it('the same repeated box can retain two distinct owned instants',()=>{
  const first='2026-11-01T05:30:00.000Z',second='2026-11-01T06:30:00.000Z';
  const box=toLocalInput(first,'America/New_York');
  expect(box).toBe(toLocalInput(second,'America/New_York'));
  expect(fromLocalInput(box,'America/New_York',first)).toBe(first);
  expect(fromLocalInput(box,'America/New_York',second)).toBe(second);
  expect(Date.parse(fromLocalInput(box,'America/New_York',second)!)-Date.parse(fromLocalInput(box,'America/New_York',first)!)).toBe(3600000);
 });
 it('without a family zone, matching device prefill preserves stored seconds',()=>{
  const original='2026-10-09T12:30:29.456Z';
  expect(fromLocalInput(toLocalInput(original),undefined,original)).toBe(original);
 });
 it('only the submitted box is trimmed before comparison',()=>{
  const original='2026-10-09T12:30:29.456Z';
  expect(fromLocalInput('  2026-10-09T12:30  ','UTC',original)).toBe(original);
 });
});

describe('hint admission does not change the existing two-argument policy',()=>{
 it.each(['UTC','America/New_York','Europe/London','not/a-zone'])('changed wall minute uses the inherited resolution in %s',zone=>{
  const original='2026-11-01T06:30:29.456Z',changed=toLocalInput(original,zone).replace(/:30$/,':31');
  expect(fromLocalInput(changed,zone,original)).toBe(fromLocalInput(changed,zone));
  expect(fromLocalInput(changed,zone,original)).not.toBe(original);
 });
 it.each([undefined,null,'','not an instant','0000-01-01T00:00:00Z'])('unusable hint %s cannot override the two-argument result',hint=>{
  expect(fromLocalInput('2026-10-09T12:30','UTC',hint)).toBe(fromLocalInput('2026-10-09T12:30','UTC'));
 });
 it('a seconds edit is resolved, rather than hidden by the old minute prefill',()=>{
  const original='2026-10-09T12:30:29.456Z';
  expect(fromLocalInput('2026-10-09T12:30:45.250','UTC',original)).toBe('2026-10-09T12:30:45.250Z');
 });
 it.each([null,undefined,'','   '])('blank %s keeps leave-alone semantics',box=>{
  expect(fromLocalInput(box,'UTC','2026-10-09T12:30:29.456Z')).toBeUndefined();
 });
 it.each(['2026-11-01T01:30:29.456-05:00','2026-10-09T12:30:29.456Z','0000-01-01T12:30'])('existing absolute or unsupported naive passthrough remains %s',value=>{
  expect(fromLocalInput(value,'UTC','2026-10-09T12:30:29.456Z')).toBe(value);
 });
 it('spring-gap edits keep the existing family-zone choice',()=>{
  expect(fromLocalInput('2026-03-08T02:30','America/Los_Angeles','2026-03-07T10:30:00Z')).toBe(fromLocalInput('2026-03-08T02:30','America/Los_Angeles'));
 });
});

let db:ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
beforeEach(()=>{
 vi.clearAllMocks();
 db=createInMemorySupabase<SupabaseClient<Database>>({defaults:{calendar_events:{description:null,location:null,ends_at:null,all_day:false,category:'general',recurrence:'none',recurrence_until:null,assignee_id:null,idempotency_key:null}},uniques:{calendar_events:[['family_id','idempotency_key']]}});
 mocks.requireUserContext.mockResolvedValue({user:{id:'synthetic-user'},active:{familyId:'synthetic-family',role:'parent',family:{name:'Synthetic',timezone:'America/New_York'},member:{id:'synthetic-member'}}});
 mocks.createServer.mockResolvedValue(db);
});

describe('real calendar action with synthetic Auth and in-memory SDK storage',()=>{
 it.each([
  ['fold spanning identical boxes','2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z'],
  ['sub-minute imported row','2026-10-09T12:30:29.456Z','2026-10-09T13:30:42.789Z'],
 ])('%s preserves both fields on three unrelated-title edits',async(_name,start,end)=>{
  const created=await createCalendarEventAction({title:'Synthetic event',startsAt:start,endsAt:end,submissionId:'11111111-1111-4111-8111-111111111111'});
  expect(created.ok).toBe(true);if(!created.ok)throw Error(created.error);
  for(let n=0;n<3;n++){
   const row=db.table('calendar_events').find(r=>r.id===created.id)!;
   const ownStart=row.starts_at as string,ownEnd=row.ends_at as string;
   const startBox=toLocalInput(ownStart,'America/New_York'),endBox=toLocalInput(ownEnd,'America/New_York');
   const result=await updateCalendarEventAction(created.id,{title:`Synthetic title ${n}`,startsAt:fromLocalInput(startBox,'America/New_York',ownStart)!,endsAt:fromLocalInput(endBox,'America/New_York',ownEnd)!});
   expect(result.ok).toBe(true);
   const saved=db.table('calendar_events').find(r=>r.id===created.id)!;
   expect(saved.starts_at).toBe(start);expect(saved.ends_at).toBe(end);
   expect(saved.family_id).toBe('synthetic-family');
  }
 });
 it('the actual modal passes each existing field to its matching helper',()=>{
  const source=readFileSync(join(process.cwd(),'components/modules/calendar-module.tsx'),'utf8');
  expect(source).toContain('fromLocalInput(parsed.data.starts_at, timeZone, existing?.starts_at)');
  expect(source).toContain('fromLocalInput(parsed.data.ends_at, timeZone, existing?.ends_at)');
  expect(source).toContain('defaultValue={toLocalInput(existing?.starts_at ?? null, timeZone)}');
  expect(source).toContain('defaultValue={toLocalInput(existing?.ends_at ?? null, timeZone)}');
  expect(source).not.toContain('family_id: existing');
 });
});


describe('optional hints require strict valid absolute instants only',()=>{
 it.each([
  '2026-02-30T12:30:29.456Z',
  '2026-10-09',
  '2026-10-09T12:30:29.456',
  'Fri, 09 Oct 2026 12:30:29 GMT',
  '2026-10-09T12:30:29.456z',
  '2026-10-09 12:30:29.456Z',
  '2026-10-09T12:30:29.456+0000',
  '2026-10-09T12:30:29.456Z ',
  '2026-10-09T12:30:29.1234567890Z',
  '2026-10-09T24:00:00.000Z',
  '0000-01-01T12:30:29.456Z',
 ])('rejects original hint %s without changing the existing submitted-value resolution',hint=>{
  const box=toLocalInput(hint,'UTC')||'2026-10-09T12:30';
  expect(fromLocalInput(box,'UTC',hint)).toBe(fromLocalInput(box,'UTC'));
  expect(fromLocalInput(box,'UTC',hint)).not.toBe(hint);
 });
 it.each(['America/New_York','Asia/Tokyo','Europe/London'])('a box rendered in UTC is not preserved under a shifted %s frame',zone=>{
  const original='2026-10-09T12:30:29.456789012Z',box=toLocalInput(original,'UTC');
  expect(box).not.toBe(toLocalInput(original,zone));
  expect(fromLocalInput(box,zone,original)).toBe(fromLocalInput(box,zone));
  expect(fromLocalInput(box,zone,original)).not.toBe(original);
 });
 it('an invalid zone preserves only the matching device-frame prefill',()=>{
  const original='2026-10-09T12:30:29.456789012Z',box=toLocalInput(original,'invalid/zone');
  expect(fromLocalInput(box,'invalid/zone',original)).toBe(original);
 });
 it('valid hint admission never reads the ambient clock',()=>{
  const original='2026-10-09T12:30:29.456789012Z',box=toLocalInput(original,'UTC');
  const ambient=vi.spyOn(Date,'now').mockImplementation(()=>{throw Error('Unexpected ambient clock');});
  try{expect(fromLocalInput(box,'UTC',original)).toBe(original);expect(ambient).not.toHaveBeenCalled();}finally{ambient.mockRestore();}
 });
});
