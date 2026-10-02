import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
// Actual packing UI, query hook, modal/form controls, translations and CSS.
// Synthetic database transport replaces persistence; every browser request is
// intercepted. These cases do not execute hosted Auth, providers, SQL or RLS.
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({page}) => {
 const errors:string[]=[]; browserErrors.set(page,errors);
 page.on('console', message => { if(['error','warning'].includes(message.type())) errors.push(message.type()+': '+message.text()); });
 page.on('pageerror', error => errors.push('pageerror: '+error.message));
 page.on('requestfailed', request => errors.push('requestfailed: '+request.url()));
});
test.afterEach(async ({page}) => {
 expect(browserErrors.get(page)).toEqual([]);
 expect(await page.evaluate(()=>(window as any).__packing?.errors??[])).toEqual([]);
});
const {react,reactDom}=reactBrowserScripts();
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const isolated=new Set(['react','react-dom','lucide-react','@/components/app/app-context','@/components/i18n/locale-provider','@/components/ui/toast','@/lib/supabase/client','@/lib/offline/cache-scope']);
const modules:Record<string,{source:string;imports:Record<string,string>}>= {};
function collect(filename:string):string {
 const id=path.resolve([filename,filename+'.ts',filename+'.tsx',path.join(filename,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile())??filename);
 if(modules[id])return id;
 const raw=fs.readFileSync(id,'utf8');
 const source=/\.tsx?$/.test(id)?ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText:raw;
 const item=modules[id]={source,imports:{} as Record<string,string>};
 for(const match of source.matchAll(/require\(["']([^"']+)["']\)/g)){
  const name=match[1]; if(isolated.has(name)){item.imports[name]=name;continue;}
  item.imports[name]=collect(name.startsWith('@/')?path.resolve(name.slice(2)):name.startsWith('.')?path.resolve(path.dirname(id),name):require.resolve(name,{paths:[path.dirname(id)]}));
 }
 return id;
}
const entry=collect('components/vacations/trip-packing.tsx');
let css='';
test.beforeAll(async()=>{
 const config={exports:{} as any};
 const code=ts.transpileModule(fs.readFileSync('tailwind.config.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 new Function('module','exports','require',code)(config,config.exports,require);
 css=(await postcss([tailwindcss(config.exports.default),autoprefixer()]).process(fs.readFileSync('app/globals.css','utf8'),{from:'app/globals.css'})).css;
});
async function fixture(page:Page,mode='success',master=true){
 await page.route('**/*',async route=>{
  if(route.request().url()!=='https://packing-fixture.invalid/')throw new Error('Unexpected request '+route.request().url());
  await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="root"></main></body></html>'});
 });
 await page.goto('https://packing-fixture.invalid/');await page.addStyleTag({content:css});
 for(const content of [react,reactDom,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json','utf8'));
 await page.evaluate(({sources,entry,messages,mode,master})=>{
 const w=window as any,R=w.React,D=w.ReactDOM;
 const p=w.__packing={mode,notices:[] as any[],errors:[] as string[],writes:[] as any[],pending:[] as any[],settled:[] as any[],settleNext:(_outcome='success'):void=>{throw Error('No synthetic save settler installed');},setTrip:(_id:string):void=>{throw Error('No synthetic trip renderer installed');},unmount:():void=>{throw Error('No synthetic root installed');},tables:{vacations:[{id:'trip-A',family_id:'family-A',kind:'domestic'}],vacation_packing_lists:master?[{id:'list-A',family_id:'family-A',vacation_id:'trip-A',is_master:true}]:[],vacation_packing_items:[],vacation_weather_snapshots:[],vacation_activities:[]} as Record<string,any[]>};
 p.settleNext=(outcome='success')=>{const held=p.pending.shift();if(!held)throw Error('No synthetic packing save is pending');held.settle(outcome);};
 window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
 function from(table:string){const filters:any[]=[];let operation='read',input:any,single=false;
  const q={select(){return this;},eq(k:string,v:any){filters.push([k,v]);return this;},insert(v:any){operation='insert';input=v;return this;},single(){single=true;return this;},then(resolve:any,reject:any){
   if(operation==='read'){const rows=p.tables[table].filter(row=>filters.every(([k,v])=>row[k]===v));return Promise.resolve({data:structuredClone(rows),error:null}).then(resolve,reject);}
   p.writes.push({table,input:structuredClone(input)});
   if((table==='vacation_packing_items'&&p.mode==='held-item')||(table==='vacation_packing_lists'&&p.mode==='held-master')){
    const recorded=structuredClone(input),number=p.writes.length;
    return new Promise((done,failed)=>p.pending.push({table,settle(outcome:string){
     p.settled.push({table,input:recorded,outcome});
     if(outcome==='refuse')return done({data:null,error:{code:'XX000',message:'Synthetic packing save refused'}});
     if(outcome==='transport')return failed(new Error('Synthetic packing transport unavailable'));
     const row={id:'inserted-'+number,packed:false,...recorded};p.tables[table].push(row);done({data:single?{id:row.id}:null,error:null});
    }})).then(resolve,reject);
   }
   if((table==='vacation_packing_lists'&&p.mode==='master-refuse')||(table==='vacation_packing_items'&&p.mode==='item-refuse'))return Promise.resolve({data:null,error:{code:'XX000',message:'Synthetic packing save refused'}}).then(resolve,reject);
   if((table==='vacation_packing_items'&&p.mode==='transport')||(table==='vacation_packing_lists'&&p.mode==='master-transport'))return Promise.reject(new Error('Synthetic packing transport unavailable')).then(resolve,reject);
   const row={id:'inserted-'+p.writes.length,packed:false,...input};p.tables[table].push(row);
   if(table==='vacation_packing_items'&&p.mode==='lost-response')return Promise.reject(new Error('Synthetic packing response lost after commit')).then(resolve,reject);
   return Promise.resolve({data:single?{id:row.id}:null,error:null}).then(resolve,reject);
  }};return q;
 }
 const db={from,channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
 const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
 const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'@/components/app/app-context':{useApp:()=>({familyId:'family-A',userId:'user-A',members:[]})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=>undefined},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true}};
 const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const loadedModule=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),loadedModule,loadedModule.exports);return loadedModule.exports;}
 const root=D.createRoot(document.getElementById('root')),TripPacking=load(entry).TripPacking;
 p.setTrip=(id:string)=>root.render(R.createElement(TripPacking,{vacationId:id}));p.unmount=()=>root.unmount();p.setTrip('trip-A');
 },{sources:modules,entry,messages,mode,master});
 await expect(page.getByRole('heading',{name:'Packing',exact:true})).toBeVisible();
}

async function settlePending(page:Page,outcome='success'){
 await page.evaluate(async outcome=>{(window as any).__packing.settleNext(outcome);await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));},outcome);
}
async function reopenWithNewDraft(page:Page){
 await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await page.getByRole('button',{name:'Add',exact:true}).click();
 await page.getByRole('textbox',{name:'Item',exact:true}).fill('Rain jacket');
 await page.getByLabel('Quantity',{exact:true}).fill('2');
 await page.getByLabel('Category',{exact:true}).selectOption('other');
}
async function editorSnapshot(page:Page){return page.evaluate(()=>({dialogs:document.querySelectorAll('[role="dialog"]').length,name:(document.querySelector('[role="dialog"] input:not([type="number"])') as HTMLInputElement|null)?.value??null,quantity:(document.querySelector('[role="dialog"] input[type="number"]') as HTMLInputElement|null)?.value??null}));}
test.describe('packing editor lifecycle',()=>{
 test('late item success preserves the draft opened after cancel',async({page})=>{
  await fixture(page,'held-item');await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await reopenWithNewDraft(page);await settlePending(page);
  expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'Rain jacket',quantity:'2'});
 });
 test('late master success stops before the cancelled item and preserves the new draft',async({page})=>{
  await fixture(page,'held-master',false);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await reopenWithNewDraft(page);await settlePending(page);
  expect(await page.evaluate(()=>(window as any).__packing.writes.map((w:any)=>w.table))).toEqual(['vacation_packing_lists']);
  expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'Rain jacket',quantity:'2'});
 });
 test('current held item success closes its own editor',async({page})=>{
  await fixture(page,'held-item');await fill(page);const add=page.getByRole('dialog').getByRole('button',{name:'Add',exact:true});await add.click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await expect(add).toBeDisabled();await settlePending(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.notices.map((n:any)=>n.kind))).toEqual(['success']);
 });
 test('current held master success continues to its own item',async({page})=>{
  await fixture(page,'held-master',false);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await settlePending(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.writes.map((w:any)=>w.table))).toEqual(['vacation_packing_lists','vacation_packing_items']);
 });
 test('current held refusal keeps the same draft and restores Add',async({page})=>{
  await fixture(page,'held-item');await fill(page);const add=page.getByRole('dialog').getByRole('button',{name:'Add',exact:true});await add.click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await settlePending(page,'refuse');
  expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'Travel pillow',quantity:'3'});await expect(add).toBeEnabled();expect(await page.evaluate(()=>(window as any).__packing.notices.map((n:any)=>n.kind))).toEqual(['error']);
 });
 test('canceling an idle draft reopens a blank enabled editor without a write',async({page})=>{
  await fixture(page);await fill(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('button',{name:'Add',exact:true}).click();
  expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'',quantity:'1'});await expect(page.getByRole('dialog').getByRole('button',{name:'Add',exact:true})).toBeEnabled();expect(await page.evaluate(()=>(window as any).__packing.writes)).toEqual([]);
 });
});
async function fill(page:Page){await page.getByRole('button',{name:'Add',exact:true}).click();await page.getByRole('textbox',{name:'Item',exact:true}).fill('Travel pillow');await page.getByLabel('Quantity',{exact:true}).fill('3');await page.getByLabel('Category',{exact:true}).selectOption('other');}
test('successful add closes form and reloads the entered packing item',async({page})=>{await fixture(page);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);const state=await page.evaluate(()=>({writes:(window as any).__packing.writes,notices:(window as any).__packing.notices}));expect(state.writes).toEqual([{table:'vacation_packing_items',input:{family_id:'family-A',vacation_id:'trip-A',list_id:'list-A',name:'Travel pillow',category:'other',quantity:3,created_by:'user-A'}}]);expect(state.notices.map((x:any)=>x.kind)).toEqual(['success']);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByRole('checkbox',{name:'Travel pillow ×3',exact:true})).toBeVisible();});
test('cancel closes without inserting an item',async({page})=>{await fixture(page);await fill(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.writes)).toEqual([]);});
test('refused item save preserves the draft for retry',async({page})=>{await fixture(page,'item-refuse');await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__packing.notices.length)).toBe(1);await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Item',exact:true})).toHaveValue('Travel pillow');await expect(page.getByLabel('Quantity',{exact:true})).toHaveValue('3');expect(await page.evaluate(()=>(window as any).__packing.notices.map((n:any)=>n.kind))).toEqual(['error']);});
test('refused master-list creation stops before item insertion',async({page})=>{await fixture(page,'master-refuse',false);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__packing.writes.length)).toBeGreaterThan(0);expect(await page.evaluate(()=>(window as any).__packing.writes.map((w:any)=>w.table))).toEqual(['vacation_packing_lists']);await expect(page.getByRole('dialog')).toBeVisible();});
test('first item creates its master list before saving',async({page})=>{await fixture(page,'success',false);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);const writes=await page.evaluate(()=>(window as any).__packing.writes);expect(writes.map((w:any)=>w.table)).toEqual(['vacation_packing_lists','vacation_packing_items']);expect(writes[1].input.list_id).toBe('inserted-1');});
test('refused save restores enabled Add and allows an explicit retry',async({page})=>{await fixture(page,'item-refuse');await fill(page);const button=page.getByRole('dialog').getByRole('button',{name:'Add',exact:true});await button.click();await expect(button).toBeEnabled();await expect(page.getByRole('textbox',{name:'Item',exact:true})).toHaveValue('Travel pillow');await expect(page.getByLabel('Quantity',{exact:true})).toHaveValue('3');await expect(page.getByLabel('Category',{exact:true})).toHaveValue('other');expect(await page.evaluate(()=>(window as any).__packing.writes.length)).toBe(1);await page.evaluate(()=>(window as any).__packing.mode='success');await button.click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.writes.length)).toBe(2);expect(await page.evaluate(()=>(window as any).__packing.tables.vacation_packing_items.length)).toBe(1);});
for(const mode of ['transport','master-transport','lost-response']){
 test(mode+' preserves draft, reports failure and does not retry automatically',async({page})=>{await fixture(page,mode,mode!=='master-transport');await fill(page);const button=page.getByRole('dialog').getByRole('button',{name:'Add',exact:true});await button.click();await expect.poll(()=>page.evaluate(()=>(window as any).__packing.notices.length)).toBe(1);await expect(button).toBeEnabled();await expect(page.getByRole('textbox',{name:'Item',exact:true})).toHaveValue('Travel pillow');await expect(page.getByLabel('Quantity',{exact:true})).toHaveValue('3');await expect(page.getByLabel('Category',{exact:true})).toHaveValue('other');const p=await page.evaluate(()=>(window as any).__packing);expect(p.notices.map((n:any)=>n.kind)).toEqual(['error']);expect(p.writes).toHaveLength(1);expect(p.tables.vacation_packing_items).toHaveLength(mode==='lost-response'?1:0);if(mode==='master-transport')expect(p.writes[0].table).toBe('vacation_packing_lists');});
}

