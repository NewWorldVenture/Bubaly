import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {test,expect,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
const root=process.env.BUBALY_FINANCES_UI_SOURCE_ROOT||process.cwd();
const origin='https://finances-dialog-visit-fixture.invalid';
const {react,reactDom}=reactBrowserScripts('development');
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const files=['components/modules/finances-module.tsx','components/ui/modal.tsx','components/ui/input.tsx','components/ui/button.tsx','components/ui/states.tsx','components/ui/states-client.tsx','components/app/page-header.tsx','lib/a11y/use-dialog-behavior.ts','lib/hooks/use-dismiss-on-escape.ts','lib/supabase/errors.ts','lib/ui/a11y.ts'];
const definitions=Object.fromEntries(files.map(file=>[`@/${file.replace(/\.tsx?$/,'')}`,ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText]));
const messages=JSON.parse(fs.readFileSync(path.join(root,'lib/i18n/messages/en-US.json'),'utf8'));
const familyId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
type Kind='income'|'expense'|'transfer'|'account';
async function fixture(page:Page,held=false,strict=false){
 const transactionCalls:any[]=[];const accountCalls:any[]=[];const pending:(()=>void)[]=[];
 const runtimeErrors:string[]=[];const consoleMessages:string[]=[];
 page.on('pageerror',error=>runtimeErrors.push(error.message));
 page.on('requestfailed',request=>runtimeErrors.push('requestfailed '+request.url()));
 page.on('console',message=>{if(['warning','error'].includes(message.type()))consoleMessages.push(message.type()+': '+message.text())});
 await page.route('**/*',async route=>{
  if(new URL(route.request().url()).origin!==origin)throw Error('Unexpected browser destination '+route.request().url());
  await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});
 });
 await page.exposeFunction('__financeTransaction',async(input:any)=>{
  if(!['income','expense','transfer'].includes(input.type)||input.amount!==0.01)throw Error('Only a synthetic one-cent UI transaction receipt is allowed');
  transactionCalls.push({...input});if(held)await new Promise<void>(resolve=>pending.push(resolve));
  return{ok:true,id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd'};
 });
 await page.exposeFunction('__financeSDK',async(url:string,method:string,body:any)=>{
  const parsed=new URL(url);
  if(parsed.origin!==origin||parsed.pathname!=='/rest/v1/financial_accounts'||method!=='POST')throw Error('Unexpected SDK operation '+method+' '+url);
  if(body.family_id!==familyId||body.created_by!==userId||body.balance!==0||body.currency!=='USD')throw Error('Only synthetic zero-balance manual account UI insert is allowed');
  accountCalls.push({...body});if(held)await new Promise<void>(resolve=>pending.push(resolve));
  return{status:201,body:null};
 });
 await page.goto(origin);await page.addScriptTag({content:react});await page.addScriptTag({content:reactDom});await page.addScriptTag({content:sdk});
 await page.addScriptTag({content:`(()=>{
  const React=window.React,defs=${JSON.stringify(definitions)},messages=${JSON.stringify(messages)},cache={};
  const tr=(key,args)=>Object.entries(args||{}).reduce((v,[k,r])=>v.replaceAll('{'+k+'}',String(r)),messages[key]||key);
  const Empty=()=>null,icons=new Proxy({},{get:()=>props=>React.createElement('svg',{'aria-hidden':true,className:props.className})});
  const denied=()=>{throw Error('Backend/provider/Auth/SQL/financial execution outside synthetic dialog fixture')};
  window.__financesRefreshes={};window.__financeSettled=0;window.__financeToasts=[];
  const sb=window.supabase.createClient(${JSON.stringify(origin)},'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,init)=>{
   const method=init.method||'GET';
   try{const reply=await window.__financeSDK(String(url),method,init.body?JSON.parse(init.body):null);return new Response(reply.body===null?'':JSON.stringify(reply.body),{status:reply.status,headers:{'content-type':'application/json'}})}
   finally{window.__financeSettled++}
  }}});
  const clock={todayKey:()=> '2026-10-25',calendarToday:()=>new Date(2026,9,25)};
  const externals={react:React,'react-dom':window.ReactDOM,'lucide-react':icons,
   'next/link':{__esModule:true,default:({href,children,...props})=>React.createElement('a',{href,...props},children)},
   '@/components/i18n/locale-provider':{useTranslations:()=>tr,useLocale:()=>({code:'en-US'})},
   '@/components/i18n/use-format':{useFamilyClock:()=>clock,useFormat:()=>({fmtDate:(value,pattern)=>String(value)})},
   '@/lib/utils/cn':{cn:(...v)=>v.filter(Boolean).join(' ')},
   '@/components/app/app-context':{useApp:()=>({familyId:${JSON.stringify(familyId)},userId:${JSON.stringify(userId)},family:{timezone:'UTC'},members:[],selfMember:null})},
   '@/components/ui/toast':{useToast:()=>({success:value=>window.__financeToasts.push(['success',value]),error:value=>window.__financeToasts.push(['error',value])})},
   '@/lib/supabase/client':{createClient:()=>sb},
   // Ready synthetic query snapshots only; actual refresh ownership and network readback are outside this fixture.
   '@/lib/hooks/use-realtime-query':{useRealtimeQuery:opts=>{const [rows,setRows]=React.useState([]);const label=opts.table==='transactions'?(opts.deps.length===1?'transactions:list':'transactions:month'):opts.table;const refresh=async()=>{window.__financesRefreshes[label]=(window.__financesRefreshes[label]||0)+1;setRows([])};return{data:rows,loading:false,error:null,stale:false,refresh}}},
   '@/app/(app)/dashboard/billing/actions':{createTransactionAction:async input=>{try{return await window.__financeTransaction(input)}finally{window.__financeSettled++}}},
   '@/lib/auth/step-up-client':{reportRefusal:denied},
   '@/components/ai/ai-insight':{AiInsight:Empty},'@/components/ui/avatar':{Avatar:Empty},
   '@/lib/finance/bills':{BILL_READ_CONTRACT:'synthetic-ready-only',readCompleteBills:denied},
   '@/lib/finance/category-label':{categoryLabel:(_tr,category)=>category},
   '@/lib/finance/budget-periods':{periodWindow:()=>({from:'2026-10-01',to:'2026-10-31'}),budgetByCategory:()=>new Map(),monthlyBudgetShare:()=>0},
   '@/lib/supabase/read-all':{readAllByIdAsQuery:denied},'@/lib/schedule/zoned':{todayInZone:()=> '2026-10-25'},
  };
  function load(name){if(externals[name])return externals[name];if(cache[name])return cache[name].exports;if(!defs[name])throw new Error('Unexpected finances fixture module '+name);const module={exports:{}};cache[name]=module;const localRequire=child=>load(child.startsWith('.')?name.slice(0,name.lastIndexOf('/')+1)+child.slice(2):child);new Function('module','exports','require','React',defs[name])(module,module.exports,localRequire,React);return module.exports;}
  const Module=load('@/components/modules/finances-module').FinancesModule;
  window.__financesRoot=window.ReactDOM.createRoot(document.getElementById('root'));window.__financesRoot.render(${strict?'React.createElement(React.StrictMode,null,React.createElement(Module))':'React.createElement(Module)'});
 })();`});
 try{await expect(page.getByRole('button',{name:'Add Transaction',exact:true}).first()).toBeVisible()}catch(error){console.log(JSON.stringify({runtimeErrors,consoleMessages}));throw error}
 return{transactionCalls,accountCalls,runtimeErrors,consoleMessages,release:()=>pending.shift()?.()};
}
async function openDraft(page:Page,kind:Kind,name:string){
 await page.getByRole('button',{name:kind==='account'?'Link Account':'Add Transaction',exact:true}).first().click();
 const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();
 if(kind==='account')await dialog.getByRole('textbox',{name:'Account name',exact:true}).fill(name);
 else{await dialog.getByRole('textbox',{name:'Description',exact:true}).fill(name);await dialog.getByRole('spinbutton',{name:'Amount',exact:true}).fill('0.01');await dialog.getByRole('combobox',{name:'Type',exact:true}).selectOption(kind)}
}
function save(page:Page,kind:Kind){return page.getByRole('dialog').getByRole('button',{name:kind==='account'?'Link Account':'Add Transaction',exact:true})}
async function settled(page:Page,count=1){await expect.poll(()=>page.evaluate(()=>(window as any).__financeSettled)).toBe(count);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))}
async function assertOwnRefresh(page:Page,kind:Kind,count=1){expect(await page.evaluate(()=>(window as any).__financesRefreshes)).toEqual(kind==='account'?{financial_accounts:count}:{'transactions:list':count,'transactions:month':count})}
function assertOnePayload(proof:any,kind:Kind,name:string){
 if(kind==='account'){expect(proof.transactionCalls).toEqual([]);expect(proof.accountCalls).toEqual([{family_id:familyId,created_by:userId,name,type:'checking',institution:null,last_four:null,balance:0,currency:'USD'}])}
 else{expect(proof.accountCalls).toEqual([]);expect(proof.transactionCalls).toEqual([{name,amount:0.01,type:kind,category:null,date:'2026-10-25',accountId:null,memberId:null}])}
}
function diagnostics(proof:any){console.log(JSON.stringify({capturedConsoleMessages:proof.consoleMessages,runtimeErrors:proof.runtimeErrors}));expect(proof.runtimeErrors).toEqual([]);expect(proof.consoleMessages).toEqual([])}
for(const kind of ['income','expense','transfer','account'] as const){
 test(kind+' healthy successful receipt closes its own visit and refreshes each affected query once',async({page})=>{
  const proof=await fixture(page);await openDraft(page,kind,'Healthy synthetic '+kind);await save(page,kind).click();await settled(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);assertOnePayload(proof,kind,'Healthy synthetic '+kind);await assertOwnRefresh(page,kind);
  expect(await page.evaluate(()=>(window as any).__financeToasts)).toEqual([['success',messages[kind==='account'?'financesModule.accountLinked':'financesModule.transactionAdded']]]);diagnostics(proof);
 });
 test(kind+' unsent cancel and reopen preserves successor draft without a write',async({page})=>{
  const proof=await fixture(page);await openDraft(page,kind,'Unsent earlier '+kind);await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await openDraft(page,kind,'Unsent successor '+kind);await expect(page.getByRole('dialog').getByRole('textbox',{name:kind==='account'?'Account name':'Description',exact:true})).toHaveValue('Unsent successor '+kind);
  expect(proof.transactionCalls).toEqual([]);expect(proof.accountCalls).toEqual([]);expect(await page.evaluate(()=>(window as any).__financesRefreshes)).toEqual({});expect(await page.evaluate(()=>(window as any).__financeToasts)).toEqual([]);diagnostics(proof);
 });
 test(kind+' retired ordinary successful receipt preserves the reopened successor draft',async({page})=>{
  const proof=await fixture(page,true);await openDraft(page,kind,'Requested earlier '+kind);const earlierSave=save(page,kind);await earlierSave.click();
  await expect.poll(()=>proof.transactionCalls.length+proof.accountCalls.length).toBe(1);await expect(earlierSave).toBeDisabled();assertOnePayload(proof,kind,'Requested earlier '+kind);
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await openDraft(page,kind,'Owned successor '+kind);await expect(page.getByRole('dialog').getByRole('textbox',{name:kind==='account'?'Account name':'Description',exact:true})).toHaveValue('Owned successor '+kind);
  proof.release();await settled(page);assertOnePayload(proof,kind,'Requested earlier '+kind);await assertOwnRefresh(page,kind);
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog').getByRole('textbox',{name:kind==='account'?'Account name':'Description',exact:true})).toHaveValue('Owned successor '+kind);await expect(save(page,kind)).toBeEnabled();
  expect(await page.evaluate(()=>(window as any).__financeToasts)).toEqual([]);diagnostics(proof);
 });
}

