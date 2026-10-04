import {beforeEach,expect,it,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
const state=vi.hoisted(()=>({db:null as any,activity:[] as any[],revalidated:[] as string[]}));
const revalidated=state.revalidated;
vi.mock('next/cache',()=>({revalidatePath:(path:string)=>state.revalidated.push(path)}));
vi.mock('@/lib/supabase/auth',()=>({requireUserContext:async()=>({user:{id:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001'},active:{familyId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',member:{id:'cccccccc-cccc-4ccc-8ccc-000000000001'},role:'parent',family:{timezone:'UTC'}}})}));
vi.mock('@/lib/supabase/server',()=>({createServer:async()=>state.db}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:async()=>((key:string)=>key)}));
vi.mock('@/lib/services/activity',()=>({recordActivitySafely:async(_s:any,input:any)=>{state.activity.push(input);return {ok:true};}}));
import {createTodoAction} from '@/app/(app)/dashboard/todos/actions';
import {createTodo} from '@/lib/services/tasks';
const family='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',foreignFamily='aaaaaaaa-aaaa-4aaa-8aaa-000000000002',ownList='eeeeeeee-eeee-4eee-8eee-000000000001',foreignList='eeeeeeee-eeee-4eee-8eee-000000000002',missingList='eeeeeeee-eeee-4eee-8eee-000000000003';
let rows:any[],requests:any[],mode:string;
beforeEach(()=>{rows=[];requests=[];mode='healthy';state.activity=[];revalidated.length=0;state.db=createClient('https://synthetic-todo-list.invalid','synthetic-not-a-secret',{accessToken:async()=>null,auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input:any,init:any)=>{const u=new URL(String(input));expect(u.origin).toBe('https://synthetic-todo-list.invalid');const table=u.pathname.split('/').pop(),method=init.method||'GET',body=init.body?JSON.parse(init.body):null;requests.push({table,method,body,query:Object.fromEntries(u.searchParams)});const response=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});const lists=[{id:ownList,family_id:family},{id:foreignList,family_id:foreignFamily}];
 if(method==='POST'&&table==='ensure_default_todo_list'){expect(body).toEqual({p_family_id:family,p_name:'To-Do',p_match_name:false,p_created_by:'cccccccc-cccc-4ccc-8ccc-000000000001'});return mode==='rpc-error'?response({code:'SYNTHETIC',message:'Synthetic default-list RPC refused'},400):response(ownList);}
 if(method==='POST'&&table==='todo_items'){expect(body.family_id).toBe(family);expect(body.created_by).toBe('cccccccc-cccc-4ccc-8ccc-000000000001');if(mode==='write-error')return response({code:'SYNTHETIC',message:'Synthetic task write refused'},400);if(!lists.some(l=>l.id===body.list_id))return response({code:'23503',message:'Synthetic single-column list FK refuses missing target'},400);const row={id:'dddddddd-dddd-4ddd-8ddd-000000000003',...body};rows.push(row);return response(row);}
 if(method==='GET'&&table==='todo_lists'){
  expect(u.searchParams.get('select')).toBe('id,family_id');expect(u.searchParams.get('family_id')).toBe('eq.'+family);expect([ownList,foreignList,missingList]).toContain(u.searchParams.get('id')?.slice(3));
  if(mode==='list-error')return response({code:'SYNTHETIC',message:'Synthetic list lookup refused'},400);
  if(mode==='list-throw')throw Error('Synthetic list transport rejected');
  if(mode==='list-multiple')return response([{id:ownList,family_id:family},{id:ownList,family_id:family}]);
  if(mode==='list-wrong-id')return response([{id:foreignList,family_id:family}]);
  if(mode==='list-wrong-family')return response([{id:ownList,family_id:foreignFamily}]);
  if(mode==='list-missing-family')return response([{id:ownList}]);
  if(mode==='list-primitive')return response([7]);
  if(mode==='list-null-row')return response([null]);
  if(mode==='list-missing')return response([]);
  return response(lists.filter(l=>u.searchParams.get('id')==='eq.'+l.id&&u.searchParams.get('family_id')==='eq.'+l.family_id));
 }
 throw Error('Unexpected SDK operation '+method+' '+table);
 }}});});
