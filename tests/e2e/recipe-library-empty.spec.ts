import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
// Actual React19 recipe library and real query hook with synthetic read rows.
// Only search/tab/category controls execute; writes/AI/grocery flows refuse.
const sourceRoot=process.env.BUBALY_RECIPE_UI_SOURCE_ROOT || process.cwd();
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
async function fixture(page:Page,mode='saved'){
 await page.route('**/*',async route=>{if(route.request().url()!=='https://recipe-fixture.invalid/')throw Error('Unexpected request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="root"></main></body></html>'});});
 await page.goto('https://recipe-fixture.invalid/');await page.addStyleTag({content:css});for(const content of [react,reactDom,'window.react=window.React;',icons])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,actions,mode})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p=w.__recipe={errors:[] as string[],notices:[] as any[],reads:[] as any[],mode,pending:[] as any[],release:():void=>{throw Error('No held read');}};
  window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const row={id:'recipe-A',family_id:'family-A',created_by:'user-A',name:'Lime pasta',description:'Quick weeknight pasta',cuisine:'Italian',category:'dinner',difficulty:'easy',servings:4,prep_time_mins:10,cook_time_mins:15,photo_url:null,source_url:null,ingredients:[],instructions:[],tags:['pasta'],allergy_flags:[],is_favorite:false,times_made:0,last_made_at:null,ai_generated:false,updated_at:'2026-10-02T00:00:00Z'};
  const fail=()=>{throw Error('Writes/provider/AI/grocery flows are outside library fixture');};
  const from=(table:string)=>{if(table!=='family_recipes')throw Error('Unexpected table '+table);const filters:any[]=[];const orders:any[]=[];const b={select(){return b;},eq(k:string,v:any){filters.push([k,v]);return b;},order(k:string,options:any={}){orders.push([k,options.ascending!==false]);return b;},insert:fail,update:fail,delete:fail,then(resolve:any,reject:any){p.reads.push({table,filters,orders});const data=p.mode==='empty'?[]:[structuredClone(row)].filter((r:any)=>filters.every(([k,v])=>r[k]===v));data.sort((a:any,c:any)=>{for(const [key,asc] of orders){if(a[key]<c[key])return asc?-1:1;if(a[key]>c[key])return asc?1:-1;}return 0;});const result=()=>p.mode==='error'?{data:null,error:{message:'Synthetic recipe list unavailable'}}:{data,error:null};return (p.mode==='loading'?new Promise<void>(done=>p.pending.push(done)).then(result):Promise.resolve(result())).then(resolve,reject);}};return b;};
  p.release=()=>{p.mode='saved';for(const done of p.pending.splice(0))done();};
  const db={from,channel:()=>({on(){return this;},subscribe(){return this;}}),removeChannel:async()=>{}};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const member={id:'member-A',user_id:'user-A',family_id:'family-A',display_name:'Alex',role:'parent',color:null};
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/navigation':{useRouter:()=>({push:fail,refresh:fail})},'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:'family-A',userId:'user-A',role:'parent',members:[member],selfMember:member})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=> 'UTC'},'@/components/ui/toast':{useToast:()=>({success:(message:string)=>p.notices.push({kind:'success',message}),error:(message:string)=>p.notices.push({kind:'error',message})})},'@/components/ui/confirm':{useConfirm:()=>fail},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/lib/recipes/ai-actions':{RECIPE_AI_ACTIONS:[]},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},[actions]:{addGroceryItemsAction:fail}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));root.render(R.createElement(load(entry).RecipesModule));
 },{sources:modules,entry,messages,actions,mode});
 if(mode==='error'){await expect(page.getByText('Could not load family recipes. Refresh and try again.',{exact:true})).toBeVisible();return;}
 if(mode==='loading'){await expect.poll(()=>page.evaluate(()=>(window as any).__recipe.pending.length)).toBe(1);return;}
 await expect(page.getByRole('heading',{name:'Family Recipes',exact:true})).toBeVisible();
 if(mode==='saved')await expect(page.getByText('Lime pasta',{exact:true})).toBeVisible();
 if(mode==='empty')await expect(page.getByText('No recipes yet',{exact:true})).toBeVisible();
}
test('search with saved recipes does not announce an empty cookbook',async({page})=>{await fixture(page);await page.getByPlaceholder('Search recipes…',{exact:true}).fill('zzzz no recipe');await expect(page.getByText('Lime pasta',{exact:true})).toHaveCount(0);await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add First Recipe',exact:true})).toHaveCount(0);});
test('empty Favorites with saved recipes does not announce an empty cookbook',async({page})=>{await fixture(page);await page.getByRole('button',{name:'⭐ Favorites',exact:true}).click();await expect(page.getByText('Lime pasta',{exact:true})).toHaveCount(0);await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);});
test('empty Recently Made with saved recipes does not announce an empty cookbook',async({page})=>{await fixture(page);await page.getByRole('button',{name:'🍳 Recently Made',exact:true}).click();await expect(page.getByText('Lime pasta',{exact:true})).toHaveCount(0);await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);});
test('unmatched category with saved recipes does not announce an empty cookbook',async({page})=>{await fixture(page);await page.getByRole('combobox',{name:'Category',exact:true}).selectOption('breakfast');await expect(page.getByText('Lime pasta',{exact:true})).toHaveCount(0);await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);});
test('clearing an unmatched search restores the saved recipe',async({page})=>{await fixture(page);await page.getByPlaceholder('Search recipes…',{exact:true}).fill('zzzz no recipe');await expect(page.getByText('Lime pasta',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Clear search',exact:true}).click();await expect(page.getByText('Lime pasta',{exact:true})).toBeVisible();await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);});
test('an actually empty cookbook keeps its first recipe guidance',async({page})=>{await fixture(page,'empty');await expect(page.getByRole('button',{name:'Add First Recipe',exact:true})).toBeVisible();});
test('matching search keeps the saved recipe visible',async({page})=>{await fixture(page);await page.getByPlaceholder('Search recipes…',{exact:true}).fill('lime');await expect(page.getByText('Lime pasta',{exact:true})).toBeVisible();await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);});

for(const filter of ['search','favorites','recent','category']){
 test('empty '+filter+' results explain the filter and keep Add Recipe usable',async({page})=>{
  await fixture(page);
  if(filter==='search')await page.getByPlaceholder('Search recipes…',{exact:true}).fill('zzzz no recipe');
  else if(filter==='favorites')await page.getByRole('button',{name:'⭐ Favorites',exact:true}).click();
  else if(filter==='recent')await page.getByRole('button',{name:'🍳 Recently Made',exact:true}).click();
  else await page.getByRole('combobox',{name:'Category',exact:true}).selectOption('breakfast');
  await expect(page.getByText('No recipes found — try another search.',{exact:true})).toBeVisible();
  await expect(page.getByText("Add your family's favorite recipes and they'll appear here.",{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Add First Recipe',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Add Recipe',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'New recipe',exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByText('No recipes found — try another search.',{exact:true})).toBeVisible();
 });
}
test('pending recipe reads do not invent empty-library guidance',async({page})=>{
 await fixture(page,'loading');await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add First Recipe',exact:true})).toHaveCount(0);
 await page.evaluate(()=>(window as any).__recipe.release());await expect(page.getByText('Lime pasta',{exact:true})).toBeVisible();
});
test('refused recipe reads stay errors and retry restores the saved library',async({page})=>{
 await fixture(page,'error');await expect(page.getByText('No recipes yet',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add First Recipe',exact:true})).toHaveCount(0);
 await page.evaluate(()=>(window as any).__recipe.mode='saved');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByText('Lime pasta',{exact:true})).toBeVisible();
});
test('truly empty first-recipe action still opens its editor without a write',async({page})=>{
 await fixture(page,'empty');await expect(page.getByText("Add your family's favorite recipes and they'll appear here.",{exact:true})).toBeVisible();await page.getByRole('button',{name:'Add First Recipe',exact:true}).click();await expect(page.getByRole('dialog',{name:'New recipe',exact:true})).toBeVisible();await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByText('No recipes yet',{exact:true})).toBeVisible();
});
