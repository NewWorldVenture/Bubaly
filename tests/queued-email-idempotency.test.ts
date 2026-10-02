import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createClient,type SupabaseClient} from '@supabase/supabase-js';
import type {Database} from '@/lib/database.types';
const h=vi.hoisted(()=>({row:null as any,members:[] as any[],prefs:[] as any[],sends:[] as any[],acks:[] as any[],calls:[] as any[],result:{ok:true} as any,failMembership:false,barrier:false,pendingReads:0,pendingReady:null as null|(()=>void),pendingRelease:null as null|Promise<void>,releasePending:null as null|(()=>void),holdProvider:false,providerRelease:null as null|Promise<void>,releaseProvider:null as null|(()=>void),firstSend:null as null|(()=>void),providerCalls:[] as any[],accepted:0,keyStore:new Map<string,any>(),ackRefusal:false,providerThrow:false,extraRows:[] as any[]}));
vi.mock('@/lib/server/list-all-auth-users',()=>({listAllAuthUsers:async()=>({users:[{id:'00000000-0000-4000-8000-000000000100',email:'synthetic@example.invalid',user_metadata:{display_name:'Synthetic adult'}}],error:null})}));
// The provider model follows documented key replay, in-flight409 and changed-payload409.
// It is inert: no actual Resend request/render or account lookup runs.
vi.mock('resend',()=>({Resend:class{
 emails={send:async(...args:any[])=>{
  const [input,options]=args,key=options?.idempotencyKey as string|undefined;
  h.providerCalls.push({args,input,key});
  const payload=JSON.stringify({from:input.from,to:input.to,subject:input.subject,replyTo:input.replyTo,props:input.react?.props,html:input.html});
  const existing=key?h.keyStore.get(key):null;
  if(existing){
   if(existing.payload!==payload)return{data:null,error:{statusCode:409,name:'invalid_idempotent_request',message:'Synthetic changed payload'}};
   if(existing.pending)return{data:null,error:{statusCode:409,name:'concurrent_idempotent_requests',message:'Synthetic in-flight request'}};
   return{data:{id:existing.id},error:null};
  }
  if(h.providerThrow)throw Error('Synthetic provider transport refusal before acceptance');
  h.sends.push({to:input.to,subject:input.subject,props:input.react.props});h.firstSend?.();
  if(key)h.keyStore.set(key,{payload,pending:true});
  if(h.holdProvider)await h.providerRelease;
  if(!h.result.ok){if(key)h.keyStore.delete(key);return{data:null,error:{statusCode:500,name:'application_error',message:'Synthetic refusal before acceptance'}};}
  const id='synthetic-accepted-'+(++h.accepted);if(key)h.keyStore.set(key,{payload,pending:false,id});return{data:{id},error:null};
 }};
}}));
import {deliverNotificationEmails} from '@/lib/server/notification-emails';
const family='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',user='00000000-0000-4000-8000-000000000100',notice='00000000-0000-4000-8000-000000000300';
const ids=(v:string|null)=>v?.startsWith('in.(')?v.slice(4,-1).split(','):[];
function db():SupabaseClient<Database>{return createClient<Database>('https://queued-email.synthetic.invalid','synthetic-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),q=url.searchParams,table=url.pathname.split('/').at(-1)!,method=init?.method??'GET';
 if(url.origin!=='https://queued-email.synthetic.invalid'||!url.pathname.startsWith('/rest/v1/'))throw Error('Unexpected transport');h.calls.push({table,method,query:url.search});
 const response=(data:any,status=200)=>new Response(data===null?null:JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(table==='notifications'&&method==='PATCH'){
  const patch=JSON.parse(String(init?.body));expect(Object.keys(patch)).toEqual(['sent_at']);expect(typeof patch.sent_at).toBe('string');const acknowledged=ids(q.get('id'));expect(acknowledged.every(id=>[h.row,...h.extraRows].some(row=>row.id===id))).toBe(true);if(h.ackRefusal)return response({code:'57014',message:'Synthetic acknowledgment refusal'},500);h.acks.push(patch);for(const row of [h.row,...h.extraRows])if(acknowledged.includes(row.id))row.sent_at=patch.sent_at;return response(null,204);
 }
 if(method!=='GET')throw Error('Unexpected mutation');let rows:any[]=[];
 if(table==='notifications'){
  expect(q.get('sent_at')).toBe('is.null');expect(q.get('user_id')).toBe('not.is.null');expect(q.get('send_at')).toMatch(/^lte\./);expect(q.get('order')).toMatch(/^created_at\.asc(?:,id\.asc)?$/);expect(q.get('limit')).toBe('500');
  // Each worker captures the same committed pending row before either can advance.
  rows=[h.row,...h.extraRows].filter(row=>row.sent_at===null).map(row=>structuredClone(row));h.pendingReads++;
  if(h.barrier){if(h.pendingReads===2)h.pendingReady?.();await h.pendingRelease;}
 }else if(table==='family_members'){
  if(h.failMembership)return response({code:'57014',message:'Synthetic membership refusal'},500);
  rows=h.members.filter(m=>ids(q.get('user_id')).includes(m.user_id)&&(!q.has('is_active')||m.is_active===true)&&(!q.has('role')||m.role==='child'));
 }else if(table==='user_preferences'){rows=h.prefs.filter(p=>ids(q.get('user_id')).includes(p.user_id));}
 else if(table==='family_ai_settings'){rows=[];}
 else throw Error('Unexpected table');
 const order=q.get('order');if(order){const keys=order.split(',').map(part=>part.split('.')[0]);rows.sort((a,b)=>{for(const key of keys){const comparison=String(a[key]).localeCompare(String(b[key]));if(comparison)return comparison;}return 0;});}
 const offset=Number(q.get('offset')??0),limit=Number(q.get('limit')??1000);rows=rows.slice(offset,offset+limit);
 const columns=q.get('select')?.split(',')??[];rows=rows.map(r=>Object.fromEntries(columns.map(k=>[k,r[k]])));return response(rows);
}}});}
beforeEach(()=>{h.row={id:notice,family_id:family,user_id:user,type:'system',title:'Synthetic household update',body:'Synthetic queue payload',sent_at:null,send_at:'2026-01-01T00:00:00Z',created_at:'2026-01-01T00:00:00Z'};h.members=[{id:'00000000-0000-4000-8000-000000000200',family_id:family,user_id:user,role:'adult',is_active:true}];h.prefs=[];h.sends=[];h.acks=[];h.calls=[];h.result={ok:true};h.failMembership=false;h.barrier=false;h.pendingReads=0;h.pendingReady=null;h.pendingRelease=null;h.releasePending=null;h.holdProvider=false;h.providerRelease=null;h.releaseProvider=null;h.firstSend=null;h.providerCalls=[];h.accepted=0;h.keyStore=new Map();h.ackRefusal=false;h.providerThrow=false;h.extraRows=[];vi.stubEnv('RESEND_API_KEY','re_synthetic_no_network');vi.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
it('overlapping workers send one pending recipient digest once',async()=>{
 h.barrier=true;h.holdProvider=true;const captured=new Promise<void>(r=>h.pendingReady=r);h.pendingRelease=new Promise<void>(r=>h.releasePending=r);h.providerRelease=new Promise<void>(r=>h.releaseProvider=r);const entered=new Promise<void>(r=>h.firstSend=r);
 const workers=Promise.all([deliverNotificationEmails(db()),deliverNotificationEmails(db())]);await captured;expect(h.pendingReads).toBe(2);expect(h.sends).toHaveLength(0);h.releasePending!();await entered;await new Promise<void>(r=>setImmediate(r));
 expect(h.acks).toEqual([]);h.releaseProvider!();const receipts=await workers;
 expect(h.row.sent_at).not.toBeNull();expect(h.sends.every(s=>s.to==='synthetic@example.invalid')).toBe(true);expect(h.sends.every(s=>s.props.items[0].title==='Synthetic household update')).toBe(true);
 expect({providerAcceptances:h.sends.length,reportedSent:receipts.reduce((n,r)=>n+r.sent,0)}).toEqual({providerAcceptances:1,reportedSent:1});
});
it('one healthy worker sends and acknowledges once',async()=>{expect(await deliverNotificationEmails(db())).toEqual({sent:1,failed:0,skipped:0});expect(h.sends).toHaveLength(1);expect(h.acks).toHaveLength(1);expect(h.row.sent_at).not.toBeNull();});
it('sequential workers respect the acknowledged row',async()=>{expect(await deliverNotificationEmails(db())).toEqual({sent:1,failed:0,skipped:0});expect(await deliverNotificationEmails(db())).toEqual({sent:0,failed:0,skipped:0});expect(h.sends).toHaveLength(1);expect(h.acks).toHaveLength(1);});
it('inactive membership is withheld and resolved without delivery',async()=>{h.members[0].is_active=false;expect(await deliverNotificationEmails(db())).toEqual({sent:0,failed:0,skipped:1});expect(h.sends).toEqual([]);expect(h.acks).toHaveLength(1);});
it('foreign-family active membership cannot authorize the digest',async()=>{h.members[0].family_id=other;expect(await deliverNotificationEmails(db())).toEqual({sent:0,failed:0,skipped:1});expect(h.sends).toEqual([]);expect(h.acks).toHaveLength(1);});
it('preflight refusal sends and acknowledges nothing',async()=>{h.failMembership=true;expect(await deliverNotificationEmails(db())).toEqual({sent:0,failed:1,skipped:0});expect(h.sends).toEqual([]);expect(h.acks).toEqual([]);expect(h.row.sent_at).toBeNull();});
it('provider refusal preserves pending and permits a later healthy retry',async()=>{h.result={ok:false};expect(await deliverNotificationEmails(db())).toEqual({sent:0,failed:1,skipped:0});expect(h.acks).toEqual([]);expect(h.row.sent_at).toBeNull();h.result={ok:true};expect(await deliverNotificationEmails(db())).toEqual({sent:1,failed:0,skipped:0});expect(h.sends).toHaveLength(2);expect(h.acks).toHaveLength(1);});

import {sendReactEmail} from '@/lib/email';
import * as React from 'react';
it('an acknowledged-failure replay reuses the accepted digest without another physical acceptance',async()=>{
 h.ackRefusal=true;expect(await deliverNotificationEmails(db())).toEqual({sent:1,failed:1,skipped:0});expect(h.row.sent_at).toBeNull();const key=h.providerCalls[0].key;
 h.ackRefusal=false;expect(await deliverNotificationEmails(db())).toEqual({sent:1,failed:0,skipped:0});expect(h.row.sent_at).not.toBeNull();expect(h.providerCalls).toHaveLength(2);expect(h.providerCalls[1].key).toBe(key);expect(h.sends).toHaveLength(1);expect(h.accepted).toBe(1);
});
it('the same pending digest successfully replays without claiming a new physical delivery',async()=>{
 await deliverNotificationEmails(db());h.row.sent_at=null;expect(await deliverNotificationEmails(db())).toEqual({sent:1,failed:0,skipped:0});expect(h.providerCalls).toHaveLength(2);expect(h.accepted).toBe(1);expect(h.sends).toHaveLength(1);
});
it('changed payload under an accepted key is refused and remains pending',async()=>{
 h.ackRefusal=true;await deliverNotificationEmails(db());h.ackRefusal=false;h.row.title='Synthetic changed title';expect(await deliverNotificationEmails(db())).toEqual({sent:0,failed:1,skipped:0});expect(h.row.sent_at).toBeNull();expect(h.acks).toEqual([]);expect(h.accepted).toBe(1);expect(h.providerCalls[1].key).toBe(h.providerCalls[0].key);
});
it('transport refusal before acceptance retains pending and permits the same-key healthy retry',async()=>{
 h.providerThrow=true;expect(await deliverNotificationEmails(db())).toEqual({sent:0,failed:1,skipped:0});expect(h.row.sent_at).toBeNull();expect(h.acks).toEqual([]);h.providerThrow=false;expect(await deliverNotificationEmails(db())).toEqual({sent:1,failed:0,skipped:0});expect(h.providerCalls[1].key).toBe(h.providerCalls[0].key);expect(h.accepted).toBe(1);
});
it('equal chronological timestamps have stable ID order and one bounded opaque key',async()=>{
 h.extraRows=[{...h.row,id:'00000000-0000-4000-8000-000000000299',title:'Synthetic earlier ID'}];h.ackRefusal=true;await deliverNotificationEmails(db());const input=h.providerCalls[0];expect(input.input.react.props.items.map((i:any)=>i.title)).toEqual(['Synthetic earlier ID','Synthetic household update']);expect(input.key).toMatch(/^notification-digest\/v1\/[0-9a-f]{64}$/);expect(input.key.length).toBeLessThanOrEqual(256);expect(input.key).not.toContain(user);expect(input.key).not.toContain(notice);
 h.ackRefusal=false;await deliverNotificationEmails(db());expect(h.providerCalls[1].key).toBe(input.key);expect(h.accepted).toBe(1);
});
it('a different notification row set gets a distinct key (changed-batch dedupe remains open)',async()=>{
 await deliverNotificationEmails(db());const first=h.providerCalls[0].key;h.row.id='00000000-0000-4000-8000-000000000301';h.row.sent_at=null;await deliverNotificationEmails(db());expect(h.providerCalls[1].key).not.toBe(first);expect(h.accepted).toBe(2);
});
it('a changed recipient identity gets a distinct digest key',async()=>{
 await deliverNotificationEmails(db());const key=h.providerCalls[0].key;const second='00000000-0000-4000-8000-000000000101';h.row.user_id=second;h.row.sent_at=null;h.members[0].user_id=second;
 // Recipient lookup is intentionally inert; add the second synthetic user via its mocked seam.
 const accounts=await import('@/lib/server/list-all-auth-users');vi.spyOn(accounts,'listAllAuthUsers').mockResolvedValue({users:[{id:second,email:'second@example.invalid',user_metadata:{}}] as any,error:null});await deliverNotificationEmails(db());expect(h.providerCalls[1].key).not.toBe(key);expect(h.accepted).toBe(2);
});
it('email helper preserves its one-argument SDK call when no key is requested',async()=>{
 expect(await sendReactEmail({to:'synthetic@example.invalid',subject:'Synthetic helper',react:React.createElement('p',null,'Synthetic')})).toEqual({ok:true});expect(h.providerCalls[0].args).toHaveLength(1);expect(h.providerCalls[0].key).toBeUndefined();
});
it('email helper forwards an optional key as SDK options and surfaces an in-flight error',async()=>{
 h.holdProvider=true;h.providerRelease=new Promise<void>(r=>h.releaseProvider=r);const args={to:'synthetic@example.invalid',subject:'Synthetic helper',react:React.createElement('p',null,'Synthetic'),idempotencyKey:'synthetic-helper/v1/1'};const first=sendReactEmail(args);await new Promise<void>(r=>setImmediate(r));const second=sendReactEmail(args);await new Promise<void>(r=>setImmediate(r));h.releaseProvider!();expect(await second).toEqual({ok:false});expect(await first).toEqual({ok:true});expect(h.providerCalls[0].args).toHaveLength(2);expect(h.providerCalls[0].args[1]).toEqual({idempotencyKey:args.idempotencyKey});expect(h.accepted).toBe(1);
});
it('installed Resend SDK encodes its idempotency option as the HTTP header without network',async()=>{
 const {Resend}=await vi.importActual<typeof import('resend')>('resend');const sdk=new Resend('re_synthetic_no_network');const boundary=vi.spyOn(sdk,'fetchRequest').mockResolvedValue({data:{id:'synthetic-sdk'},error:null} as any);await sdk.emails.send({from:'synthetic@example.invalid',to:'synthetic@example.invalid',subject:'Synthetic SDK',html:'<p>Synthetic</p>'},{idempotencyKey:'synthetic-sdk/v1/1'});expect(boundary).toHaveBeenCalledTimes(1);const [path,options]=boundary.mock.calls[0];expect(path).toBe('/emails');expect(new Headers((options as RequestInit | undefined)?.headers).get('Idempotency-Key')).toBe('synthetic-sdk/v1/1');
});
