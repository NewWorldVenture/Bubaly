import {beforeEach,expect,it,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
const state=vi.hoisted(()=>({db:null as any,revalidated:[] as string[],activity:[] as any[]}));
const family='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',foreignFamily='aaaaaaaa-aaaa-4aaa-8aaa-000000000002',user='bbbbbbbb-bbbb-4bbb-8bbb-000000000001',member='cccccccc-cccc-4ccc-8ccc-000000000001',foreignMember='cccccccc-cccc-4ccc-8ccc-000000000002',ownTask='dddddddd-dddd-4ddd-8ddd-000000000001',foreignTask='dddddddd-dddd-4ddd-8ddd-000000000002';
vi.mock('@/lib/supabase/auth',()=>({requireUserContext:async()=>({user:{id:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'},active:{familyId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',member:{id:'cccccccc-cccc-4ccc-8ccc-000000000001'},role:'parent',family:{timezone:'UTC'}}})}));
vi.mock('@/lib/supabase/server',()=>({createServer:async()=>state.db}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=>((key:string)=>key)}));
vi.mock('next/cache',()=>({revalidatePath:(path:string)=>state.revalidated.push(path)}));
vi.mock('@/lib/services/activity',()=>({recordActivitySafely:async(_scope:any,input:any)=>{state.activity.push(input);return {ok:true};}}));
import {updateTodoAction} from '@/app/(app)/dashboard/todos/actions';
import {createTodo,assignTodo} from '@/lib/services/tasks';
const scope=()=>({db:state.db,familyId:family,userId:user,memberId:member,role:'parent' as const,actorKind:'member' as const,tz:'UTC'});
let rows:any[],requests:any[],mode:string;
beforeEach(()=>{
 rows=[{id:ownTask,family_id:family,title:'Synthetic kit task',assigned_to_id:member,is_done:false},{id:foreignTask,family_id:foreignFamily,title:'Synthetic foreign task',assigned_to_id:foreignMember,is_done:false}];requests=[];mode='healthy';state.revalidated=[];state.activity=[];
 state.db=createClient('https://synthetic-todo-family.invalid','synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input:any,init:any)=>{
  const u=new URL(String(input));if(u.origin!=='https://synthetic-todo-family.invalid')throw Error('unexpected SDK destination');const table=u.pathname.split('/').pop(),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;requests.push({table,method,body,query:Object.fromEntries(u.searchParams)});
  const response=(body:any,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  if(method==='GET'&&table==='family_members'){
   expect(u.searchParams.get('select')).toBe('id,family_id');expect(u.searchParams.get('family_id')).toBe('eq.'+family);expect([member,foreignMember]).toContain(u.searchParams.get('id')?.slice(3));
   if(mode==='member-error')return response({code:'SYNTHETIC',message:'Synthetic member lookup refused'},400);
   if(mode==='member-throw')throw Error('Synthetic member transport rejected');
   if(mode==='member-multiple')return response([{id:member,family_id:family},{id:member,family_id:family}]);
   if(mode==='member-wrong-id')return response([{id:foreignMember,family_id:family}]);
   if(mode==='member-wrong-family')return response([{id:member,family_id:foreignFamily}]);
   if(mode==='member-missing-family')return response([{id:member}]);
   if(mode==='member-primitive')return response([7]);
   if(mode==='member-null-row')return response([null]);
   if(mode==='member-missing')return response([]);
   const roster=[{id:member,family_id:family,is_active:true},{id:foreignMember,family_id:foreignFamily,is_active:true}];return response(roster.filter(r=>(!u.searchParams.has('id')||u.searchParams.get('id')==='eq.'+r.id)&&(!u.searchParams.has('family_id')||u.searchParams.get('family_id')==='eq.'+r.family_id)));
  }
  if(method==='POST'&&table==='todo_items'){
   expect(body.family_id).toBe(family);expect(body.created_by).toBe(member);expect(body.list_id).toBe('eeeeeeee-eeee-4eee-8eee-000000000001');
   const row={id:'dddddddd-dddd-4ddd-8ddd-000000000003',...body};rows.push(row);return response(structuredClone(row));
  }
  if(method==='PATCH'&&table==='todo_items'){
   expect(u.searchParams.get('family_id')).toBe('eq.'+family);expect(u.searchParams.get('select')).toBe('*');
   if(mode==='error')return response({code:'SYNTHETIC',message:'Synthetic update refused'},400);
   if(mode==='zero')return response([]);
   const target=rows.find(r=>u.searchParams.get('id')==='eq.'+r.id&&u.searchParams.get('family_id')==='eq.'+r.family_id);if(!target)return response([]);
   if(body.assigned_to_id!==null&&body.assigned_to_id!==undefined&&!([member,foreignMember].includes(body.assigned_to_id)))return response({code:'23503',message:'Synthetic member FK refuses missing target'},400);
   Object.assign(target,body);return response([structuredClone(target)]);
  }
  throw Error('unexpected SDK operation '+method+' '+table);
 }}});
});
it('refuses assigning an own task to a member of another family before persisting it',async()=>{
 const result=await updateTodoAction(ownTask,{assigneeId:foreignMember});expect(result.ok,JSON.stringify({result,persistedAssignee:rows[0].assigned_to_id,requests,revalidated:state.revalidated,activity:state.activity})).toBe(false);expect(rows[0].assigned_to_id).toBe(member);expect(state.revalidated).toEqual([]);expect(state.activity).toEqual([]);
});
it('accepts an active same-family assignee with own-family filters',async()=>{
 const result=await updateTodoAction(ownTask,{assigneeId:member});expect(result).toEqual({ok:true,id:ownTask});expect(rows[0].assigned_to_id).toBe(member);expect(requests.filter(r=>r.method==='PATCH')).toHaveLength(1);expect(state.revalidated).toEqual(['/dashboard/todos']);
});
it('preserves explicit unassignment without a roster requirement',async()=>{
 const result=await updateTodoAction(ownTask,{assigneeId:null});expect(result).toEqual({ok:true,id:ownTask});expect(rows[0].assigned_to_id).toBeNull();expect(state.revalidated).toEqual(['/dashboard/todos']);
});
it('cannot update another family task even with a valid own-family assignee',async()=>{
 const result=await updateTodoAction(foreignTask,{assigneeId:member});expect(result.ok).toBe(false);expect(rows[1].assigned_to_id).toBe(foreignMember);expect(state.revalidated).toEqual([]);expect(state.activity).toEqual([]);
});
it('ignores injected family IDs and derives the own family scope server-side',async()=>{
 const result=await updateTodoAction(foreignTask,{title:'Synthetic attempt',familyId:foreignFamily,family_id:foreignFamily} as any);expect(result.ok).toBe(false);expect(rows[1].title).toBe('Synthetic foreign task');expect(requests[0].query.family_id).toBe('eq.'+family);expect(state.revalidated).toEqual([]);
});
for(const m of ['error','zero'])it(m+' receipt cannot report a saved assignment',async()=>{
 mode=m;const result=await updateTodoAction(ownTask,{assigneeId:null});expect(result.ok).toBe(false);expect(rows[0].assigned_to_id).toBe(member);expect(state.revalidated).toEqual([]);expect(state.activity).toEqual([]);
});

