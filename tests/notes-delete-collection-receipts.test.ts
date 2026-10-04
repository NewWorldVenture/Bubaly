import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {createClient} from '@supabase/supabase-js';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

// Actual notes/types/errors and installed SDK; all activity/context/Auth seams inert.
const sourceRoot=process.env.BUBALY_NOTES_SOURCE_ROOT??process.cwd();
const sourceFiles={notes:'lib/services/notes/index.ts',types:'lib/services/types.ts',errors:'lib/supabase/errors.ts'};
const sources=Object.fromEntries(Object.entries(sourceFiles).map(([name,file])=>[name,ts.transpileModule(fs.readFileSync(path.join(sourceRoot,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText]));
const note={id:'note-A',family_id:'family-A',title:'Synthetic household note',body:'Neutral ordinary text',is_pinned:false,created_by:'synthetic-user-A'};
type Receipt={name:string;requests:any[];sdkReplies:any[];activity:any[];forbidden:string[];transportErrors:string[];expectedServiceLogs:any[];settled:number};
const allReceipts:Receipt[]=[];let receipt:Receipt;
beforeEach(()=>{receipt={name:expect.getState().currentTestName??'unnamed',requests:[],sdkReplies:[],activity:[],forbidden:[],transportErrors:[],expectedServiceLogs:[],settled:0};vi.spyOn(console,'error').mockImplementation((...args)=>{receipt.expectedServiceLogs.push(args);});});
afterEach(()=>{
 allReceipts.push(receipt);
 expect(receipt.forbidden).toEqual([]);expect(receipt.transportErrors).toEqual([]);expect(receipt.requests.length).toBeLessThanOrEqual(2);expect(receipt.settled).toBe(receipt.requests.length);
 expect(receipt.expectedServiceLogs.every(args=>['[service:notes] delete matched no row','[service:notes] delete failed','[service:notes] read failed'].includes(args[0]))).toBe(true);
 vi.restoreAllMocks();
});
afterAll(()=>{if(process.env.BUBALY_NOTES_RECEIPTS)fs.writeFileSync(process.env.BUBALY_NOTES_RECEIPTS,JSON.stringify(allReceipts,null,2)+'\n');});
function fixture(deleted:unknown,status=200,readBody:unknown=[note],readStatus=200){
 const deny=(label:string):never=>{receipt.forbidden.push(label);throw Error('Outside finite notes fixture: '+label);};
 const transport=async(input:RequestInfo|URL,init:RequestInit={})=>{try{
  const url=new URL(String(input)),method=init.method??'GET',index=receipt.requests.length;
  if(url.origin!=='https://notes-receipts.invalid'||url.pathname!=='/rest/v1/notes'||!['GET','DELETE'].includes(method)||url.searchParams.get('family_id')!=='eq.family-A'||url.searchParams.get('id')!=='eq.note-A'||url.searchParams.get('select')!==(method==='GET'?'*':'id')||index>=2)deny('unexpected SDK transport');
  if((index===0&&method!=='GET')||(index===1&&method!=='DELETE'))deny('unexpected request order');
  receipt.requests.push({method,path:url.pathname,query:url.search,accept:new Headers(init.headers).get('accept'),prefer:new Headers(init.headers).get('prefer')});
  receipt.settled++;const body=index===0?readBody:deleted,code=index===0?readStatus:status;
  return new Response(code===204?null:JSON.stringify(body),{status:code,headers:{'content-type':'application/json'}});
 }catch(cause){receipt.transportErrors.push(cause instanceof Error?cause.message:String(cause));throw cause;}};
 const db=createClient('https://notes-receipts.invalid','synthetic-public-key',{accessToken:async()=>null,global:{fetch:transport},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
 const wrap=(builder:any,kind:string):any=>new Proxy(builder,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);if(key==='then')return(resolve:any,reject:any)=>value.call(target,(reply:any)=>{receipt.sdkReplies.push({kind,data:reply.data,error:reply.error});return resolve(reply);},reject);if(typeof value==='function')return(...args:any[])=>{const next=value.apply(target,args);return typeof next==='object'&&next!==null?wrap(next,key==='delete'?'delete':kind):next;};return value;}});
 const instrumented={from:(table:string)=>wrap(db.from(table),'read'),channel:()=>deny('realtime'),rpc:()=>deny('RPC')};
 const scope={db:instrumented,familyId:'family-A',userId:'synthetic-user-A',memberId:'synthetic-member-A',role:'parent',actorKind:'member',tz:'UTC'};
 const modules:Record<string,any>={};
 function load(id:string):any{if(id==='server-only')return{};if(id==='../activity')return{recordActivitySafely:async(_scope:any,event:any)=>{receipt.activity.push(event);}};const key=id==='../types'?'types':id==='@/lib/supabase/errors'?'errors':id;if(!(key in sources))return deny('unapproved source import '+id);if(modules[key])return modules[key].exports;const entry=modules[key]={exports:{}};new Function('require','module','exports',sources[key])(load,entry,entry.exports);return entry.exports;}
 return{scope,deleteNote:load('notes').deleteNote};
}
async function call(deleted:unknown,status=200,readBody:unknown=[note],readStatus=200){const f=fixture(deleted,status,readBody,readStatus);return f.deleteNote(f.scope,'note-A');}
function refusal(result:any){expect.soft(result).toMatchObject({ok:false,code:'db',error:expect.any(String)});expect.soft(receipt.activity).toEqual([]);}

describe('original notes DELETE collection receipt contract',()=>{
 for(const body of[{length:1,0:{id:'note-A'}},{},'X',42])it('SDK200 '+(typeof body==='object'?(Object.keys(body).length?'indexed object':'plain object'):typeof body)+' cannot confirm deletion without an array receipt',async()=>{const result=await call(body);refusal(result);expect(receipt.requests.map(r=>r.method)).toEqual(['GET','DELETE']);expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:body,error:null});});
 it('healthy nonempty SDK collection confirms deletion and exactly one inert activity',async()=>{expect(await call([{id:'note-A'}])).toEqual({ok:true,data:{id:'note-A'}});expect(receipt.activity).toEqual([{agent:'notes',action:'delete',title:'Deleted the note "Synthetic household note"',href:'/dashboard/notes',resourceId:'note-A'}]);expect(receipt.sdkReplies).toEqual([{kind:'read',data:note,error:null},{kind:'delete',data:[{id:'note-A'}],error:null}]);});
 it('empty DELETE array refuses without success activity',async()=>{refusal(await call([]));expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:[],error:null});});
 it('null DELETE success preserves existing refusal',async()=>{refusal(await call(null));expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:null,error:null});});
 it('falsy boolean DELETE success preserves existing refusal',async()=>{refusal(await call(false));expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:false,error:null});});
 it('204 without returned collection refuses confirmation',async()=>{refusal(await call(null,204));expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:null,error:null});});
 it('explicit DELETE403 refuses cleanly',async()=>{refusal(await call({code:'42501',message:'Synthetic read refused'},403));expect(receipt.sdkReplies[1].error).toMatchObject({code:'42501'});});
 it('explicit DELETE500 refuses cleanly',async()=>{refusal(await call({message:'Synthetic delete unavailable'},500));expect(receipt.sdkReplies[1].error).not.toBeNull();});
 it('read failure prevents DELETE dispatch',async()=>{refusal(await call([{id:'note-A'}],200,{message:'Synthetic read unavailable'},500));expect(receipt.requests.map(r=>r.method)).toEqual(['GET']);});
 it('missing scoped note prevents DELETE dispatch',async()=>{expect(await call([{id:'note-A'}],200,[])).toMatchObject({ok:false,code:'not_found'});expect(receipt.activity).toEqual([]);expect(receipt.requests.map(r=>r.method)).toEqual(['GET']);});
 it('SDK maybeSingle multirow refusal prevents DELETE dispatch',async()=>{refusal(await call([{id:'note-A'}],200,[note,{...note,id:'note-B'}]));expect(receipt.requests.map(r=>r.method)).toEqual(['GET']);expect(receipt.sdkReplies[0].error).toMatchObject({code:'PGRST116'});});
 it('empty requested id performs no SDK transport or activity',async()=>{const f=fixture([{id:'note-A'}]);expect(await f.deleteNote(f.scope,'  ')).toMatchObject({ok:false,code:'invalid_input'});expect(receipt.requests).toEqual([]);expect(receipt.activity).toEqual([]);});
});

