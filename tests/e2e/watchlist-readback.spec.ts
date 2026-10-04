import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
const sourceRoot=process.env.BUBALY_WATCHLIST_UI_SOURCE_ROOT || process.cwd();
const origin='https://watchlist-readback.invalid';
const {react,reactDom}=reactBrowserScripts();
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/i18n/use-format','@/components/ui/toast','@/components/ui/confirm','@/lib/supabase/client','@/lib/offline/cache-scope','@/components/ai/ai-insight']);
const modules:Record<string,{source:string;imports:Record<string,string>}>= {};
function collect(filename:string):string {
 const id=path.resolve([filename,filename+'.ts',filename+'.tsx',path.join(filename,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile())??filename);
 if(modules[id])return id;
 const raw=fs.readFileSync(id,'utf8');
 const source=/\.tsx?$/.test(id)?ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText:raw;
 const item=modules[id]={source,imports:{} as Record<string,string>};
 for(const match of source.matchAll(/require\(["']([^"']+)["']\)/g)){const name=match[1];if(isolated.has(name)){item.imports[name]=name;continue;}item.imports[name]=collect(name.startsWith('@/')?path.join(sourceRoot,name.slice(2)):name.startsWith('.')?path.resolve(path.dirname(id),name):require.resolve(name,{paths:[path.dirname(id)]}));}
 return id;
}
const entry=collect(path.join(sourceRoot,'components/modules/watchlist-module.tsx'));
const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(browserErrors.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__watch?.errors??[])).toEqual([]);});
async function fixture(page:Page,initialMode='healthy'){
 let mode=initialMode;
 const family='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',user='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const rows:any[]=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',family_id:family,created_by:user,title:'Synthetic harbor film',kind:'movie',year:2020,genres:[],age_rating:'G',min_age:0,runtime_min:90,service:'netflix',status:'want',priority:2,external_url:null,notes:null,created_at:'2026-10-02T00:00:00Z',added_by:null}];
 const requests:any[]=[];
 await page.route('**/*',async route=>{if(route.request().url()!==origin+'/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});});
 await page.exposeFunction('__watchFetch',async(url:string,method:string,body:any)=>{
  const parsed=new URL(url);if(parsed.origin!==origin)throw Error('Unexpected SDK destination');
  const table=parsed.pathname.split('/').pop();requests.push({url,method,body,table});
  if(method==='GET'&&['watchlist_titles','watchlist_votes','watch_sessions'].includes(table!)){
   if(mode==='read-error'&&table==='watchlist_titles')return{status:400,body:{code:'SYNTHETIC',message:'Synthetic watchlist unavailable'}};
   if(table!=='watchlist_titles')return{status:200,body:[]};
   expect(parsed.searchParams.get('family_id')).toBe('eq.'+family);
   return{status:200,body:structuredClone(rows)};
  }
  if(['PATCH','DELETE'].includes(method)&&table==='watchlist_titles'){
   expect(parsed.searchParams.get('select')).toBe('id');const id=parsed.searchParams.get('id')?.replace(/^eq\./,'');
   if(mode==='refusal')return{status:400,body:{code:'SYNTHETIC',message:'Synthetic change refused'}};
   if(mode==='zero')return{status:200,body:[]};
   const index=rows.findIndex(r=>r.id===id);if(index<0)throw Error('Unknown synthetic title');
   if(method==='PATCH'){expect(body).toEqual({status:'watching'});Object.assign(rows[index],body);}else rows.splice(index,1);
   return{status:200,body:[{id}]};
  }
  throw Error('Unexpected SDK operation '+method+' '+table);
 });
 await page.goto(origin);for(const content of [react,reactDom,sdk,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,origin,family,user})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__watch={errors:[] as string[],notices:[] as any[],callbacks:[] as any[],settled:0,confirmations:0};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const fail=()=>{throw Error('Provider/AI/calendar/vote/session flow outside ordinary title fixture');};
  const sb=w.supabase.createClient(origin,'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url:any,init:any)=>{
   const method=init.method||'GET';try{const response=await w.__watchFetch(String(url),method,init.body?JSON.parse(init.body):null);return new Response(JSON.stringify(response.body),{status:response.status,headers:{'content-type':'application/json'}});}finally{if(method!=='GET')p.settled++;}
  }}});
  // Actual SDK request builder and inert subscription transport. No synthetic event
  // is delivered unless a control explicitly fires the saved real-hook callback.
  const db={from:(table:string)=>sb.from(table),channel:()=>({on(_event:any,filter:any,callback:any){p.callbacks.push({filter,callback});return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:family,userId:user,role:'parent',members:[],selfMember:null})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},'@/components/i18n/use-format':{useFamilyClock:()=>({todayKey:()=> '2026-10-02'}),useFamilyCalendarToday:()=>new Date('2026-10-02T12:00:00Z'),useFormat:()=>({fmtDate:()=> 'Oct 2'})},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>async()=>{p.confirmations++;return true;}},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));root.render(R.createElement(load(entry).WatchlistModule));
 },{sources:modules,entry,messages,origin,family,user});
 if(mode==='read-error')await expect(page.getByText('Could not load the watchlist. Refresh and try again.',{exact:true})).toBeVisible();
 else await expect(page.getByRole('button',{name:'Start Synthetic harbor film',exact:true})).toBeVisible();
 return{rows,requests,setMode:(value:string)=>{mode=value;},writes:()=>requests.filter(r=>r.method!=='GET'),reads:()=>requests.filter(r=>r.method==='GET'&&r.table==='watchlist_titles')};
}
async function settled(page:Page){await expect.poll(()=>page.evaluate(()=>(window as any).__watch.settled)).toBe(1);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
test('confirmed Start refreshes current Want and Watching tabs without a Realtime event',async({page})=>{
 const proof=await fixture(page);await page.getByRole('button',{name:'Start Synthetic harbor film',exact:true}).click();await settled(page);
 expect(proof.rows[0].status).toBe('watching');expect(proof.writes()).toHaveLength(1);expect(await page.evaluate(()=>(window as any).__watch.notices)).toEqual([{kind:'success',message:'Synthetic harbor film: Watching'}]);
 await expect(page.getByRole('button',{name:'Start Synthetic harbor film',exact:true})).toHaveCount(0);await page.getByRole('tab',{name:'Watching',exact:true}).click();await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toBeVisible();
});
test('confirmed own removal reads back title absence without a delete event',async({page})=>{
 const proof=await fixture(page);await page.getByRole('button',{name:'Remove Synthetic harbor film',exact:true}).click();await settled(page);
 expect(proof.rows).toEqual([]);expect(proof.writes()).toHaveLength(1);expect(proof.writes()[0].method).toBe('DELETE');expect(await page.evaluate(()=>(window as any).__watch.confirmations)).toBe(1);
 await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add the first title',exact:true})).toBeVisible();
});
test('actual saved status becomes visible when a real-hook synthetic Realtime callback fires',async({page})=>{
 const proof=await fixture(page);await page.getByRole('button',{name:'Start Synthetic harbor film',exact:true}).click();await settled(page);expect(proof.rows[0].status).toBe('watching');
 await page.evaluate(()=>(window as any).__watch.callbacks.find((x:any)=>x.filter.table==='watchlist_titles').callback());await expect(page.getByRole('button',{name:'Start Synthetic harbor film',exact:true})).toHaveCount(0);await page.getByRole('tab',{name:'Watching',exact:true}).click();await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toBeVisible();expect(proof.reads().length).toBeGreaterThan(1);
});
test('online refresh reveals a confirmed own removal using the actual hook',async({page})=>{
 const proof=await fixture(page);await page.getByRole('button',{name:'Remove Synthetic harbor film',exact:true}).click();await settled(page);expect(proof.rows).toEqual([]);
 await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toHaveCount(0);expect(proof.reads().length).toBeGreaterThan(1);
});
for(const mode of ['refusal','zero'])test(mode+' Start preserves Want status and reports no success',async({page})=>{
 const proof=await fixture(page,mode);await page.getByRole('button',{name:'Start Synthetic harbor film',exact:true}).click();await settled(page);expect(proof.rows[0].status).toBe('want');expect(proof.writes()).toHaveLength(1);await expect(page.getByRole('button',{name:'Start Synthetic harbor film',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__watch.notices.map((x:any)=>x.kind))).toEqual(['error']);
});
test('ordinary tab and kind filters restore a saved title without a write',async({page})=>{
 const proof=await fixture(page);await page.getByRole('tab',{name:'Watching',exact:true}).click();await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toHaveCount(0);await page.getByRole('tab',{name:'Want to watch',exact:true}).click();await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Kind',exact:true}).selectOption('show');await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toHaveCount(0);await page.getByRole('combobox',{name:'Kind',exact:true}).selectOption('all');await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toBeVisible();expect(proof.writes()).toEqual([]);
});

for(const mode of ['refusal','zero'])test(mode+' own removal keeps its row and reports no success',async({page})=>{
 const proof=await fixture(page,mode);const reads=proof.reads().length;
 await page.getByRole('button',{name:'Remove Synthetic harbor film',exact:true}).click();await settled(page);
 expect(proof.rows).toHaveLength(1);expect(proof.writes()).toHaveLength(1);expect(proof.writes()[0].method).toBe('DELETE');
 await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__watch.notices.map((x:any)=>x.kind))).toEqual(['error']);expect(proof.reads()).toHaveLength(reads);
});

