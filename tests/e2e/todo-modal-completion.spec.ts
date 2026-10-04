import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {test, expect, type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';

// Actual TodosModule, modal controls, dialog behavior and SDK reads execute.
// Session/family context, action transport, realtime subscription, icons and
// unrelated widgets are inert seams. No live Auth/RLS or Next action claim.
const root=process.env.BUBALY_TODO_UI_SOURCE_ROOT ?? process.cwd();
const origin='https://todo-modal-completion-fixture.invalid';
const {react,reactDom}=reactBrowserScripts('development');
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const files=['components/modules/todos-module.tsx','components/ui/modal.tsx','components/ui/input.tsx','components/ui/button.tsx','components/ui/badge.tsx','components/ui/states.tsx','components/ui/states-client.tsx','components/app/page-header.tsx','lib/a11y/use-dialog-behavior.ts','lib/supabase/errors.ts','lib/utils/submission-id.ts'];
const definitions=Object.fromEntries(files.map(file=>['@/'+file.replace(/\.tsx?$/,''),ts.transpileModule(fs.readFileSync(file==='components/modules/todos-module.tsx' && process.env.BUBALY_TODO_MODULE_SOURCE ? process.env.BUBALY_TODO_MODULE_SOURCE:path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText]));
const messages=JSON.parse(fs.readFileSync(path.join(root,'lib/i18n/messages/en-US.json'),'utf8'));
declare global {interface Window {
  __toasts:[string,string][];
  __todoSettled:number;
  __unmountTodo:()=>void;
}}

async function fixture(page:Page,mode='healthy',strict=false) {
  const familyId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const list={id:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',family_id:familyId,name:'Household',icon:'📋',color:'violet',is_shared:true,archived_at:null};
  const rows=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',family_id:familyId,list_id:list.id,title:'Synthetic task A',notes:null,priority:'medium',due_date:'2026-10-05',assigned_to_id:null,is_done:false},{id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',family_id:familyId,list_id:list.id,title:'Synthetic task B',notes:null,priority:'medium',due_date:'2026-10-05',assigned_to_id:null,is_done:false}];
  const calls:any[]=[];const pending:(()=>void)[]=[];
  const requests:{url:string,method:string,body:any}[]=[];
  const errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('console',message=>{if(['warning','error'].includes(message.type()))errors.push(message.type()+': '+message.text())});
  page.on('requestfailed',request=>errors.push('requestfailed '+request.url()));
  await page.route('**/*',async route=>{
    if(new URL(route.request().url()).origin!==origin)throw Error('Unexpected native browser request '+route.request().url());
    await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});
  });
  await page.exposeFunction('__reminderFetch',async(url:string,method:string,body:any)=>{
    const parsed=new URL(url);
    if(parsed.origin!==origin)throw Error('Unexpected synthetic SDK destination');
    requests.push({url,method,body});
    const table=parsed.pathname.split('/').pop();
    if(method==='GET'){
      if(table==='todo_lists')return{status:200,body:[list]};
      if(table==='todo_items')return mode==='read-error'?{status:403,body:{code:'42501',message:'Synthetic read refused'}}:{status:200,body:rows};
    }
    throw Error('Unexpected SDK operation '+method+' '+url);
  });
  await page.exposeFunction('__todoAction',async(id:string,fields:any)=>{
    calls.push({id,fields});if(mode.startsWith('held'))await new Promise<void>(resolve=>pending.push(resolve));
    if(mode==='held-error'||mode==='error')return{ok:false,error:'Synthetic save refused'};
    if(mode==='held-throw'||mode==='throw')throw Error('Synthetic transport lost');
    const target=rows.find(row=>row.id===id);if(!target)throw Error('Unexpected synthetic action id');
    Object.assign(target,{title:fields.title,notes:fields.notes,priority:fields.priority,due_date:fields.dueDate,assigned_to_id:fields.assigneeId});return{ok:true,data:target};
  });
  await page.goto(origin);
  await page.addScriptTag({content:react}); await page.addScriptTag({content:reactDom}); await page.addScriptTag({content:sdk});
  await page.addScriptTag({content:`(()=>{
    const React=window.React,defs=${JSON.stringify(definitions)},messages=${JSON.stringify(messages)},cache={};
    const tr=(key,args)=>Object.entries(args||{}).reduce((v,[k,r])=>v.replaceAll('{'+k+'}',String(r)),messages[key]||key);
    const Empty=()=>null,icons=new Proxy({},{get:()=>props=>React.createElement('svg',{'aria-hidden':true,className:props.className})});
    const sb=window.supabase.createClient(${JSON.stringify(origin)},'synthetic-not-a-secret',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:async(url,init)=>{const reply=await window.__reminderFetch(String(url),init.method||'GET',init.body?JSON.parse(init.body):null);return new Response(JSON.stringify(reply.body),{status:reply.status,headers:{'content-type':'application/json'}})}}});
    const externals={react:React,'react-dom':window.ReactDOM,'lucide-react':icons,
      '@/components/i18n/locale-provider':{useTranslations:()=>tr,usePlural:()=>((key,count)=>tr(key+'.other',{count}))},
      '@/components/i18n/use-format':{useFormat:()=>({fmtDate:value=>value,fmtRelative:()=> 'now'}),useFamilyClock:()=>({wallToday:()=>new Date('2026-10-02T00:00:00Z'),wallKey:date=>date.toISOString().slice(0,10),addDays:(date,count)=>new Date(date.getTime()+count*86400000)})},
      '@/lib/utils/cn':{cn:(...v)=>v.filter(Boolean).join(' ')},
      '@/components/app/app-context':{useApp:()=>({familyId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',userId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',members:[]})},
      '@/components/ui/toast':{useToast:()=>({success:value=>window.__toasts.push(['success',value]),error:value=>window.__toasts.push(['error',value])})},
      '@/lib/supabase/client':{createClient:()=>sb},
      '@/lib/hooks/use-realtime-query':{useRealtimeQuery:opts=>{const [state,set]=React.useState({data:[],loading:true,error:null}); const refresh=async()=>{const result=await opts.fetcher(sb);set({data:result.data||[],loading:false,error:result.error});};React.useEffect(()=>{void refresh()},[opts.table,opts.familyId]);return {...state,refresh}}},
      '@/lib/hooks/use-action':{useAction:()=>({run:async(key,fn)=>fn(),isPending:()=>false})},
      '@/lib/storage/family-media':{familyMediaPath:()=>{throw Error('Storage outside fixture scope')}},
      '@/components/ui/avatar':{Avatar:Empty},
      '@/app/(app)/dashboard/todos/actions':{updateTodoAction:async(id,fields)=>{try{return await window.__todoAction(id,fields)}finally{window.__todoSettled++}},createTodoAction:()=>{throw Error('Creation outside fixture scope')},deleteTodoAction:()=>{throw Error('Deletion outside fixture scope')},completeTodoAction:()=>{throw Error('Completion outside fixture scope')}},
      '@/components/ai/ai-insight':{AiInsight:Empty},
      'next/link':{default:({children,...props})=>React.createElement('a',props,children)},
    };
    function load(name){if(externals[name])return externals[name];if(cache[name])return cache[name].exports;if(!defs[name])throw Error('Undeclared dependency '+name);const module={exports:{}};cache[name]=module;const localRequire=child=>load(child.startsWith('.')?name.slice(0,name.lastIndexOf('/')+1)+child.slice(2):child);new Function('module','exports','require','React',defs[name])(module,module.exports,localRequire,React);return module.exports;}
    window.__toasts=[];window.__todoSettled=0;
    const Module=load('@/components/modules/todos-module').TodosModule;
    const app=window.ReactDOM.createRoot(document.getElementById('root'));app.render(${strict?'React.createElement(React.StrictMode,null,React.createElement(Module))':'React.createElement(Module)'});
    window.__unmountTodo=()=>app.unmount();
  })();`});
  if(mode==='read-error')await expect(page.getByText(messages['todosModule.couldNotLoadTasksRefresh'],{exact:true})).toBeVisible();
  else try {await expect(page.getByRole('button',{name:'Edit task',exact:true}).first()).toBeVisible();}catch(error){console.log(JSON.stringify({fixtureErrors:errors,requests}));throw error}
  return {requests,errors,rows,calls,release:()=>pending.shift()?.()};
}

