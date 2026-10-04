import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
const sourceRoot=process.env.BUBALY_DECISIONS_UI_SOURCE_ROOT || process.cwd();
const origin='https://decisions-readback.invalid';
const {react,reactDom}=reactBrowserScripts();
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/i18n/use-format','@/components/ui/toast','@/components/ui/confirm','@/lib/supabase/client','@/lib/offline/cache-scope','@/components/ai/ai-insight','@/lib/wallet/ledger']);
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
const entry=collect(path.join(sourceRoot,'components/modules/decisions-module.tsx'));
const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(browserErrors.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__decision?.errors??[])).toEqual([]);});
async function fixture(page:Page,initialMode='healthy'){
 let mode=initialMode;
 const family='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',user='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const decisionId='aaaaaaaa-aaaa-4aaa-8aaa-000000000001',optionId='dddddddd-dddd-4ddd-8ddd-000000000001';
 const rows:any[]=[{id:decisionId,family_id:family,created_by:user,question:'Synthetic quiet activity',detail:null,status:'open',decided_option_id:null,budget_cents:null,max_travel_minutes:null,weights:{},updated_at:'2026-10-02T00:00:00Z',created_at:'2026-10-02T00:00:00Z'}];
 const options=[{id:optionId,family_id:family,decision_id:decisionId,label:'Synthetic puzzle',cost_cents:null,time_minutes:null,travel_minutes:null,load_delta:null,benefit:null,score:null,rationale:null,feasible:true},{id:'dddddddd-dddd-4ddd-8ddd-000000000002',family_id:family,decision_id:decisionId,label:'Synthetic reading',cost_cents:null,time_minutes:null,travel_minutes:null,load_delta:null,benefit:null,score:null,rationale:null,feasible:true}];
 const requests:any[]=[];
 await page.route('**/*',async route=>{if(route.request().url()!==origin+'/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});});
 await page.exposeFunction('__decisionFetch',async(url:string,method:string,body:any)=>{
  const parsed=new URL(url);if(parsed.origin!==origin)throw Error('Unexpected SDK destination');
  const table=parsed.pathname.split('/').pop();requests.push({url,method,body,table});
  if(method==='GET'&&['family_decisions','decision_options'].includes(table!)){
   expect(parsed.searchParams.get('family_id')).toBe('eq.'+family);
   if((mode==='read-error'||(mode==='readback-error'&&requests.some(r=>r.method==='PATCH')))&&table==='family_decisions')return{status:400,body:{code:'SYNTHETIC',message:'Synthetic decisions unavailable'}};
   return{status:200,body:structuredClone(table==='family_decisions'?rows:options)};
  }
  if(method==='PATCH'&&table==='family_decisions'){
   expect(parsed.searchParams.get('id')).toBe('eq.'+decisionId);expect(parsed.searchParams.get('select')).toBe('id');expect(body).toEqual({decided_option_id:optionId,status:'decided'});
   if(mode==='refusal')return{status:400,body:{code:'SYNTHETIC',message:'Synthetic choice refused'}};
   if(mode==='zero')return{status:200,body:[]};
   Object.assign(rows[0],body);return{status:200,body:[{id:decisionId}]};
  }
  throw Error('Unexpected SDK operation '+method+' '+table);
 });
 await page.goto(origin);for(const content of [react,reactDom,sdk,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,origin,family,user})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__decision={errors:[] as string[],notices:[] as any[],callbacks:[] as any[],settled:0,confirmations:0};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const fail=()=>{throw Error('Provider/AI/calendar/vote/session flow outside ordinary title fixture');};
  const sb=w.supabase.createClient(origin,'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url:any,init:any)=>{
   const method=init.method||'GET';try{const response=await w.__decisionFetch(String(url),method,init.body?JSON.parse(init.body):null);return new Response(JSON.stringify(response.body),{status:response.status,headers:{'content-type':'application/json'}});}finally{if(method!=='GET')p.settled++;}
  }}});
  // Actual SDK request builder and inert subscription transport. No synthetic event
  // is delivered unless a control explicitly fires the saved real-hook callback.
  const db={from:(table:string)=>sb.from(table),channel:()=>({on(_event:any,filter:any,callback:any){p.callbacks.push({filter,callback});return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:family,userId:user,role:'parent',members:[],selfMember:null})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},'@/components/i18n/use-format':{useFamilyClock:()=>({todayKey:()=> '2026-10-02'}),useFamilyCalendarToday:()=>new Date('2026-10-02T12:00:00Z'),useFormat:()=>({fmtDate:()=> 'Oct 2'})},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>async()=>{p.confirmations++;return true;}},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/lib/wallet/ledger':{formatCents:fail},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));root.render(R.createElement(load(entry).DecisionsModule));
 },{sources:modules,entry,messages,origin,family,user});
 if(mode==='read-error')await expect(page.getByText('Could not load decision data. Refresh and try again.',{exact:true})).toBeVisible();
 else await expect(page.getByRole('button',{name:'Synthetic quiet activity',exact:true})).toBeVisible();
 return{rows,requests,setMode:(value:string)=>{mode=value;},writes:()=>requests.filter(r=>r.method!=='GET'),reads:()=>requests.filter(r=>r.method==='GET'&&r.table==='family_decisions')};
}

