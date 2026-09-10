import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { verifyOnboardingOwner } from '@/lib/onboarding/verify-owner';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
const userId='11111111-1111-4111-8111-111111111111';
const familyId='22222222-2222-4222-8222-222222222222';
const otherFamily='33333333-3333-4333-8333-333333333333';
let db= createInMemorySupabase({userId});
const read=()=>db as unknown as SupabaseClient<Database>;
beforeEach(()=>{db=createInMemorySupabase({userId});});
afterEach(()=>vi.restoreAllMocks());
function owned(source='wizard'){
 db.seed('family_members',[{user_id:userId,family_id:familyId,role:'parent',is_active:true}]);
 db.seed('families',[{id:familyId,created_by:userId}]);
 db.seed('user_preferences',[{user_id:userId,active_family_id:familyId}]);
 db.seed('onboarding_progress',[{user_id:userId,family_id:familyId,source,status:'in_progress'}]);
}
describe('fresh out-of-band onboarding ownership assertions',()=>{
 it('permits a new account with no family and performs no write',async()=>{
  expect(await verifyOnboardingOwner(read(),userId,{userId,familyId:null})).toBe(true);
  expect(db.table('families')).toHaveLength(0);
 });
 it.each(['wizard','auto_provision'])('permits same-user %s family adoption after the no-family render',async(source)=>{
  owned(source);expect(await verifyOnboardingOwner(read(),userId,{userId,familyId:null})).toBe(true);
 });
 it('permits a same-family idempotent Finish retry after completion',async()=>{
  owned();db.table('onboarding_progress')[0].status='completed';
  expect(await verifyOnboardingOwner(read(),userId,{userId,familyId:null})).toBe(true);
 });
 it.each(['active-family','foreign-owner','invite','multiple-memberships','non-parent','missing-marker'] as const)('does not adopt %s context from an old no-family screen',async(change)=>{
  owned();
  if(change==='active-family')db.table('user_preferences')[0].active_family_id=otherFamily;
  if(change==='foreign-owner')db.table('families')[0].created_by=otherFamily;
  if(change==='invite')db.table('onboarding_progress')[0].source='invite';
  if(change==='multiple-memberships')db.seed('family_members',[{user_id:userId,family_id:otherFamily,role:'parent',is_active:true}]);
  if(change==='non-parent')db.table('family_members')[0].role='adult';
  if(change==='missing-marker')db.replace('onboarding_progress',[]);
  expect(await verifyOnboardingOwner(read(),userId,{userId,familyId:null})).toBe(false);
 });
 it('compares an existing family with its freshly selected active family',async()=>{
  owned();expect(await verifyOnboardingOwner(read(),userId,{userId,familyId})).toBe(true);
  expect(await verifyOnboardingOwner(read(),userId,{userId,familyId:otherFamily})).toBe(false);
 });
 it('rejects a changed user before any family query',async()=>{
  const from=vi.spyOn(db,'from');expect(await verifyOnboardingOwner(read(),userId,{userId:otherFamily,familyId:null})).toBe(false);expect(from).not.toHaveBeenCalled();
 });
 it('rejects malformed explicit assertions and never treats them as an omitted legacy argument',async()=>{
  expect(await verifyOnboardingOwner(read(),userId,{userId,familyId:undefined} as never)).toBe(false);
  expect(await verifyOnboardingOwner(read(),userId,null as never)).toBe(false);
 });
});