for(const action of ['Start','Remove'])test('confirmed '+action+' readback failure stays visible and Retry reads the saved store without another write',async({page})=>{
 const proof=await fixture(page);proof.setMode('read-error');
 await page.getByRole('button',{name:action+' Synthetic harbor film',exact:true}).click();await settled(page);
 expect(proof.writes()).toHaveLength(1);if(action==='Start')expect(proof.rows[0].status).toBe('watching');else expect(proof.rows).toEqual([]);
 await expect(page.getByText('Could not load the watchlist. Refresh and try again.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>(window as any).__watch.notices.map((x:any)=>x.kind))).toEqual(['success']);
 proof.setMode('healthy');await page.getByRole('button',{name:'Try again',exact:true}).click();
 if(action==='Start'){await page.getByRole('tab',{name:'Watching',exact:true}).click();await expect(page.getByRole('button',{name:'Edit Synthetic harbor film',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Start Synthetic harbor film',exact:true})).toHaveCount(0);}
 else await expect(page.getByRole('button',{name:'Add the first title',exact:true})).toBeVisible();
 expect(proof.writes()).toHaveLength(1);expect(proof.reads().length).toBeGreaterThan(2);
});

test('initial refused list read offers Retry and restores titles without a write',async({page})=>{
 const proof=await fixture(page,'read-error');await expect(page.getByRole('button',{name:'Start Synthetic harbor film',exact:true})).toHaveCount(0);
 proof.setMode('healthy');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('button',{name:'Start Synthetic harbor film',exact:true})).toBeVisible();expect(proof.writes()).toEqual([]);expect(proof.reads()).toHaveLength(2);
});