function assertTwoPayloads(proof:any,kind:'income'|'account',names:string[]){
 if(kind==='account'){expect(proof.transactionCalls).toEqual([]);expect(proof.accountCalls).toEqual(names.map(name=>({family_id:familyId,created_by:userId,name,type:'checking',institution:null,last_four:null,balance:0,currency:'USD'})))}
 else{expect(proof.accountCalls).toEqual([]);expect(proof.transactionCalls).toEqual(names.map(name=>({name,amount:0.01,type:'income',category:null,date:'2026-10-25',accountId:null,memberId:null})))}
}
for(const kind of ['income','account'] as const){
 test(kind+' StrictMode own successful receipt closes and refreshes each query once',async({page})=>{
  const proof=await fixture(page,false,true);await openDraft(page,kind,'Strict healthy '+kind);await save(page,kind).click();await settled(page);
  await expect(page.getByRole('dialog')).toHaveCount(0);assertOnePayload(proof,kind,'Strict healthy '+kind);await assertOwnRefresh(page,kind);
  expect(await page.evaluate(()=>(window as any).__financeToasts)).toEqual([['success',messages[kind==='account'?'financesModule.accountLinked':'financesModule.transactionAdded']]]);diagnostics(proof);
 });
 test(kind+' Escape retires ordinary successful receipt without closing reopened draft',async({page})=>{
  const proof=await fixture(page,true);await openDraft(page,kind,'Escape earlier '+kind);await save(page,kind).click();await expect.poll(()=>proof.transactionCalls.length+proof.accountCalls.length).toBe(1);
  await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);await openDraft(page,kind,'Escape successor '+kind);
  proof.release();await settled(page);assertOnePayload(proof,kind,'Escape earlier '+kind);await assertOwnRefresh(page,kind);
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog').getByRole('textbox',{name:kind==='account'?'Account name':'Description',exact:true})).toHaveValue('Escape successor '+kind);await expect(save(page,kind)).toBeEnabled();
  expect(await page.evaluate(()=>(window as any).__financeToasts)).toEqual([]);diagnostics(proof);
 });
 test(kind+' earlier successful receipt preserves newer pending save until its own success',async({page})=>{
  const proof=await fixture(page,true);const earlier='Earlier requested '+kind,newer='Newer requested '+kind;
  await openDraft(page,kind,earlier);await save(page,kind).click();await expect.poll(()=>proof.transactionCalls.length+proof.accountCalls.length).toBe(1);
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await openDraft(page,kind,newer);const newerSave=save(page,kind);await newerSave.click();await expect.poll(()=>proof.transactionCalls.length+proof.accountCalls.length).toBe(2);await expect(newerSave).toBeDisabled();assertTwoPayloads(proof,kind,[earlier,newer]);
  proof.release();await settled(page);assertTwoPayloads(proof,kind,[earlier,newer]);await assertOwnRefresh(page,kind);
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('dialog').getByRole('textbox',{name:kind==='account'?'Account name':'Description',exact:true})).toHaveValue(newer);await expect(newerSave).toBeDisabled();expect(await page.evaluate(()=>(window as any).__financeToasts)).toEqual([]);
  // The earlier completion must not re-enable or resubmit the successor's already-owned request.
  await newerSave.evaluate(button=>(button as HTMLButtonElement).click());assertTwoPayloads(proof,kind,[earlier,newer]);
  proof.release();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);assertTwoPayloads(proof,kind,[earlier,newer]);await assertOwnRefresh(page,kind,2);
  expect(await page.evaluate(()=>(window as any).__financeToasts)).toEqual([['success',messages[kind==='account'?'financesModule.accountLinked':'financesModule.transactionAdded']]]);diagnostics(proof);
 });
}
