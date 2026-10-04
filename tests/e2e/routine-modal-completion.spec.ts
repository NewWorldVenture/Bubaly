import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
// Actual React19 routine editor and real query hook, synthetic builder only.
// Only manual routine creation executes; calendar actions remain hard refusals.
const sourceRoot=process.env.BUBALY_ROUTINE_UI_SOURCE_ROOT || process.cwd();
const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(browserErrors.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__routine?.errors??[])).toEqual([]);});
const {react,reactDom}=reactBrowserScripts();
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const actions='@/app/(app)/dashboard/calendar/actions';
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/ui/toast','@/components/ui/confirm','@/lib/supabase/client','@/lib/offline/cache-scope',actions]);
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
const entry=collect(path.join(sourceRoot,'components/modules/routines-panel.tsx'));
let css='';
test.beforeAll(async()=>{const config={exports:{} as any};const code=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,'tailwind.config.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;new Function('module','exports','require',code)(config,config.exports,require);config.exports.default.content=[path.join(sourceRoot,'components/**/*.{ts,tsx}'),path.join(sourceRoot,'app/**/*.{ts,tsx}')];css=(await postcss([tailwindcss(config.exports.default),autoprefixer()]).process(fs.readFileSync(path.join(sourceRoot,'app/globals.css'),'utf8'),{from:path.join(sourceRoot,'app/globals.css')})).css;});

type FixtureOptions={seed?:string[];holdAt?:'items'|'rename'|'delete';strict?:boolean;failRename?:boolean;failDelete?:boolean};
async function fixture(page:Page,options:FixtureOptions={}){
 await page.route('**/*',async route=>{if(route.request().url()!=='https://routine-fixture.invalid/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="root"></main></body></html>'});});
 await page.goto('https://routine-fixture.invalid/');await page.addStyleTag({content:css});for(const content of [react,reactDom,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,actions,options})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__routine={errors:[] as string[],notices:[] as any[],writes:[] as any[],pending:[] as any[],reads:[] as any[],familyId:'family-A',userId:'user-A',holdAt:options.holdAt||'items',strict:options.strict||false,failRename:options.failRename||false,failDelete:options.failDelete||false,settle:(_outcome:string):void=>{throw Error('No settler');},root:null as any,render:():void=>{throw Error('No renderer');},switchContext:(_family:string,_user:string):void=>{throw Error('No context switch');},tables:{} as Record<string,any[]>};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const tables:Record<string,any[]>=p.tables={routine_templates:(options.seed||[]).map((name,index)=>({id:'seed-'+index,name,icon:'🔁',weekday_mask:31,family_id:'family-A',created_by:'user-A',source:'manual',created_at:'2026-10-02T00:00:00Z'})),routine_template_items:(options.seed||[]).map((_,index)=>({id:'seed-item-'+index,template_id:'seed-'+index,family_id:'family-A',title:'Breakfast',category:'general',start_minutes:420,duration_minutes:30,assignee_id:null,sort_order:0}))};
  const from=(table:string)=>{if(!(table in tables))throw Error('Unexpected table '+table);const filters:any[]=[];const orders:string[]=[];let operation='read',payload:any,projection:string|undefined;const b={select(value?:string){projection=value;return b;},eq(k:string,v:any){filters.push([k,v]);return b;},in(){throw Error('Unexpected membership query');},order(k:string){orders.push(k);return b;},insert(value:any){operation='insert';payload=structuredClone(value);return b;},update(value:any){operation='update';payload=structuredClone(value);return b;},delete(){operation='delete';return b;},single(){return b;},then(resolve:any,reject:any){
   const matches=(row:any)=>filters.every(([key,value])=>row[key]===value);
   if(operation==='read'){p.reads.push({table,filters:structuredClone(filters)});const data=structuredClone(tables[table]).filter(matches);data.sort((a:any,c:any)=>{for(const key of orders){if(a[key]<c[key])return -1;if(a[key]>c[key])return 1;}return 0;});return Promise.resolve({data,error:null}).then(resolve,reject);}
   p.writes.push({table,operation,payload,filters:structuredClone(filters),projection});
   const phase=table==='routine_templates'&&operation==='update'?'rename':table==='routine_template_items'&&operation==='delete'?'delete':table==='routine_template_items'&&operation==='insert'?'items':'create';
   const execute=()=>{
    if(phase==='rename'&&p.failRename)return{data:[],error:null};
    if(phase==='delete'&&p.failDelete)return{data:null,error:{message:'Synthetic delete refused'}};
    if(phase==='create'){const row={...payload,id:'template-'+p.writes.length,created_at:'2026-10-02T00:00:00Z'};tables[table].push(row);return{data:{id:row.id},error:null};}
    if(phase==='rename'){const rows=tables[table].filter(matches);rows.forEach(row=>Object.assign(row,payload));return{data:rows.map(row=>({id:row.id})),error:null};}
    if(phase==='delete'){tables[table]=tables[table].filter(row=>!matches(row));return{data:null,error:null};}
    if(phase==='items'){tables[table].push(...payload.map((item:any,index:number)=>({...item,id:'item-'+p.writes.length+'-'+index})));return{data:null,error:null};}
    throw Error('Unexpected operation '+table+' '+operation);
   };
   if(phase===p.holdAt)return new Promise((res,rej)=>p.pending.push({resolve:res,reject:rej,execute,phase})).then(resolve,reject);
   return Promise.resolve(execute()).then(resolve,reject);
  }};return b;};
  p.settle=(outcome:string)=>{const pending=p.pending.shift();if(!pending)throw Error('No pending routine phase');if(outcome==='transport')pending.reject(Error('Synthetic routine response unavailable'));else if(outcome==='refuse')pending.resolve({data:null,error:{message:'Synthetic routine refused'}});else if(outcome==='zero')pending.resolve({data:[],error:null});else pending.resolve(pending.execute());};
  const db={from,channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const fail=()=>{throw Error('Unrelated calendar/confirmation action must remain inert');};
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>{const member={id:'member-'+p.familyId,user_id:p.userId,family_id:p.familyId,display_name:'Alex',role:'parent',color:null};return{familyId:p.familyId,userId:p.userId,role:'parent',members:[member],selfMember:member};}},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>fail},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},[actions]:{applyRoutineToCalendarAction:fail,undoCalendarEventsAction:fail}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const Panel=load(entry).RoutinesPanel;p.root=D.createRoot(document.getElementById('root'));p.render=()=>{const panel=R.createElement(Panel,{events:[],weekStartMonday:new Date('2026-09-28T00:00:00Z'),timeZone:'UTC',onApplied:fail});p.root.render(p.strict?R.createElement(R.StrictMode,null,panel):panel);};p.switchContext=(family:string,user:string)=>{p.familyId=family;p.userId=user;p.render();};p.render();
 },{sources:modules,entry,messages,actions,options});
 await expect(page.getByRole('heading',{name:'Routines',exact:true})).toBeVisible();
}
async function openDraft(page:Page,name='Morning A'){await page.getByRole('button',{name:'New',exact:true}).click();await page.getByRole('textbox',{name:'Name',exact:true}).fill(name);await page.getByPlaceholder('e.g. Breakfast', {exact:true}).fill('Breakfast');}
async function start(page:Page){await page.getByRole('button',{name:'Create routine',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.pending.length)).toBe(1);}
async function settle(page:Page,outcome='success'){await page.evaluate(async outcome=>{(window as any).__routine.settle(outcome);await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));},outcome);}
test('earlier saved routine leaves a reopened routine draft intact',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Evening B');await settle(page);await expect(page.getByRole('dialog')).toHaveCount(1);await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Evening B');expect(await page.evaluate(()=>(window as any).__routine.writes)).toHaveLength(2);});
test('earlier item refusal does not attach stale feedback to a new draft',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Evening B');await settle(page,'refuse');await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Evening B');expect(await page.evaluate(()=>(window as any).__routine.notices)).toEqual([]);});
test('current saved routine closes and refreshes its own list',async({page})=>{await fixture(page);await openDraft(page);await start(page);const reads=await page.evaluate(()=>(window as any).__routine.reads.length);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>(window as any).__routine.reads.length)).toBeGreaterThan(reads);expect(await page.evaluate(()=>(window as any).__routine.writes)).toHaveLength(2);});
test('current item refusal keeps the draft usable',async({page})=>{await fixture(page);await openDraft(page);await start(page);await settle(page,'refuse');await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Morning A');await expect(page.getByRole('button',{name:'Create routine',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).__routine.notices.map((n:any)=>n.kind))).toEqual(['error']);});
test('canceling an idle routine editor does not write',async({page})=>{await fixture(page);await openDraft(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__routine.writes)).toEqual([]);});

async function openEdit(page:Page,name:string){const card=page.locator('div.group').filter({has:page.getByText(name,{exact:true})});await card.hover();await card.getByRole('button',{name:'Edit routine',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(1);}
async function beginEdit(page:Page,name:string){await page.getByRole('textbox',{name:'Name',exact:true}).fill(name);await page.getByRole('button',{name:'Save routine',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.pending.length)).toBe(1);}
async function state(page:Page){return page.evaluate(()=>{const p=(window as any).__routine;return{writes:p.writes,reads:p.reads,tables:p.tables,notices:p.notices};});}
test('closed create transport failure does not report into the reopened draft',async({page})=>{await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Evening B');await settle(page,'transport');await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Evening B');expect((await state(page)).notices).toEqual([]);});
test('earlier create preserves a newer pending save and confirmed old routine read-refresh',async({page})=>{
 await fixture(page);await openDraft(page);await start(page);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'Evening B');await page.getByRole('button',{name:'Create routine',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.pending.length)).toBe(2);
 await settle(page);await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Evening B');await expect(page.getByRole('button',{name:'Create routine',exact:true})).toBeDisabled();await expect(page.getByText('Morning A',{exact:true})).toBeVisible();expect((await state(page)).writes).toHaveLength(4);
 await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Evening B',{exact:true})).toBeVisible();expect((await state(page)).tables.routine_templates.map((t:any)=>t.name)).toEqual(['Morning A','Evening B']);
});
for(const target of ['same','different'])for(const outcome of ['success','refuse','transport']){
 test('old edit '+outcome+' preserves '+target+' reopened draft and its own later save',async({page})=>{
  await fixture(page,{seed:['Morning A','Evening B']});await openEdit(page,'Morning A');await beginEdit(page,'Earlier renamed A');await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openEdit(page,target==='same'?'Morning A':'Evening B');await page.getByRole('textbox',{name:'Name',exact:true}).fill('Later routine draft');
  await settle(page,outcome);await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Later routine draft');await expect(page.getByRole('button',{name:'Save routine',exact:true})).toBeEnabled();expect((await state(page)).notices).toEqual([]);
  const old=await state(page);expect(old.writes.map((w:any)=>w.operation)).toEqual(['update','delete','insert']);expect(old.writes[0].filters).toEqual([['id','seed-0']]);expect(old.writes[1].filters).toEqual([['template_id','seed-0']]);expect(old.writes[2].payload[0]).toMatchObject({template_id:'seed-0',family_id:'family-A',title:'Breakfast',sort_order:0});
  await page.getByRole('button',{name:'Save routine',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.pending.length)).toBe(1);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect((await state(page)).writes).toHaveLength(6);expect((await state(page)).tables.routine_templates[target==='same'?0:1].name).toBe('Later routine draft');
 });
}
test('current edit finishes ordered rename/delete/insert and refreshes name/icon/steps',async({page})=>{
 await fixture(page,{seed:['Morning A']});await openEdit(page,'Morning A');await page.getByRole('button',{name:'🌙',exact:true}).click();await page.getByPlaceholder('e.g. Breakfast',{exact:true}).fill('New step');await beginEdit(page,'Evening edit');const reads=(await state(page)).reads.length;await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Evening edit',{exact:true})).toBeVisible();
 const p=await state(page);expect(p.writes.map((w:any)=>w.operation)).toEqual(['update','delete','insert']);expect(p.tables.routine_templates[0]).toMatchObject({name:'Evening edit',icon:'🌙'});expect(p.tables.routine_template_items).toHaveLength(1);expect(p.tables.routine_template_items[0].title).toBe('New step');expect(p.reads.length).toBeGreaterThan(reads);
});
for(const outcome of ['refuse','transport'])test('current edit '+outcome+' retains draft and allows an explicit complete-pipeline retry',async({page})=>{
 await fixture(page,{seed:['Morning A']});await openEdit(page,'Morning A');await beginEdit(page,'Retained edit draft');await settle(page,outcome);await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Retained edit draft');await expect(page.getByRole('button',{name:'Save routine',exact:true})).toBeEnabled();expect((await state(page)).notices.map((n:any)=>n.kind)).toEqual(['error']);expect((await state(page)).writes).toHaveLength(3);
 await page.getByRole('button',{name:'Save routine',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.pending.length)).toBe(1);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect((await state(page)).writes).toHaveLength(6);expect((await state(page)).tables.routine_template_items).toHaveLength(1);
});
test('current zero-row rename refuses replacement steps before delete/insert',async({page})=>{
 await fixture(page,{seed:['Morning A'],failRename:true});await openEdit(page,'Morning A');await page.getByRole('textbox',{name:'Name',exact:true}).fill('Refused rename');await page.getByRole('button',{name:'Save routine',exact:true}).click();await expect(page.getByRole('button',{name:'Save routine',exact:true})).toBeEnabled();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.notices.length)).toBe(1);const p=await state(page);expect(p.writes.map((w:any)=>w.operation)).toEqual(['update']);expect(p.tables.routine_templates[0].name).toBe('Morning A');expect(p.tables.routine_template_items[0].title).toBe('Breakfast');await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Refused rename');
});
test('current refused step deletion prevents insertion and retains usable draft',async({page})=>{
 await fixture(page,{seed:['Morning A'],failDelete:true});await openEdit(page,'Morning A');await page.getByRole('textbox',{name:'Name',exact:true}).fill('Renamed before refusal');await page.getByRole('button',{name:'Save routine',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.notices.length)).toBe(1);await expect(page.getByRole('button',{name:'Save routine',exact:true})).toBeEnabled();const p=await state(page);expect(p.writes.map((w:any)=>w.operation)).toEqual(['update','delete']);expect(p.tables.routine_template_items).toHaveLength(1);await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Renamed before refusal');
});
for(const phase of ['rename','delete'] as const)test('closed edit paused at '+phase+' still executes the entire requested pipeline',async({page})=>{
 await fixture(page,{seed:['Morning A'],holdAt:phase});await openEdit(page,'Morning A');await beginEdit(page,'Closed committed edit');await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await openDraft(page,'New untouched draft');await settle(page);await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('New untouched draft');const p=await state(page);expect(p.writes.map((w:any)=>w.operation)).toEqual(['update','delete','insert']);expect(p.tables.routine_templates[0].name).toBe('Closed committed edit');expect(p.tables.routine_template_items).toHaveLength(1);expect(p.notices).toEqual([]);await expect(page.getByText('Closed committed edit',{exact:true})).toBeVisible();
});
for(const kind of ['create','edit'])for(const outcome of ['success','refuse','transport'])test('unmounted '+kind+' '+outcome+' produces no stale feedback or automatic retry',async({page})=>{
 await fixture(page,{seed:kind==='edit'?['Morning A']:[]});if(kind==='create'){await openDraft(page);await start(page)}else{await openEdit(page,'Morning A');await beginEdit(page,'Unmounted edit')}
 const writes=(await state(page)).writes.length;await page.evaluate(()=>(window as any).__routine.root.unmount());await settle(page,outcome);const p=await state(page);expect(p.writes).toHaveLength(writes);expect(p.notices).toEqual([]);expect(p.tables.routine_template_items).toHaveLength(outcome==='success'?1:0);
});
for(const kind of ['create','edit'])test('StrictMode '+kind+' completion still closes and confirms read-refresh',async({page})=>{
 await fixture(page,{seed:kind==='edit'?['Morning A']:[],strict:true});if(kind==='create'){await openDraft(page);await start(page)}else{await openEdit(page,'Morning A');await beginEdit(page,'Strict edit')}
 const reads=(await state(page)).reads.length;await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect((await state(page)).reads.length).toBeGreaterThan(reads);
});
test('old context create cannot close or populate new context draft or trigger old query refresh',async({page})=>{
 await fixture(page);await openDraft(page);await start(page);await page.evaluate(()=>(window as any).__routine.switchContext('family-B','user-B'));await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('');await page.getByRole('textbox',{name:'Name',exact:true}).fill('New family draft');await page.getByPlaceholder('e.g. Breakfast',{exact:true}).fill('Breakfast B');const reads=(await state(page)).reads.length;
 await settle(page);await expect(page.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('New family draft');const p=await state(page);expect(p.reads).toHaveLength(reads);expect(p.writes[0].payload).toMatchObject({family_id:'family-A',created_by:'user-A'});expect(p.writes[1].payload[0].family_id).toBe('family-A');expect(p.notices).toEqual([]);
 await page.getByRole('button',{name:'Create routine',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__routine.pending.length)).toBe(1);await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect((await state(page)).writes[2].payload).toMatchObject({family_id:'family-B',created_by:'user-B',name:'New family draft'});
});
for(const kind of ['create','edit'])test('pending '+kind+' gates duplicate native clicks and Cancel stays usable',async({page})=>{
 await fixture(page,{seed:kind==='edit'?['Morning A']:[]});if(kind==='create'){await openDraft(page);await start(page)}else{await openEdit(page,'Morning A');await beginEdit(page,'Pending edit')}
 const button=page.getByRole('button',{name:kind==='create'?'Create routine':'Save routine',exact:true});await expect(button).toBeDisabled();const writes=(await state(page)).writes.length;await button.evaluate(node=>{(node as HTMLButtonElement).click();(node as HTMLButtonElement).click()});expect((await state(page)).writes).toHaveLength(writes);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await settle(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect((await state(page)).writes).toHaveLength(writes);
});
test('idle edit cancellation dispatches no rename/delete/insert',async({page})=>{await fixture(page,{seed:['Morning A']});await openEdit(page,'Morning A');await page.getByRole('textbox',{name:'Name',exact:true}).fill('Unsent edit');await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();expect((await state(page)).writes).toEqual([]);expect((await state(page)).tables.routine_templates[0].name).toBe('Morning A');});