describe('additional notes DELETE collection compatibility controls',()=>{
 it('truthy boolean SDK200 cannot confirm deletion without an array receipt',async()=>{refusal(await call(true));expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:true,error:null});});
 it('zero numeric SDK200 preserves existing refusal',async()=>{refusal(await call(0));expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:0,error:null});});
 it('empty string SDK200 preserves existing refusal',async()=>{refusal(await call(''));expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:'',error:null});});
 it('nonempty array with null entry preserves collection-only admission',async()=>{expect(await call([null])).toEqual({ok:true,data:{id:'note-A'}});expect(receipt.activity).toHaveLength(1);expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:[null],error:null});});
 it('nonempty array with scalar entry preserves collection-only admission',async()=>{expect(await call(['synthetic-entry'])).toEqual({ok:true,data:{id:'note-A'}});expect(receipt.activity).toHaveLength(1);expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:['synthetic-entry'],error:null});});
 it('multiple returned array rows preserve existing deletion confirmation',async()=>{const rows=[{id:'note-A'},{id:'note-A'}];expect(await call(rows)).toEqual({ok:true,data:{id:'note-A'}});expect(receipt.activity).toHaveLength(1);expect(receipt.sdkReplies[1]).toEqual({kind:'delete',data:rows,error:null});});
});