it('refuses an existing foreign-family list reference before creating an own-family task',async()=>{const result=await createTodoAction({title:'Synthetic ordinary task',listId:foreignList,assigneeId:null});expect(result.ok,JSON.stringify({result,rows,requests,activity:state.activity,revalidated})).toBe(false);expect(rows).toEqual([]);expect(state.activity).toEqual([]);expect(revalidated).toEqual([]);});
it('accepts an existing same-family list',async()=>{const result=await createTodoAction({title:'Synthetic ordinary task',listId:ownList,assigneeId:null});expect(result.ok).toBe(true);expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({family_id:family,list_id:ownList,assigned_to_id:null});expect(revalidated).toEqual(['/dashboard/todos']);});
it('a nonexistent list is refused by the synthetic FK without success acknowledgement',async()=>{const result=await createTodoAction({title:'Synthetic ordinary task',listId:missingList,assigneeId:null});expect(result.ok).toBe(false);expect(rows).toEqual([]);expect(revalidated).toEqual([]);expect(state.activity).toEqual([]);});
it('a refused task insert does not refresh or record saved activity',async()=>{mode='write-error';const result=await createTodoAction({title:'Synthetic ordinary task',listId:ownList,assigneeId:null});expect(result.ok).toBe(false);expect(rows).toEqual([]);expect(revalidated).toEqual([]);expect(state.activity).toEqual([]);});
it('ignores caller family injection and preserves server-derived task scope',async()=>{const result=await createTodoAction({title:'Synthetic ordinary task',listId:ownList,assigneeId:null,familyId:foreignFamily,family_id:foreignFamily} as any);expect(result.ok).toBe(true);expect(rows[0].family_id).toBe(family);expect(requests.find(r=>r.method==='POST').body.family_id).toBe(family);});

for(const m of ['list-error','list-throw','list-multiple','list-wrong-id','list-wrong-family','list-missing-family','list-primitive','list-null-row','list-missing'])it(m+' cannot create a task or acknowledge success',async()=>{mode=m;const result=await createTodoAction({title:'Synthetic ordinary task',listId:ownList,assigneeId:null});expect(result.ok).toBe(false);expect(requests.filter(r=>r.table==='todo_items'&&r.method!=='GET')).toEqual([]);expect(rows).toEqual([]);expect(state.activity).toEqual([]);expect(revalidated).toEqual([]);});
for(const listId of [undefined,null,''])it('default list input '+String(listId)+' retains the existing RPC path',async()=>{const result=await createTodoAction({title:'Synthetic ordinary task',listId,assigneeId:null});expect(result.ok).toBe(true);expect(rows).toHaveLength(1);expect(rows[0].list_id).toBe(ownList);expect(requests.filter(r=>r.table==='todo_lists')).toEqual([]);expect(requests.filter(r=>r.table==='ensure_default_todo_list')).toHaveLength(1);expect(requests.filter(r=>r.table==='todo_items'&&r.method==='POST')).toHaveLength(1);});
it('default-list RPC refusal creates no task or saved feedback',async()=>{mode='rpc-error';const result=await createTodoAction({title:'Synthetic ordinary task',assigneeId:null});expect(result.ok).toBe(false);expect(rows).toEqual([]);expect(requests.filter(r=>r.table==='todo_items')).toEqual([]);expect(state.activity).toEqual([]);expect(revalidated).toEqual([]);});
for(const listId of [{id:ownList},[ownList],7,'   '])it('truthy invalid explicit list '+JSON.stringify(listId)+' refuses before a task write',async()=>{const result=await createTodoAction({title:'Synthetic ordinary task',listId,assigneeId:null} as any);expect(result.ok).toBe(false);expect(requests.filter(r=>r.table==='todo_items'&&r.method!=='GET')).toEqual([]);expect(rows).toEqual([]);expect(revalidated).toEqual([]);expect(state.activity).toEqual([]);});
for(const target of ['own','foreign'])it('direct createTodo '+target+' list reference',async()=>{const result=await createTodo({db:state.db,familyId:family,userId:'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',memberId:'cccccccc-cccc-4ccc-8ccc-000000000001',role:'parent',actorKind:'member',tz:'UTC'},{title:'Synthetic ordinary task',listId:target==='own'?ownList:foreignList,assigneeId:null});if(target==='foreign'){expect(result.ok).toBe(false);expect(rows).toEqual([]);expect(state.activity).toEqual([]);}else{expect(result.ok).toBe(true);expect(rows).toHaveLength(1);expect(rows[0].list_id).toBe(ownList);}});
