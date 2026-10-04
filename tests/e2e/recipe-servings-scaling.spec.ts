import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
// Actual React19 recipe detail/servings controls and real query hook.
// Synthetic saved ingredients only; writes/AI/grocery flows remain inert.
const sourceRoot=process.env.BUBALY_RECIPE_UI_SOURCE_ROOT||process.cwd();
const browserErrors=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];browserErrors.set(page,errors);page.on('console',m=>{if(['error','warning'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>errors.push(r.url()));});
test.afterEach(async({page})=>{expect(browserErrors.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__recipe?.errors??[])).toEqual([]);});
const {react,reactDom}=reactBrowserScripts();
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const actions='@/app/(app)/dashboard/grocery/actions';
const isolated=new Set(['react','react-dom','lucide-react','next/navigation','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/ui/toast','@/components/ui/confirm','@/lib/supabase/client','@/lib/offline/cache-scope','@/components/ai/ai-insight','@/lib/recipes/ai-actions',actions]);
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
const entry=collect(path.join(sourceRoot,'components/modules/recipes-module.tsx'));
let css='';
test.beforeAll(async()=>{const config={exports:{} as any};const code=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,'tailwind.config.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;new Function('module','exports','require',code)(config,config.exports,require);config.exports.default.content=[path.join(sourceRoot,'components/**/*.{ts,tsx}'),path.join(sourceRoot,'app/**/*.{ts,tsx}')];css=(await postcss([tailwindcss(config.exports.default),autoprefixer()]).process(fs.readFileSync(path.join(sourceRoot,'app/globals.css'),'utf8'),{from:path.join(sourceRoot,'app/globals.css')})).css;});
async function fixture(page:Page,quantity='1'){
 const mode='saved';
 await page.route('**/*',async route=>{if(route.request().url()!=='https://recipe-fixture.invalid/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="root"></main></body></html>'});});
 await page.goto('https://recipe-fixture.invalid/');await page.addStyleTag({content:css});for(const content of [react,reactDom,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,actions,mode,quantity})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__recipe={errors:[] as string[],notices:[] as any[],reads:[] as any[],mode,pending:[] as any[],release:():void=>{throw Error('No held read');}};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const row={id:'recipe-A',family_id:'family-A',created_by:'user-A',name:'Lime pasta',description:'Quick weeknight pasta',cuisine:'Italian',category:'dinner',difficulty:'easy',servings:4,prep_time_mins:10,cook_time_mins:15,photo_url:null,source_url:null,ingredients:[{name:'Flour',quantity,unit:'cup'}],instructions:[],tags:['pasta'],allergy_flags:[],is_favorite:false,times_made:0,last_made_at:null,ai_generated:false,updated_at:'2026-10-02T00:00:00Z'};
  const fail=()=>{throw Error('Writes/provider/AI/grocery flows are outside library fixture');};
  const from=(table:string)=>{if(table!=='family_recipes')throw Error('Unexpected table '+table);const filters:any[]=[];const orders:any[]=[];const b={select(){return b;},eq(k:string,v:any){filters.push([k,v]);return b;},order(k:string,options:any={}){orders.push([k,options.ascending!==false]);return b;},insert:fail,update:fail,delete:fail,then(resolve:any,reject:any){p.reads.push({table,filters,orders});const data=p.mode==='empty'?[]:[structuredClone(row)].filter((r:any)=>filters.every(([k,v])=>r[k]===v));data.sort((a:any,c:any)=>{for(const [key,asc] of orders){if(a[key]<c[key])return asc?-1:1;if(a[key]>c[key])return asc?1:-1;}return 0;});const result=()=>p.mode==='error'?{data:null,error:{message:'Synthetic recipe list unavailable'}}:{data,error:null};return (p.mode==='loading'?new Promise<void>(done=>p.pending.push(done)).then(result):Promise.resolve(result())).then(resolve,reject);}};return b;};
  p.release=()=>{p.mode='saved';for(const done of p.pending.splice(0))done();};
  const db={from,channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const member={id:'member-A',user_id:'user-A',family_id:'family-A',display_name:'Alex',role:'parent',color:null};
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:'family-A',userId:'user-A',role:'parent',members:[member],selfMember:member})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>fail},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/lib/recipes/ai-actions':{RECIPE_AI_ACTIONS:[]},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},[actions]:{addGroceryItemsAction:fail}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));root.render(R.createElement(load(entry).RecipesModule));
 },{sources:modules,entry,messages,actions,mode,quantity});
 await expect(page.getByRole('heading',{name:'Family Recipes',exact:true})).toBeVisible();
 await expect(page.getByText('Lime pasta',{exact:true})).toBeVisible();
}
async function detail(page:Page,quantity:string){await fixture(page,quantity);await page.getByText('Lime pasta',{exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(1);await expect(page.getByText('Flour',{exact:true})).toBeVisible();}
async function shown(page:Page){return (await page.getByText('Flour',{exact:true}).locator('..').locator('span.font-semibold').textContent())?.trim()??'';}
async function doubleServings(page:Page){for(let index=0;index<4;index++)await page.getByRole('dialog').getByRole('button',{name:'+',exact:true}).click();}
test('opening a saved half-cup ingredient keeps the original quantity',async({page})=>{await detail(page,'1/2');expect(await shown(page)).toMatch(/^(?:0\.5|1\/2|½) cup$/);});
test('doubling servings turns a half cup into one cup',async({page})=>{await detail(page,'1/2');await doubleServings(page);expect(await shown(page)).toBe('1 cup');});
test('doubling servings turns a mixed one-and-half quantity into three',async({page})=>{await detail(page,'1 1/2');await doubleServings(page);expect(await shown(page)).toBe('3 cup');});
test('doubling servings scales a saved unicode half fraction',async({page})=>{await detail(page,'½');await doubleServings(page);expect(await shown(page)).toBe('1 cup');});
test('opening a quarter-decimal quantity does not round it up',async({page})=>{await detail(page,'0.25');expect(await shown(page)).toMatch(/^(?:0\.25|1\/4|¼) cup$/);});
test('whole-number quantity scales with the servings controls',async({page})=>{await detail(page,'2');await doubleServings(page);expect(await shown(page)).toBe('4 cup');});
test('decimal half quantity scales with the servings controls',async({page})=>{await detail(page,'0.5');await doubleServings(page);expect(await shown(page)).toBe('1 cup');});
test('descriptive quantity remains readable when servings change',async({page})=>{await detail(page,'to taste');await doubleServings(page);expect(await shown(page)).toBe('to taste cup');});
test('unicode fraction remains readable without adjusting servings',async({page})=>{await detail(page,'½');expect(await shown(page)).toBe('½ cup');});
test('tripling servings keeps the scaled quarter-decimal amount',async({page})=>{await detail(page,'0.25');for(let index=0;index<8;index++)await page.getByRole('dialog').getByRole('button',{name:'+',exact:true}).click();expect(await shown(page)).toMatch(/^(?:0\.75|3\/4|¾) cup$/);});
test('unchanged servings preserve the saved mixed fraction string',async({page})=>{await detail(page,'1 1/2');expect(await shown(page)).toBe('1 1/2 cup');});
test('unchanged servings preserve the saved decimal precision',async({page})=>{await detail(page,'0.125');expect(await shown(page)).toBe('0.125 cup');});
test('doubling a mixed unicode fraction scales the entire quantity',async({page})=>{await detail(page,'1½');await doubleServings(page);expect(await shown(page)).toBe('3 cup');});
test('doubling an eighth-decimal quantity retains quarter precision',async({page})=>{await detail(page,'0.125');await doubleServings(page);expect(await shown(page)).toBe('0.25 cup');});
test('a quantity range remains intact when servings change',async({page})=>{await detail(page,'1-2');await doubleServings(page);expect(await shown(page)).toBe('1-2 cup');});
test('unrecognized quantity suffixes are not truncated',async({page})=>{await detail(page,'1 heaped');await doubleServings(page);expect(await shown(page)).toBe('1 heaped cup');});
test('a zero-denominator fraction remains intact instead of becoming a number',async({page})=>{await detail(page,'1/0');await doubleServings(page);expect(await shown(page)).toBe('1/0 cup');});
test('invalid NaN quantities remain suppressed after changing servings',async({page})=>{await detail(page,'NaN');await doubleServings(page);await expect(page.getByText('Flour',{exact:true}).locator('..').locator('span.font-semibold')).toHaveCount(0);});
