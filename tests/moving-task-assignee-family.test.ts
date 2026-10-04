import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {createClient} from '@supabase/supabase-js';
import {addTask} from '@/lib/services/moving';
const {activity}=vi.hoisted(()=>({activity:[] as any[]}));
vi.mock('@/lib/services/activity',()=>({recordActivitySafely:async(_scope:any,input:any)=>{activity.push(input)}}));
vi.mock('@/lib/services/scope',()=>({scopeNow:()=>{throw Error('Unapproved clock')},dayKeyInTz:()=>{throw Error('Unapproved day')}}));
vi.mock('@/lib/constants/roles',()=>({isManager:()=>{throw Error('Unapproved role routine')}}));
vi.mock('@/lib/moving/recalculation',()=>({addMoveDays:()=>{throw Error('Date ops out of initial proof')},isMoveDate:()=>{throw Error('Date ops out of initial proof')},isMoveDatePreview:()=>{throw Error('Unapproved preview')},isMoveDateResult:()=>{throw Error('Unapproved result')}}));
vi.mock('@/lib/supabase/settle',()=>({settleAll:()=>{throw Error('Unapproved aggregate helper')}}));
vi.mock('@/lib/moving/planner',async()=>{const actual:any=await vi.importActual('@/lib/moving/planner');return Object.fromEntries(Object.entries(actual).map(([key,value])=>[key,typeof value==='function'?()=>{throw Error('Unapproved planner operation '+key)}:value]));});
const A='10000000-0000-4000-8000-000000000001',B='10000000-0000-4000-8000-000000000002';
const MA='20000000-0000-4000-8000-000000000001',MB='20000000-0000-4000-8000-000000000002';
const MOVE='30000000-0000-4000-8000-000000000001',TASK='40000000-0000-4000-8000-000000000001';
let proof:any,log:any;
beforeEach(()=>{activity.length=0;proof={name:expect.getState().currentTestName,requests:[],replies:[],fixtureErrors:[],forbidden:[],active:0,activity};log=vi.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>{log.mockRestore();expect(proof.fixtureErrors).toEqual([]);expect(proof.forbidden).toEqual([]);expect(proof.active).toBe(0);expect(proof.requests.length).toBeLessThanOrEqual(4);for(const r of proof.requests){const q=new URLSearchParams(r.query);expect(q.get('select')).toBe(r.table==='family_members'?'id,family_id':'*');expect(q.get('family_id')??r.payload?.family_id).toBe(r.method==='POST'?proof.family:'eq.'+proof.family);if(r.table==='moves'){expect(r.method).toBe('GET');expect(q.get('limit')).toBe('1');if(proof.input.moveId){expect(q.get('id')).toBe('eq.'+proof.input.moveId);expect(q.get('status')).toBeNull();}else{expect(q.get('status')).toBe('in.(planning,packing,moving_day,settling)');expect(q.get('order')).toBe('move_date.asc');}}else if(r.table==='family_members'){expect(r.method).toBe('GET');expect(q.get('id')).toBe('eq.'+proof.input.assigneeId);}else if(r.method==='GET'){expect(r.table).toBe('move_tasks');expect(q.get('move_id')).toBe('eq.'+MOVE);expect(q.get('template_key')).toBe('eq.'+proof.input.templateKey.trim());expect(q.get('limit')).toBe('1');}else{expect(r.table).toBe('move_tasks');expect(r.payload).toEqual({family_id:proof.family,move_id:MOVE,title:proof.input.title.trim(),category:(proof.input.category??'other').trim(),offset_days:0,due_date:null,date_mode:'fixed',assignee_id:proof.input.assigneeId??null,template_key:proof.input.templateKey?.trim()||null,notes:proof.input.notes?.trim()||null,created_by:'50000000-0000-4000-8000-000000000001'});expect(r.prefer).toContain('return=representation');}}if(process.env.BUBALY_MOVING_TASK_RECEIPTS)fs.appendFileSync(process.env.BUBALY_MOVING_TASK_RECEIPTS,JSON.stringify(proof)+'\n');});
function scope(family=A,options:any={}){
 proof.family=family;
 const db=createClient('https://moving-task-assignee.invalid','synthetic-key',{accessToken:async()=>null,auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input:any,init:any={})=>{proof.active++;try{const u=new URL(String(input)),method=init.method??'GET',table=u.pathname.split('/').pop();if(u.origin!=='https://moving-task-assignee.invalid'||!['moves','move_tasks','family_members'].includes(table!)||!['GET','POST'].includes(method)||(method==='POST'&&table!=='move_tasks')||proof.requests.length>=4){proof.forbidden.push(String(input));throw Error('Unapproved transport');}const payload=init.body?JSON.parse(String(init.body)):null;const headers=new Headers(init.headers);proof.requests.push({table,method,query:u.search,payload,prefer:headers.get('prefer'),accept:headers.get('accept')});let body:any,status=200;
 if(table==='moves'){status=options.readStatus??200;body=status!==200?{code:'42501',message:'Synthetic read refusal'}:options.missing?[]:options.malformedMove?{}:[{id:MOVE,family_id:family,title:'Neutral move',move_date:'2026-11-03',status:'planning'}];}
 else if(table==='family_members'){const id=u.searchParams.get('id')?.slice(3);const member=id===MA?{id:MA,family_id:A}:id===MB?{id:MB,family_id:B}:null;status=options.memberStatus??200;body=status!==200?{code:'42501',message:'Synthetic member read refusal'}:Object.prototype.hasOwnProperty.call(options,'memberBody')?options.memberBody:member?.family_id===family?[member]:[];}
 else if(method==='GET'){status=options.probeStatus??200;body=status!==200?{code:'42501',message:'Synthetic task read refusal'}:options.existing?[{id:TASK,family_id:family,move_id:MOVE,title:'Existing neutral task',assignee_id:null,template_key:proof.input.templateKey.trim()}]:[];}
 else{status=options.postStatus??201;body=options.emptyPost?null:status>=400?{code:'42501',message:'Synthetic task write refusal'}:{...payload,id:TASK,status:'todo'};}
 proof.replies.push({table,method,status,body});return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 }catch(e){proof.fixtureErrors.push(e instanceof Error?e.message:String(e));throw e;}finally{proof.active--;}}}});
 return {db,familyId:family,userId:'50000000-0000-4000-8000-000000000001',memberId:family===A?MA:MB,role:'parent',actorKind:'member',tz:'UTC'} as any;
}
async function run(family=A,input:any={title:'Neutral task'},options:any={}){proof.input=input;const result=await addTask(scope(family,options),input);proof.result=result;return result;}
// ORIGINAL CASES BEGIN
it('family A refuses family B member before new task POST and activity',async()=>{const r=await run(A,{title:'Neutral task',assigneeId:MB});expect.soft(r.ok).toBe(false);expect(proof.requests.filter((x:any)=>x.method==='POST')).toHaveLength(0);expect.soft(activity).toHaveLength(0);});
it('family B refuses family A member before new task POST and activity',async()=>{const r=await run(B,{title:'Neutral task',assigneeId:MA});expect.soft(r.ok).toBe(false);expect(proof.requests.filter((x:any)=>x.method==='POST')).toHaveLength(0);expect.soft(activity).toHaveLength(0);});
it('family A own assignee creates one ordinary task',async()=>{const r=await run(A,{title:'Neutral task',assigneeId:MA});expect(r).toMatchObject({ok:true,data:{created:true,task:{assignee_id:MA,family_id:A}}});expect(proof.requests.filter((x:any)=>x.method==='POST')).toHaveLength(1);expect(activity).toHaveLength(1);expect(activity[0].memberId).toBe(MA);});
it('family B own assignee creates one ordinary task',async()=>{const r=await run(B,{title:'Neutral task',assigneeId:MB});expect(r).toMatchObject({ok:true,data:{created:true,task:{assignee_id:MB,family_id:B}}});expect(activity).toHaveLength(1);});
it('null assignee remains unassigned without member lookup',async()=>{expect(await run(A,{title:'Neutral task',assigneeId:null})).toMatchObject({ok:true,data:{task:{assignee_id:null}}});expect(proof.requests.filter((x:any)=>x.table==='family_members')).toHaveLength(0);});
it('omitted assignee remains unassigned without member lookup',async()=>{expect(await run()).toMatchObject({ok:true,data:{task:{assignee_id:null}}});expect(proof.requests.filter((x:any)=>x.table==='family_members')).toHaveLength(0);});
it('normalization and blank template preserve fixed undated payload',async()=>{expect(await run(A,{title:'  Neutral task  ',category:' admin ',notes:'  Neutral note  ',templateKey:'  '})).toMatchObject({ok:true,data:{created:true,task:{title:'Neutral task',category:'admin',notes:'Neutral note',template_key:null,date_mode:'fixed',due_date:null}}});});
it('own settled template returns old task without new member lookup or POST',async()=>{expect(await run(A,{title:'Neutral task',templateKey:' neutral-key ',assigneeId:MA},{existing:true})).toMatchObject({ok:true,data:{created:false,task:{id:TASK}}});expect(proof.requests.map((x:any)=>x.table)).toEqual(['moves','move_tasks']);expect(activity).toHaveLength(0);});
it('foreign supplied assignee on settled replay preserves existing no-write return',async()=>{expect(await run(A,{title:'Neutral task',templateKey:'neutral-key',assigneeId:MB},{existing:true})).toMatchObject({ok:true,data:{created:false}});expect(proof.requests.map((x:any)=>x.table)).toEqual(['moves','move_tasks']);expect(activity).toHaveLength(0);});
it('missing scoped move refuses before task write',async()=>{expect(await run(A,{title:'Neutral task',assigneeId:MA},{missing:true})).toMatchObject({ok:false,code:'not_found'});expect(proof.requests).toHaveLength(1);expect(activity).toHaveLength(0);});
it('move GET403 retains database refusal precedence',async()=>{expect(await run(A,{title:'Neutral task',assigneeId:MA},{readStatus:403})).toMatchObject({ok:false,code:'db'});expect(proof.requests).toHaveLength(1);expect(activity).toHaveLength(0);});
it('template GET403 refuses before any insert',async()=>{expect(await run(A,{title:'Neutral task',templateKey:'neutral-key',assigneeId:MA},{probeStatus:403})).toMatchObject({ok:false,code:'db'});expect(proof.requests.map((x:any)=>x.method)).toEqual(['GET','GET']);expect(activity).toHaveLength(0);});
it('task POST403 refuses without success activity',async()=>{expect(await run(A,{title:'Neutral task',assigneeId:MA},{postStatus:403})).toMatchObject({ok:false,code:'db'});expect(proof.requests.filter((x:any)=>x.method==='POST')).toHaveLength(1);expect(activity).toHaveLength(0);});
it('null successful task POST refuses without activity',async()=>{expect(await run(A,{title:'Neutral task'},{emptyPost:true})).toMatchObject({ok:false,code:'db'});expect(activity).toHaveLength(0);});
it('blank title refuses with zero requests',async()=>{expect(await run(A,{title:'  '})).toMatchObject({ok:false,code:'invalid_input'});expect(proof.requests).toHaveLength(0);});
it('invalid category refuses with zero requests',async()=>{expect(await run(A,{title:'Neutral task',category:'not-a-category'})).toMatchObject({ok:false,code:'invalid_input'});expect(proof.requests).toHaveLength(0);});
it('invalid numeric offset refuses before date helper or requests',async()=>{expect(await run(A,{title:'Neutral task',offsetDays:400})).toMatchObject({ok:false,code:'invalid_input'});expect(proof.requests).toHaveLength(0);});
it('explicit move ID uses family and ID scoped GET',async()=>{expect(await run(A,{title:'Neutral task',moveId:MOVE})).toMatchObject({ok:true,data:{created:true}});expect(new URLSearchParams(proof.requests[0].query).get('id')).toBe('eq.'+MOVE);});
it('published malformed move collection guard still refuses before insert',async()=>{expect(await run(A,{title:'Neutral task'},{malformedMove:true})).toEqual({ok:false,error:'Could not load the move.',code:'db'});expect(proof.requests).toHaveLength(1);expect(activity).toHaveLength(0);});
// ORIGINAL CASES END