for(const target of ['foreign','own','null'] as const)it('createTodo '+target+' assignee reference',async()=>{
 const assigneeId=target==='foreign'?foreignMember:target==='own'?member:null;
 const result=await createTodo(scope(),{title:'Synthetic new task',listId:'eeeeeeee-eeee-4eee-8eee-000000000001',assigneeId});
 if(target==='foreign'){expect(result.ok,JSON.stringify({result,requests,rows})).toBe(false);expect(rows).toHaveLength(2);expect(state.activity).toEqual([]);}else{expect(result.ok).toBe(true);expect(rows).toHaveLength(3);expect(rows[2].assigned_to_id).toBe(assigneeId);expect(requests.filter(r=>r.method==='POST')).toHaveLength(1);}
});
for(const target of ['foreign','own','null'] as const)it('assignTodo '+target+' assignee reference',async()=>{
 const assigneeId=target==='foreign'?foreignMember:target==='own'?member:null;
 const result=await assignTodo(scope(),ownTask,assigneeId);
 if(target==='foreign'){expect(result.ok,JSON.stringify({result,requests,rows})).toBe(false);expect(rows[0].assigned_to_id).toBe(member);}else{expect(result.ok).toBe(true);expect(rows[0].assigned_to_id).toBe(assigneeId);expect(requests.filter(r=>r.method==='PATCH')).toHaveLength(1);}
});

const writePath=(kind:'create'|'update'|'assign',assigneeId:string|null)=>kind==='create'?createTodo(scope(),{title:'Synthetic new task',listId:'eeeeeeee-eeee-4eee-8eee-000000000001',assigneeId}):kind==='update'?updateTodoAction(ownTask,{assigneeId}):assignTodo(scope(),ownTask,assigneeId);
for(const kind of ['create','update','assign'] as const)for(const m of ['member-error','member-throw','member-multiple','member-wrong-id','member-wrong-family','member-missing-family','member-primitive','member-null-row','member-missing'])it(kind+' refuses '+m+' before any task write',async()=>{
 mode=m;const result=await writePath(kind,member);expect(result.ok).toBe(false);expect(requests.filter(r=>r.method!=='GET')).toEqual([]);expect(rows).toHaveLength(2);expect(rows[0].assigned_to_id).toBe(member);expect(state.revalidated).toEqual([]);expect(state.activity).toEqual([]);
});
for(const kind of ['create','update','assign'] as const)it(kind+' explicit null skips the member lookup',async()=>{
 const result=await writePath(kind,null);expect(result.ok).toBe(true);expect(requests.filter(r=>r.table==='family_members')).toEqual([]);expect(requests.filter(r=>r.method!=='GET')).toHaveLength(1);
});
it('an ordinary title-only edit does not revalidate an unchanged assignee reference',async()=>{
 const result=await updateTodoAction(ownTask,{title:'Synthetic renamed task'});expect(result).toEqual({ok:true,id:ownTask});expect(rows[0].title).toBe('Synthetic renamed task');expect(rows[0].assigned_to_id).toBe(member);expect(requests.filter(r=>r.table==='family_members')).toEqual([]);
});
it('createTodo validates its default acting member against the family',async()=>{
 const result=await createTodo(scope(),{title:'Synthetic default assignee',listId:'eeeeeeee-eeee-4eee-8eee-000000000001'});expect(result.ok).toBe(true);expect(rows[2].assigned_to_id).toBe(member);expect(requests.find(r=>r.table==='family_members')?.query).toMatchObject({id:'eq.'+member,family_id:'eq.'+family});
});
