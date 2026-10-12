import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual MessagesModule, browser cookie client and installed SDK. App context,
// HTTP server, formatting/media and realtime transport are synthetic boundaries.
// No database/RLS/Auth-provider qualification; original family-state file stays intact.
const { react, reactDom } = reactBrowserScripts('development');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');
const isolated = new Set(['react','react-dom','lucide-react','@/components/app/app-context','@/components/i18n/locale-provider','@/components/i18n/use-format','@/components/ui/toast','@/components/ai/ai-insight','@/lib/utils/format','@/lib/storage/use-family-media','@/components/media/family-media-img']);
const modules: Record<string,{source:string;imports:Record<string,string>}> = {};
function collect(filename:string):string {
  const id=path.resolve([filename,`${filename}.ts`,`${filename}.tsx`,path.join(filename,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile())??filename);
  if(modules[id])return id;
  const raw=fs.readFileSync(id,'utf8');
  const source=id.endsWith('.json')?`module.exports={default:${raw}};`:/\.tsx?$/.test(id)?ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText:raw;
  const item=modules[id]={source,imports:{} as Record<string,string>};
  for(const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name=match[1];
    if(isolated.has(name)||name==='@supabase/supabase-js'){item.imports[name]=name;continue;}
    item.imports[name]=collect(name.startsWith('@/')?path.resolve(name.slice(2)):name.startsWith('.')&&/\.tsx?$/.test(id)?path.resolve(path.dirname(id),name):require.resolve(name,{paths:[path.dirname(id)]}));
  }return id;
}
const entries=Object.fromEntries(['components/modules/messages-module.tsx','lib/supabase/client.ts','lib/messages/reads.ts'].map(file=>[file,collect(file)]));
const catalogue=JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json','utf8'));
const origin='https://messages-ui.invalid',provider='https://messages-provider.invalid',cookieKey='sb-messages-provider-auth-token';
const actor='20000000-0000-4000-8000-000000000001';
const families=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'];
const conversations=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
const rowIds=['40000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002'];
const markerA='Private history belonging to family A',markerB='Current history belonging to family B';
function session(){const now=Math.floor(Date.now()/1000),payload={sub:actor,session_id:'11111111-1111-4111-8111-111111111111',exp:now+3600,iat:now,iss:provider+'/auth/v1',aud:'authenticated',role:'authenticated'};return{access_token:[Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),Buffer.from(JSON.stringify(payload)).toString('base64url'),'synthetic-signature'].join('.'),refresh_token:'synthetic-owned-refresh',token_type:'bearer',expires_in:3600,expires_at:now+3600,user:{id:actor,aud:'authenticated',role:'authenticated',email:'synthetic@example.invalid',app_metadata:{},user_metadata:{},created_at:'2026-10-01T00:00:00Z'}};}
const diagnostics = new WeakMap<Page,{reads:unknown[];writes:string[];pending:unknown[];pageErrors:string[]}>();
async function fixture(page:Page,holdA:boolean){
  const reads:Array<{method:string;path:string;family:string|null;conversation:string|null;countRequested:boolean}>=[],writes:string[]=[],pending:Array<()=>Promise<void>>=[];
  const pageErrors:string[]=[];diagnostics.set(page,{reads,writes,pending,pageErrors});page.on('pageerror',error=>pageErrors.push(error.message));
  const headers={'access-control-allow-origin':origin,'access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS','access-control-expose-headers':'content-range'};
  const conv=(i:number)=>({id:conversations[i],family_id:families[i],name:'Family '+(i?'B':'A'),kind:'group',avatar_emoji:'💬',is_archived:false,is_family_chat:true,member_ids:[actor],participant_ids:['member-'+i],created_by:actor,last_message_at:'2026-10-02T12:00:00Z',created_at:'2026-10-01T12:00:00Z',updated_at:'2026-10-02T12:00:00Z'});
  const message=(i:number)=>({id:rowIds[i],family_id:families[i],conversation_id:conversations[i],content:i?markerB:markerA,sender_id:'20000000-0000-4000-8000-000000000002',sender_name:'Synthetic reader',kind:'text',attachment_url:null,attachment_name:null,attachment_mime:null,reply_to_id:null,reactions:{},read_by:[],is_pinned:false,deleted_at:null,created_at:'2026-10-02T12:00:00Z',edited_at:null});
  await page.routeWebSocket('**/realtime/**',socket=>socket.close({code:1000,reason:'Synthetic realtime server deliberately unavailable'}));
  await page.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===origin){await route.fulfill({contentType:'text/html',body:'<!doctype html><main id="root"></main>'});return;}
    if(url.origin!==provider)throw new Error('Unexpected external transport destination');
    if(request.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    const family=url.searchParams.get('family_id')?.replace(/^eq\./,'')??null,conversation=url.searchParams.get('conversation_id')?.replace(/^eq\./,'')??null;
    reads.push({method:request.method(),path:url.pathname,family,conversation,countRequested:(request.headers().prefer??'').includes('count=exact')});
    if(url.pathname==='/realtime/v1/api/broadcast'&&request.method()==='POST'){await route.fulfill({status:503,contentType:'application/json',headers,body:JSON.stringify({error:'Synthetic realtime unavailable'})});return;}
    let body:unknown=[],total=0;
    if(url.pathname==='/rest/v1/family_conversations'){const i=families.indexOf(family!);if(i<0)throw new Error('Inbox query lacks known family scope');body=[conv(i)];total=1;}
    else if(url.pathname==='/rest/v1/family_messages'){const i=families.indexOf(family!);if(i<0||conversation!==conversations[i])throw new Error('History query lacks exact family/conversation scope');body=[message(i)];total=1;}
    else if(url.pathname==='/rest/v1/rpc/family_conversation_overview'){const args=request.postDataJSON() as {p_family_id:string};const i=families.indexOf(args.p_family_id);if(i<0)throw new Error('Overview missing family');body=[{conversation_id:conversations[i],last_message:null,unread_count:0}];total=1;}
    else if(url.pathname==='/rest/v1/rpc/ensure_family_conversation'||url.pathname==='/rest/v1/rpc/mark_conversation_read_through'){writes.push(url.pathname);body=null;}
    else if(url.pathname==='/rest/v1/family_conversation_preferences'){body=[];}
    else throw new Error('Unexpected SDK endpoint '+url.pathname);
    const respond=()=>route.fulfill({status:200,contentType:'application/json',headers:{...headers,'content-range':total?`0-${total-1}/${total}`:'*/0'},body:JSON.stringify(body)});
    if(holdA&&url.pathname==='/rest/v1/family_messages'&&family===families[0])pending.push(respond);else await respond();
  });
  await page.context().addCookies([{name:cookieKey,value:'base64-'+Buffer.from(JSON.stringify(session())).toString('base64url'),url:origin,secure:true,sameSite:'Lax'}]);
  await page.goto(origin);for(const content of [react,reactDom,sdk])await page.addScriptTag({content});await page.addScriptTag({content:'window.react=window.React;'});await page.addScriptTag({content:icons});
  await page.addScriptTag({content:`(()=>{
    const sources=${JSON.stringify(modules)},entries=${JSON.stringify(entries)},loaded={},catalogue=${JSON.stringify(catalogue)},families=${JSON.stringify(families)},actor=${JSON.stringify(actor)};
    const process={env:{NEXT_PUBLIC_SUPABASE_URL:${JSON.stringify(provider)},NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key'}};
    const p=window.__messagesSdk={errors:[],notices:[],settlements:[]};window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
    let index=0;const members=()=>[{id:'member-'+index,family_id:families[index],user_id:actor,display_name:'Alex',role:'parent',is_active:true,color:'#123456'}];
    const translate=(key,vars={})=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),catalogue[key]||key),fmt={fmtDate:iso=>new Date(iso).toLocaleDateString('en-US'),fmtTime:iso=>new Date(iso).toLocaleTimeString('en-US')};
    const toast={error:message=>p.notices.push(message),success:message=>p.notices.push(message)}; const h=React.createElement,mocks={react:React,'react-dom':ReactDOM,'lucide-react':window.LucideReact,'@supabase/supabase-js':window.supabase,
      '@/components/app/app-context':{useApp:()=>({familyId:families[index],userId:actor,members:members(),selfMember:members()[0],role:'parent'})},
      '@/components/i18n/locale-provider':{useTranslations:()=>translate,useLocale:()=>({code:'en-US'})},
      '@/components/i18n/use-format':{useFormat:()=>fmt,useFamilyClock:()=>({dayKeyOf:iso=>iso.slice(0,10),todayKey:()=> '2026-10-02',wallKey:()=> '2026-10-01',addDays:x=>x,wallToday:()=>new Date('2026-10-02')})},
      '@/lib/utils/format':{firstName:name=>name.split(' ')[0],initials:name=>name.slice(0,2),createFormat:()=>fmt},
      '@/components/ui/toast':{useToast:()=>toast},'@/components/ai/ai-insight':{AiInsight:()=>null},
      '@/lib/storage/use-family-media':{useFamilyMediaUrls:()=>()=>undefined},'@/components/media/family-media-img':{FamilyMediaImg:props=>h('div',{role:'img','aria-label':props.alt})}};
    function load(id){if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports','process',item.source)(name=>load(item.imports[name]),m,m.exports,process);return m.exports;}
    const readers=load(entries['lib/messages/reads.ts']),original=readers.readMessageWindow;
    readers.readMessageWindow=(...args)=>original(...args).then(result=>{p.settlements.push({family:args[1],conversation:args[2],error:result.error?.code??null,rows:result.data?.length??null});return result;},error=>{p.settlements.push({family:args[1],conversation:args[2],thrown:String(error)});throw error;});
    const client=load(entries['lib/supabase/client.ts']).createClient();p.user=async()=> (await client.auth.getSession()).data.session?.user.id??null;
    const root=ReactDOM.createRoot(document.getElementById('root'));const render=()=>ReactDOM.flushSync(()=>root.render(h(load(entries['components/modules/messages-module.tsx']).MessagesModule)));
    p.switchFamily=()=>{index=1;render();};p.retire=()=>ReactDOM.flushSync(()=>root.unmount());p.flush=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));render();
  })();`});
  return{reads,writes,pending,releaseA:async()=>{holdA=false;for(const respond of pending.splice(0))await respond();}};
}
const probe=(page:Page)=>page.evaluate(()=>({errors:(window as any).__messagesSdk.errors,settlements:(window as any).__messagesSdk.settlements}));
test('installed SDK healthy history uses exact family and conversation counts',async({page})=>{
  const state=await fixture(page,false);await expect(page.locator('#message-'+rowIds[0])).toContainText(markerA);
  expect(state.reads.some(r=>r.path==='/rest/v1/family_messages'&&r.family===families[0]&&r.conversation===conversations[0]&&r.countRequested)).toBe(true);
  expect(await page.evaluate(()=>(window as any).__messagesSdk.user())).toBe(actor);expect((await probe(page)).errors).toEqual([]);
  await page.evaluate(()=>(window as any).__messagesSdk.retire());
});
test('old SDK history cannot enter a valid new-family workspace after completion',async({page})=>{
  const state=await fixture(page,true);await expect.poll(()=>state.pending.length).toBeGreaterThan(0);
  const before=(await page.context().cookies()).filter(c=>c.name.startsWith(cookieKey));
  expect(await page.evaluate(()=>(window as any).__messagesSdk.user())).toBe(actor);
  await page.evaluate(()=>(window as any).__messagesSdk.switchFamily());
  await expect(page.locator('#message-'+rowIds[1])).toContainText(markerB);await expect(page.locator('#message-'+rowIds[0])).toHaveCount(0);
  expect(state.reads.some(r=>r.path==='/rest/v1/family_messages'&&r.family===families[1]&&r.conversation===conversations[1]&&r.countRequested)).toBe(true);
  await state.releaseA();
  await expect.poll(async()=> (await probe(page)).settlements.filter((r:any)=>r.family===families[0]).length).toBeGreaterThan(0);
  await page.evaluate(()=>(window as any).__messagesSdk.flush());
  const old=(await probe(page)).settlements.filter((r:any)=>r.family===families[0]);
  expect(old.every((r:any)=>r.rows===1&&r.error===null)).toBe(true);
  await expect(page.locator('#message-'+rowIds[1])).toContainText(markerB);await expect(page.locator('#message-'+rowIds[0])).toHaveCount(0);
  expect((await page.context().cookies()).filter(c=>c.name.startsWith(cookieKey))).toEqual(before);
  expect(await page.evaluate(()=>(window as any).__messagesSdk.user())).toBe(actor);expect((await probe(page)).errors).toEqual([]);
  await test.info().attach('history-transport-observations',{contentType:'application/json',body:Buffer.from(JSON.stringify({reads:state.reads,settlements:(await probe(page)).settlements}))});
  await page.evaluate(()=>(window as any).__messagesSdk.retire());
});

// Failure-only observation; original two test callbacks and oracles stay intact.
test.afterEach(async ({page},info)=>{
  const state=diagnostics.get(page);
  const browser=await page.evaluate(()=>{const p=(window as any).__messagesSdk;return{errors:p?.errors??[],notices:p?.notices??[],settlements:p?.settlements??[],rootText:document.getElementById('root')?.innerText?.slice(0,2000)??null,rootChildren:document.getElementById('root')?.childElementCount??null};}).catch(error=>({observationError:String(error)}));
  const safe=JSON.stringify({status:info.status,reads:state?.reads??[],writes:state?.writes??[],pendingCount:state?.pending.length??0,pageErrors:state?.pageErrors??[],browser}).replace(/https?:\/\/[^\s"']+/g,'[redacted-url]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,'[redacted-token]');
  await info.attach('safe-prerequisite-diagnostics',{contentType:'application/json',body:Buffer.from(safe)});
});
