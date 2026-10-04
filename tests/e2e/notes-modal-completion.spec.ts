import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {test, expect, type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';

// Actual NotesModule, modal controls, dialog behavior and SDK reads execute.
// Session/family context, action transport, realtime subscription, icons and
// unrelated widgets are inert seams. No live Auth/RLS or Next action claim.
const root=process.env.BUBALY_NOTES_UI_SOURCE_ROOT ?? process.cwd();
const origin='https://notes-modal-completion-fixture.invalid';
const {react,reactDom}=reactBrowserScripts('development');
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const files=['components/modules/notes-module.tsx','components/ui/modal.tsx','components/ui/input.tsx','components/ui/button.tsx','components/ui/states.tsx','components/ui/states-client.tsx','components/app/page-header.tsx','lib/a11y/use-dialog-behavior.ts','lib/supabase/errors.ts','lib/ui/a11y.ts','lib/notes/ai.ts'];
const definitions=Object.fromEntries(files.map(file=>['@/'+file.replace(/\.tsx?$/,''),ts.transpileModule(fs.readFileSync(file==='components/modules/notes-module.tsx' && process.env.BUBALY_NOTES_MODULE_SOURCE ? process.env.BUBALY_NOTES_MODULE_SOURCE:path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText]));
const messages=JSON.parse(fs.readFileSync(path.join(root,'lib/i18n/messages/en-US.json'),'utf8'));
declare global {interface Window {
  __toasts:[string,string][];
  __noteSettled:number;
  __unmountNotes:()=>void;
}}

async function fixture(page:Page,mode='healthy',strict=false) {
  const familyId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const rows=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',family_id:familyId,title:'Synthetic note A',body:'Synthetic note content A',is_pinned:false,updated_at:'2026-10-02T12:00:00Z'},{id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',family_id:familyId,title:'Synthetic note B',body:'Synthetic note content B',is_pinned:false,updated_at:'2026-10-02T12:00:00Z'}];
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
      if(table==='notes')return{status:200,body:rows};
    }
    throw Error('Unexpected SDK operation '+method+' '+url);
  });
  await page.exposeFunction('__noteAction',async(id:string|null,fields:any)=>{
    const outcome=mode;calls.push({id,fields});if(outcome.startsWith('held'))await new Promise<void>(resolve=>pending.push(resolve));
    if(outcome==='held-error'||mode==='error')return{ok:false,error:'Synthetic save refused'};
    if(outcome==='held-throw'||mode==='throw')throw Error('Synthetic transport lost');
    if(outcome==='opaque-throw')throw Error('');
    let target=rows.find(row=>row.id===id);
    if(id===null){target={...rows[0],id:'ffffffff-ffff-4fff-8fff-'+String(rows.length+1).padStart(12,'0')};rows.push(target);}
    if(!target)throw Error('Unexpected synthetic action id');
    Object.assign(target,{title:fields.title,body:fields.body});
    if(outcome==='committed-throw')throw Error('Synthetic response lost after commit');
    return{ok:true,id:target.id};
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
      '@/components/ui/confirm':{useConfirm:()=>({askConfirm:async()=>{throw Error('Confirmation outside fixture scope')}})},
      '@/app/(app)/dashboard/notes/actions':{saveNoteAction:async(id,fields)=>{try{return await window.__noteAction(id,fields)}finally{window.__noteSettled++}},deleteNoteAction:()=>{throw Error('Deletion outside fixture scope')},duplicateNoteAction:()=>{throw Error('Copy outside fixture scope')},setNotePinnedAction:()=>{throw Error('Pin outside fixture scope')}},
      '@/components/ai/ai-insight':{AiInsight:Empty},
      'next/link':{default:({children,...props})=>React.createElement('a',props,children)},
    };
    function load(name){if(externals[name])return externals[name];if(cache[name])return cache[name].exports;if(!defs[name])throw Error('Undeclared dependency '+name);const module={exports:{}};cache[name]=module;const localRequire=child=>load(child.startsWith('.')?name.slice(0,name.lastIndexOf('/')+1)+child.slice(2):child);new Function('module','exports','require','React',defs[name])(module,module.exports,localRequire,React);return module.exports;}
    window.__toasts=[];window.__noteSettled=0;
    const Module=load('@/components/modules/notes-module').NotesModule;
    const app=window.ReactDOM.createRoot(document.getElementById('root'));app.render(${strict?'React.createElement(React.StrictMode,null,React.createElement(Module))':'React.createElement(Module)'});
    window.__unmountNotes=()=>app.unmount();
  })();`});
  try {await expect(page.getByText('Synthetic note A',{exact:true}).first()).toBeVisible();}catch(error){console.log(JSON.stringify({fixtureErrors:errors,requests}));throw error}
  return {requests,errors,rows,calls,release:()=>pending.shift()?.(),succeed:()=>{mode='healthy'}};
}

async function edit(page:Page){
  await page.getByText('Synthetic note A',{exact:true}).first().click();
  await page.getByRole('button',{name:'Edit',exact:true}).click();
  await page.locator('input[name=title]').fill('Edited title');
  await page.getByLabel('Content',{exact:true}).fill('Edited content');
}
async function settled(page:Page,count=1){
  await expect.poll(()=>page.evaluate(()=>window.__noteSettled)).toBe(count);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}
async function openDraft(page:Page,kind:'create'|'same'|'different',title='Later draft title',body='Later draft content'){
 if(kind==='create')await page.getByRole('button',{name:'New Note',exact:true}).click();
 else {await page.getByText(kind==='same'?'Synthetic note A':'Synthetic note B',{exact:true}).first().click();await page.getByRole('button',{name:'Edit',exact:true}).click();}
 await page.locator('input[name=title]').fill(title);await page.getByLabel('Content',{exact:true}).fill(body);
}
async function closeDraft(page:Page,method='Cancel'){
 if(method==='Escape')await page.keyboard.press('Escape');
 else await page.getByRole('button',{name:method,exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
}
async function assertLaterDraft(page:Page){await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('input[name=title]')).toHaveValue('Later draft title');await expect(page.getByLabel('Content',{exact:true})).toHaveValue('Later draft content');}
for(const [oldCreate,laterKind] of [[false,'same'],[false,'different'],[false,'create'],[true,'different'],[true,'create']] as const)test((oldCreate?'old create':'old edit')+' success preserves '+laterKind+' reopened draft, refreshes commit, and permits its own save',async({page})=>{
 const proof=await fixture(page,'held');
 if(oldCreate)await openDraft(page,'create','Earlier created title','Earlier created content');else await edit(page);
 await page.getByRole('button',{name:oldCreate?'Create Note':'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await closeDraft(page);await openDraft(page,laterKind);
 proof.release();await settled(page);expect(proof.rows.find(r=>r.title===(oldCreate?'Earlier created title':'Edited title'))?.body).toBe(oldCreate?'Earlier created content':'Edited content');expect(proof.calls).toHaveLength(1);
 await assertLaterDraft(page);await expect(page.getByRole('button',{name:laterKind==='create'?'Create Note':'Save',exact:true})).toBeEnabled();
 expect(await page.evaluate(()=>window.__toasts)).toEqual([]);await expect(page.getByText(oldCreate?'Earlier created title':'Edited title',{exact:true}).first()).toBeVisible();
 proof.succeed();await page.getByRole('button',{name:laterKind==='create'?'Create Note':'Save',exact:true}).click();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.calls).toHaveLength(2);expect(proof.calls[1].fields).toMatchObject({title:'Later draft title',body:'Later draft content'});expect(proof.calls[1].id).toBe(laterKind==='create'?null:laterKind==='same'?proof.rows[0].id:proof.rows[1].id);
 await expect(page.getByText('Later draft title',{exact:true}).first()).toBeVisible();expect(await page.evaluate(()=>window.__toasts)).toHaveLength(1);expect(proof.errors).toEqual([]);
});
for(const mode of ['held-error','held-throw'])for(const laterKind of ['different','create'] as const)test('closed '+mode+' is silent and preserves '+laterKind+' draft with independent successful save',async({page})=>{
 const proof=await fixture(page,mode);await edit(page);await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await closeDraft(page);await openDraft(page,laterKind);proof.release();await settled(page);
 await assertLaterDraft(page);expect(proof.rows[0].title).toBe('Synthetic note A');expect(await page.evaluate(()=>window.__toasts)).toEqual([]);expect(proof.calls).toHaveLength(1);
 proof.succeed();await page.getByRole('button',{name:laterKind==='create'?'Create Note':'Save',exact:true}).click();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.calls).toHaveLength(2);expect(proof.calls[1].fields).toMatchObject({title:'Later draft title',body:'Later draft content'});expect(proof.errors).toEqual([]);
});
for(const method of ['Cancel','Escape','Close dialog'])test(method+' fences pending save completion from a newly created draft',async({page})=>{
 const proof=await fixture(page,'held');await edit(page);await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await closeDraft(page,method);await openDraft(page,'create');proof.release();await settled(page);await assertLaterDraft(page);expect(proof.rows[0].title).toBe('Edited title');expect(proof.calls).toHaveLength(1);expect(await page.evaluate(()=>window.__toasts)).toEqual([]);expect(proof.errors).toEqual([]);
});
test('StrictMode setup retains a live new instance after closing the old instance',async({page})=>{
 const proof=await fixture(page,'held',true);await edit(page);await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await closeDraft(page);await openDraft(page,'different');proof.release();await settled(page);await assertLaterDraft(page);proof.succeed();await page.getByRole('button',{name:'Save',exact:true}).click();await settled(page,2);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.calls).toHaveLength(2);expect(proof.errors).toEqual([]);
});
test('successful closed save refreshes its committed note even without a new dialog',async({page})=>{
 const proof=await fixture(page,'held');await edit(page);await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await closeDraft(page);const before=proof.requests.length;proof.release();await settled(page);await expect(page.getByText('Edited title',{exact:true}).first()).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.requests.length).toBeGreaterThan(before);expect(proof.calls).toHaveLength(1);expect(await page.evaluate(()=>window.__toasts)).toEqual([]);expect(proof.errors).toEqual([]);
});
test('whole module unmount fences stale completion feedback while the requested action persists',async({page})=>{
 const proof=await fixture(page,'held');await edit(page);await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await page.evaluate(()=>window.__unmountNotes());proof.release();await settled(page);expect(proof.rows[0].title).toBe('Edited title');expect(proof.calls).toHaveLength(1);expect(await page.evaluate(()=>window.__toasts)).toEqual([]);expect(proof.errors).toEqual([]);
});
test('an unsent cancelled draft still performs no mutation',async({page})=>{const proof=await fixture(page);await openDraft(page,'create');await closeDraft(page);expect(proof.calls).toEqual([]);expect(proof.rows).toHaveLength(2);expect(proof.errors).toEqual([]);});