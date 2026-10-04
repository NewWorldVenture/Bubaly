import { afterEach, expect, it, vi } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { completeTodo } from '@/lib/services/tasks';
vi.mock('@/lib/services/activity',()=>({recordActivitySafely:async(_scope:any,descriptor:any)=>{(globalThis as any).__todoProof.activity.push(descriptor);}}));
vi.mock('@/lib/i18n/server',()=>({getTranslations:()=>{throw Error('Unused translation seam invoked');}}));
vi.mock('@/lib/supabase/escape-like',()=>({escapeLike:()=>{throw Error('Unused escaping seam invoked');}}));
const FAMILY='ab111111-1111-4111-8111-111111111111',TODO='cd222222-2222-4222-8222-222222222222',MEMBER='ef333333-3333-4333-8333-333333333333',OTHER='aa444444-4444-4444-8444-444444444444',NOW='2026-10-10T15:00:00.000Z';
const row={id:TODO,family_id:FAMILY,title:'Opaque task',assigned_to_id:MEMBER,is_done:true,opaque:{nested:['unchanged',17]}};let proof:any;
afterEach(()=>{vi.useRealTimers();let observerIOError:unknown=null;try{if(process.env.BUBALY_TODO_COMPLETE_RECEIPTS)appendFileSync(process.env.BUBALY_TODO_COMPLETE_RECEIPTS,JSON.stringify({...proof,test:expect.getState().currentTestName})+String.fromCharCode(10));}catch(error){observerIOError=error;}expect(observerIOError).toBeNull();expect(proof.forbidden).toEqual([]);expect(proof.transportErrors).toEqual([]);expect(proof.active).toBe(0);expect(proof.settled).toBe(true);expect(proof.requests).toHaveLength(1);expect(proof.actualSdkReplies).toHaveLength(1);const request=proof.requests[0],q=new URLSearchParams(request.query);expect(request.method).toBe('PATCH');expect(request.table).toBe('todo_items');expect([...q.keys()].sort()).toEqual(['family_id','id','select']);expect(q.get('family_id')).toBe('eq.'+proof.familyId);expect(q.get('id')).toBe('eq.'+proof.todoId);expect(q.get('select')).toBe('*');expect(request.accept).toBeNull();expect(request.contentType).toBe('application/json');expect(request.prefer).toBe('return=representation');expect(request.payload).toEqual({is_done:proof.done,completed_at:proof.done?NOW:null});});
async function run(body:any=row,options:any={}){vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(NOW));proof={familyId:options.familyId??FAMILY,todoId:options.todoId??TODO,done:options.done??true,status:options.status??200,requests:[],rawResponses:[],actualSdkReplies:[],declaredAdapters:[],activity:[],forbidden:[],transportErrors:[],active:0,settled:false};(globalThis as any).__todoProof=proof;
const db=createClient('https://todo-completion-receipt.invalid','synthetic-key',{accessToken:async()=>null,auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url:any,init:any={})=>{proof.active++;try{const u=new URL(String(url)),method=init.method??'GET';if(u.origin!=='https://todo-completion-receipt.invalid'||u.pathname!=='/rest/v1/todo_items'||method!=='PATCH'||proof.requests.length>=1){proof.forbidden.push(String(url));throw Error('Forbidden finite transport');}const h=new Headers(init.headers);proof.requests.push({method,table:'todo_items',query:u.search,accept:h.get('accept'),contentType:h.get('content-type'),prefer:h.get('prefer'),payload:JSON.parse(String(init.body))});proof.rawResponses.push({status:proof.status,body:proof.status===204?null:body});return new Response(proof.status===204?null:JSON.stringify(body),{status:proof.status,headers:{'content-type':'application/json'}});}catch(error){proof.transportErrors.push(error instanceof Error?error.message:String(error));throw error;}finally{proof.active--;}}}});
function observe(builder:any):any{return new Proxy(builder,{get(target,key){if(key==='then')return(fulfilled:any,rejected:any)=>target.then((reply:any)=>{proof.actualSdkReplies.push({status:reply.status,data:reply.data,dataUndefined:reply.data===undefined,error:reply.error});let next=reply;if(options.adapter==='undefined'){next={...reply,data:undefined};proof.declaredAdapters.push({kind:'post-await data undefined'});}if(options.adapter==='error'){next={...reply,error:{code:'42501',message:'Declared synthetic update refusal'}};proof.declaredAdapters.push({kind:'post-await data plus explicit error'});}return next;}).then(fulfilled,rejected);const value=Reflect.get(target,key,target);if(typeof value!=='function')return value;return(...args:any[])=>{const next=value.apply(target,args);return next&&typeof next==='object'?observe(next):next;};}});}
const scope:any={db:{from:(table:string)=>{if(table!=='todo_items'){proof.forbidden.push(table);throw Error('Forbidden builder');}return observe(db.from(table));}},familyId:proof.familyId,userId:'synthetic-user',memberId:MEMBER,role:'parent',actorKind:'member',tz:'UTC'};try{const result=options.omitDone?await completeTodo(scope,proof.todoId):await completeTodo(scope,proof.todoId,proof.done);proof.result=result;return result;}catch(error){proof.result={thrown:error instanceof Error?error.message:String(error)};return proof.result;}finally{proof.settled=true;}}
async function refusal(body:any){expect(await run(body)).toMatchObject({ok:false,code:'db'});expect(proof.activity).toEqual([]);}
function activity(done:boolean){return{agent:'tasks',action:'update',title:done?'Ticked off "Opaque task"':'Put "Opaque task" back on the list',href:'/dashboard/todos',memberId:MEMBER,resourceId:TODO};}
// ORIGINAL CASES BEGIN
it('successful empty object refuses unverifiable saved row',async()=>{await refusal({});});
it('native successful empty array normalizes to missing-row refusal',async()=>{expect(await run([])).toMatchObject({ok:false,code:'not_found'});expect(proof.actualSdkReplies[0].data).toBeNull();expect(proof.activity).toEqual([]);});
it('native successful one-row array normalizes to healthy saved-row success',async()=>{expect(await run([row])).toEqual({ok:true,data:row});expect(proof.actualSdkReplies[0].data).toEqual(row);expect(proof.activity).toEqual([activity(true)]);});
it('successful nonempty string refuses unverifiable saved row',async()=>{await refusal('malformed');});
it('successful nonzero number refuses unverifiable saved row',async()=>{await refusal(17);});
it('successful true boolean refuses unverifiable saved row',async()=>{await refusal(true);});
it('saved row with empty ID refuses before activity',async()=>{await refusal({...row,id:''});});
it('saved row with unrelated todo ID refuses before activity',async()=>{await refusal({...row,id:OTHER});});
it('saved row with unrelated family ID refuses before activity',async()=>{await refusal({...row,family_id:OTHER});});
it('healthy default completion preserves opaque saved row and descriptor',async()=>{expect(await run(row,{omitDone:true})).toEqual({ok:true,data:row});expect(proof.activity).toEqual([activity(true)]);});
it('healthy reopening preserves row and writes null completed_at',async()=>{const reopened={...row,is_done:false};expect(await run(reopened,{done:false})).toEqual({ok:true,data:reopened});expect(proof.activity).toEqual([activity(false)]);});
it('alphabetic upper-case requested UUIDs accept normalized saved identity',async()=>{expect(FAMILY.toUpperCase()).not.toBe(FAMILY);expect(TODO.toUpperCase()).not.toBe(TODO);expect(await run(row,{familyId:FAMILY.toUpperCase(),todoId:TODO.toUpperCase()})).toEqual({ok:true,data:row});expect(proof.activity).toEqual([activity(true)]);});
it('HTTP200 null preserves missing-row refusal',async()=>{expect(await run(null)).toMatchObject({ok:false,code:'not_found'});expect(proof.activity).toEqual([]);});
it('HTTP204 preserves missing-row refusal',async()=>{expect(await run(null,{status:204})).toMatchObject({ok:false,code:'not_found'});expect(proof.activity).toEqual([]);});
it('declared undefined adapter preserves missing-row refusal after raw SDK reply',async()=>{expect(await run(row,{adapter:'undefined'})).toMatchObject({ok:false,code:'not_found'});expect(proof.actualSdkReplies[0].data).toEqual(row);expect(proof.declaredAdapters).toEqual([{kind:'post-await data undefined'}]);expect(proof.activity).toEqual([]);});
it('HTTP403 preserves native SDK error precedence',async()=>{expect(await run({code:'42501',message:'Synthetic update denied'},{status:403})).toMatchObject({ok:false,code:'db'});expect(proof.actualSdkReplies[0].error).toMatchObject({code:'42501'});expect(proof.activity).toEqual([]);});
it('declared data-plus-error preserves explicit error precedence',async()=>{expect(await run(row,{adapter:'error'})).toMatchObject({ok:false,code:'db'});expect(proof.actualSdkReplies[0].error).toBeNull();expect(proof.actualSdkReplies[0].data).toEqual(row);expect(proof.declaredAdapters).toEqual([{kind:'post-await data plus explicit error'}]);expect(proof.activity).toEqual([]);});
// ORIGINAL CASES END

