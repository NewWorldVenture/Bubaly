import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {createClient} from '@supabase/supabase-js';
import {dispatchPendingPushes} from '@/lib/server/push';
const native=vi.hoisted(()=>({send:vi.fn()}));
vi.mock('@/lib/server/native-push',()=>({sendNativePush:native.send,nativePushConfigured:()=>({fcm:true,apns:false})}));
vi.mock('web-push',()=>({default:{setVapidDetails:()=>{throw Error('No web push')},sendNotification:()=>{throw Error('No web push')}}}));
vi.mock('@/lib/server/push-endpoint',()=>({isDeliverablePushEndpoint:()=>{throw Error('No web endpoint')}}));
const id='00000000-0000-4000-8000-000000000001',previous='00000000-0000-4000-8000-000000000000';
const now=new Date('2026-10-02T01:00:00Z');
const cursor=(n=id)=>({version:1,createdAt:now.toISOString(),id:n});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve};}
function fixture({advances=false,inactive=false,receiptError=false,generation='',outcome='sent',twoRows=false,claimError=false,emptyClaim=false}={}){
  const settings:Record<string,unknown>={'push_dispatch_cursor:v1:global':cursor(advances?previous:id),'push_dispatch_cursor:v1:family:family':cursor(advances?previous:id)};
  const notice:any={id,family_id:'family',user_id:'recipient',title:'Synthetic ordinary reminder',body:'Synthetic neutral content',created_at:now.toISOString(),send_at:now.toISOString(),pushed_at:null};
  if(generation)for(const key of Object.keys(settings))settings[key]={...(settings[key] as object),generation};
  const tables:any={notifications:twoRows?[notice,{...notice,id:'00000000-0000-4000-8000-000000000002'}]:[notice],family_members:[{id:'member',family_id:'family',user_id:'recipient',role:'parent',is_active:!inactive}],user_preferences:[],family_ai_settings:[],push_devices:[{id:'device',user_id:'recipient',provider:'fcm',platform:'android',enabled:true,token:'synthetic-token'}],push_deliveries:[]};
  const requests:any[]=[];const firstPending=deferred(),bothPending=deferred(),releasePending=deferred(),bothClaims=deferred(),releaseSend=deferred();let barrier=false,pendingReads=0,claims=0,sends=0;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);if(url.origin!=='https://synthetic.invalid')throw Error('Unexpected origin');
    const table=url.pathname.split('/').at(-1)!;const method=init?.method??'GET';const body=init?.body?JSON.parse(String(init.body)):null;
    requests.push({table,method,query:Object.fromEntries(url.searchParams),body});
    const reply=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
    const object=(rows:any[])=>String((init?.headers as any)?.Accept??(init?.headers as any)?.accept??'').includes('vnd.pgrst.object')?(rows[0]??null):rows;
    if(table==='app_settings'){
      const key=url.searchParams.get('key')!.slice(3);
      if(method==='GET')return reply(object([{value:structuredClone(settings[key])}]));
      if(method!=='PATCH')throw Error('Unexpected settings operation');
      if(claimError)return reply({code:'XX000',message:'Synthetic cursor refusal'},500);
      const expected=JSON.parse(url.searchParams.get('value')!.slice(3));const matches=!emptyClaim&&JSON.stringify(settings[key])===JSON.stringify(expected);
      requests.at(-1).matched=matches;requests.at(-1).oldValue=structuredClone(settings[key]);
      if(matches)settings[key]=structuredClone(body.value);
      claims++;if(claims===2)bothClaims.resolve();
      return reply(object(matches?[{key}]:[]));
    }
    if(!(table in tables))throw Error('Unexpected table '+table);
    if(table==='push_deliveries'&&receiptError&&method==='GET')return reply({code:'XX000',message:'Synthetic receipt refusal'},500);
    const matches=(row:any)=>[...url.searchParams].every(([key,raw])=>{
      if(['select','order','limit','offset','on_conflict'].includes(key))return true;
      if(key==='or') {const wrap=raw.includes('created_at.lt.'); const keyCursor={id:raw.match(/id\.(?:lte|gt)\.([^),]+)/)![1]}; const equalTime=row.created_at===now.toISOString();return wrap?(row.created_at<now.toISOString()||(equalTime&&row.id<=keyCursor.id)):(row.created_at>now.toISOString()||(equalTime&&row.id>keyCursor.id));}
      const [op,...parts]=raw.split('.');const value=parts.join('.');
      if(op==='eq')return String(row[key])===value;if(op==='is')return value==='null'?row[key]===null:false;
      if(op==='lte')return row[key]<=value;if(op==='in')return value.slice(1,-1).split(',').map(v=>v.replaceAll('"','')).includes(String(row[key]));
      throw Error('Unimplemented filter '+key+':'+raw);
    });
    let rows=tables[table].filter(matches).map((r:any)=>structuredClone(r));
    const order=url.searchParams.get('order');if(order)rows.sort((a:any,b:any)=>{for(const clause of order.split(',')){const [key,dir]=clause.split('.');if(a[key]!==b[key])return (a[key]<b[key]?-1:1)*(dir==='desc'?-1:1);}return 0;});
    if(method==='GET'){
      rows=rows.slice(Number(url.searchParams.get('offset')??0));const limit=url.searchParams.get('limit');if(limit)rows=rows.slice(0,Number(limit));
      if(table==='notifications'&&rows.length&&barrier){pendingReads++;firstPending.resolve();if(pendingReads===2)bothPending.resolve();await releasePending.promise;}
      const select=url.searchParams.get('select');if(select&&select!=='*')rows=rows.map((r:any)=>Object.fromEntries(select.split(',').map(k=>[k.trim(),r[k.trim()]])));
      return reply(object(rows));
    }
    if(table==='push_deliveries'&&method==='POST'){if(!tables.push_deliveries.some((r:any)=>r.notification_id===body.notification_id&&r.device_id===body.device_id))tables.push_deliveries.push(body);return reply(null,201);}
    if(table==='notifications'&&method==='PATCH'){for(const row of tables.notifications.filter(matches))Object.assign(row,body);return reply(null);}
    throw Error('Unexpected operation '+table+'/'+method);
  };
  const db=createClient('https://synthetic.invalid','synthetic-key',{accessToken:async()=>null,auth:{persistSession:false,autoRefreshToken:false},global:{fetch:fetcher}});
  native.send.mockImplementation(async()=>{sends++;await releaseSend.promise;return outcome;});
  return {db,requests,tables,settings,notice,get sends(){return sends},releaseSend,firstPending,bothPending,releasePending,bothClaims,enableBarrier(){barrier=true;},disableBarrier(){barrier=false;}};
}
beforeEach(()=>{native.send.mockReset();vi.spyOn(console,'error').mockImplementation(()=>{});vi.spyOn(console,'warn').mockImplementation(()=>{});});
afterEach(()=>vi.restoreAllMocks());
async function overlap(f:ReturnType<typeof fixture>,secondFamily=false){
  f.enableBarrier();const a=dispatchPendingPushes(f.db as any,{now});await f.firstPending.promise;
  const b=dispatchPendingPushes(f.db as any,{now,...(secondFamily?{familyId:'family'}:{})});await f.bothPending.promise;f.releasePending.resolve();await f.bothClaims.promise;
  // Both real SDK conditional writes completed. Allow their downstream reads
  // to finish while inert accepted sends are held, before either receipt exists.
  for(let i=0;i<20;i++)await new Promise<void>(r=>setImmediate(r));
  f.releaseSend.resolve();const results=await Promise.all([a,b]);
  console.info('SYNTHETIC_PUSH_OVERLAP',JSON.stringify({scope:secondFamily?'global+family':'global+global',physicalAcceptances:f.sends,reportedSent:results.reduce((n,r)=>n+r.result.sent,0),results,receiptRows:f.tables.push_deliveries.length,claims:f.requests.filter(r=>r.table==='app_settings'&&r.method==='PATCH'),operationOrder:f.requests.map(r=>`${r.method}:${r.table}`)}));
  return results;
}
describe('push cursor overlap actual SDK boundary',()=>{
 it('one existing scope delivers a wrapped same-cursor batch only once',async()=>{const f=fixture();const results=await overlap(f);expect(f.requests.filter(r=>r.table==='app_settings'&&r.method==='PATCH')).toHaveLength(2);expect(f.tables.push_deliveries).toHaveLength(1);expect(f.sends).toBe(1);expect(results.reduce((n,r)=>n+r.result.sent,0)).toBe(1);});
 it('changing the cursor preserves the existing single-winner guard',async()=>{const f=fixture({advances:true});const results=await overlap(f);expect(f.sends).toBe(1);expect(results.reduce((n,r)=>n+r.result.sent,0)).toBe(1);expect(results.some(r=>r.notifications===0)).toBe(true);});
 it('normal one-worker wrap still delivers and acknowledges',async()=>{const f=fixture();f.releaseSend.resolve();const result=await dispatchPendingPushes(f.db as any,{now});expect(result.result.sent).toBe(1);expect(f.notice.pushed_at).toBeTruthy();expect(f.tables.push_deliveries).toHaveLength(1);});
 it('sequential global then family does not send an acknowledged row again',async()=>{const f=fixture();f.releaseSend.resolve();await dispatchPendingPushes(f.db as any,{now});expect((await dispatchPendingPushes(f.db as any,{familyId:'family',now})).notifications).toBe(0);expect(f.sends).toBe(1);});
 it('refused receipt read sends and acknowledges nothing',async()=>{const f=fixture({receiptError:true});f.releaseSend.resolve();await expect(dispatchPendingPushes(f.db as any,{now})).rejects.toThrow('Push receipt read failed');expect(f.sends).toBe(0);expect(f.notice.pushed_at).toBeNull();});
 it('inactive membership remains withheld',async()=>{const f=fixture({inactive:true});f.releaseSend.resolve();expect((await dispatchPendingPushes(f.db as any,{now})).result.withheld).toBe(1);expect(f.sends).toBe(0);});
});

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
describe('stored cursor generation compatibility and ownership',()=>{
 it('upgrades a legacy cursor with exactly one opaque generation field',async()=>{
  const f=fixture();f.releaseSend.resolve();await dispatchPendingPushes(f.db as any,{now});
  expect(f.settings['push_dispatch_cursor:v1:global']).toEqual({...cursor(),generation:expect.stringMatching(UUID)});
  const write=f.requests.find(r=>r.table==='app_settings'&&r.method==='PATCH');
  expect(write.query.value).toBe('eq.'+JSON.stringify(cursor()));expect(write.matched).toBe(true);
 });
 it('uses a fresh generation when a refused delivery wraps to the same position again',async()=>{
  const f=fixture({outcome:'failed'});f.releaseSend.resolve();
  expect((await dispatchPendingPushes(f.db as any,{now})).result.failed).toBe(1);
  const first=structuredClone(f.settings['push_dispatch_cursor:v1:global']) as any;
  expect(first).toEqual({...cursor(),generation:expect.stringMatching(UUID)});
  expect((await dispatchPendingPushes(f.db as any,{now})).result.failed).toBe(1);
  const second=f.settings['push_dispatch_cursor:v1:global'] as any;
  expect(second).toEqual({...cursor(),generation:expect.stringMatching(UUID)});
  expect(second.generation).not.toBe(first.generation);expect(f.sends).toBe(2);expect(f.notice.pushed_at).toBeNull();expect(f.tables.push_deliveries).toEqual([]);
 });
 it('compares the complete stored generation for competing existing-cursor snapshots',async()=>{
  const generation='11111111-1111-4111-8111-111111111111';const f=fixture({generation});
  const results=await overlap(f);const claims=f.requests.filter(r=>r.table==='app_settings'&&r.method==='PATCH');
  expect(claims.map(r=>r.query.value)).toEqual(['eq.'+JSON.stringify({...cursor(),generation}),'eq.'+JSON.stringify({...cursor(),generation})]);
  expect(claims.map(r=>r.matched)).toEqual([true,false]);expect(f.sends).toBe(1);expect(results.reduce((n,r)=>n+r.result.sent,0)).toBe(1);
  expect(f.settings['push_dispatch_cursor:v1:global']).toEqual({...cursor(),generation:expect.stringMatching(UUID)});
  expect((f.settings['push_dispatch_cursor:v1:global'] as any).generation).not.toBe(generation);
 });
 it('rejects a stale snapshot after two real workers move the cursor away and back',async()=>{
  const f=fixture({twoRows:true,outcome:'failed'});f.releaseSend.resolve();f.enableBarrier();
  const stale=dispatchPendingPushes(f.db as any,{now,limit:1});await f.firstPending.promise;f.disableBarrier();
  expect((await dispatchPendingPushes(f.db as any,{now,limit:1})).result.failed).toBe(1);
  expect((await dispatchPendingPushes(f.db as any,{now,limit:1})).result.failed).toBe(1);
  expect((f.settings['push_dispatch_cursor:v1:global'] as any).id).toBe(id);
  f.releasePending.resolve();expect((await stale).notifications).toBe(0);expect(f.sends).toBe(2);
  expect(f.requests.filter(r=>r.table==='app_settings'&&r.method==='PATCH').map(r=>r.matched)).toEqual([true,true,false]);
  expect(f.tables.push_deliveries).toEqual([]);expect(f.tables.notifications.every((r:any)=>r.pushed_at===null)).toBe(true);
 });
 it.each(['refused','lost'])('sends and acknowledges nothing after a %s conditional cursor write',async mode=>{
  const f=fixture({claimError:mode==='refused',emptyClaim:mode==='lost'});f.releaseSend.resolve();
  if(mode==='refused')await expect(dispatchPendingPushes(f.db as any,{now})).rejects.toThrow('Push cursor write failed');
  else expect((await dispatchPendingPushes(f.db as any,{now})).notifications).toBe(0);
  expect(f.sends).toBe(0);expect(f.notice.pushed_at).toBeNull();expect(f.tables.push_deliveries).toEqual([]);expect(f.settings['push_dispatch_cursor:v1:global']).toEqual(cursor());
 });
});
