import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {test, expect, type Page} from '@playwright/test';
import {reactBrowserScripts} from './helpers/react-browser';

// Actual NotesModule, modal controls, dialog behavior and SDK reads execute.
// Session/family context, action transport, realtime subscription, icons and
// unrelated widgets are inert seams. No live Auth/RLS or Next action claim.
const root=process.env.BUBALY_NOTES_UI_SOURCE_ROOT ?? process.cwd();
const origin='https://notes-save-rejection-fixture.invalid';
const {react,reactDom}=reactBrowserScripts('development');
const sdk=fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')),'dist/umd/supabase.js'),'utf8');
const files=['components/modules/notes-module.tsx','components/ui/modal.tsx','components/ui/input.tsx','components/ui/button.tsx','components/ui/states.tsx','components/ui/states-client.tsx','components/app/page-header.tsx','lib/a11y/use-dialog-behavior.ts','lib/supabase/errors.ts','lib/ui/a11y.ts','lib/notes/ai.ts'];
const definitions=Object.fromEntries(files.map(file=>['@/'+file.replace(/\.tsx?$/,''),ts.transpileModule(fs.readFileSync(file==='components/modules/notes-module.tsx' && process.env.BUBALY_NOTES_MODULE_SOURCE ? process.env.BUBALY_NOTES_MODULE_SOURCE:path.join(root,file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText]));
const messages=JSON.parse(fs.readFileSync(path.join(root,'lib/i18n/messages/en-US.json'),'utf8'));
declare global {interface Window {
  __toasts:[string,string][];
  __todoSettled:number;
  __unmountTodo:()=>void;
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
    calls.push({id,fields});if(mode.startsWith('held'))await new Promise<void>(resolve=>pending.push(resolve));
    if(mode==='held-error'||mode==='error')return{ok:false,error:'Synthetic save refused'};
    if(mode==='held-throw'||mode==='throw')throw Error('Synthetic transport lost');
    if(mode==='opaque-throw')throw Error('');
    let target=rows.find(row=>row.id===id);
    if(id===null){target={...rows[0],id:'ffffffff-ffff-4fff-8fff-ffffffffffff'};rows.push(target);}
    if(!target)throw Error('Unexpected synthetic action id');
    Object.assign(target,{title:fields.title,body:fields.body});
    if(mode==='committed-throw')throw Error('Synthetic response lost after commit');
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
      '@/app/(app)/dashboard/notes/actions':{saveNoteAction:async(id,fields)=>{try{return await window.__noteAction(id,fields)}finally{window.__todoSettled++}},deleteNoteAction:()=>{throw Error('Deletion outside fixture scope')},duplicateNoteAction:()=>{throw Error('Copy outside fixture scope')},setNotePinnedAction:()=>{throw Error('Pin outside fixture scope')}},
      '@/components/ai/ai-insight':{AiInsight:Empty},
      'next/link':{default:({children,...props})=>React.createElement('a',props,children)},
    };
    function load(name){if(externals[name])return externals[name];if(cache[name])return cache[name].exports;if(!defs[name])throw Error('Undeclared dependency '+name);const module={exports:{}};cache[name]=module;const localRequire=child=>load(child.startsWith('.')?name.slice(0,name.lastIndexOf('/')+1)+child.slice(2):child);new Function('module','exports','require','React',defs[name])(module,module.exports,localRequire,React);return module.exports;}
    window.__toasts=[];window.__todoSettled=0;
    const Module=load('@/components/modules/notes-module').NotesModule;
    const app=window.ReactDOM.createRoot(document.getElementById('root'));app.render(${strict?'React.createElement(React.StrictMode,null,React.createElement(Module))':'React.createElement(Module)'});
    window.__unmountTodo=()=>app.unmount();
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
  await expect.poll(()=>page.evaluate(()=>window.__todoSettled)).toBe(count);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
}
for(const create of [false,true])for(const mode of ['healthy','error','throw'])test((create?'create':'edit')+' note '+mode+' retains draft, avoids automatic retry and permits explicit success',async({page})=>{
  const proof=await fixture(page,mode);
  if(create){await page.getByRole('button',{name:'New Note',exact:true}).click();await page.locator('input[name=title]').fill('Edited title');await page.getByLabel('Content',{exact:true}).fill('Edited content');}
  else await edit(page);
  await page.getByRole('button',{name:create?'Create Note':'Save',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.__todoSettled)).toBe(1);
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  if(mode==='healthy'){
    await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows[create?2:0].title).toBe('Edited title');expect(proof.rows[create?2:0].body).toBe('Edited content');
    expect(proof.rows).toHaveLength(create?3:2);
    await page.getByText('Edited title',{exact:true}).first().click();await page.getByRole('button',{name:'Edit',exact:true}).click();
    await expect(page.locator('input[name=title]')).toHaveValue('Edited title');await expect(page.getByLabel('Content',{exact:true})).toHaveValue('Edited content');expect(proof.errors).toEqual([]);
  }else{
    await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('input[name=title]')).toHaveValue('Edited title');await expect(page.getByLabel('Content',{exact:true})).toHaveValue('Edited content');
    expect(proof.rows[0].title).toBe('Synthetic note A');expect(proof.rows[0].body).toBe('Synthetic note content A');
    await expect(page.getByRole('button',{name:create?'Create Note':'Save',exact:true})).toBeEnabled();expect(await page.evaluate(()=>window.__toasts)).toEqual([['error',mode==='throw'?'Synthetic transport lost':'Synthetic save refused']]);expect(proof.errors).toEqual([]);
    expect(proof.calls).toHaveLength(1);expect(proof.rows).toHaveLength(2);
    proof.succeed();await page.getByRole('button',{name:create?'Create Note':'Save',exact:true}).click();await settled(page,2);
    await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.rows[create?2:0]).toMatchObject({title:'Edited title',body:'Edited content'});expect(proof.rows).toHaveLength(create?3:2);
  }
  expect(proof.calls).toHaveLength(mode==='healthy'?1:2);expect(proof.calls[0].id).toBe(create?null:proof.rows[0].id);expect(proof.errors).toEqual([]);
});
test('cancel unsent note draft performs no mutation',async({page})=>{
  const proof=await fixture(page);await edit(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(proof.calls).toHaveLength(0);expect(proof.rows[0].title).toBe('Synthetic note A');expect(proof.errors).toEqual([]);
});

test('rejection without usable message uses existing translated feedback',async({page})=>{
  const proof=await fixture(page,'opaque-throw');await edit(page);await page.getByRole('button',{name:'Save',exact:true}).click();await settled(page);
  await expect(page.getByRole('button',{name:'Save',exact:true})).toBeEnabled();await expect(page.locator('input[name=title]')).toHaveValue('Edited title');expect(await page.evaluate(()=>window.__toasts)).toEqual([['error',messages['actions.couldNotSaveThatNote']]]);expect(proof.errors).toEqual([]);
});

test('pending save remains gated and does not retry before explicit confirmation',async({page})=>{
  const proof=await fixture(page,'held');await edit(page);await page.getByRole('button',{name:'Save',exact:true}).click();await expect.poll(()=>proof.calls.length).toBe(1);await expect(page.getByRole('button',{name:'Save',exact:true})).toBeDisabled();expect(proof.rows[0].title).toBe('Synthetic note A');
  proof.release();await settled(page);await expect(page.getByRole('dialog')).toHaveCount(0);expect(proof.calls).toHaveLength(1);expect(proof.rows[0].title).toBe('Edited title');expect(proof.errors).toEqual([]);
});

test('an ambiguous create response does not automatically create another note',async({page})=>{
  const proof=await fixture(page,'committed-throw');await page.getByRole('button',{name:'New Note',exact:true}).click();await page.locator('input[name=title]').fill('Possibly saved title');await page.getByLabel('Content',{exact:true}).fill('Possibly saved content');await page.getByRole('button',{name:'Create Note',exact:true}).click();await settled(page);
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('input[name=title]')).toHaveValue('Possibly saved title');await expect(page.getByRole('button',{name:'Create Note',exact:true})).toBeEnabled();expect(proof.calls).toHaveLength(1);expect(proof.rows).toHaveLength(3);expect(proof.rows[2]).toMatchObject({title:'Possibly saved title',body:'Possibly saved content'});
  expect(await page.evaluate(()=>window.__toasts)).toEqual([['error','Synthetic response lost after commit']]);await page.getByRole('button',{name:'Cancel',exact:true}).click();expect(proof.calls).toHaveLength(1);expect(proof.errors).toEqual([]);
});

