import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
const sourceRoot=process.env.BUBALY_WISHLIST_UI_SOURCE_ROOT||process.cwd();
const origin='https://wishlist-readback.invalid';
const {react,reactDom}=reactBrowserScripts();
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/ui/toast','@/components/ui/confirm','@/lib/supabase/client','@/lib/offline/cache-scope','@/components/ai/ai-insight','@/components/wishlists/before-you-buy','@/lib/wishlists/gifts']);
const modules:Record<string,{source:string;imports:Record<string,string>}>= {};
function collect(filename:string):string {
 const id=path.resolve([filename,filename+'.ts',filename+'.tsx',path.join(filename,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile())??filename);
 if(modules[id])return id;
 const raw=fs.readFileSync(id,'utf8');const source=/\.tsx?$/.test(id)?ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText:raw;
 const item=modules[id]={source,imports:{} as Record<string,string>};
 for(const match of source.matchAll(/require\(["']([^"']+)["']\)/g)){const name=match[1];if(isolated.has(name)){item.imports[name]=name;continue;}item.imports[name]=collect(name.startsWith('@/')?path.join(sourceRoot,name.slice(2)):name.startsWith('.')?path.resolve(path.dirname(id),name):require.resolve(name,{paths:[path.dirname(id)]}));}
 return id;
}
const entry=collect(path.join(sourceRoot,'components/modules/wishlists-module.tsx'));
const diagnostics=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];diagnostics.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(diagnostics.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__wish?.errors??[])).toEqual([]);});
async function fixture(page:Page,mode='healthy'){
 const family='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',user='cccccccc-cccc-4ccc-8ccc-cccccccccccc',member='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
 const rows:any[]=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',family_id:family,member_id:member,created_by:user,title:'Paper kite',url:null,price:null,priority:'medium',notes:null,is_purchased:false,claimed_by:null}];
 const requests:any[]=[];
 await page.route('**/*',async route=>{if(route.request().url()!==origin+'/')throw Error('Unexpected browser request');await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});});
 await page.exposeFunction('__wishlistFetch',async(url:string,method:string,body:any)=>{
  const parsed=new URL(url);if(parsed.origin!==origin||parsed.pathname!=='/rest/v1/wishlist_items')throw Error('Unexpected SDK destination');requests.push({method,url,body});
  if(method==='GET'){expect(parsed.searchParams.get('family_id')).toBe('eq.'+family);if(mode==='read-error')return{status:400,body:{code:'SYNTHETIC',message:'Synthetic title list unavailable'}};return{status:200,body:structuredClone(rows)};}
  if(!['POST','PATCH','DELETE'].includes(method))throw Error('Unexpected operation');
  expect(parsed.searchParams.get('select')).toBe('id');
  if(mode==='refusal')return{status:400,body:{code:'SYNTHETIC',message:'Synthetic title change refused'}};
  if(mode==='zero')return{status:200,body:[]};
  if(method==='POST'){
   const input=Array.isArray(body)?body[0]:body;expect(Object.keys(input).sort()).toEqual(['created_by','family_id','member_id','notes','price','priority','title','url']);expect(input.price).toBeNull();expect(input.url).toBeNull();expect(input.notes).toBeNull();expect(input.family_id).toBe(family);expect(input.member_id).toBe(member);expect(input.created_by).toBe(user);
   const row={...rows[0],...input,id:'aaaaaaaa-aaaa-4aaa-8aaa-000000000002'};rows.push(row);return{status:201,body:[{id:row.id}]};
  }
  const id=parsed.searchParams.get('id')?.replace(/^eq\./,'');const index=rows.findIndex(r=>r.id===id);if(index<0)throw Error('Unknown synthetic title');
  if(method==='PATCH'){expect(Object.keys(body).sort()).toEqual(['notes','price','priority','title','url']);expect(body.price).toBeNull();expect(body.url).toBeNull();expect(body.notes).toBeNull();Object.assign(rows[index],body);}else rows.splice(index,1);
  return{status:200,body:[{id}]};
 });
 await page.goto(origin);for(const content of [react,reactDom,sdk,'window.react=window.React;',icons])await page.addScriptTag({content});
 await page.evaluate(({sources,entry,messages,origin,family,user,member})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__wish={errors:[] as string[],notices:[] as any[],callbacks:[] as any[],settled:0,confirmations:0};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const fail=()=>{throw Error('Gift/purchase/AI/provider/money/context workflows excluded');};
  const sb=w.supabase.createClient(origin,'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url:any,init:any)=>{const method=init.method||'GET';try{const response=await w.__wishlistFetch(String(url),method,init.body?JSON.parse(init.body):null);return new Response(JSON.stringify(response.body),{status:response.status,headers:{'content-type':'application/json'}});}finally{if(method!=='GET')p.settled++;}}}});
  const db={from:(table:string)=>{if(table!=='wishlist_items')fail();return sb.from(table);},channel:()=>({on(_event:any,filter:any,callback:any){p.callbacks.push({filter,callback});return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const self={id:member,user_id:user,family_id:family,display_name:'Alex',role:'parent'};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  // Domain claim/purchase behavior is an inert presentation seam. These tests
  // remain on this synthetic member's own title list and never test gift state.
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:family,userId:user,members:[self],selfMember:self})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'})},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>async()=>{p.confirmations++;return true;}},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/components/wishlists/before-you-buy':{BeforeYouBuy:fail},'@/lib/wishlists/gifts':{claimState:()=> 'hidden',canToggleClaim:()=>false,sortWishes:(rows:any[])=>[...rows],WISH_PRIORITY_LABELS:{high:'High',medium:'Medium',low:'Low'}},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module');const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  D.createRoot(document.getElementById('root')).render(R.createElement(load(entry).WishlistsModule));
 },{sources:modules,entry,messages,origin,family,user,member});
 if(mode==='read-error')await expect(page.getByText('Could not load data. Please try again.',{exact:true})).toBeVisible();
 else await expect(page.getByText('Paper kite',{exact:true})).toBeVisible();
 return{rows,requests,setMode:(value:string)=>{mode=value;},writes:()=>requests.filter(r=>r.method!=='GET'),reads:()=>requests.filter(r=>r.method==='GET')};
}
async function add(page:Page,title:string){await page.getByRole('button',{name:messages['wishlists.addAWish'],exact:true}).click();await page.getByRole('dialog').getByRole('textbox').first().fill(title);await page.getByRole('button',{name:'Add wish',exact:true}).click();}
async function settled(page:Page){await expect.poll(()=>page.evaluate(()=>(window as any).__wish.settled)).toBe(1);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
test('confirmed new title reads back without a Realtime event',async({page})=>{const proof=await fixture(page);await add(page,'Blue paper kite');await settled(page);expect(proof.rows.map(r=>r.title)).toEqual(['Paper kite','Blue paper kite']);expect(proof.writes()).toHaveLength(1);await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByText('Blue paper kite',{exact:true})).toBeVisible();});
test('confirmed edited title reads back without a Realtime event',async({page})=>{const proof=await fixture(page);await page.getByRole('button',{name:messages['wishlists.edit'],exact:true}).click();await page.getByRole('dialog').getByRole('textbox').first().fill('Blue paper kite');await page.getByRole('button',{name:'Save changes',exact:true}).click();await settled(page);expect(proof.rows[0].title).toBe('Blue paper kite');expect(proof.writes()).toHaveLength(1);await expect(page.getByText('Blue paper kite',{exact:true})).toBeVisible();});
test('confirmed removed title reads back absence without a Realtime event',async({page})=>{const proof=await fixture(page);await page.getByRole('button',{name:messages['wishlists.remove'],exact:true}).click();await settled(page);expect(proof.rows).toEqual([]);expect(proof.writes()).toHaveLength(1);await expect(page.getByText('Paper kite',{exact:true})).toHaveCount(0);await expect(page.getByText(messages['wishlists.yourListEmpty'],{exact:true})).toBeVisible();});
for(const mode of ['refusal','zero'])test(mode+' creation keeps draft without success',async({page})=>{const proof=await fixture(page,mode);await add(page,'Blue paper kite');await settled(page);expect(proof.rows).toHaveLength(1);expect(proof.writes()).toHaveLength(1);await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue('Blue paper kite');expect(await page.evaluate(()=>(window as any).__wish.notices.map((n:any)=>n.kind))).toEqual(['error']);});
test('canceling an idle new title dispatches no write',async({page})=>{const proof=await fixture(page);await page.getByRole('button',{name:messages['wishlists.addAWish'],exact:true}).click();await page.getByRole('dialog').getByRole('textbox').first().fill('Blue paper kite');await page.getByRole('button',{name:messages['wishlists.cancel'],exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.writes()).toEqual([]);expect(proof.rows).toHaveLength(1);});
test('actual hook online refresh reveals a committed title with no second write',async({page})=>{const proof=await fixture(page);await add(page,'Blue paper kite');await settled(page);await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByText('Blue paper kite',{exact:true})).toBeVisible();expect(proof.writes()).toHaveLength(1);expect(proof.reads().length).toBeGreaterThan(1);});

for(const mode of ['refusal','zero'])for(const action of ['edit','remove'])test(mode+' '+action+' keeps stored title and does not read after refused write',async({page})=>{
 const proof=await fixture(page,mode);const reads=proof.reads().length;
 if(action==='edit'){await page.getByRole('button',{name:messages['wishlists.edit'],exact:true}).click();await page.getByRole('dialog').getByRole('textbox').first().fill('Blue paper kite');await page.getByRole('button',{name:'Save changes',exact:true}).click();}
 else await page.getByRole('button',{name:messages['wishlists.remove'],exact:true}).click();
 await settled(page);expect(proof.rows.map(r=>r.title)).toEqual(['Paper kite']);expect(proof.writes()).toHaveLength(1);expect(proof.reads()).toHaveLength(reads);expect(await page.evaluate(()=>(window as any).__wish.notices.map((n:any)=>n.kind))).toEqual(['error']);
 if(action==='edit')await expect(page.getByRole('dialog').getByRole('textbox').first()).toHaveValue('Blue paper kite');
 else await expect(page.getByText('Paper kite',{exact:true})).toBeVisible();
});

for(const action of ['create','edit','remove'])test('confirmed '+action+' with refused readback shows error and online recovery only rereads',async({page})=>{
 const proof=await fixture(page);proof.setMode('read-error');
 if(action==='create')await add(page,'Blue paper kite');
 else if(action==='edit'){await page.getByRole('button',{name:messages['wishlists.edit'],exact:true}).click();await page.getByRole('dialog').getByRole('textbox').first().fill('Blue paper kite');await page.getByRole('button',{name:'Save changes',exact:true}).click();}
 else await page.getByRole('button',{name:messages['wishlists.remove'],exact:true}).click();
 await settled(page);expect(proof.writes()).toHaveLength(1);expect(proof.reads()).toHaveLength(2);
 expect(proof.rows.map(r=>r.title)).toEqual(action==='create'?['Paper kite','Blue paper kite']:action==='edit'?['Blue paper kite']:[]);
 await expect(page.getByText('Could not load data. Please try again.',{exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).__wish.notices.map((n:any)=>n.kind))).toEqual(['success']);
 proof.setMode('healthy');await page.evaluate(()=>window.dispatchEvent(new Event('online')));
 if(action==='remove')await expect(page.getByText(messages['wishlists.yourListEmpty'],{exact:true})).toBeVisible();
 else await expect(page.getByText('Blue paper kite',{exact:true})).toBeVisible();
 expect(proof.writes()).toHaveLength(1);expect(proof.reads()).toHaveLength(3);
});

test('initial refused title read recovers through actual online hook without a write',async({page})=>{
 const proof=await fixture(page,'read-error');proof.setMode('healthy');await page.evaluate(()=>window.dispatchEvent(new Event('online')));await expect(page.getByText('Paper kite',{exact:true})).toBeVisible();expect(proof.writes()).toEqual([]);expect(proof.reads()).toHaveLength(2);
});