it('saved row with missing ID refuses before activity', async () => {
  const receipt: Record<string, unknown> = { ...row };
  delete receipt.id;
  await refusal(receipt);
});
it('saved row with whitespace ID refuses before activity', async () => {
  await refusal({ ...row, id: '   ' });
});
it('saved row with numeric ID refuses before activity', async () => {
  await refusal({ ...row, id: 7 });
});
it('saved row with missing family refuses before activity', async () => {
  const receipt: Record<string, unknown> = { ...row };
  delete receipt.family_id;
  await refusal(receipt);
});
it('saved row with whitespace family refuses before activity', async () => {
  await refusal({ ...row, family_id: '   ' });
});
it('saved row with numeric family refuses before activity', async () => {
  await refusal({ ...row, family_id: 7 });
});
it('malformed saved data with explicit error preserves denial precedence', async () => {
  expect(await run({}, { adapter: 'error' })).toEqual({
    ok: false,
    error: "You don't have permission to do that. Ask a family admin if you think this is a mistake.",
    code: 'db',
  });
  expect(proof.actualSdkReplies[0].data).toEqual({});
  expect(proof.actualSdkReplies[0].error).toBeNull();
  expect(proof.declaredAdapters).toEqual([{ kind: 'post-await data plus explicit error' }]);
  expect(proof.activity).toEqual([]);
});
