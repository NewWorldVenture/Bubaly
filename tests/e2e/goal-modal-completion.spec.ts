import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
const sourceRoot=process.env.BUBALY_GOAL_UI_SOURCE_ROOT || process.cwd();
const origin='https://goal-modal-lifetime.invalid';
const {react,reactDom}=reactBrowserScripts();
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/i18n/use-format','@/components/ui/toast','@/components/ui/confirm','@/lib/supabase/client','@/lib/offline/cache-scope','@/components/ai/ai-insight','@/app/(app)/dashboard/goals/actions']);
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
const entry=collect(path.join(sourceRoot,'components/modules/goals-module.tsx'));
const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(browserErrors.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__goal?.errors??[])).toEqual([]);});

async function fixture(page:Page,initialMode='healthy',seed=false,strict=false){
 let mode=initialMode;
 const family='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',user='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const rows:any[]=seed?[{id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',family_id:family,created_by:user,title:'Synthetic weekly walks',description:'A family walk each week',target_date:null,progress:25,is_complete:false,created_at:'2026-10-02T00:00:00Z'}]:[];
 const calls:any[]=[],reads:any[]=[],pending:(()=>void)[]=[];
 await page.route('**/*',async route=>{if(route.request().url()!==origin+'/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});});
 await page.exposeFunction('__goalRead',async(url:string,method:string)=>{
  const parsed=new URL(url);if(parsed.origin!==origin||method!=='GET'||!parsed.pathname.endsWith('/goals'))throw Error('Unexpected SDK read');
  expect(parsed.searchParams.get('family_id')).toBe('eq.'+family);expect(parsed.searchParams.get('select')).toBe('*');reads.push({url,method});
  if(mode==='read-error')return{status:400,body:{code:'SYNTHETIC_READ',message:'Synthetic goal read refused'}};
  return{status:200,body:structuredClone(rows)};
 });
 await page.exposeFunction('__goalSave',async(id:string|null,payload:any)=>{
  calls.push({id,payload});expect(payload.targetDate).toBeNull();const outcome=mode;
  if(outcome.startsWith('held'))await new Promise<void>(resolve=>pending.push(resolve));
  if(outcome==='refusal'||outcome==='held-refusal')return{ok:false,error:'Synthetic goal save refused'};
  if(outcome==='throw'||outcome==='held-throw')throw Error('Synthetic save transport rejected');
  if(id){const row=rows.find(row=>row.id===id);if(!row)throw Error('Unknown synthetic goal');row.title=payload.title;row.description=payload.description;}
  else rows.push({id:'aaaaaaaa-aaaa-4aaa-8aaa-'+String(rows.length+1).padStart(12,'0'),family_id:family,created_by:user,title:payload.title,description:payload.description,target_date:null,progress:0,is_complete:false,created_at:'2026-10-02T00:00:00Z'});
  return{ok:true};
 });
 await page.goto(origin);for(const content of [react,reactDom,sdk,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,origin,family,user,strict})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p:any=w.__goal={errors:[] as string[],notices:[] as any[],settled:0,identityUser:user};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const fail=()=>{throw Error('Progress/delete/AI/provider/date/money flow outside ordinary title fixture');};
  const sb=w.supabase.createClient(origin,'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url:any,init:any)=>{const response=await w.__goalRead(String(url),init.method||'GET');return new Response(JSON.stringify(response.body),{status:response.status,headers:{'content-type':'application/json'}});}}});
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:family,userId:p.identityUser,role:'parent',members:[]})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},'@/components/i18n/use-format':{useFormat:()=>({fmtDate:fail})},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>fail},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/lib/supabase/client':{createClient:()=>({from:(table:string)=>sb.from(table),channel:fail,removeChannel:fail})},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},'@/app/(app)/dashboard/goals/actions':{saveGoalAction:async(id:string|null,payload:any)=>{try{return await w.__goalSave(id,payload);}finally{p.settled++;}},deleteGoalAction:fail,setGoalProgressAction:fail}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));p.rerender=()=>root.render(strict?R.createElement(R.StrictMode,null,R.createElement(load(entry).GoalsModule)):R.createElement(load(entry).GoalsModule));p.rerender();
 },{sources:modules,entry,messages,origin,family,user,strict});
 await expect(page.getByRole('heading',{name:'Family Goals',exact:true})).toBeVisible();
 return{rows,calls,reads,release:()=>pending.shift()?.(),setMode:(value:string)=>{mode=value;}};
}
async function open(page:Page,title:string){await page.getByRole('button',{name:'New goal',exact:true}).first().click();await page.getByRole('textbox',{name:'Goal',exact:true}).fill(title);}
async function settled(page:Page){await expect.poll(()=>page.evaluate(()=>(window as any).__goal.settled)).toBe(1);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
test('closed earlier create completion preserves the newly opened goal draft',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Earlier synthetic walking goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Later synthetic reading goal');await page.getByRole('textbox',{name:'Description',exact:true}).fill('Keep this later draft');proof.release();await settled(page);
 expect(proof.rows).toHaveLength(1);expect(proof.rows[0].title).toBe('Earlier synthetic walking goal');expect(proof.calls).toHaveLength(1);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Later synthetic reading goal');await expect(page.getByRole('textbox',{name:'Description',exact:true})).toHaveValue('Keep this later draft');
});
test('closed earlier edit completion preserves a different new goal draft',async({page})=>{
 const proof=await fixture(page,'held',true);await page.getByRole('button',{name:'Synthetic weekly walks A family walk each week',exact:true}).click();await page.getByRole('textbox',{name:'Goal',exact:true}).fill('Saved earlier walk title');await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Later reading goal');proof.release();await settled(page);
 expect(proof.calls[0].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-000000000001');expect(proof.rows[0].title).toBe('Saved earlier walk title');
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Later reading goal');
});
test('healthy create persists the title and description and refreshes its card',async({page})=>{
 const proof=await fixture(page);await open(page,'Synthetic reading goal');await page.getByRole('textbox',{name:'Description',exact:true}).fill('Read together weekly');await page.getByRole('button',{name:'Create goal',exact:true}).click();await settled(page);
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Synthetic reading goal',{exact:true})).toBeVisible();expect(proof.rows[0]).toMatchObject({title:'Synthetic reading goal',description:'Read together weekly',target_date:null});expect(proof.calls).toHaveLength(1);expect(proof.reads.length).toBeGreaterThan(1);
});
for(const mode of ['refusal','throw'])test(mode+' ordinary save keeps the entered draft and enables Save',async({page})=>{
 const proof=await fixture(page,mode);await open(page,'Refused reading draft');await page.getByRole('button',{name:'Create goal',exact:true}).click();await settled(page);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Refused reading draft');await expect(page.getByRole('button',{name:'Create goal',exact:true})).toBeEnabled();expect(proof.rows).toEqual([]);expect(proof.calls).toHaveLength(1);expect(await page.evaluate(()=>(window as any).__goal.notices.map((x:any)=>x.kind))).toEqual(['error']);
});
test('unsent cancel closes the goal draft without saving',async({page})=>{
 const proof=await fixture(page);await open(page,'Unsent reading draft');await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.calls).toEqual([]);expect(proof.rows).toEqual([]);
});