async function settled(page:Page,count=1){
  await expect.poll(()=>page.evaluate(()=>window.__todoSettled)).toBe(count);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}
for(const mode of ['held','held-error','held-throw'])for(const same of [false,true])test('closed '+(same?'same-task':'different-task')+' save leaves current draft and its save usable: '+mode,async({page})=>{
  const proof=await fixture(page,mode,true);
  await page.getByRole('button',{name:'Edit task',exact:true}).first().click();
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('Confirmed A edit');
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button',{name:'Edit task',exact:true}).nth(same?0:1).click();
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('Current unsaved draft');
  proof.release();await settled(page);
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Current unsaved draft');
  await expect(page.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  expect(proof.rows[0].title).toBe(mode==='held'?'Confirmed A edit':'Synthetic task A');expect(proof.rows[1].title).toBe('Synthetic task B');
  expect(await page.evaluate(()=>window.__toasts)).toEqual([]);
  // A successful request from the closed editor must still refresh the list.
  if(mode==='held'){
    await expect(page.getByText('Confirmed A edit',{exact:true}).first()).toBeVisible();
    await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(2);proof.release();await settled(page,2);
    await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows[same?0:1].title).toBe('Current unsaved draft');
  }
  expect(proof.calls).toHaveLength(mode==='held'?2:1);expect(proof.errors).toEqual([]);
});