async function changeTrip(page:Page,id:string){
 await page.evaluate(async id=>{
  const p=(window as any).__packing;
  if(!p.tables.vacations.some((row:any)=>row.id===id)){
   p.tables.vacations.push({id,family_id:'family-A',kind:'domestic'});
   p.tables.vacation_packing_lists.push({id:'list-'+id,family_id:'family-A',vacation_id:id,is_master:true});
  }
  p.setTrip(id);await new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done())));
 },id);
 await expect(page.getByRole('heading',{name:'Packing',exact:true})).toBeVisible();
}
test.describe('packing editor lifecycle safeguards',()=>{
 test('a reopened editor can save and keeps its own loading state when the old save finishes',async({page})=>{
  await fixture(page,'held-item');await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await reopenWithNewDraft(page);
  const add=page.getByRole('dialog').getByRole('button',{name:'Add',exact:true});await expect(add).toBeEnabled();await add.click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(2);
  await page.getByRole('dialog').locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(await page.evaluate(()=>(window as any).__packing.writes.length)).toBe(2);
  await settlePending(page);await expect(add).toBeDisabled();expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'Rain jacket',quantity:'2'});
  expect(await page.evaluate(()=>(window as any).__packing.notices)).toEqual([]);await settlePending(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('checkbox',{name:'Travel pillow ×3',exact:true})).toBeVisible();await expect(page.getByRole('checkbox',{name:'Rain jacket ×2',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as any).__packing.notices.map((n:any)=>n.kind))).toEqual(['success']);
 });
 for(const table of ['item','master'])for(const outcome of ['refuse','transport']){
  test('late '+table+' '+outcome+' does not report against or change a reopened draft',async({page})=>{
   await fixture(page,'held-'+table,table==='item');await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
   await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await reopenWithNewDraft(page);await settlePending(page,outcome);
   expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'Rain jacket',quantity:'2'});await expect(page.getByRole('dialog').getByRole('button',{name:'Add',exact:true})).toBeEnabled();
   expect(await page.evaluate(()=>(window as any).__packing.notices)).toEqual([]);expect(await page.evaluate(()=>(window as any).__packing.writes.length)).toBe(1);
  });
 }
 for(const outcome of ['refuse','transport']){
  test('current held master '+outcome+' keeps its draft and restores Add',async({page})=>{
   await fixture(page,'held-master',false);await fill(page);const add=page.getByRole('dialog').getByRole('button',{name:'Add',exact:true});await add.click();
   await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await settlePending(page,outcome);
   expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'Travel pillow',quantity:'3'});await expect(add).toBeEnabled();
   expect(await page.evaluate(()=>(window as any).__packing.notices.map((n:any)=>n.kind))).toEqual(['error']);expect(await page.evaluate(()=>(window as any).__packing.writes.map((w:any)=>w.table))).toEqual(['vacation_packing_lists']);
  });
 }
 test('a confirmed late master is read back for the next same-trip add without another master insert',async({page})=>{
  await fixture(page,'held-master',false);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await reopenWithNewDraft(page);await settlePending(page);
  expect(await editorSnapshot(page)).toEqual({dialogs:1,name:'Rain jacket',quantity:'2'});await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);const writes=await page.evaluate(()=>(window as any).__packing.writes);
  expect(writes.map((w:any)=>w.table)).toEqual(['vacation_packing_lists','vacation_packing_items']);expect(writes[1].input).toMatchObject({vacation_id:'trip-A',list_id:'inserted-1',name:'Rain jacket'});
  expect(await page.evaluate(()=>(window as any).__packing.notices.map((n:any)=>n.kind))).toEqual(['success']);
 });
 test('changing vacation hides the old draft and prevents its late master from inserting an item',async({page})=>{
  await fixture(page,'held-master',false);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await changeTrip(page,'trip-B');await settlePending(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.writes.map((w:any)=>w.table))).toEqual(['vacation_packing_lists']);expect(await page.evaluate(()=>(window as any).__packing.notices)).toEqual([]);
  await page.getByRole('button',{name:'Add',exact:true}).click();await page.getByRole('textbox',{name:'Item',exact:true}).fill('Rain jacket');await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.writes[1].input)).toMatchObject({vacation_id:'trip-B',list_id:'list-trip-B',name:'Rain jacket'});
 });
 test('leaving and returning to a vacation does not resurrect its old editor and reads back the confirmed master',async({page})=>{
  await fixture(page,'held-master',false);await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await changeTrip(page,'trip-B');await changeTrip(page,'trip-A');await settlePending(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.writes.map((w:any)=>w.table))).toEqual(['vacation_packing_lists']);expect(await page.evaluate(()=>(window as any).__packing.notices)).toEqual([]);
  await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__packing.writes.map((w:any)=>w.table))).toEqual(['vacation_packing_lists','vacation_packing_items']);expect(await page.evaluate(()=>(window as any).__packing.writes[1].input.list_id)).toBe('inserted-1');
 });
 for(const table of ['master','item']){
  test('unmounting before held '+table+' success suppresses editor feedback and keeps confirmed dispatched writes',async({page})=>{
   await fixture(page,'held-'+table,table==='item');await fill(page);await page.getByRole('dialog').getByRole('button',{name:'Add',exact:true}).click();
   await expect.poll(()=>page.evaluate(()=>(window as any).__packing.pending.length)).toBe(1);await page.evaluate(()=>(window as any).__packing.unmount());await settlePending(page);
   await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__packing.notices)).toEqual([]);expect(await page.evaluate(()=>(window as any).__packing.writes.length)).toBe(1);
   expect(await page.evaluate(table=>(window as any).__packing.tables[table==='master'?'vacation_packing_lists':'vacation_packing_items'].length,table)).toBe(1);
  });
 }
});