for(const mode of ['held-refusal','held-throw'])test(mode+' from a closed goal cannot report feedback against the new draft',async({page})=>{
 const proof=await fixture(page,mode);await open(page,'Earlier refused goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Later preserved goal');proof.release();await settled(page);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Later preserved goal');await expect(page.getByRole('button',{name:'Create goal',exact:true})).toBeEnabled();expect(proof.rows).toEqual([]);expect(proof.calls).toHaveLength(1);expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([]);
});

test('closed goal successful save refreshes its card without reopening or reporting stale feedback',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Committed closed goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await page.getByRole('button',{name:'Cancel',exact:true}).click();proof.release();await settled(page);
 await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Committed closed goal',{exact:true})).toBeVisible();expect(proof.rows[0].title).toBe('Committed closed goal');expect(proof.calls).toHaveLength(1);expect(proof.reads.length).toBeGreaterThan(1);expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([]);
});

test('reopening the same goal protects a newer edited draft from its older save',async({page})=>{
 const proof=await fixture(page,'held',true);await page.getByRole('button',{name:'Synthetic weekly walks A family walk each week',exact:true}).click();await page.getByRole('textbox',{name:'Goal',exact:true}).fill('Earlier confirmed edit');await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Synthetic weekly walks A family walk each week',exact:true}).click();await page.getByRole('textbox',{name:'Goal',exact:true}).fill('Newer same-goal draft');proof.release();await settled(page);
 expect(proof.rows[0].title).toBe('Earlier confirmed edit');await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Newer same-goal draft');expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([]);
});