for(const strict of [false,true])test('ordinary save refresh/reopen persists date and edits; duplicate click gated; strict='+strict,async({page})=>{
  const proof=await fixture(page,'held',strict);await page.getByRole('button',{name:'Edit task',exact:true}).first().click();
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('Confirmed edited task');await page.getByLabel('Due date',{exact:true}).fill('2026-11-02');
  const save=page.getByRole('button',{name:'Save',exact:true});await save.click();await expect.poll(()=>proof.calls.length).toBe(1);await expect(save).toBeDisabled();
  proof.release();await expect(page.getByRole('dialog')).toHaveCount(0);await page.getByRole('button',{name:'Edit task',exact:true}).first().click();
  await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Confirmed edited task');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2026-11-02');
  expect(proof.calls).toHaveLength(1);expect(proof.errors).toEqual([]);
});

test('cancel without save does not mutate either task',async({page})=>{
  const proof=await fixture(page);await page.getByRole('button',{name:'Edit task',exact:true}).first().click();
  await page.getByRole('textbox',{name:'Title',exact:true}).fill('Discarded A draft');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  expect(proof.calls).toHaveLength(0);expect(proof.rows[0].title).toBe('Synthetic task A');expect(proof.errors).toEqual([]);
});

for(const close of ['Escape','Close dialog'])test('pending '+close+' never licenses an old completion to close another draft',async({page})=>{
  const proof=await fixture(page,'held');await page.getByRole('button',{name:'Edit task',exact:true}).first().click();await page.getByRole('textbox',{name:'Title',exact:true}).fill('Saved A');
  await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
  if(close==='Escape')await page.keyboard.press('Escape');else await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await page.getByRole('button',{name:'Edit task',exact:true}).nth(1).click();await page.getByRole('textbox',{name:'Title',exact:true}).fill('B kept');
  proof.release();await settled(page);await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('B kept');expect(proof.errors).toEqual([]);
});

for(const mode of ['error','throw'])test('current editor '+mode+' retains draft and allows retry',async({page})=>{
  const proof=await fixture(page,mode);await page.getByRole('button',{name:'Edit task',exact:true}).first().click();await page.getByRole('textbox',{name:'Title',exact:true}).fill('Retained draft');
  await page.getByRole('button',{name:'Save',exact:true}).click();await settled(page);await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('textbox',{name:'Title',exact:true})).toHaveValue('Retained draft');await expect(page.getByRole('button',{name:'Save',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>window.__toasts.map(([kind])=>kind))).toEqual(['error']);expect(proof.rows[0].title).toBe('Synthetic task A');expect(proof.errors).toEqual([]);
});

test('failed task read shows refusal without opening an editable empty state',async({page})=>{
  const proof=await fixture(page,'read-error');await expect(page.getByRole('button',{name:'Edit task',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Add Task',exact:true})).toHaveCount(0);expect(proof.calls).toHaveLength(0);expect(proof.errors).toEqual([]);
});

for(const mode of ['held','held-error'])test('unmounted module safely settles its already-requested save: '+mode,async({page})=>{
  const proof=await fixture(page,mode);await page.getByRole('button',{name:'Edit task',exact:true}).first().click();await page.getByRole('textbox',{name:'Title',exact:true}).fill('Saved before leaving');await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);
  await page.evaluate(()=>window.__unmountTodo());proof.release();await settled(page);expect(proof.rows[0].title).toBe(mode==='held'?'Saved before leaving':'Synthetic task A');expect(await page.evaluate(()=>window.__toasts)).toEqual([]);expect(proof.errors).toEqual([]);
});
