import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
const sourceRoot=process.env.BUBALY_DECLUTTER_UI_SOURCE_ROOT || process.cwd();
const origin='https://declutter-archived.invalid';
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
const entry=collect(path.join(sourceRoot,'components/modules/declutter-module.tsx'));
const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(browserErrors.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__declutter?.errors??[])).toEqual([]);});
async function fixture(page:Page,initialMode='active'){
 let mode=initialMode;
 const family='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',user='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const zone=(id:string,name:string,active:boolean)=>({id,family_id:family,created_by:user,name,room:null,kind:'surface',clutter_score:1,last_reset_at:null,is_active:active,target_state:null,created_at:'2026-10-02T00:00:00Z',updated_at:'2026-10-02T00:00:00Z'});
 const active=zone('aaaaaaaa-aaaa-4aaa-8aaa-000000000001','Synthetic active shelf',true);
 const archived=zone('aaaaaaaa-aaaa-4aaa-8aaa-000000000002','Synthetic archived shelf',false);
 const rows:any[]=initialMode==='archived'?[archived]:initialMode==='mixed'?[active,archived]:initialMode==='empty'?[]:[active];
 const requests:any[]=[];
 await page.route('**/*',async route=>{if(route.request().url()!==origin+'/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});});
 await page.exposeFunction('__declutterFetch',async(url:string,method:string,body:any)=>{
  const parsed=new URL(url);if(parsed.origin!==origin)throw Error('Unexpected SDK destination');
  const table=parsed.pathname.split('/').pop();requests.push({url,method,body,table});
  if(method==='GET'&&['declutter_zones','declutter_missions','declutter_sessions'].includes(table!)){
   if(mode==='read-error'&&table==='declutter_zones')return{status:400,body:{code:'SYNTHETIC',message:'Synthetic zones unavailable'}};
   if(table!=='declutter_zones')return{status:200,body:[]};
   expect(parsed.searchParams.get('family_id')).toBe('eq.'+family);
   return{status:200,body:structuredClone(rows)};
  }
  throw Error('Unexpected SDK operation '+method+' '+table);
 });
 await page.goto(origin);for(const content of [react,reactDom,sdk,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,origin,family,user})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__declutter={errors:[] as string[],notices:[] as any[],callbacks:[] as any[],settled:0,confirmations:0};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const fail=()=>{throw Error('Provider/AI/calendar/vote/session flow outside ordinary title fixture');};
  const sb=w.supabase.createClient(origin,'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url:any,init:any)=>{
   const method=init.method||'GET';try{const response=await w.__declutterFetch(String(url),method,init.body?JSON.parse(init.body):null);return new Response(JSON.stringify(response.body),{status:response.status,headers:{'content-type':'application/json'}});}finally{if(method!=='GET')p.settled++;}
  }}});
  // Actual SDK request builder and inert subscription transport. No synthetic event
  // is delivered unless a control explicitly fires the saved real-hook callback.
  const db={from:(table:string)=>sb.from(table),channel:()=>({on(_event:any,filter:any,callback:any){p.callbacks.push({filter,callback});return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:family,userId:user,role:'parent',members:[],selfMember:null})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),usePlural:()=>(key:string,n:number,vars:any={})=>tr(key+'.'+(n===1?'one':'other'),{n,...vars}),useFamilyTimeZone:()=> 'UTC'},'@/components/i18n/use-format':{useFamilyClock:()=>({todayKey:()=> '2026-10-02'}),useFamilyCalendarToday:()=>new Date('2026-10-02T12:00:00Z'),useFormat:()=>({fmtDate:()=> 'Oct 2'})},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>async()=>{p.confirmations++;return true;}},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));root.render(R.createElement(load(entry).DeclutterModule));
 },{sources:modules,entry,messages,origin,family,user});
 if(mode==='read-error')await expect(page.getByText('Could not load your declutter zones. Refresh and try again.',{exact:true})).toBeVisible();
 else await expect(page.getByRole('heading',{name:'Zones',exact:true})).toBeVisible();
 return{rows,requests,setMode:(value:string)=>{mode=value;},writes:()=>requests.filter(r=>r.method!=='GET'),reads:()=>requests.filter(r=>r.method==='GET'&&r.table==='declutter_zones')};
}

test('Show archived reveals an existing archived zone when no active zone remains',async({page})=>{
 const proof=await fixture(page,'archived');await expect(page.getByRole('heading',{name:'No zones yet',exact:true})).toBeVisible();await expect(page.getByText('Synthetic archived shelf',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Show archived',exact:true}).click();await expect(page.getByRole('button',{name:'Hide archived',exact:true})).toBeVisible();
 await expect(page.getByText('Synthetic archived shelf',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'No zones yet',exact:true})).toHaveCount(0);expect(proof.writes()).toEqual([]);
});
test('an active zone is displayed without empty-zone guidance',async({page})=>{
 const proof=await fixture(page);await expect(page.getByText('Synthetic active shelf',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'No zones yet',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Show archived',exact:true})).toHaveCount(0);expect(proof.writes()).toEqual([]);
});
test('a genuinely empty zone list offers Add a zone and no archived filter',async({page})=>{
 const proof=await fixture(page,'empty');await expect(page.getByRole('heading',{name:'No zones yet',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Add a zone',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Show archived',exact:true})).toHaveCount(0);expect(proof.writes()).toEqual([]);
});
test('mixed active and archived zones toggle visibility without a write',async({page})=>{
 const proof=await fixture(page,'mixed');await expect(page.getByText('Synthetic active shelf',{exact:true})).toBeVisible();await expect(page.getByText('Synthetic archived shelf',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Show archived',exact:true}).click();await expect(page.getByText('Synthetic archived shelf',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeVisible();await expect(page.getByText('Synthetic active shelf',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Hide archived',exact:true}).click();await expect(page.getByText('Synthetic archived shelf',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Restore',exact:true})).toHaveCount(0);await expect(page.getByText('Synthetic active shelf',{exact:true})).toBeVisible();expect(proof.writes()).toEqual([]);
});
test('zone read refusal is visible and Retry restores the actual read result',async({page})=>{
 const proof=await fixture(page,'read-error');expect(proof.reads()).toHaveLength(1);proof.setMode('active');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByText('Synthetic active shelf',{exact:true})).toBeVisible();await expect(page.getByText('Could not load your declutter zones. Refresh and try again.',{exact:true})).toHaveCount(0);expect(proof.reads().length).toBeGreaterThan(1);expect(proof.writes()).toEqual([]);
});

test('an all-archived collection returns to empty-state guidance after Hide archived',async({page})=>{
 const proof=await fixture(page,'archived');await page.getByRole('button',{name:'Show archived',exact:true}).click();await expect(page.getByText('Synthetic archived shelf',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Hide archived',exact:true}).click();await expect(page.getByText('Synthetic archived shelf',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Restore',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'No zones yet',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Add a zone',exact:true})).toBeVisible();expect(proof.writes()).toEqual([]);
});
test('keyboard activation reveals the all-archived zone without re-reading or writing',async({page})=>{
 const proof=await fixture(page,'archived');const reads=proof.reads().length;const toggle=page.getByRole('button',{name:'Show archived',exact:true});await toggle.focus();await page.keyboard.press('Enter');await expect(page.getByText('Synthetic archived shelf',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Restore',exact:true})).toBeVisible();expect(proof.reads()).toHaveLength(reads);expect(proof.writes()).toEqual([]);
});
