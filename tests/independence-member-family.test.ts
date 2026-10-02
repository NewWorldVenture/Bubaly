import {beforeEach,expect,it,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
const state=vi.hoisted(()=>({db:null as any,role:'parent',audits:[] as any[],serverCalls:0}));
vi.mock('@/lib/supabase/auth',()=>({requireUserContext:async()=>({user:{id:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'},active:{familyId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',role:state.role}})}));
vi.mock('@/lib/supabase/server',()=>({createServer:async()=>{state.serverCalls++;return state.db;}}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=>((key:string)=>key)}));
vi.mock('@/lib/server/audit',()=>({logAudit:async(_db:any,payload:any)=>{state.audits.push(payload);}}));
import {startMilestoneAction} from '@/app/(app)/dashboard/independence/actions';
const family='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',foreignFamily='aaaaaaaa-aaaa-4aaa-8aaa-000000000002';
const ownMember='cccccccc-cccc-4ccc-8ccc-000000000001',foreignMember='cccccccc-cccc-4ccc-8ccc-000000000002',missingMember='cccccccc-cccc-4ccc-8ccc-000000000003';
const title='Packs their school bag';
let rows:any[],requests:any[],mode:string;
beforeEach(()=>{rows=[];requests=[];mode='healthy';state.role='parent';state.audits=[];state.serverCalls=0;
 const roster=[{id:ownMember,family_id:family},{id:foreignMember,family_id:foreignFamily}];
 state.db=createClient('https://synthetic-independence.invalid','synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input:any,init:any)=>{
  const u=new URL(String(input));expect(u.origin).toBe('https://synthetic-independence.invalid');const table=u.pathname.split('/').pop(),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;
  requests.push({table,method,body,query:Object.fromEntries(u.searchParams),prefer:new Headers(init.headers).get('prefer')});
  const reply=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
  if(method==='POST'&&table==='independence_milestones'){
   expect(body).toEqual({family_id:family,member_id:body.member_id,domain:'school',title,description:'Puts folder, snack, and water bottle in the bag.',age_band:'4-6',status:'in_progress',points:5,created_by:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'});
   expect(u.searchParams.get('on_conflict')).toBe('family_id,member_id,domain,title');expect(new Headers(init.headers).get('prefer')).toContain('resolution=merge-duplicates');
   if(mode==='write-refusal')return reply({code:'42501',message:'Synthetic policy refused this write'},403);
   if(!roster.some(r=>r.id===body.member_id))return reply({code:'23503',message:'Synthetic single-column member FK refuses a nonexistent member'},409);
   const previous=rows.findIndex(r=>r.family_id===body.family_id&&r.member_id===body.member_id&&r.domain===body.domain&&r.title===body.title);if(previous>=0)rows[previous]=body;else rows.push(body);
   return new Response(null,{status:204});
  }
  // This future-compatible seam accepts only a correctly scoped reference read.
  if(method==='GET'&&table==='family_members'){
   expect(u.searchParams.get('select')).toBe('id,family_id');expect(u.searchParams.get('family_id')).toBe('eq.'+family);expect([ownMember,foreignMember,missingMember]).toContain(u.searchParams.get('id')?.slice(3));
   if(mode==='read-error')return reply({code:'42501',message:'Synthetic member read refused'},403);
   if(mode==='read-throw')throw Error('Synthetic member transport rejected');
   if(mode==='read-empty')return reply([]);
   if(mode==='read-multiple')return reply([{id:ownMember,family_id:family},{id:ownMember,family_id:family}]);
   if(mode==='read-wrong-id')return reply([{id:foreignMember,family_id:family}]);
   if(mode==='read-wrong-family')return reply([{id:ownMember,family_id:foreignFamily}]);
   if(mode==='read-missing-id')return reply([{family_id:family}]);
   if(mode==='read-missing-family')return reply([{id:ownMember}]);
   if(mode==='read-primitive')return reply([7]);
   if(mode==='read-null-row')return reply([null]);
   return reply(roster.filter(r=>u.searchParams.get('id')==='eq.'+r.id&&u.searchParams.get('family_id')==='eq.'+r.family_id));
  }
  throw Error('Denied unexpected SDK operation '+method+' '+table);
 }}});
});
it('refuses a foreign-family member before starting an own-family school milestone',async()=>{const result=await startMilestoneAction(foreignMember,title);expect(result.ok,JSON.stringify({result,rows,requests,audits:state.audits})).toBe(false);expect(rows).toEqual([]);expect(state.audits).toEqual([]);});
it('starts a same-family school milestone with server-derived scope and normal 204 acknowledgement',async()=>{const result=await startMilestoneAction(ownMember,title);expect(result).toEqual({ok:true});expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({family_id:family,member_id:ownMember,domain:'school',title,status:'in_progress'});expect(state.audits).toEqual([{familyId:family,actorId:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',action:'create',resource:'independence_milestones',resourceId:ownMember,metadata:{title}}]);});
it('a nonexistent member fails the synthetic single-column FK without audit success',async()=>{const result=await startMilestoneAction(missingMember,title);expect(result.ok).toBe(false);expect(rows).toEqual([]);expect(state.audits).toEqual([]);});
it('a child cannot start a milestone and causes no SDK or server-client work',async()=>{state.role='child';const result=await startMilestoneAction(ownMember,title);expect(result).toEqual({ok:false,error:'actions.onlyAParentCanMoveTheLadder'});expect(requests).toEqual([]);expect(state.serverCalls).toBe(0);expect(state.audits).toEqual([]);});
it('an unknown title causes no write or audit',async()=>{const result=await startMilestoneAction(ownMember,'Synthetic unknown neutral title');expect(result).toEqual({ok:false,error:'actions.unknownMilestone'});expect(requests).toEqual([]);expect(rows).toEqual([]);expect(state.audits).toEqual([]);});
it('an explicit upsert refusal never records success',async()=>{mode='write-refusal';const result=await startMilestoneAction(ownMember,title);expect(result.ok).toBe(false);expect(rows).toEqual([]);expect(state.audits).toEqual([]);expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);});
it('an adult manager retains the same-family start behavior',async()=>{state.role='adult';const result=await startMilestoneAction(ownMember,title);expect(result).toEqual({ok:true});expect(rows).toHaveLength(1);expect(rows[0].member_id).toBe(ownMember);expect(state.audits).toHaveLength(1);});

for(const refusedRead of ['read-error','read-throw','read-empty','read-multiple','read-wrong-id','read-wrong-family','read-missing-id','read-missing-family','read-primitive','read-null-row'])it(refusedRead+' cannot write or audit a started milestone',async()=>{mode=refusedRead;const result=await startMilestoneAction(ownMember,title);expect(result.ok).toBe(false);expect(requests.filter(r=>r.method!=='GET')).toEqual([]);expect(rows).toEqual([]);expect(state.audits).toEqual([]);});
it('a scoped reference read precedes the milestone upsert and retains the exact audit scope',async()=>{expect(await startMilestoneAction(ownMember,title)).toEqual({ok:true});expect(requests.map(r=>[r.method,r.table])).toEqual([['GET','family_members'],['POST','independence_milestones']]);expect(requests[0].query).toEqual({select:'id,family_id',id:'eq.'+ownMember,family_id:'eq.'+family});expect(state.audits[0].familyId).toBe(family);expect(state.audits[0].resourceId).toBe(ownMember);});
it('a repeated start retains the existing upsert identity and one persisted synthetic row',async()=>{expect(await startMilestoneAction(ownMember,title)).toEqual({ok:true});expect(await startMilestoneAction(ownMember,title)).toEqual({ok:true});expect(rows).toHaveLength(1);expect(requests.filter(r=>r.method==='POST')).toHaveLength(2);expect(state.audits).toHaveLength(2);});
for(const role of ['teen','caregiver','guest'])it(role+' retains the existing manager refusal before any SDK work',async()=>{state.role=role;expect(await startMilestoneAction(ownMember,title)).toEqual({ok:false,error:'actions.onlyAParentCanMoveTheLadder'});expect(requests).toEqual([]);expect(state.serverCalls).toBe(0);expect(rows).toEqual([]);expect(state.audits).toEqual([]);});
