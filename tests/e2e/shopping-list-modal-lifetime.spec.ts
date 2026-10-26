import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {test,expect,type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';
const root=process.env.BUBALY_SHOPPING_UI_SOURCE_ROOT || process.cwd();
const origin='https://shopping-list-lifetime-fixture.invalid';
const {react,reactDom}=reactBrowserScripts('development');
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const files=['components/modules/shopping-module.tsx','components/ui/modal.tsx','components/ui/input.tsx','components/ui/button.tsx','components/ui/states.tsx','components/ui/states-client.tsx','components/app/page-header.tsx','components/ui/badge.tsx','lib/a11y/use-dialog-behavior.ts','lib/supabase/errors.ts','lib/ui/a11y.ts','lib/groceries/add-summary.ts','lib/grocery/retailers.ts','lib/i18n/grocery-category.ts'];
const definitions=Object.fromEntries(files.map(file=>['@/'+file.replace(/\.tsx?$/,''),ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText]));
const messages=JSON.parse(fs.readFileSync(path.join(root,'lib/i18n/messages/en-US.json'),'utf8'));
async function fixture(page:Page,initialMode='healthy',seedNames:string[]=[],strict=false,bought?:'healthy'|'held'|'partial'){
 let mode=initialMode;
 const familyId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 const userId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 const rows:any[]=seedNames.map((name,index)=>({id:'aaaaaaaa-aaaa-4aaa-8aaa-'+String(index+1).padStart(12,'0'),name,family_id:familyId,created_by:userId,list_icon:'🛒',sort_order:index,is_archived:false,archived_at:null,created_at:'2026-10-02T12:00:00Z'}));const requests:any[]=[];const pending:(()=>void)[]=[];
 // Bought is an opt-in synthetic normal-success boundary; all original list-name cases still deny every action.
 const tripCalls:any[]=[];const tripPending:(()=>void)[]=[];
 if(bought&&seedNames.length!==1)throw Error('Bought fixture requires exactly one synthetic list');
 const groceryItems:any[]=bought?[{id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',list_id:rows[0].id,name:'Synthetic milk',quantity:'1',category:'Dairy & Eggs',is_checked:true,created_at:'2026-10-02T12:00:00Z'}]:[];
 if(bought==='partial')groceryItems.push({...groceryItems[0],id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',name:'Synthetic bread',category:'Pantry'});
 const runtimeErrors:string[]=[];const consoleMessages:string[]=[];
 page.on('pageerror',error=>runtimeErrors.push(error.message));
 page.on('requestfailed',request=>runtimeErrors.push('requestfailed '+request.url()));
 page.on('console',message=>{if(['warning','error'].includes(message.type()))consoleMessages.push(message.type()+': '+message.text())});
 await page.route('**/*',async route=>{
  if(new URL(route.request().url()).origin!==origin)throw Error('Unexpected browser destination '+route.request().url());
  await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});
 });
 await page.exposeFunction('__shoppingFetch',async(url:string,method:string,body:any)=>{
  const parsed=new URL(url);if(parsed.origin!==origin)throw Error('Unexpected SDK destination');
  requests.push({url,method,body});
  const table=parsed.pathname.split('/').pop();
  if(method==='GET'&&table==='grocery_lists')return{status:200,body:rows};
  if(method==='GET'&&table==='grocery_items')return{status:200,body:groceryItems.filter(item=>parsed.searchParams.get('list_id')==='eq.'+item.list_id)};
  if(['POST','PATCH'].includes(method)&&table==='grocery_lists'){
   const outcome=mode;if(outcome.startsWith('held'))await new Promise<void>(resolve=>pending.push(resolve));
   if(outcome==='refusal'||outcome==='held-refusal')return{status:400,body:{code:'SYNTHETIC_REFUSAL',message:'Synthetic list save refused'}};
   if(outcome==='throw'||outcome==='held-throw')throw Error('Synthetic transport lost');
   if(outcome==='zero'||outcome==='held-zero')return{status:200,body:[]};
   if(method==='PATCH'){
    const id=parsed.searchParams.get('id')?.replace(/^eq\./,'');
    const row=rows.find(row=>row.id===id);if(!row)throw Error('Unknown synthetic list update');
    Object.assign(row,body);return{status:200,body:[{id}]};
   }
   const id='aaaaaaaa-aaaa-4aaa-8aaa-'+String(rows.length+1).padStart(12,'0');
   rows.push({...body,id,sort_order:0,is_archived:false,archived_at:null,created_at:'2026-10-02T12:00:00Z',list_icon:body.list_icon||'🛒'});
   return{status:201,body:{id}};
  }
  throw Error('Unexpected SDK operation '+method+' '+table);
 });
 if(bought)await page.exposeFunction('__shoppingTrip',async(input:any)=>{
  if(input.listId!==rows[0].id||input.amount!==null)throw Error('Only the synthetic list and blank amount are permitted');
  tripCalls.push({...input});
  if(bought==='held')await new Promise<void>(resolve=>tripPending.push(resolve));
  if(bought==='partial'&&tripCalls.length===1){
   const milk=groceryItems.findIndex(item=>item.name==='Synthetic milk');
   if(milk<0)throw Error('Synthetic milk must remain before partial receipt');
   groceryItems.splice(milk,1);
   return{ok:true,pantryUpdated:['Synthetic milk'],pantryFailed:[{name:'Synthetic bread',error:'synthetic line refusal'}],clearFailed:[],unitMismatch:[],cleared:1,purchaseRecorded:false};
  }
  const names=groceryItems.map(item=>item.name);groceryItems.splice(0,groceryItems.length);
  return{ok:true,pantryUpdated:names,pantryFailed:[],clearFailed:[],unitMismatch:[],cleared:names.length,purchaseRecorded:false};
 });
 await page.goto(origin);
 await page.addScriptTag({content:react});await page.addScriptTag({content:reactDom});await page.addScriptTag({content:sdk});
 await page.addScriptTag({content:`(()=>{
  const React=window.React,defs=${JSON.stringify(definitions)},messages=${JSON.stringify(messages)},cache={};
  const tr=(key,args)=>Object.entries(args||{}).reduce((v,[k,r])=>v.replaceAll('{'+k+'}',String(r)),messages[key]||key);
  const Empty=()=>null,icons=new Proxy({},{get:()=>props=>React.createElement('svg',{'aria-hidden':true,className:props.className})});
  const denied=()=>{throw Error('Action/provider/financial flow outside list-name fixture')};
  const sb=window.supabase.createClient(${JSON.stringify(origin)},'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,init)=>{
   const method=init.method||'GET';
   try{const reply=await window.__shoppingFetch(String(url),method,init.body?JSON.parse(init.body):null);return new Response(JSON.stringify(reply.body),{status:reply.status,headers:{'content-type':'application/json'}})}
   finally{if(['POST','PATCH'].includes(method))window.__sdkSettled++}
  }}});
  const externals={react:React,'react-dom':window.ReactDOM,'lucide-react':icons,
   '@/components/i18n/locale-provider':{useTranslations:()=>tr,usePlural:()=>((key,count)=>tr(key+'.other',{count}))},
   '@/lib/utils/cn':{cn:(...v)=>v.filter(Boolean).join(' ')},
   '@/components/app/app-context':{useApp:()=>({familyId:${JSON.stringify(familyId)},userId:${JSON.stringify(userId)},members:[]})},
   '@/components/ui/toast':{useToast:()=>({success:value=>window.__toasts.push(['success',value]),error:value=>window.__toasts.push(['error',value])})},
   '@/lib/supabase/client':{createClient:()=>sb},
   '@/lib/hooks/use-realtime-query':{useRealtimeQuery:opts=>{const [state,set]=React.useState({data:[],loading:true,error:null});const refresh=async()=>{const result=await opts.fetcher(sb);set({data:result.data||[],loading:false,error:result.error})};React.useEffect(()=>{void refresh()},opts.deps||[opts.table,opts.familyId]);return {...state,refresh}}},
   '@/lib/hooks/use-action':{useAction:()=>({run:async(key,fn)=>fn(),isPending:()=>false})},
   '@/app/(app)/dashboard/grocery/actions':{addGroceryItemsAction:denied,clearCheckedGroceriesAction:denied,recordShoppingTripAction:${bought ? 'async input=>{try{return await window.__shoppingTrip(input)}finally{window.__tripSettled++}}' : 'denied'},removeGroceryItemAction:denied,setGroceryItemCheckedAction:denied},
   '@/components/ai/ai-insight':{AiInsight:Empty},
  };
  function load(name){if(externals[name])return externals[name];if(cache[name])return cache[name].exports;if(!defs[name])throw Error('Undeclared dependency '+name);const module={exports:{}};cache[name]=module;const localRequire=child=>load(child.startsWith('.')?name.slice(0,name.lastIndexOf('/')+1)+child.slice(2):child);new Function('module','exports','require','React',defs[name])(module,module.exports,localRequire,React);return module.exports;}
  window.__toasts=[];window.__sdkSettled=0;window.__tripSettled=0;
  const Module=load('@/components/modules/shopping-module').ShoppingModule;
  window.__shoppingRoot=window.ReactDOM.createRoot(document.getElementById('root'));
  window.__shoppingRoot.render(${strict ? 'React.createElement(React.StrictMode,null,React.createElement(Module))' : 'React.createElement(Module)'});
 })();`});
 try{await expect(page.getByRole('button',{name:'New list',exact:true})).toBeVisible()}catch(error){console.log(JSON.stringify({runtimeErrors,consoleMessages}));throw error}
 return{rows,requests,runtimeErrors,consoleMessages,tripCalls,groceryItems,releaseTrip:()=>tripPending.shift()?.(),writes:()=>requests.filter(r=>r.method==='POST'),release:()=>pending.shift()?.(),succeed:()=>{mode='healthy'},setMode:(next:string)=>{mode=next},mutations:()=>requests.filter(r=>['POST','PATCH'].includes(r.method))};
}
async function open(page:Page,name:string){
 await page.getByRole('button',{name:'New list',exact:true}).click();
 await page.getByRole('textbox',{name:'List name',exact:true}).fill(name);
}
async function settled(page:Page,count=1){
 await expect.poll(()=>page.evaluate(()=> (window as any).__sdkSettled)).toBe(count);
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}
function diagnostics(proof:any){console.log(JSON.stringify({capturedConsoleMessages:proof.consoleMessages,runtimeErrors:proof.runtimeErrors}));expect(proof.runtimeErrors).toEqual([])}
test('old cancelled list creation preserves the reopened list draft after its requested commit',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Earlier synthetic list');
 await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();await expect.poll(()=>proof.writes().length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await open(page,'Later synthetic list');proof.release();await settled(page);
 expect(proof.rows).toHaveLength(1);expect(proof.rows[0].name).toBe('Earlier synthetic list');expect(proof.writes()).toHaveLength(1);
 diagnostics(proof);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Later synthetic list');
});
test('healthy create persists exact name/icon/user/family through actual SDK and closes',async({page})=>{
 const proof=await fixture(page);await open(page,'Synthetic saved list');await page.getByRole('button',{name:'🏠',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();await settled(page);await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(proof.writes()).toHaveLength(1);expect(proof.writes()[0].body).toMatchObject({name:'Synthetic saved list',list_icon:'🏠',family_id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',created_by:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});
 expect(new URL(proof.writes()[0].url).searchParams.get('select')).toBe('id');await expect(page.getByText('Synthetic saved list',{exact:true}).first()).toBeVisible();diagnostics(proof);
});
test('unsent cancelled list draft performs no write',async({page})=>{
 const proof=await fixture(page);await open(page,'Unsent synthetic list');await page.getByRole('button',{name:'Cancel',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.writes()).toEqual([]);expect(proof.rows).toEqual([]);diagnostics(proof);
});
test('refused create retains entered name, re-enables save and allows explicit successful retry',async({page})=>{
 const proof=await fixture(page,'refusal');await open(page,'Refused synthetic list');await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();await settled(page);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Refused synthetic list');await expect(page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true})).toBeEnabled();
 expect(proof.rows).toEqual([]);expect(await page.evaluate(()=>(window as any).__toasts)).toHaveLength(1);
 proof.succeed();await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.writes()).toHaveLength(2);expect(proof.rows).toHaveLength(1);diagnostics(proof);
});
test('pending create gates duplicate submit clicks while cancellation still works',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Pending synthetic list');const save=page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true});
 await save.click();await expect.poll(()=>proof.writes().length).toBe(1);await expect(save).toBeDisabled();await save.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click()});
 expect(proof.writes()).toHaveLength(1);await page.getByRole('button',{name:'Cancel',exact:true}).click();proof.release();await settled(page);
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows).toHaveLength(1);diagnostics(proof);
});


async function edit(page:Page,name:string){
 await page.getByRole('button').filter({has:page.getByText(name,{exact:true})}).click();
 await page.getByRole('button',{name:'Edit list',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
}
async function saveEdit(page:Page,name:string){
 await page.getByRole('textbox',{name:'List name',exact:true}).fill(name);
 await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();
}
for(const outcome of ['refusal','throw']){
 test('closed create '+outcome+' does not report feedback into a new draft',async({page})=>{
  const proof=await fixture(page,'held-'+outcome);await open(page,'Earlier failed create');
  await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();await expect.poll(()=>proof.mutations().length).toBe(1);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Newer create draft');proof.release();await settled(page);
  await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Newer create draft');
  await expect(page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true})).toBeEnabled();
  expect(proof.rows).toEqual([]);expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);expect(proof.mutations()).toHaveLength(1);diagnostics(proof);
 });
}
test('unmounted module allows its requested create to commit without stale feedback',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Committed after unmount');await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();
 await expect.poll(()=>proof.mutations().length).toBe(1);await page.evaluate(()=>(window as any).__shoppingRoot.unmount());proof.release();await settled(page);
 expect(proof.rows).toHaveLength(1);expect(proof.rows[0].name).toBe('Committed after unmount');expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);diagnostics(proof);
});
for(const target of ['same','different'])for(const outcome of ['success','refusal','throw']){
 test('closed edit '+outcome+' preserves '+target+' list reopened draft and its explicit save',async({page})=>{
  const proof=await fixture(page,outcome==='success'?'held':'held-'+outcome,['First synthetic list','Second synthetic list']);
  await edit(page,'First synthetic list');await saveEdit(page,'Earlier edit request');await expect.poll(()=>proof.mutations().length).toBe(1);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await edit(page,target==='same'?'First synthetic list':'Second synthetic list');
  await page.getByRole('textbox',{name:'List name',exact:true}).fill('Later edit draft');proof.release();await settled(page);
  await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Later edit draft');await expect(page.getByRole('dialog').getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  expect(proof.rows[0].name).toBe(outcome==='success'?'Earlier edit request':'First synthetic list');expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);
  if(outcome==='success')await expect(page.getByRole('button').filter({has:page.getByText('Earlier edit request',{exact:true})})).toBeVisible();
  proof.succeed();await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(proof.mutations()).toHaveLength(2);expect(proof.rows[target==='same'?0:1].name).toBe('Later edit draft');
  const first=proof.mutations()[0];expect(first.method).toBe('PATCH');expect(new URL(first.url).searchParams.get('id')).toBe('eq.aaaaaaaa-aaaa-4aaa-8aaa-000000000001');expect(new URL(first.url).searchParams.get('select')).toBe('id');diagnostics(proof);
 });
}
test('healthy edit persists exact name/icon and refreshes rendered list',async({page})=>{
 const proof=await fixture(page,'healthy',['Initial synthetic list']);await edit(page,'Initial synthetic list');
 await page.getByRole('button',{name:'🍕',exact:true}).click();await saveEdit(page,'Renamed synthetic list');await settled(page);await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(proof.rows[0]).toMatchObject({name:'Renamed synthetic list',list_icon:'🍕'});expect(proof.mutations()).toHaveLength(1);await expect(page.getByRole('button').filter({has:page.getByText('Renamed synthetic list',{exact:true})})).toBeVisible();diagnostics(proof);
});
for(const outcome of ['zero','refusal','throw']){
 test('current edit '+outcome+' retains draft, feedback, enabled save and explicit retry',async({page})=>{
  const proof=await fixture(page,outcome,['Initial synthetic list']);await edit(page,'Initial synthetic list');await saveEdit(page,'Retained edit draft');await settled(page);
  await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Retained edit draft');await expect(page.getByRole('dialog').getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  expect(proof.rows[0].name).toBe('Initial synthetic list');expect(await page.evaluate(()=>(window as any).__toasts)).toHaveLength(1);
  proof.succeed();await page.getByRole('dialog').getByRole('button',{name:'Save',exact:true}).click();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows[0].name).toBe('Retained edit draft');expect(proof.mutations()).toHaveLength(2);diagnostics(proof);
 });
}
test('pending edit gates duplicate clicks and cancelled requested update still commits',async({page})=>{
 const proof=await fixture(page,'held',['Initial synthetic list']);await edit(page,'Initial synthetic list');await saveEdit(page,'Requested edit');await expect.poll(()=>proof.mutations().length).toBe(1);
 const save=page.getByRole('dialog').getByRole('button',{name:'Save',exact:true});await expect(save).toBeDisabled();await save.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click()});
 expect(proof.mutations()).toHaveLength(1);await page.getByRole('button',{name:'Cancel',exact:true}).click();proof.release();await settled(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows[0].name).toBe('Requested edit');await expect(page.getByRole('button').filter({has:page.getByText('Requested edit',{exact:true})})).toBeVisible();diagnostics(proof);
});
test('old create does not change selected list or close an edit draft',async({page})=>{
 const proof=await fixture(page,'held',['Existing synthetic list']);await open(page,'Earlier new list');await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();await expect.poll(()=>proof.mutations().length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await edit(page,'Existing synthetic list');await page.getByRole('textbox',{name:'List name',exact:true}).fill('Existing edited draft');proof.release();await settled(page);
 await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Existing edited draft');
 await expect(page.locator('h2').filter({hasText:'Existing synthetic list'})).toBeVisible();expect(proof.rows).toHaveLength(2);expect(proof.mutations()).toHaveLength(1);diagnostics(proof);
});
test('old edit does not close or replace a new list draft',async({page})=>{
 const proof=await fixture(page,'held',['Existing synthetic list']);await edit(page,'Existing synthetic list');await saveEdit(page,'Earlier renamed list');await expect.poll(()=>proof.mutations().length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Later new list draft');proof.release();await settled(page);
 await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Later new list draft');expect(proof.rows[0].name).toBe('Earlier renamed list');expect(proof.mutations()).toHaveLength(1);diagnostics(proof);
});
for(const kind of ['create','edit']){
 test('StrictMode '+kind+' keeps current completion and refresh functional',async({page})=>{
  const proof=await fixture(page,'healthy',kind==='edit'?['Initial strict list']:[],true);
  if(kind==='create'){await open(page,'Strict created list');await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click()}
  else{await edit(page,'Initial strict list');await saveEdit(page,'Strict edited list')}
  await settled(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.mutations()).toHaveLength(1);expect(proof.rows[0].name).toBe(kind==='create'?'Strict created list':'Strict edited list');diagnostics(proof);
 });
}
test('ordinary selector and sibling Edit support native keyboard without nested buttons or console failures',async({page})=>{
 await page.setViewportSize({width:390,height:844});const proof=await fixture(page,'healthy',['First keyboard list','Second keyboard list']);
 const second=page.getByRole('button').filter({has:page.getByText('Second keyboard list',{exact:true})});await second.focus();await page.keyboard.press('Enter');
 await expect(page.locator('h2').filter({hasText:'Second keyboard list'})).toBeVisible();
 const editButton=page.getByRole('button',{name:'Edit list',exact:true});await editButton.focus();await page.keyboard.press('Space');
 await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Second keyboard list');await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(await page.locator('button button').count()).toBe(0);expect(proof.mutations()).toEqual([]);expect(proof.consoleMessages).toEqual([]);diagnostics(proof);
});
test('earlier create completion preserves the newer pending save until its own confirmed commit',async({page})=>{
 const proof=await fixture(page,'held');await open(page,'Earlier requested create');await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click();await expect.poll(()=>proof.mutations().length).toBe(1);
 await page.getByRole('button',{name:'Cancel',exact:true}).click();await open(page,'Newer requested create');const save=page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true});await save.click();await expect.poll(()=>proof.mutations().length).toBe(2);
 proof.release();await settled(page);await expect(page.getByRole('textbox',{name:'List name',exact:true})).toHaveValue('Newer requested create');await expect(save).toBeDisabled();expect(proof.rows).toHaveLength(1);
 await save.evaluate(button=>(button as HTMLButtonElement).click());expect(proof.mutations()).toHaveLength(2);
 proof.release();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows.map(row=>row.name)).toEqual(['Earlier requested create','Newer requested create']);await expect(page.locator('h2').filter({hasText:'Newer requested create'})).toBeVisible();diagnostics(proof);
});
for(const kind of ['create','edit'])for(const outcome of ['refusal','throw']){
 test('unmounted '+kind+' '+outcome+' does not publish stale error feedback or retry',async({page})=>{
  const proof=await fixture(page,'held-'+outcome,kind==='edit'?['Initial unmount list']:[]);
  if(kind==='create'){await open(page,'Unsent after unmount');await page.getByRole('dialog').getByRole('button',{name:'Create List',exact:true}).click()}
  else{await edit(page,'Initial unmount list');await saveEdit(page,'Unsent edit after unmount')}
  await expect.poll(()=>proof.mutations().length).toBe(1);await page.evaluate(()=>(window as any).__shoppingRoot.unmount());proof.release();await settled(page);
  expect(proof.mutations()).toHaveLength(1);expect(proof.rows.map(row=>row.name)).toEqual(kind==='edit'?['Initial unmount list']:[]);expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);diagnostics(proof);
 });
}
test('unmounted edit commits its already requested name/icon without feedback',async({page})=>{
 const proof=await fixture(page,'held',['Initial unmount list']);await edit(page,'Initial unmount list');await page.getByRole('button',{name:'🏠',exact:true}).click();await saveEdit(page,'Committed unmounted edit');
 await expect.poll(()=>proof.mutations().length).toBe(1);await page.evaluate(()=>(window as any).__shoppingRoot.unmount());proof.release();await settled(page);expect(proof.rows[0]).toMatchObject({name:'Committed unmounted edit',list_icon:'🏠'});expect(proof.mutations()).toHaveLength(1);expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);diagnostics(proof);
});

