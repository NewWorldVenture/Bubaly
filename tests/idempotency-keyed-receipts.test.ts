import fs from 'node:fs';
import path from 'node:path';
import * as nativeCrypto from 'node:crypto';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const sourceRoot=process.env.BUBALY_IDEMPOTENCY_RECEIPT_SOURCE_ROOT??process.cwd();
const sourceText=Object.fromEntries(Object.entries({idempotency:'lib/services/idempotency.ts',types:'lib/services/types.ts',errors:'lib/supabase/errors.ts'}).map(([name,file])=>[name,ts.transpileModule(fs.readFileSync(path.join(sourceRoot,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText]));
const FAMILY='abcdefab-1234-4000-8000-000000000001',OTHER='bcdefabc-1234-4000-8000-000000000002',KEY='synthetic-key-A';
const ROW={id:'cdefabcd-1234-4000-8000-000000000001',family_id:FAMILY,idempotency_key:KEY,title:'Neutral synthetic reminder',member_id:null};
const CREATE_REFUSAL={ok:false,error:'Modeled create callback refused.',code:'db'};
const traces:any[]=[];let trace:any;
beforeEach(()=>{trace={name:expect.getState().currentTestName,requests:[],rawResponses:[],sdkReplies:[],createCalls:[],forbidden:[],transportErrors:[],settled:0,logs:[]};for(const method of['error','warn']as const)vi.spyOn(console,method).mockImplementation((...args)=>trace.logs.push({method,args}));});
afterEach(()=>{
 traces.push(trace);expect(trace.forbidden).toEqual([]);expect(trace.transportErrors).toEqual([]);expect(trace.requests.length).toBeGreaterThanOrEqual(1);expect(trace.requests.length).toBeLessThanOrEqual(2);expect(trace.settled).toBe(trace.requests.length);expect(trace.rawResponses).toHaveLength(trace.requests.length);expect(trace.sdkReplies).toHaveLength(trace.requests.length);expect(trace.createCalls.length).toBeLessThanOrEqual(1);
 for(const request of trace.requests){expect(request.method).toBe('GET');expect(request.table).toBe('family_reminders');expect(request.query).toEqual({select:'*',family_id:'eq.'+trace.family,idempotency_key:'eq.'+KEY,limit:'1'});expect(request.accept).toBeUndefined();expect(request.payload).toBeUndefined();}
 for(const call of trace.createCalls)expect(call.key).toBe(KEY);
 expect(trace.logs.every((l:any)=>String(l.args[0]).startsWith('[service:idempotency] duplicate probe failed for family_reminders'))).toBe(true);vi.restoreAllMocks();
});
afterAll(()=>{if(process.env.BUBALY_IDEMPOTENCY_RECEIPT_TRACE)fs.writeFileSync(process.env.BUBALY_IDEMPOTENCY_RECEIPT_TRACE,JSON.stringify(traces,null,2)+'\n');});
function fixture(options:any={}){
 const family=options.family??FAMILY,sequence=options.sequence??[{body:[ROW],status:200}];trace.family=family;trace.sequence=sequence;let index=0;
 const deny=(reason:string):never=>{trace.forbidden.push(reason);throw Error(reason);};
 const sdk=createClient('https://idempotency-keyed-receipt.invalid','synthetic-key-not-a-secret',{accessToken:async()=>null,auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input:any,init:any)=>{
  try{const url=new URL(String(input)),method=String(init?.method??'GET'),table=url.pathname.split('/').pop();if(url.origin!=='https://idempotency-keyed-receipt.invalid'||url.pathname!=='/rest/v1/family_reminders'||method!=='GET'||trace.requests.length>=2)deny('Outside finite GET transport');
   trace.requests.push({method,table,query:Object.fromEntries(url.searchParams),accept:new Headers(init?.headers).get('accept')??undefined,payload:init?.body});
   const reply=sequence[index++];if(!reply)deny('Unplanned extra SDK request');const status=reply.status??200;trace.rawResponses.push({status,body:reply.body});return new Response(JSON.stringify(reply.body),{status,headers:{'content-type':'application/json'}});
  }catch(error){trace.transportErrors.push(String(error));throw error;}finally{trace.settled++;}
 }}});
 const db={from:(table:string)=>{if(table!=='family_reminders')return deny('Unapproved table');let current:any=sdk.from(table);const observer:any=new Proxy({},{get(_target,key){if(key==='then')return(resolve:any,reject:any)=>current.then((reply:any)=>{trace.sdkReplies.push({data:reply.data,dataUndefined:reply.data===undefined,error:reply.error,status:reply.status,statusText:reply.statusText,count:reply.count});const adapted=options.dataErrorAdapter?{...reply,error:{code:'42501',message:'Declared data plus error adapter'}}:reply;if(options.dataErrorAdapter)trace.adapter='Healthy native SDK reply plus explicit error adapter';return resolve(adapted);},reject);const value=Reflect.get(current,key,current);return typeof value==='function'?(...args:any[])=>{const next=value.apply(current,args);if(next&&typeof next==='object')current=next;return observer;}:value;}});return observer;}};
 const modules:any={};function load(name:string):any{if(modules[name])return modules[name];const entry={exports:{}};modules[name]=entry.exports;const require=(id:string):any=>{if(id==='server-only')return{};if(id==='node:crypto')return nativeCrypto;if(id==='./types')return load('types');if(id==='@/lib/supabase/errors')return load('errors');return deny('Unexpected runtime import '+id);};new Function('require','module','exports',sourceText[name])(require,entry,entry.exports);modules[name]=entry.exports;return entry.exports;}
 const scope:any={db,familyId:family,userId:'synthetic-user',memberId:null,role:'parent',actorKind:'member',tz:'UTC',idempotencyKey:KEY};
 return{run:async()=>{const helper=load('idempotency');const result=await helper.withIdempotency(scope,{operation:'synthetic.keyedReceipt',input:{title:'Neutral synthetic reminder'},find:helper.keyedProbe(scope,'family_reminders','reminder')},async(key:string|null)=>{const result=options.createSuccess?{ok:true,data:ROW}:CREATE_REFUSAL;trace.createCalls.push({key,result});return result;});trace.result=result;return result;}};
}
// BEGIN ORIGINAL19 COMPLETE CASE BLOCK
 describe('original keyed saved receipt boundary',()=>{
  for(const[label,body]of[
   ['string','Neutral synthetic receipt'],['number',7],['boolean',false],['empty object',{}],['other family',[{...ROW,family_id:OTHER}]],['other key',[{...ROW,idempotency_key:'synthetic-key-a'}]],
  ]as const){it('refuses successful initial '+label+' receipt as a saved result',async()=>{expect(await fixture({sequence:[{body}]}).run()).toMatchObject({ok:false,code:'db'});expect(trace.createCalls).toEqual([]);expect(trace.requests).toHaveLength(1);});}
  for(const[label,body]of[['string','Neutral synthetic recovery'],['other family',[{...ROW,family_id:OTHER}]]]as const){it('failed create keeps its refusal instead of successful '+label+' recovery receipt',async()=>{expect(await fixture({sequence:[{body:[]},{body}]}).run()).toEqual(CREATE_REFUSAL);expect(trace.createCalls).toHaveLength(1);expect(trace.requests).toHaveLength(2);});}
  it('returns a healthy same-family saved row unchanged without a create',async()=>{expect(await fixture().run()).toEqual({ok:true,data:ROW});expect(trace.createCalls).toEqual([]);expect(trace.requests).toHaveLength(1);});
  it('accepts case-insensitive family UUID identity without changing the saved row',async()=>{expect(await fixture({family:FAMILY.toUpperCase()}).run()).toEqual({ok:true,data:ROW});expect(trace.createCalls).toEqual([]);});
  it('retains same-family settled legacy foreign-member outcome',async()=>{const row={...ROW,member_id:'defabcde-1234-4000-8000-000000000002'};expect(await fixture({sequence:[{body:[row]}]}).run()).toEqual({ok:true,data:row});expect(trace.createCalls).toEqual([]);});
  it('preserves opaque extra saved-row fields without a new content schema',async()=>{const row={...ROW,tags:[null,{opaque:true}],unknown_extra:{value:7}};expect(await fixture({sequence:[{body:[row]}]}).run()).toEqual({ok:true,data:row});expect(trace.createCalls).toEqual([]);});
  it('empty SDK collection permits one modeled successful create callback',async()=>{expect(await fixture({sequence:[{body:[]}],createSuccess:true}).run()).toEqual({ok:true,data:ROW});expect(trace.createCalls).toHaveLength(1);expect(trace.requests).toHaveLength(1);});
  it('legacy JSON null absence permits one modeled successful create callback',async()=>{expect(await fixture({sequence:[{body:null}],createSuccess:true}).run()).toEqual({ok:true,data:ROW});expect(trace.createCalls).toHaveLength(1);});
  it('initial native SDK403 refuses before any modeled create',async()=>{expect(await fixture({sequence:[{body:{code:'42501',message:'Neutral synthetic read refusal'},status:403}]}).run()).toMatchObject({ok:false,code:'db'});expect(trace.createCalls).toEqual([]);expect(trace.sdkReplies[0]).toMatchObject({status:403,data:null,error:{code:'42501'}});});
  it('declared data plus error adapter preserves initial error precedence',async()=>{expect(await fixture({dataErrorAdapter:true}).run()).toMatchObject({ok:false,code:'db'});expect(trace.createCalls).toEqual([]);expect(trace.sdkReplies[0]).toMatchObject({data:ROW,error:null,status:200});expect(trace.adapter).toBe('Healthy native SDK reply plus explicit error adapter');});
  it('failed modeled create returns a healthy matching recovery winner',async()=>{expect(await fixture({sequence:[{body:[]},{body:[ROW]}]}).run()).toEqual({ok:true,data:ROW});expect(trace.createCalls).toHaveLength(1);expect(trace.requests).toHaveLength(2);});
  it('failed modeled create without a winner retains the original refusal',async()=>{expect(await fixture({sequence:[{body:[]},{body:[]}]}).run()).toEqual(CREATE_REFUSAL);expect(trace.createCalls).toHaveLength(1);expect(trace.requests).toHaveLength(2);});
  it('failed recovery SDK403 retains the original modeled create refusal',async()=>{expect(await fixture({sequence:[{body:[]},{body:{code:'42501',message:'Neutral synthetic recovery refusal'},status:403}]}).run()).toEqual(CREATE_REFUSAL);expect(trace.createCalls).toHaveLength(1);expect(trace.sdkReplies[1]).toMatchObject({data:null,error:{code:'42501'},status:403});});
 });
// END ORIGINAL19 COMPLETE CASE BLOCK

// BEGIN FINAL20 EMPTY SAVED ID CASE
it('refuses a successful empty saved-row id before any modeled create',async()=>{const row={...ROW,id:''};expect(await fixture({sequence:[{body:[row]}]}).run()).toMatchObject({ok:false,code:'db'});expect(trace.sdkReplies[0]).toMatchObject({data:row,error:null,status:200});expect(trace.createCalls).toEqual([]);expect(trace.requests).toHaveLength(1);});
// END FINAL20 EMPTY SAVED ID CASE
