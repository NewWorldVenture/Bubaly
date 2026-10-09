import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import {expect,test,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';

// Actual SchoolModule, shared UI, classifier, query hook and SDK; synthetic GET
// transport and a deferred proposal action. No Auth/RLS/deployed workflow proof.
const sourceRoot=process.env.BUBALY_SCHOOL_UI_SOURCE_ROOT||process.cwd();
const diagnostics=new WeakMap<Page,string[]>();
const readFailures=new WeakMap<Page,string[]>();
test.beforeEach(async({page})=>{const errors:string[]=[];diagnostics.set(page,errors);readFailures.set(page,[]);page.on('console',m=>{if(m.text().startsWith('[school-desk] front desk read failed'))readFailures.get(page)!.push(m.text());else if(['warning','error'].includes(m.type()))errors.push(m.type()+': '+m.text());});page.on('pageerror',e=>errors.push(e.message));});
test.afterEach(async({page},info)=>{expect(readFailures.get(page)).toHaveLength(/^(missing-count|later-error|ceiling) /.test(info.title)?1:0);expect(diagnostics.get(page)).toEqual([]);expect(await page.evaluate(()=>(window as any).__desk.errors)).toEqual([]);});
const {react,reactDom}=reactBrowserScripts();
const icons=fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')),'dist/umd/lucide-react.min.js'),'utf8');
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const isolated=new Set(['react','react-dom','lucide-react','next/link','@/components/app/app-context','@/components/i18n/locale-provider','@/components/i18n/use-format','@/components/ui/toast','@/lib/supabase/client','@/lib/offline/cache-scope','@/components/ui/confirm','@/components/ai/ai-insight','@/app/(app)/dashboard/school/actions']);
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
const entry=collect(path.join(sourceRoot,'components/modules/school-module.tsx'));
let css='';
test.beforeAll(async()=>{const config={exports:{} as any};const code=ts.transpileModule(fs.readFileSync(path.join(sourceRoot,'tailwind.config.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;new Function('module','exports','require',code)(config,config.exports,require);config.exports.default.content=[path.join(sourceRoot,'components/**/*.{ts,tsx}'),path.join(sourceRoot,'app/**/*.{ts,tsx}')];css=(await postcss([tailwindcss(config.exports.default),autoprefixer()]).process(fs.readFileSync(path.join(sourceRoot,'app/globals.css'),'utf8'),{from:path.join(sourceRoot,'app/globals.css')})).css;});

type Scenario = 'healthy' | 'members' | 'classes' | 'teams' | 'missing-count' | 'later-error' | 'ceiling' | 'empty' | 'queue';
async function fixture(page:Page,scenario:Scenario='healthy',hold=false){
 await page.route('**/*',async route=>{if(route.request().url()!=='https://school-fixture.invalid/')throw Error('Unexpected native request '+route.request().url());await route.fulfill({contentType:'text/html',body:'<!doctype html><html><head></head><body><main id="root"></main></body></html>'});});
 await page.goto('https://school-fixture.invalid/');await page.addStyleTag({content:css});for(const content of [react,reactDom,'window.react=window.React;',icons,sdk])await page.addScriptTag({content});
 const messages=JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'));
 await page.evaluate(({sources,entry,messages,scenario,hold})=>{
  const w=window as any,R=w.React,D=w.ReactDOM,p:any=w.__desk={errors:[],requests:[],toasts:[],proposals:[],held:[],hold,familyId:'family-A',userId:'user-A',version:'initial'};
  window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
  const fail=(name:string)=>{p.errors.push(name);throw Error(name);};
  const member=(id:string,name:string)=>({id,display_name:name,is_active:true,created_at:id,role:'child',avatar_color:null});
  p.members=[member('a','Ava Jones'),member('middle','Taylor Reed'),member('z',scenario==='members'?'Ava Stone':'Noah Stone')];
  const clock={todayKey:()=> '2026-10-08',dayKeyOf:(d:Date)=>d.toISOString().slice(0,10),wallToday:()=>new Date('2026-10-08T00:00:00Z'),toInstant:(d:Date)=>d,addDays:(d:Date,n:number)=>new Date(d.getTime()+n*86400000)};
  const classes=scenario==='classes'?['a','middle','z'].map((id,i)=>({id:'class-'+id,member_id:id,subject:['Art','Math','Writing'][i],teacher:i===1?'Jordan Rivera':'Morgan Green',school_name:'Cedar Academy',time_slot:'09:00',day_of_week:1})):[];
  const teams=scenario==='teams'?['a','middle','z'].map((id,i)=>({id:'team-'+id,member_id:id,team_name:['Aces','Bees','Stars'][i],sport:'soccer',coach:i===1?'Jordan Rivera':'Morgan Green'})):[];
  const transport=async(input:any,options:any={})=>{
   const url=new URL(String(input)),table=url.pathname.split('/').pop()??'',q=url.searchParams;
   if(url.origin!=='https://school-store.invalid'||!['school_events','school_classes','grades','family_members','teams','family_inbox_messages'].includes(table)||(options.method??'GET')!=='GET')return fail('Unexpected SDK request '+url);
   const family=q.get('family_id')?.slice(3);if(!family)return fail('Unscoped read');
   const offset=Number(q.get('offset')||0),limit=Number(q.get('limit')||1000),counted=new Headers(options.headers).get('prefer')?.includes('count=exact');
   p.requests.push({table,family,offset,limit,counted,query:url.search});
   const headline=family+' '+p.version+' school permission slip';
   const body=scenario==='teams'?'Soccer practice: Coach Morgan Green needs the permission slip.':scenario==='classes'?'School field trip: Teacher Morgan Green needs the permission slip.':scenario==='members'?'School field trip: Ava needs the permission slip.':'School field trip: Ava Jones needs the permission slip.';
   let rows:any[]=table==='family_members'?p.members:table==='school_classes'?classes:table==='teams'?teams:table==='family_inbox_messages'?[{id:family+'-message',family_id:family,subject:headline,body,from_addr:'school@example.invalid',ai_handled:false,occurred_at:'2026-10-08T10:00:00Z',status:'received'}]:[];
   if(table==='family_inbox_messages'&&scenario==='empty')rows=[];
   if(table==='family_inbox_messages'&&scenario==='queue')rows=Array.from({length:45},(_,i)=>({...rows[0],id:'message-'+String(i).padStart(2,'0'),subject:'School queue item '+String(i).padStart(2,'0')}));
   rows=rows.map(row=>({...row,family_id:family})).filter(row=>[...q].every(([key,value])=>value.startsWith('eq.')?String(row[key])===value.slice(3):value.startsWith('neq.')?String(row[key])!==value.slice(4):true));
   const order=q.get('order');if(order)rows.sort((a,b)=>{for(const item of order.split(',')){const [key,direction]=item.split('.');if(a[key]<b[key])return direction==='desc'?1:-1;if(a[key]>b[key])return direction==='desc'?-1:1;}return 0;});
   const total=scenario==='ceiling'&&table==='family_members'?2001:rows.length;
   rows=rows.slice(offset,offset+Math.min(limit,2));
   const select=q.get('select');if(select&&select!=='*')rows=rows.map(row=>Object.fromEntries(select.split(',').map(key=>[key.trim(),row[key.trim()]])));
   const headers:Record<string,string>={'content-type':'application/json'};
   if(counted&&!(scenario==='missing-count'&&table==='teams'))headers['content-range']=rows.length?`${offset}-${offset+rows.length-1}/${total}`:`*/${total}`;
   const response=scenario==='later-error'&&table==='family_members'&&offset>0?new Response(JSON.stringify({message:'Synthetic later-page failure'}),{status:403,headers}):new Response(JSON.stringify(rows),{status:200,headers});
   // Deliberately ignore AbortSignal: ownership must protect against transports
   // that have already completed or do not implement cancellation.
   if(p.hold&&table==='family_inbox_messages')await new Promise<void>(resolve=>p.held.push(resolve));
   return response;
  };
  const db=w.supabase.createClient('https://school-store.invalid','synthetic-public-key',{global:{fetch:transport},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});db.channel=()=>({on(){return this;},subscribe(){return this;}});db.removeChannel=async()=>{};
  const tr=(key:string,vars:Record<string,unknown>={})=>Object.entries(vars).reduce((s,[k,v])=>s.split('{'+k+'}').join(String(v)),messages[key]||key);
  const mocks:Record<string,any>={react:R,'react-dom':D,'lucide-react':w.LucideReact,'next/link':{default:(props:any)=>R.createElement('a',props,props.children)},'@/components/app/app-context':{useApp:()=>({familyId:p.familyId,userId:p.userId,role:'parent',members:p.members.slice(0,2),family:{timezone:'UTC'},selfMember:null})},'@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'})},'@/components/i18n/use-format':{useFamilyClock:()=>clock,useFormat:()=>({fmtDate:(value:any)=>String(value),fmtTimeAgo:()=> 'just now'})},'@/components/ui/toast':{useToast:()=>({toast:(x:any)=>p.toasts.push(x),success:(x:any)=>p.toasts.push(x),error:(x:any)=>p.toasts.push(x)})},'@/lib/supabase/client':{createClient:()=>db},'@/lib/offline/cache-scope':{useAuthenticatedCacheScope:()=>null,isAuthenticatedCacheScopeCurrent:()=>true},'@/components/ui/confirm':{useConfirm:()=>()=>fail('Unexpected write confirmation')},'@/components/ai/ai-insight':{AiInsight:()=>null},'@/app/(app)/dashboard/school/actions':{proposeFrontDeskAction:(id:string)=>new Promise(resolve=>p.proposals.push({id,resolve}))}};
  const loaded:Record<string,any>={};function load(id:string):any{if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw Error('Unexpected module '+id);const m=loaded[id]={exports:{}};new Function('require','module','exports',item.source)((name:string)=>load(item.imports[name]),m,m.exports);return m.exports;}
  const root=D.createRoot(document.getElementById('root'));p.render=()=>root.render(R.createElement(load(entry).SchoolModule));p.render();
 },{sources:modules,entry,messages,scenario,hold});
 await expect(page.getByRole('heading',{name:'School & Sports desk',exact:true})).toBeVisible();
}
const card=(page:Page,family='family-A',version='initial')=>page.getByText(family+' '+version+' school permission slip',{exact:true}).locator('../..');
async function switchOwner(page:Page,family:string,user='user-A',version='initial'){await page.evaluate(({family,user,version})=>{const p=(window as any).__desk;p.familyId=family;p.userId=user;p.version=version;p.hold=false;p.render();},{family,user,version});}
async function release(page:Page){await page.evaluate(()=>{const p=(window as any).__desk;p.hold=false;p.held.splice(0).forEach((resolve:any)=>resolve());});}
// A round-trip through the render/event loop lets any stale completion commit.
async function flush(page:Page){await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
test('healthy complete unique child can be proposed',async({page})=>{await fixture(page);await expect(card(page).getByText('Ava',{exact:true})).toBeVisible();await expect(card(page).getByRole('button',{name:'Propose',exact:true})).toBeEnabled();});
for(const scenario of ['members','classes','teams'] as const)test('hidden competing '+scenario+' prevent a false child badge',async({page})=>{await fixture(page,scenario);await expect(card(page)).toBeVisible();await expect(card(page).getByText('Ava',{exact:true})).toHaveCount(0);await expect(card(page).getByRole('button',{name:'Propose',exact:true})).toBeEnabled();});
for(const scenario of ['missing-count','later-error','ceiling'] as const)test(scenario+' fails closed without a partial desk',async({page})=>{await fixture(page,scenario);await expect(page.getByText('Could not load the front desk.',{exact:true})).toBeVisible();await expect(card(page)).toHaveCount(0);await expect(page.getByText('Nothing waiting from school or the clubs',{exact:true})).toHaveCount(0);});
test('late family read cannot replace the current family',async({page})=>{await fixture(page,'healthy',true);await expect.poll(()=>page.evaluate(()=>(window as any).__desk.held.length)).toBe(1);await switchOwner(page,'family-B');await expect(card(page,'family-B')).toBeVisible();await release(page);await flush(page);await expect(card(page,'family-B')).toBeVisible();await expect(card(page)).toHaveCount(0);});
test('returning to a family does not revive its earlier request',async({page})=>{await fixture(page,'healthy',true);await expect.poll(()=>page.evaluate(()=>(window as any).__desk.held.length)).toBe(1);await switchOwner(page,'family-B');await expect(card(page,'family-B')).toBeVisible();await switchOwner(page,'family-A','user-A','fresh');await expect(card(page,'family-A','fresh')).toBeVisible();await release(page);await flush(page);await expect(card(page,'family-A','fresh')).toBeVisible();await expect(card(page)).toHaveCount(0);});
test('a same-family user switch owns a fresh read',async({page})=>{await fixture(page);await expect(card(page)).toBeVisible();await switchOwner(page,'family-A','user-B','new user');await expect(card(page,'family-A','new user')).toBeVisible();await expect(card(page)).toHaveCount(0);});
test('late proposal completion cannot toast or clear another family proposal',async({page})=>{await fixture(page);await card(page).getByRole('button',{name:'Propose',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__desk.proposals.length)).toBe(1);await switchOwner(page,'family-B');await card(page,'family-B').getByRole('button',{name:'Propose',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__desk.proposals.length)).toBe(2);const before=await page.evaluate(()=>(window as any).__desk.requests.length);await page.evaluate(()=>(window as any).__desk.proposals[0].resolve({ok:true,outcome:'pending_approval',approvalId:'synthetic-approval'}));await flush(page);await expect(card(page,'family-B').getByRole('button',{name:'Proposing…',exact:true})).toBeDisabled();expect(await page.evaluate(()=>(window as any).__desk.toasts)).toEqual([]);expect(await page.evaluate(()=>(window as any).__desk.requests.length)).toBe(before);});

test('an actually empty complete desk can say nothing is waiting',async({page})=>{await fixture(page,'empty');await expect(page.getByText('Nothing waiting from school or the clubs',{exact:true})).toBeVisible();await expect(page.getByText('Could not load the front desk.',{exact:true})).toHaveCount(0);});
test('the recent-message prefix remains bounded and pages through a lower server cap',async({page})=>{await fixture(page,'queue');await expect(page.getByText('School queue item 00',{exact:true})).toBeVisible();await expect(page.locator('p').filter({hasText:/^School queue item /})).toHaveCount(6);const reads=await page.evaluate(()=>(window as any).__desk.requests.filter((r:any)=>r.table==='family_inbox_messages'));expect(reads.map((r:any)=>r.offset)).toEqual(Array.from({length:20},(_,i)=>i*2));expect(reads.every((r:any)=>r.counted&&r.family==='family-A')).toBe(true);expect(reads.at(-1).limit).toBe(2);expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);});
test('a current proposal success notifies and rereads while retaining approval wording',async({page})=>{await fixture(page);await card(page).getByRole('button',{name:'Propose',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__desk.proposals.length)).toBe(1);await page.evaluate(()=>(window as any).__desk.proposals[0].resolve({ok:true,outcome:'pending_approval',approvalId:'synthetic-approval'}));await expect(card(page).getByRole('button',{name:'Propose',exact:true})).toBeEnabled();await expect.poll(()=>page.evaluate(()=>(window as any).__desk.requests.filter((r:any)=>r.table==='family_inbox_messages').length)).toBe(2);expect(await page.evaluate(()=>(window as any).__desk.toasts)).toEqual([JSON.parse(fs.readFileSync(path.join(sourceRoot,'lib/i18n/messages/en-US.json'),'utf8'))['schoolDesk.sentForApproval']]);});
test('changing family hides the old queue while the new read is still pending',async({page})=>{await fixture(page);await expect(card(page)).toBeVisible();await page.evaluate(()=>{const p=(window as any).__desk;p.hold=true;p.familyId='family-B';p.render();});await expect.poll(()=>page.evaluate(()=>(window as any).__desk.held.length)).toBe(1);await expect(card(page)).toHaveCount(0);await expect(page.getByText('Nothing waiting from school or the clubs',{exact:true})).toHaveCount(0);await release(page);await expect(card(page,'family-B')).toBeVisible();});