// Ordinary successful ACK ownership only. No backend action, money, provider, SQL or transport-fault reproduction.
async function openBought(page:Page){
 await page.getByRole('button',{name:'Bought',exact:true}).click();
 await expect(page.getByRole('dialog')).toBeVisible();
}
async function tripSettled(page:Page,count=1){
 await expect.poll(()=>page.evaluate(()=>(window as any).__tripSettled)).toBe(count);
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}
test('healthy Bought success closes its own visit and refreshes the checked list once',async({page})=>{
 const proof=await fixture(page,'healthy',['Synthetic shop'],false,'healthy');await openBought(page);
 const readsBefore=proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length;
 await page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true}).click();await tripSettled(page);
 await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(proof.tripCalls).toEqual([{listId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',amount:null,merchant:null}]);
 expect(proof.groceryItems).toEqual([]);expect(proof.mutations()).toEqual([]);
 await expect.poll(()=>proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length).toBe(readsBefore+1);
 await expect(page.getByRole('button',{name:'Bought',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([['success','Added to your pantry: 1.']]);diagnostics(proof);
});
test('cancel and reopen an unsent Bought visit preserves the new merchant without actions',async({page})=>{
 const proof=await fixture(page,'healthy',['Synthetic shop'],false,'healthy');await openBought(page);
 await page.getByRole('textbox',{name:'Store',exact:true}).fill('Unsent earlier merchant');
 await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await openBought(page);await page.getByRole('textbox',{name:'Store',exact:true}).fill('Unsent successor merchant');
 await expect(page.getByRole('textbox',{name:'Store',exact:true})).toHaveValue('Unsent successor merchant');
 expect(proof.tripCalls).toEqual([]);expect(proof.groceryItems).toHaveLength(1);expect(proof.mutations()).toEqual([]);
 expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);diagnostics(proof);
});
test('retired successful Bought ACK preserves the reopened successor merchant draft',async({page})=>{
 const proof=await fixture(page,'healthy',['Synthetic shop'],false,'held');await openBought(page);
 const readsBefore=proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length;
 await page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true}).click();
 await expect.poll(()=>proof.tripCalls.length).toBe(1);
 await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await openBought(page);await page.getByRole('textbox',{name:'Store',exact:true}).fill('Owned successor merchant');
 proof.releaseTrip();await tripSettled(page);
 expect(proof.tripCalls).toEqual([{listId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',amount:null,merchant:null}]);
 expect(proof.groceryItems).toEqual([]);expect(proof.mutations()).toEqual([]);
 await expect.poll(()=>proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length).toBe(readsBefore+1);
 await expect(page.getByRole('dialog')).toBeVisible();
 await expect(page.getByRole('textbox',{name:'Store',exact:true})).toHaveValue('Owned successor merchant');
 await expect(page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);diagnostics(proof);
});

test('StrictMode healthy Bought success owns its visit and reads back once',async({page})=>{
 const proof=await fixture(page,'healthy',['Strict synthetic shop'],true,'healthy');await openBought(page);
 const readsBefore=proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length;
 await page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true}).click();await tripSettled(page);
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.tripCalls).toEqual([{listId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',amount:null,merchant:null}]);
 expect(proof.groceryItems).toEqual([]);expect(proof.mutations()).toEqual([]);
 await expect.poll(()=>proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length).toBe(readsBefore+1);
 expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([['success','Added to your pantry: 1.']]);diagnostics(proof);
});
test('Escape retires pending Bought success without closing the reopened successor merchant',async({page})=>{
 const proof=await fixture(page,'healthy',['Escape synthetic shop'],false,'held');await openBought(page);
 const readsBefore=proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length;
 await page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true}).click();await expect.poll(()=>proof.tripCalls.length).toBe(1);
 await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
 await openBought(page);await page.getByRole('textbox',{name:'Store',exact:true}).fill('Escape successor merchant');proof.releaseTrip();await tripSettled(page);
 expect(proof.tripCalls).toEqual([{listId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',amount:null,merchant:null}]);expect(proof.groceryItems).toEqual([]);expect(proof.mutations()).toEqual([]);
 await expect.poll(()=>proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length).toBe(readsBefore+1);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Store',exact:true})).toHaveValue('Escape successor merchant');
 await expect(page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([]);diagnostics(proof);
});
test('active partial Bought receipt retains merchant and retries only the remaining checked line',async({page})=>{
 const proof=await fixture(page,'healthy',['Partial synthetic shop'],false,'partial');await openBought(page);
 await expect(page.getByRole('dialog').getByText('Synthetic milk',{exact:true})).toBeVisible();await expect(page.getByRole('dialog').getByText('Synthetic bread',{exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'Store',exact:true}).fill('Partial synthetic market');
 const readsBefore=proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length;
 await page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true}).click();await tripSettled(page);
 await expect.poll(()=>proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length).toBe(readsBefore+1);
 await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Store',exact:true})).toHaveValue('Partial synthetic market');
 await expect(page.getByRole('dialog').getByText('Synthetic milk',{exact:true})).toHaveCount(0);await expect(page.getByRole('dialog').getByText('Synthetic bread',{exact:true})).toBeVisible();
 await expect(page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true})).toBeEnabled();
 expect(proof.groceryItems.map(item=>item.name)).toEqual(['Synthetic bread']);expect(proof.tripCalls).toEqual([{listId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',amount:null,merchant:'Partial synthetic market'}]);
 expect(await page.evaluate(()=>(window as any).__toasts)).toEqual([['error','Could not put these in the pantry: Synthetic bread. Tap again to retry just those — the rest is already put away.'],['success','Added to your pantry: 1.']]);
 await page.getByRole('dialog').getByRole('button',{name:'Put it in the pantry',exact:true}).click();await tripSettled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect.poll(()=>proof.requests.filter(r=>r.method==='GET'&&new URL(r.url).pathname.endsWith('/grocery_items')).length).toBe(readsBefore+2);
 expect(proof.groceryItems).toEqual([]);expect(proof.tripCalls).toEqual([{listId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',amount:null,merchant:'Partial synthetic market'},{listId:'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',amount:null,merchant:'Partial synthetic market'}]);
 expect(proof.mutations()).toEqual([]);expect(await page.evaluate(()=>(window as any).__toasts)).toHaveLength(3);diagnostics(proof);
});