test('editing a different goal preserves its draft and later Save after the older commit',async({page})=>{
 const proof=await fixture(page,'held',true);proof.rows.push({...proof.rows[0],id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',title:'Synthetic reading goal',description:'Read as a family'});await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByText('Synthetic reading goal',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Synthetic weekly walks A family walk each week',exact:true}).click();await page.getByRole('textbox',{name:'Goal',exact:true}).fill('Confirmed earlier walking edit');await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Synthetic reading goal Read as a family',exact:true}).click();await page.getByRole('textbox',{name:'Goal',exact:true}).fill('Newer reading edit');proof.release();await settled(page);
 expect(proof.rows[0].title).toBe('Confirmed earlier walking edit');expect(proof.rows[1].title).toBe('Synthetic reading goal');await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Newer reading edit');expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([]);
 proof.setMode('healthy');await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__goal.settled)).toBe(2);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Newer reading edit',{exact:true})).toBeVisible();expect(proof.rows[1].title).toBe('Newer reading edit');expect(proof.calls).toHaveLength(2);expect(proof.calls[1].id).toBe('aaaaaaaa-aaaa-4aaa-8aaa-000000000002');
});

test('newer create remains usable and saves once after a closed earlier create commits',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Earlier committed goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Later committed goal');proof.release();await settled(page);
 await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Later committed goal');proof.setMode('healthy');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__goal.settled)).toBe(2);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Later committed goal',{exact:true})).toBeVisible();expect(proof.rows.map(row=>row.title)).toEqual(['Earlier committed goal','Later committed goal']);expect(proof.calls).toHaveLength(2);expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([{kind:'success',message:'Goal created'}]);
});

test('a still-pending newer dialog stays disabled when the closed earlier save settles',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Earlier held goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Later held goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(2);proof.release();await settled(page);
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Later held goal');await expect(page.getByRole('dialog').getByRole('button',{name:'Create goal',exact:true})).toBeDisabled();expect(proof.rows).toHaveLength(1);expect(proof.calls).toHaveLength(2);proof.release();await expect.poll(()=>page.evaluate(()=>(window as any).__goal.settled)).toBe(2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows).toHaveLength(2);
});

test('current goal refusal permits only an explicit successful retry',async({page})=>{
 const proof=await fixture(page,'refusal');await open(page,'Explicit retry goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await settled(page);expect(proof.rows).toEqual([]);await expect(page.getByRole('button',{name:'Create goal',exact:true})).toBeEnabled();expect(proof.calls).toHaveLength(1);
 proof.setMode('healthy');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__goal.settled)).toBe(2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.calls).toHaveLength(2);expect(proof.rows[0].title).toBe('Explicit retry goal');expect(await page.evaluate(()=>(window as any).__goal.notices.map((x:any)=>x.kind))).toEqual(['error','success']);
});

test('blank title remains local validation and performs no goal save',async({page})=>{
 const proof=await fixture(page);await open(page,'   ');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('button',{name:'Create goal',exact:true})).toBeEnabled();expect(proof.calls).toEqual([]);expect(await page.evaluate(()=>(window as any).__goal.notices.map((x:any)=>x.kind))).toEqual(['error']);
});

test('confirmed current goal save with refused readback offers Retry without another save',async({page})=>{
 const proof=await fixture(page);await open(page,'Saved before read error');proof.setMode('read-error');await page.getByRole('button',{name:'Create goal',exact:true}).click();await settled(page);await expect(page.getByText('Could not load data. Please try again.',{exact:true})).toBeVisible();expect(proof.rows[0].title).toBe('Saved before read error');expect(proof.calls).toHaveLength(1);
 proof.setMode('healthy');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByText('Saved before read error',{exact:true})).toBeVisible();expect(proof.calls).toHaveLength(1);expect(proof.reads.length).toBeGreaterThan(2);
});

for(const held of [false,true])test('StrictMode '+(held?'closed completion preserves the new draft':'current save still commits and refreshes'),async({page})=>{
 const proof=await fixture(page,held?'held':'healthy',false,true);await open(page,'Strict earlier goal');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
 if(held){await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Strict later draft');proof.release();}
 await settled(page);expect(proof.rows[0].title).toBe('Strict earlier goal');expect(proof.calls).toHaveLength(1);
 if(held){await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('Strict later draft');expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([]);}
 else{await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Strict earlier goal',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([{kind:'success',message:'Goal created'}]);}
});

test('inert UI identity context changes cannot inherit an earlier dialog completion',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Earlier context save');await page.getByRole('button',{name:'Create goal',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
 await page.evaluate(()=>{const p=(window as any).__goal;p.identityUser='dddddddd-dddd-4ddd-8ddd-dddddddddddd';p.rerender();});await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('');await expect(page.getByRole('button',{name:'Create goal',exact:true})).toBeEnabled();await page.getByRole('textbox',{name:'Goal',exact:true}).fill('New context draft');proof.release();await settled(page);
 expect(proof.rows[0].title).toBe('Earlier context save');await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Goal',exact:true})).toHaveValue('New context draft');expect(await page.evaluate(()=>(window as any).__goal.notices)).toEqual([]);
});
