import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';

// Actual Inventory browsing/shared UI/CSS/query hook/SDK GETs with synthetic rows.
// Media/storage/weather/recommendations/cost/date and app/cache context are inert.
// No writes, Auth, RLS, provider, hosted backend or full Inventory proof.
const sourceRoot=process.env.BUBALY_INVENTORY_UI_SOURCE_ROOT||process.cwd();
// Wire assertions follow the actual items callback; visible catalog assertions remain unchanged.
const inventoryAst=ts.createSourceFile('inventory-module.tsx',fs.readFileSync(path.join(sourceRoot,'components/modules/inventory-module.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let itemsFetcher='';let itemsFetcherCount=0;
function inspectInventory(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(inventoryAst)==='useRealtimeQuery'&&n.arguments.length){const arg=n.arguments[0];if(ts.isObjectLiteralExpression(arg)&&arg.properties.some(p=>ts.isPropertyAssignment(p)&&p.name.getText(inventoryAst)==='table'&&ts.isStringLiteral(p.initializer)&&p.initializer.text==='inventory_items')){const p=arg.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(inventoryAst)==='fetcher');if(p&&ts.isPropertyAssignment(p)){itemsFetcher=p.initializer.getText(inventoryAst);itemsFetcherCount++;}}}ts.forEachChild(n,inspectInventory);}inspectInventory(inventoryAst);
if(itemsFetcherCount!==1)throw Error('Expected one actual Inventory items callback');
const cursorProtocol=itemsFetcher.includes('readInventoryItems');
if(!cursorProtocol&&!itemsFetcher.includes('readAllAsQuery'))throw Error('Undeclared Inventory wire protocol');
const diagnostics=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];diagnostics.set(page,errors);page.on('console',m=>{if(['warning','error'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(diagnostics.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__inventory.errors)).toEqual([]);});
const {react,reactDom}=reactBrowserScripts();
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/i18n/use-format','@/components/ui/toast','@/lib/supabase/client','@/lib/offline/cache-scope','@/lib/storage/family-media','@/lib/weather/open-meteo','@/lib/inventory/finder','@/lib/wallet/ledger','@/components/ui/confirm','@/lib/closet/wear','@/components/media/family-media-img','@/components/ai/ai-insight']);
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
const entry=collect(path.join(sourceRoot,'components/modules/inventory-module.tsx'));
let css='';
test.beforeAll(async()=>{const config={exports:{} as any};const code=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,'tailwind.config.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;new Function('module','exports','require',code)(config,config.exports,require);config.exports.default.content=[path.join(sourceRoot,'components/**/*.{ts,tsx}'),path.join(sourceRoot,'app/**/*.{ts,tsx}')];css=(await postcss([tailwindcss(config.exports.default),autoprefixer()]).process(fs.readFileSync(path.join(sourceRoot,'app/globals.css'),'utf8'),{from:path.join(sourceRoot,'app/globals.css')})).css;});
const finderCode=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,'lib/inventory/finder.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
async function fixture(page:Page,count=121,withLocation=false,cap=Number.MAX_SAFE_INTEGER,foreign=false,faultOffset:number|null=null,ties=false,holdLater=false){
 await page.route('**/*',async route=>{if(route.request().url()!=='https://inventory-fixture.invalid/')throw Error('Unexpected native request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="root"></main></body></html>'});});
 await page.goto('https://inventory-fixture.invalid/');await page.addStyleTag({content:css});for(const content of [react,reactDom,'window.react=window.React;',icons,sdk])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,count,finderCode,withLocation,cap,foreign,faultOffset,ties,holdLater,cursorProtocol})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p:any=w.__inventory={errors:[] as string[],requests:[] as any[],forbidden:[] as string[],familyId:'family-A',userId:'user-A',responses:[] as any[],totalDelivered:0,faultOffset,holdLater};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const deny=(name:string)=>(...args:any[])=>{p.forbidden.push(name);throw Error('Outside ordinary browsing fixture: '+name);},fail=deny('nonordinary operation');
  const respond=(body:any)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
  p.store=Array.from({length:count},(_,index)=>({id:'item-'+(index+1),name:'Catalog item '+String(index+1).padStart(3,'0'),family_id:'family-A',updated_at:String(index+1).padStart(4,'0'),category:'tools',status:'in_place',quantity:1,location_id:withLocation?'room-A':null,owner_member_id:null,photo_path:null,value_cents:null,brand:null,model:null,serial_number:index===0?'unique-tail-spanner':null,tags:[],lent_to:null,lent_on:null,warranty_until:null}));
  if(ties)p.store.forEach((row:any)=>row.updated_at='same');
  if(foreign)p.store.push({...p.store[0],id:'foreign-item',family_id:'family-B',name:'Foreign family item'});
  const transport=async(input:any,options:any={})=>{
   const url=new URL(String(input)),table=url.pathname.split('/').pop(),method=options.method??'GET';
   if(url.origin!=='https://inventory-store.invalid'||!['inventory_items','home_locations','inventory_moves'].includes(table??'')||method!=='GET')return deny('SDK transport '+method+' '+url)();
   p.requests.push({table,method,query:url.search});if(table!=='inventory_items')return respond(table==='home_locations'&&withLocation?[{id:'room-A',name:'Workshop',kind:'room',parent_id:null,family_id:p.familyId}]:[]);
   let rows=p.store.filter((row:any)=>[...url.searchParams].every(([key,value])=>!value.startsWith('eq.')||String(row[key])===value.slice(3))).filter((row:any)=>!url.searchParams.get('id')||row.id>(url.searchParams.get('id')??'').slice(3));
   const order=url.searchParams.get('order');if(order!==(cursorProtocol?'id.asc':'updated_at.desc,id.desc')||url.searchParams.get('select')!=='*'||!url.searchParams.get('family_id')?.startsWith('eq.')||(cursorProtocol&&url.searchParams.get('offset')!=='0')||(!cursorProtocol&&url.searchParams.has('id'))||(url.searchParams.has('id')&&!url.searchParams.get('id')?.startsWith('gt.')))return deny('Inventory wire protocol')();if(order){const keys=order.split(',');rows=[...rows].sort((a:any,b:any)=>{for(const item of keys){const [key,direction]=item.split('.');if(a[key]<b[key])return direction==='desc'?1:-1;if(a[key]>b[key])return direction==='desc'?-1:1;}return 0;});}
   const offset=Number(url.searchParams.get('offset')||0),limit=url.searchParams.get('limit'),family=url.searchParams.get('family_id');const cursor=url.searchParams.get('id');if(p.faultOffset!==null&&(cursorProtocol?cursor==='gt.item-'+p.faultOffset:offset===p.faultOffset)){p.failures=(p.failures??0)+1;return new Response(JSON.stringify({message:'synthetic later catalog read refused'}),{status:500,headers:{'content-type':'application/json'}});}rows=rows.slice(offset,limit?offset+Number(limit):undefined);rows=rows.slice(0,cap);
   if(p.holdLater&&family==='eq.family-A'&&(cursorProtocol?cursor!==null:offset>0)){p.holdLater=false;p.held=true;await new Promise<void>(resolve=>p.release=resolve);}
   p.delivered=rows.length;p.totalDelivered+=rows.length;p.responses.push({offset,limit,cap,returned:rows.length,family,cursor,ids:rows.map((r:any)=>r.id)});return respond(rows);
  };
  const db=w.supabase.createClient('https://inventory-store.invalid','synthetic-public-key',{global:{fetch:transport},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});db.channel=()=>({on(){return this;},subscribe(){return this;}});db.removeChannel=async()=>{};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const finder={exports:{} as any};new Function('module','exports',finderCode)(finder,finder.exports);
  const ordinaryFinder={...finder.exports,lentOut:()=>[],warrantyAlerts:()=>[],valueSummary:()=>({valuedItems:0,totalCents:0,byCategory:[]}),inventorySummary:()=>({text:'Ordinary catalog fixture',rooms:0,unlocated:count,overdueLoans:0}),lastConfirmed:()=>null,dayDiff:deny('date difference')};
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:p.familyId,userId:p.userId,role:'parent',members:[],selfMember:null})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),usePlural:()=>((key:string,n:number)=>n+' items')},'@/components/i18n/use-format':{useFamilyClock:()=>({todayKey:deny('family day')}),useFamilyCalendarToday:()=>null,useFormat:()=>({fmtDate:deny('date format')})},'@/components/ui/toast':{useToast:()=>({success:deny('write success'),error:deny('write error')})},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},'@/lib/storage/family-media':{familyMediaPath:deny('storage')},'@/lib/inventory/finder':ordinaryFinder,'@/lib/wallet/ledger':{formatCents:deny('money')},'@/components/ui/confirm':{useConfirm:()=>deny('confirmation/write')},'@/components/media/family-media-img':{FamilyMediaImg:({fallback}:any)=>fallback},'@/components/ai/ai-insight':{AiInsight:()=>null}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));p.render=()=>root.render(R.createElement(load(entry).InventoryModule));p.render();
 },{sources:modules,entry,messages,count,finderCode,withLocation,cap,foreign,faultOffset,ties,holdLater,cursorProtocol});
 await expect.poll(()=>page.evaluate(()=>(window as any).__inventory.responses.length)).toBeGreaterThan(0);
 if(faultOffset===null&&!holdLater)await expect(page.getByText(/^\d+ items$/)).toBeVisible();
}
const itemNames=(page:Page)=>page.locator('p.font-medium').filter({hasText:/^Catalog item \d{3,}$/});
test.afterEach(async({page})=>{expect(await page.evaluate(()=>(window as any).__inventory.forbidden)).toEqual([]);expect(await page.evaluate(()=>(window as any).__inventory.requests.filter((r:any)=>r.table==='inventory_items').length)).toBeLessThanOrEqual(32);});