// New member-admission cases. The complete original19 block above is unchanged.
const memberRefusals: [string, any][] = [
  ['member GET403 refuses before task POST', { memberStatus: 403 }],
  ['null member success refuses before task POST', { memberBody: null }],
  ['empty member array refuses before task POST', { memberBody: [] }],
  ['object member collection refuses before task POST', { memberBody: {} }],
  ['string member collection refuses before task POST', { memberBody: 'member' }],
  ['number member collection refuses before task POST', { memberBody: 0 }],
  ['boolean member collection refuses before task POST', { memberBody: false }],
  ['array-like member collection refuses before task POST', { memberBody: { 0: { id: MA, family_id: A }, length: 1 } }],
  ['null member entry refuses before task POST', { memberBody: [null] }],
  ['primitive member entry refuses before task POST', { memberBody: ['member'] }],
  ['missing member identity refuses before task POST', { memberBody: [{}] }],
  ['numeric member id refuses before task POST', { memberBody: [{ id: 1, family_id: A }] }],
  ['numeric member family refuses before task POST', { memberBody: [{ id: MA, family_id: 1 }] }],
  ['wrong returned member refuses before task POST', { memberBody: [{ id: MB, family_id: A }] }],
  ['wrong returned family refuses before task POST', { memberBody: [{ id: MA, family_id: B }] }],
];
for (const [name, options] of memberRefusals) {
  it(name, async () => {
    expect.soft(await run(A, { title: 'Neutral task', assigneeId: MA }, options)).toMatchObject({ ok: false, code: 'db' });
    expect(proof.requests.filter((r: any) => r.method === 'POST')).toHaveLength(0);
    expect.soft(activity).toHaveLength(0);
  });
}
it('alphabetic UUID casing preserves matching member and original input payload', async () => {
  const family = 'abcdefab-0000-4000-8000-abcdefabcdef';
  const member = 'abcdefab-1111-4111-8111-abcdefabcdef';
  const result = await run(family.toUpperCase(), { title: 'Neutral task', assigneeId: member.toUpperCase() }, { memberBody: [{ id: member, family_id: family }] });
  expect(result).toMatchObject({ ok: true, data: { created: true, task: { family_id: family.toUpperCase(), assignee_id: member.toUpperCase() } } });
  expect(activity[0].memberId).toBe(member.toUpperCase());
  expect(proof.requests.filter((r: any) => r.table === 'family_members')).toHaveLength(1);
});
it('new template task preserves scoped probe then member lookup then one POST', async () => {
  expect(await run(A, { title: 'Neutral task', assigneeId: MA, templateKey: ' neutral-key ' })).toMatchObject({ ok: true, data: { created: true, task: { template_key: 'neutral-key' } } });
  expect(activity).toHaveLength(1);
  expect(proof.requests.map((r: any) => r.table + ':' + r.method)).toEqual(['moves:GET', 'move_tasks:GET', 'family_members:GET', 'move_tasks:POST']);
});
