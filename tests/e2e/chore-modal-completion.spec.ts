import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
// Read-only actual ordinary chore UI. Synthetic reads/action bridge; no SDK,
// server actions, rewards/money, Auth, date logic or providers execute.
const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(browserErrors.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__chore?.errors??[])).toEqual([]);});
const {react,reactDom}=reactBrowserScripts();
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const actions='@/app/(app)/dashboard/chores/actions';
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/i18n/use-format','@/components/ui/toast','@/lib/supabase/client','@/lib/offline/cache-scope',actions,'@/app/(app)/wallet/actions','@/app/(app)/dashboard/rewards/actions']);
const modules:Record<string,{source:string;imports:Record<string,string>}>= {};
function collect(filename:string):string {
 const id=path.resolve([filename,filename+'.ts',filename+'.tsx',path.join(filename,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile())??filename);
 if(modules[id])return id;
 const raw=fs.readFileSync(id,'utf8');
 const source=/\.tsx?$/.test(id)?ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText:raw;
 const item=modules[id]={source,imports:{} as Record<string,string>};
 for(const match of source.matchAll(/require\(["']([^"']+)["']\)/g)){const name=match[1];if(isolated.has(name)){item.imports[name]=name;continue;}item.imports[name]=collect(name.startsWith('@/')?path.resolve(name.slice(2)):name.startsWith('.')?path.resolve(path.dirname(id),name):require.resolve(name,{paths:[path.dirname(id)]}));}
 return id;
}
const entry=collect('components/modules/chores-module.tsx');
let css='';
test.beforeAll(async()=>{const config={exports:{} as any};const code=ts.transpileModule(fs.readFileSync('tailwind.config.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;new Function('module','exports','require',code)(config,config.exports,require);css=(await postcss([tailwindcss(config.exports.default),autoprefixer()]).process(fs.readFileSync('app/globals.css','utf8'),{from:'app/globals.css'})).css;});
async function fixture(page:Page,strict=false){
 await page.route('**/*',async route=>{if(route.request().url()!=='https://chore-fixture.invalid/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="root"></main></body></html>'});});
 await page.goto('https://chore-fixture.invalid/');await page.addStyleTag({content:css});for(const content of [react,reactDom,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json','utf8'));
 await page.evaluate(({sources,entry,messages,actions,strict})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__chore={errors:[] as string[],notices:[] as any[],calls:[] as any[],pending:[] as any[],reads:[] as any[],settle:(_outcome:string):void=>{throw Error('No settler');},unmount:():void=>{throw Error('No root');}};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const tables:Record<string,any[]>={chore_assignments:[],chores:[],rewards:[]};
  const member={id:'member-A',user_id:'user-A',family_id:'family-A',display_name:'Alex',role:'parent',color:null};
  const from=(table:string)=>{const filters:any[]=[];return {select(){return this;},eq(k:string,v:any){filters.push([k,v]);return this;},in(){return this;},order(){return this;},then(resolve:any,reject:any){p.reads.push({table});return Promise.resolve({data:structuredClone(tables[table]??[]).filter((r:any)=>filters.every(([k,v])=>r[k]===v)),error:null}).then(resolve,reject);}};};
  const db={from,channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const fail=()=>{throw Error('Unrelated action must remain inert');};
  const bridge={createChoreAction:(input:any)=>{p.calls.push(structuredClone(input));return new Promise((resolve,reject)=>p.pending.push({resolve,reject}));},setChoreStatusAction:fail,deleteChoreAssignmentAction:fail};
  p.settle=(outcome:string)=>{const pending=p.pending.shift();if(!pending)throw Error('No pending chore save');if(outcome==='transport')pending.reject(Error('Synthetic chore response unavailable'));else pending.resolve(outcome==='refuse'?{ok:false,error:'Synthetic chore refused'}:outcome==='already_saved'?{ok:false,code:'already_saved',error:'Synthetic earlier chore already saved'}:{ok:true});};
  const clock={todayKey:()=> '2026-10-02',dayStart:()=>new Date('2026-10-02T00:00:00Z'),dayKeyOf:()=> '2026-10-02',timeZone:'UTC'};
  const format={fmtDate:()=> 'Synthetic date',fmtTime:()=> 'Synthetic time'};
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:'family-A',userId:'user-A',role:'parent',members:[member],selfMember:member})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},'@/components/i18n/use-format':{useFormat:()=>format,useFamilyClock:()=>clock},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},[actions]:bridge,'@/app/(app)/wallet/actions':{payChoreRewardAction:fail},'@/app/(app)/dashboard/rewards/actions':{requestRedemptionAction:fail}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));p.unmount=()=>root.unmount();const element=R.createElement(load(entry).ChoresModule);root.render(strict?R.createElement(R.StrictMode,null,element):element);
 },{sources:modules,entry,messages,actions,strict});
 await expect(page.getByRole('heading',{name:'Chores',exact:true})).toBeVisible();
}
async function openDraft(page:Page,title='Sweep porch'){
 await page.getByRole('button',{name:'Add Chore',exact:true}).first().click();await page.getByRole('textbox',{name:'Title',exact:true}).fill(title);await page.getByRole('combobox',{name:'Assign to',exact:true}).selectOption('member-A');
}
async function start(page:Page){await page.getByRole('dialog').getByRole('button',{name:'Add Chore',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__chore.pending.length)).toBe(1);}
async function settle(page:Page,outcome='success'){await page.evaluate(async outcome=>{(window as any).__chore.settle(outcome);await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));},outcome);}
test('earlier successful add keeps a reopened chore draft',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Water plants');await settle(page);await expect(page.getByRole('dialog')).toHaveCount(1);await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Water plants');expect(await page.evaluate(()=>(window as any).__chore.calls)).toHaveLength(1);});
test('earlier refusal does not display feedback in a reopened draft',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Water plants');await settle(page,'refuse');await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Water plants');expect(await page.evaluate(()=>(window as any).__chore.notices)).toEqual([]);});
test('current successful add closes its own dialog and refreshes',async({page})=>{await fixture(page);await openDraft(page);await start(page);const reads=await page.evaluate(()=>(window as any).__chore.reads.length);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).__chore.reads.length)).toBeGreaterThan(reads);});
test('current refused add retains fields and restores Add',async({page})=>{await fixture(page);await openDraft(page);await start(page);await settle(page,'refuse');await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Sweep porch');await expect(page.getByRole('dialog').getByRole('button',{name:'Add Chore',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).__chore.notices.map((n:any)=>n.kind))).toEqual(['error']);});
test('canceling an idle editor does not dispatch a save',async({page})=>{await fixture(page);await openDraft(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__chore.calls)).toEqual([]);});

test('current new editor retains its loading state when an earlier success arrives',async({page})=>{
 await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Water plants');
 await page.getByRole('dialog').getByRole('button',{name:'Add Chore',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__chore.pending.length)).toBe(2);
 const calls=await page.evaluate(()=>(window as any).__chore.calls);expect(calls.map((c:any)=>c.title)).toEqual(['Sweep porch','Water plants']);expect(calls[0].submissionId).not.toBe(calls[1].submissionId);
 await settle(page);await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Water plants');await expect(page.getByRole('dialog').getByRole('button',{name:'Saving…',exact:true})).toBeDisabled();
 await page.getByRole('dialog').locator('form').evaluate((form:HTMLFormElement)=>form.requestSubmit());expect(await page.evaluate(()=>(window as any).__chore.calls)).toHaveLength(2);
 await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__chore.notices)).toEqual([]);
});
test('earlier transport refusal leaves the newer draft without stale feedback',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Water plants');await settle(page,'transport');await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Water plants');await expect(page.getByRole('dialog').getByRole('button',{name:'Add Chore',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).__chore.notices)).toEqual([]);});
for(const outcome of ['refuse','transport']){
 test('closed editor '+outcome+' does not emit stale feedback',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await settle(page,outcome);await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__chore.notices)).toEqual([]);expect(await page.evaluate(()=>(window as any).__chore.calls)).toHaveLength(1);});
 test('unmounted editor '+outcome+' does not emit stale feedback',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.evaluate(()=>(window as any).__chore.unmount());await settle(page,outcome);expect(await page.evaluate(()=>(window as any).__chore.notices)).toEqual([]);expect(await page.evaluate(()=>(window as any).__chore.calls)).toHaveLength(1);});
}
test('confirmed earlier save still refreshes after cancel without reopening',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();const reads=await page.evaluate(()=>(window as any).__chore.reads.length);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).__chore.reads.length)).toBeGreaterThan(reads);expect(await page.evaluate(()=>(window as any).__chore.calls)).toHaveLength(1);});
test('current transport refusal restores Add and explicit retry keeps its submission identity',async({page})=>{await fixture(page);await openDraft(page);await start(page);await settle(page,'transport');await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Sweep porch');await expect(page.getByRole('dialog').getByRole('button',{name:'Add Chore',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).__chore.notices.map((n:any)=>n.kind))).toEqual(['error']);await start(page);const calls=await page.evaluate(()=>(window as any).__chore.calls);expect(calls).toHaveLength(2);expect(calls[0].submissionId).toBe(calls[1].submissionId);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);});
test('current already-saved refusal renews submission identity for explicit new add',async({page})=>{await fixture(page);await openDraft(page);await start(page);await settle(page,'already_saved');await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Sweep porch');await start(page);const calls=await page.evaluate(()=>(window as any).__chore.calls);expect(calls[0].submissionId).not.toBe(calls[1].submissionId);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);});
test('StrictMode replay permits current save and confirmed refresh',async({page})=>{await fixture(page,true);await openDraft(page);await start(page);const reads=await page.evaluate(()=>(window as any).__chore.reads.length);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).__chore.reads.length)).toBeGreaterThan(reads);});
test('StrictMode replay keeps newer draft after earlier successful save',async({page})=>{await fixture(page,true);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Water plants');await settle(page);await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Water plants');await expect(page.getByRole('dialog').getByRole('button',{name:'Add Chore',exact:true})).toBeEnabled();});