async function stored(page:Page,own:number,delivered:number){
 const proof=await page.evaluate(()=>{const p=(window as any).__inventory;return {own:p.store.filter((r:any)=>r.family_id==='family-A').length,responses:p.responses,total:p.totalDelivered,requests:p.requests};});
 await test.info().attach('synthetic SDK read receipt',{body:JSON.stringify(proof),contentType:'application/json'});
 expect(proof.own).toBe(own);expect(proof.total).toBeGreaterThanOrEqual(delivered);expect(proof.responses.reduce((total:number,response:any)=>total+response.returned,0)).toBe(proof.total);
 expect(proof.requests.every((r:any)=>r.method==='GET')).toBe(true);
 expect(proof.requests.filter((r:any)=>r.table==='inventory_items').every((r:any)=>new URLSearchParams(r.query).get('family_id')==='eq.family-A')).toBe(true);
}
async function browseAll(page:Page,count:number){
 for(let index=0;index<Math.ceil(count/120)-1;index++)await page.getByRole('button',{name:'More',exact:true}).click();
 await expect(itemNames(page)).toHaveCount(count);await expect(page.getByText('Catalog item 001',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'More',exact:true})).toHaveCount(0);
}
test('modeled cap1000 does not truncate the stored1001 catalog total',async({page})=>{
 await fixture(page,1001,false,1000);await stored(page,1001,1000);
 await expect(page.getByText('1001 items',{exact:true})).toBeVisible();
});
test('modeled cap1000 still permits searching the stored1001 tail item',async({page})=>{
 await fixture(page,1001,false,1000);await stored(page,1001,1000);
 await page.getByRole('textbox').first().fill('unique-tail-spanner');
 await expect(page.getByText('1 items',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(1);await expect(page.getByText('Catalog item 001',{exact:true})).toHaveCount(2);
});
test('uncapped1001 catalog preserves its count and can browse every row',async({page})=>{
 await fixture(page,1001);await stored(page,1001,1001);await expect(page.getByText('1001 items',{exact:true})).toBeVisible();await browseAll(page,1001);
 await page.getByRole('textbox').first().fill('unique-tail-spanner');await expect(page.getByText('1 items',{exact:true})).toBeVisible();await expect(page.getByText('Catalog item 001',{exact:true})).toHaveCount(2);
});
test('exactly1000 stored rows are complete under modeled cap1000',async({page})=>{
 await fixture(page,1000,false,1000);await stored(page,1000,1000);await expect(page.getByText('1000 items',{exact:true})).toBeVisible();await browseAll(page,1000);
});
test('different-family row is excluded from ordinary catalog browsing',async({page})=>{
 await fixture(page,3,false,1000,true);await stored(page,3,3);await expect(page.getByText('3 items',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(3);
 expect(await page.evaluate(()=>(window as any).__inventory.store.length)).toBe(4);await expect(page.getByText('Foreign family item',{exact:true})).toHaveCount(0);
});

test('configured cap1 retrieves all3 rows and an empty terminal page',async({page})=>{
 await fixture(page,3,false,1);await expect(page.getByText('3 items',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(3);
 const receipts=await page.evaluate(()=>(window as any).__inventory.responses);expect(receipts.map((r:any)=>[r.offset,r.returned])).toEqual(cursorProtocol?[[0,1],[0,1],[0,1],[0,0]]:[[0,1],[1,1],[2,1],[3,0]]);expect(receipts.map((r:any)=>r.cursor)).toEqual(cursorProtocol?[null,'gt.item-1','gt.item-2','gt.item-3']:[null,null,null,null]);
});
test('configured cap7 uses stable id tie ordering across short pages',async({page})=>{
 await fixture(page,15,false,7,false,null,true);await expect(page.getByText('15 items',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(15);
 const proof=await page.evaluate(()=>{const p=(window as any).__inventory;return {receipts:p.responses,orders:p.requests.filter((r:any)=>r.table==='inventory_items').map((r:any)=>new URLSearchParams(r.query).get('order')),expected:[...p.store].sort((a:any,b:any)=>a.id<b.id?1:a.id>b.id?-1:0).map((r:any)=>r.name)};});
 expect(proof.receipts.map((r:any)=>[r.offset,r.returned])).toEqual(cursorProtocol?[[0,7],[0,7],[0,1],[0,0]]:[[0,7],[7,7],[14,1],[15,0]]);expect(proof.receipts.map((r:any)=>r.cursor)).toEqual(cursorProtocol?[null,'gt.item-15','gt.item-8','gt.item-9']:[null,null,null,null]);expect(proof.orders).toEqual(Array(4).fill(cursorProtocol?'id.asc':'updated_at.desc,id.desc'));expect(await itemNames(page).allTextContents()).toEqual(proof.expected);
});
for(const [title,count,fault] of [['later nonempty page',3,2],['terminal empty page',2,2]] as const)test(title+' failure cannot publish a partial-success catalog',async({page})=>{
 await fixture(page,count,false,2,false,fault);await expect(page.getByText('Could not load the home inventory. Refresh and try again.',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__inventory.failures)).toBe(1);await expect(page.getByRole('button',{name:'Add the first item',exact:true})).toHaveCount(0);
 await page.evaluate(()=>(window as any).__inventory.faultOffset=null);await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByText(count+' items',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(count);
});
test('a held old-family later page cannot replace a completed current-family catalog',async({page})=>{
 await fixture(page,3,false,2,false,null,false,true);
 const paged=await page.evaluate(()=>(window as any).__inventory.requests.some((r:any)=>r.table==='inventory_items'&&new URLSearchParams(r.query).has('offset')));
 if(paged)await expect.poll(()=>page.evaluate(()=>(window as any).__inventory.held)).toBe(true);
 await page.evaluate(()=>{const p=(window as any).__inventory;p.store.push(...p.store.slice(0,2).map((r:any,index:number)=>({...r,id:'B-'+index,family_id:'family-B',name:'Family B neutral '+index})));p.familyId='family-B';p.render();});
 await expect(page.getByText('2 items',{exact:true})).toBeVisible();await expect(page.getByText('Family B neutral 0',{exact:true})).toBeVisible();await expect(page.getByText('Family B neutral 1',{exact:true})).toBeVisible();
 if(paged){await page.evaluate(()=>(window as any).__inventory.release());await expect.poll(()=>page.evaluate(()=>(window as any).__inventory.responses.filter((r:any)=>r.family==='eq.family-A').map((r:any)=>[r.offset,r.returned,r.cursor]))).toEqual(cursorProtocol?[[0,2,null],[0,1,'gt.item-2'],[0,0,'gt.item-3']]:[[0,2,null],[2,1,null],[3,0,null]]);}
 await expect(page.getByText('2 items',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(0);expect(await page.evaluate(()=>(window as any).__inventory.requests.every((r:any)=>r.method==='GET'))).toBe(true);
});
test('an empty catalog under a small cap retains the first-item state',async({page})=>{
 await fixture(page,0,false,1);await expect(page.getByText('0 items',{exact:true})).toBeVisible();await expect(itemNames(page)).toHaveCount(0);await expect(page.getByRole('button',{name:'Add the first item',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).__inventory.responses.map((r:any)=>[r.offset,r.returned]))).toEqual([[0,0]]);
});