async function settled(page:Page){await expect.poll(()=>page.evaluate(()=>(window as any).__decision.settled)).toBe(1);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
const puzzle=(page:Page)=>page.locator('div.rounded-xl.border.p-4').filter({has:page.getByText('Synthetic puzzle',{exact:true})});
test('a confirmed ordinary choice reads back its selected winner without Realtime',async({page})=>{
 const proof=await fixture(page);await puzzle(page).getByRole('button',{name:'Choose',exact:true}).click();await settled(page);expect(proof.rows[0].status).toBe('decided');expect(proof.writes()).toHaveLength(1);expect(proof.writes()[0].body.decided_option_id).toBe('dddddddd-dddd-4ddd-8ddd-000000000001');expect(await page.evaluate(()=>(window as any).__decision.notices)).toEqual([{kind:'success',message:'Decision recorded'}]);await expect(puzzle(page).getByRole('button',{name:'Choose',exact:true})).toHaveCount(0);expect(proof.reads().length).toBeGreaterThan(1);
});
test('the actual hook online event displays the confirmed selected winner',async({page})=>{
 const proof=await fixture(page);await puzzle(page).getByRole('button',{name:'Choose',exact:true}).click();await settled(page);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(puzzle(page).getByRole('button',{name:'Choose',exact:true})).toHaveCount(0);expect(proof.writes()).toHaveLength(1);expect(proof.reads().length).toBeGreaterThan(1);
});
for(const mode of ['refusal','zero'])test(mode+' choice retains undecided view and reports no success',async({page})=>{
 const proof=await fixture(page,mode);await puzzle(page).getByRole('button',{name:'Choose',exact:true}).click();await settled(page);expect(proof.rows[0].status).toBe('open');expect(proof.rows[0].decided_option_id).toBeNull();await expect(puzzle(page).getByRole('button',{name:'Choose',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__decision.notices.map((n:any)=>n.kind))).toEqual(['error']);expect(proof.writes()).toHaveLength(1);
});
test('healthy neutral options display without a write or financial formatting',async({page})=>{
 const proof=await fixture(page);await expect(puzzle(page).getByRole('button',{name:'Choose',exact:true})).toBeVisible();await expect(page.getByText('Synthetic reading',{exact:true})).toBeVisible();expect(proof.writes()).toEqual([]);
});

test('refused read offers Try again and restores neutral choices without a write',async({page})=>{
 const proof=await fixture(page,'read-error');proof.setMode('healthy');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(puzzle(page).getByRole('button',{name:'Choose',exact:true})).toBeVisible();expect(proof.reads().length).toBeGreaterThan(1);expect(proof.writes()).toEqual([]);
});

test('a confirmed choice with refused readback retries only the read before showing its winner',async({page})=>{
 const proof=await fixture(page,'readback-error');await puzzle(page).getByRole('button',{name:'Choose',exact:true}).click();await settled(page);expect(proof.rows[0].status).toBe('decided');expect(proof.writes()).toHaveLength(1);await expect(page.getByText('Could not load decision data. Refresh and try again.',{exact:true})).toBeVisible();proof.setMode('healthy');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(puzzle(page).getByRole('button',{name:'Choose',exact:true})).toHaveCount(0);await expect(page.getByText('Synthetic puzzle',{exact:true}).last()).toBeVisible();expect(proof.writes()).toHaveLength(1);expect(proof.reads().length).toBeGreaterThan(2);
});
