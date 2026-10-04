import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sourceRoot=process.env.BUBALY_CHORE_ASSIGNEE_SOURCE_ROOT ?? process.cwd();
const sources=Object.fromEntries(Object.entries({tasks:'lib/services/tasks/index.ts',types:'lib/services/types.ts',errors:'lib/supabase/errors.ts'}).map(([name,file])=>[name,ts.transpileModule(fs.readFileSync(path.join(sourceRoot,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText]));
const FAMILY='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',CHORE='33333333-3333-4333-8333-333333333333',MEMBER='abcdefab-cdef-4abc-8def-abcdefabcdef',FOREIGN_A='44444444-4444-4444-8444-444444444444',FOREIGN_B='55555555-5555-4555-8555-555555555555';
const traces:any[]=[];let trace:any;
beforeEach(()=>{trace={name:expect.getState().currentTestName,requests:[],transportErrors:[],forbidden:[],settled:0,logs:[],responses:[],replies:[]};vi.spyOn(console,'error').mockImplementation((...args)=>trace.logs.push(args));});
afterEach(()=>{
 traces.push(trace);expect(trace.forbidden).toEqual([]);expect(trace.transportErrors).toEqual([]);expect(trace.requests.length).toBeLessThanOrEqual(3);expect(trace.settled).toBe(trace.requests.length);
 const chores=trace.requests.filter((r:any)=>r.table==='chores'),members=trace.requests.filter((r:any)=>r.table==='family_members'),posts=trace.requests.filter((r:any)=>r.method==='POST');
 expect(chores.length).toBeLessThanOrEqual(1);expect(members.length).toBeLessThanOrEqual(1);expect(posts.length).toBeLessThanOrEqual(1);
 for(const r of chores){expect(r.method).toBe('GET');expect(r.query).toEqual({select:'id,due_at',id:'eq.'+trace.input.choreId,family_id:'eq.'+FAMILY});expect(r.headers.accept).toBeUndefined();}
 for(const r of members){expect(r.method).toBe('GET');expect(r.query).toEqual({select:'id,family_id',id:'eq.'+trace.input.memberId,family_id:'eq.'+FAMILY});expect(r.headers.accept).toBeUndefined();}
 for(const r of posts){expect(r.table).toBe('chore_assignments');expect(r.query).toEqual({select:'*'});expect(r.headers.accept).toBe('application/vnd.pgrst.object+json');expect(r.headers.prefer).toContain('return=representation');expect(r.payload).toEqual({family_id:FAMILY,chore_id:CHORE,member_id:trace.input.memberId,status:'todo',due_at:trace.input.dueAt??trace.choreDue??null,...(trace.input.idempotencyKey?{idempotency_key:trace.input.idempotencyKey}:{})});}
 expect(trace.logs.every((a:any[])=>['[service:tasks] chore lookup failed','[service:tasks] chore assign failed','[service:tasks] assignee lookup failed','[service:tasks] chore assignee lookup failed'].includes(a[0]))).toBe(true);
 vi.restoreAllMocks();
});
afterAll(()=>{if(process.env.BUBALY_CHORE_ASSIGNEE_TRACE)fs.writeFileSync(process.env.BUBALY_CHORE_ASSIGNEE_TRACE,JSON.stringify(traces,null,2)+'\n',{flag:'wx'});});
type Options={memberReceipt?:unknown;memberId?:string;memberFamily?:string;memberMissing?:boolean;memberStatus?:number;choreMissing?:boolean;choreStatus?:number;choreDue?:string|null;postStatus?:number;postNull?:boolean;dueAt?:string|null;idempotencyKey?:string|null;choreId?:string;extraInput?:Record<string,unknown>};
function fixture(options:Options={}){
 const input={choreId:options.choreId??CHORE,memberId:options.memberId??MEMBER,...('dueAt'in options?{dueAt:options.dueAt}:{}),...('idempotencyKey'in options?{idempotencyKey:options.idempotencyKey}:{}),...options.extraInput};trace.input=input;trace.choreDue=options.choreDue??null;
 const deny=(reason:string):never=>{trace.forbidden.push(reason);throw Error(reason);};
 const transport:typeof fetch=async(resource,init)=>{try{
  const url=new URL(String(resource)),method=init?.method??'GET',table=url.pathname.split('/').at(-1),headers=Object.fromEntries(new Headers(init?.headers).entries()),payload=init?.body?JSON.parse(String(init.body)):undefined;
  if(url.origin!=='https://chore-assignee.invalid'||url.pathname!=='/rest/v1/'+table||trace.requests.length>=3||!((table==='chores'||table==='family_members')&&method==='GET'||table==='chore_assignments'&&method==='POST'))deny('Outside finite assignChore transport');
  trace.requests.push({table,method,query:Object.fromEntries(url.searchParams),headers:{accept:headers.accept,prefer:headers.prefer},...(payload?{payload}:{})});
  let body:unknown,status=200;
  if(table==='chores'){status=options.choreStatus??200;body=options.choreMissing?[]:[{id:CHORE,due_at:options.choreDue??null}];}
  else if(table==='family_members'){status=options.memberStatus??200;const family=options.memberFamily??FAMILY;body='memberReceipt'in options?options.memberReceipt:options.memberMissing||family!==FAMILY?[]:[{id:(input.memberId===MEMBER.toUpperCase()?MEMBER:input.memberId),family_id:family}];}
  else{status=options.postStatus??201;body=options.postNull?null:{id:'66666666-6666-4666-8666-666666666666',...payload};}
  if(status>=400)body={code:status===403?'42501':'XX000',message:'Neutral synthetic refusal'};
  trace.responses.push({table,method,status,body});return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
 }catch(error){trace.transportErrors.push(String(error));throw error;}finally{trace.settled++;}};
 const sdk=createClient('https://chore-assignee.invalid','synthetic-key',{accessToken:async()=>null,auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:transport}});
 const db={from:(table:string)=>{let current:any=sdk.from(table);const observer:any=new Proxy({},{get(_target,key){if(key==='then')return(resolve:any,reject:any)=>current.then((reply:any)=>{trace.replies.push({table,data:reply.data,error:reply.error,count:reply.count,status:reply.status,statusText:reply.statusText});return resolve(reply);},reject);const value=Reflect.get(current,key,current);return typeof value==='function'?(...args:any[])=>{const next=value.apply(current,args);if(next&&typeof next==='object')current=next;return observer;}:value;}});return observer;}};
 const modules:any={};function load(name:string):any{if(modules[name])return modules[name];const entry={exports:{}};modules[name]=entry.exports;const require=(id:string):any=>{if(id==='server-only')return{};if(id==='../types')return load('types');if(id==='@/lib/supabase/errors')return load('errors');if(id==='../activity')return{recordActivitySafely:()=>deny('Unused activity')};if(id==='../idempotency')return new Proxy({},{get:()=>()=>deny('Unused idempotency')});if(id==='../scope')return{scopeNow:()=>deny('Unused scopeNow')};if(id==='@/lib/chores/respawn')return{nextChoreDueAt:()=>deny('Unused respawn'),choreRepeats:()=>deny('Unused respawn')};if(id==='@/lib/supabase/chunked-in')return{readAllInChunks:()=>deny('Unused readAllInChunks')};if(id==='@/lib/supabase/escape-like')return{escapeLike:()=>deny('Unused escapeLike')};if(id==='@/lib/i18n/server')return{getTranslations:()=>deny('Unused translations')};return deny('Unexpected module '+id);};new Function('require','module','exports',sources[name])(require,entry,entry.exports);modules[name]=entry.exports;return entry.exports;}
 const scope:any={db,familyId:FAMILY,userId:'synthetic-user',memberId:MEMBER,role:'parent',actorKind:'member',tz:'UTC',now:new Date('2026-01-01T00:00:00Z')};
 return{run:async()=>{const result=await load('tasks').assignChore(scope,input);trace.result=result;return result;},input};
}
const posts=()=>trace.requests.filter((r:any)=>r.method==='POST');
// BEGIN ORIGINAL19 COMPLETE CASE BLOCK
 describe('original chore assignment member family boundary',()=>{
  for(const [label,member]of [['A',FOREIGN_A],['B',FOREIGN_B]] as const){it('refuses foreign family member '+label+' before assignment POST',async()=>{const f=fixture({memberId:member,memberFamily:OTHER});expect(await f.run()).toMatchObject({ok:false,code:'not_found'});expect(posts()).toHaveLength(0);});}
  it('refuses a missing positive member before assignment POST',async()=>{const f=fixture({memberMissing:true});expect(await f.run()).toMatchObject({ok:false,code:'not_found'});expect(posts()).toHaveLength(0);});
  it('refuses an actualSDK403 member read before assignment POST',async()=>{const f=fixture({memberStatus:403});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(posts()).toHaveLength(0);});
  it('assigns a same-family member with the original payload',async()=>{const f=fixture();expect(await f.run()).toEqual({ok:true,data:{id:'66666666-6666-4666-8666-666666666666',family_id:FAMILY,chore_id:CHORE,member_id:MEMBER,status:'todo',due_at:null}});expect(posts()).toHaveLength(1);});
  it('preserves uppercase UUID assignment input',async()=>{const f=fixture({memberId:MEMBER.toUpperCase()});expect(await f.run()).toMatchObject({ok:true,data:{member_id:MEMBER.toUpperCase()}});expect(posts()).toHaveLength(1);});
  it('requires a member before any GET or POST',async()=>{const f=fixture({memberId:''});expect(await f.run()).toMatchObject({ok:false,code:'invalid_input'});expect(trace.requests).toHaveLength(0);});
  it('preserves a missing chore refusal before member lookup or POST',async()=>{const f=fixture({choreMissing:true});expect(await f.run()).toMatchObject({ok:false,code:'not_found'});expect(trace.requests).toHaveLength(1);expect(posts()).toHaveLength(0);});
  it('scopes an injected foreign chore id to the current family',async()=>{const f=fixture({choreId:'77777777-7777-4777-8777-777777777777',choreMissing:true});expect(await f.run()).toMatchObject({ok:false,code:'not_found'});expect(trace.requests).toHaveLength(1);});
  it('preserves chore SDK403 error before member lookup or POST',async()=>{const f=fixture({choreStatus:403});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(trace.requests).toHaveLength(1);expect(posts()).toHaveLength(0);});
  it('preserves chore SDK500 error before member lookup or POST',async()=>{const f=fixture({choreStatus:500});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(trace.requests).toHaveLength(1);});
  it('preserves assignment SDK403 refusal',async()=>{const f=fixture({postStatus:403});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(posts()).toHaveLength(1);});
  it('preserves assignment SDK500 refusal',async()=>{const f=fixture({postStatus:500});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(posts()).toHaveLength(1);});
  it('refuses a null successful assignment receipt',async()=>{const f=fixture({postNull:true});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(posts()).toHaveLength(1);});
  it('inherits the chore due date',async()=>{const f=fixture({choreDue:'2026-01-02T10:00:00Z'});expect(await f.run()).toMatchObject({ok:true,data:{due_at:'2026-01-02T10:00:00Z'}});});
  it('preserves an explicit assignment due date',async()=>{const f=fixture({choreDue:'2026-01-02T10:00:00Z',dueAt:'2026-01-03T11:00:00Z'});expect(await f.run()).toMatchObject({ok:true,data:{due_at:'2026-01-03T11:00:00Z'}});});
  it('preserves null due fallback rather than clearing the chore date',async()=>{const f=fixture({choreDue:'2026-01-02T10:00:00Z',dueAt:null});expect(await f.run()).toMatchObject({ok:true,data:{due_at:'2026-01-02T10:00:00Z'}});});
  it('preserves an assignment idempotency key without probing',async()=>{const f=fixture({idempotencyKey:'neutral-operation-key'});expect(await f.run()).toMatchObject({ok:true,data:{idempotency_key:'neutral-operation-key'}});expect(posts()).toHaveLength(1);});
  it('omits an empty idempotency key from the assignment payload',async()=>{const f=fixture({idempotencyKey:''});const result=await f.run();expect(result.ok).toBe(true);if(result.ok)expect(result.data).not.toHaveProperty('idempotency_key');expect(posts()).toHaveLength(1);});
 });
// END ORIGINAL19 COMPLETE CASE BLOCK
describe('additional chore member receipt controls',()=>{
 it('refuses an actualSDK500 member read before assignment POST',async()=>{const f=fixture({memberStatus:500});expect(await f.run()).toMatchObject({ok:false,code:'db'});expect(posts()).toHaveLength(0);});
 for(const [label,body]of [['string','neutral synthetic member'],['numeric id',{id:7,family_id:FAMILY}],['numeric family id',{id:MEMBER,family_id:7}],['wrong string id',{id:FOREIGN_A,family_id:FAMILY}],['wrong string family',{id:MEMBER,family_id:OTHER}]] as const){it('refuses a successful malformed member receipt '+label+' before assignment POST',async()=>{const f=fixture({memberReceipt:body});expect(await f.run()).toMatchObject({ok:false,code:'not_found'});expect(posts()).toHaveLength(0);});}
});
