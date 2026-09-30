import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Actual InboxModule, React and reachable UI modules. Session context, locale
// lookup, query/action/AI/write receipts and notification delivery are explicit
// controlled boundaries. These cases verify message ownership and pending edits;
// database persistence, provider delivery and RLS require separate acceptance.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');
const isolated = new Set([
  'react', 'react-dom', 'lucide-react', 'next/link', '@/components/app/app-context',
  '@/components/i18n/locale-provider', '@/components/ui/toast', '@/components/ai/ai-insight',
  '@capacitor/core', '@capacitor/haptics',
  '@/lib/supabase/client', '@/lib/offline/cache-scope', '@/lib/hooks/use-realtime-query', '@/app/(app)/dashboard/reminders/actions',
  '@/app/(app)/dashboard/meals/actions', '@/app/(app)/dashboard/grocery/actions',
]);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function sourceFile(filename: string) {
  return [filename, `${filename}.ts`, `${filename}.tsx`, path.join(filename, 'index.ts')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename;
}
function collect(filename: string): string {
  const id = path.resolve(sourceFile(filename));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name)) { item.imports[name] = name; continue; }
    const target = name.startsWith('@/') ? path.resolve(name.slice(2))
      : name.startsWith('.') && /\.tsx?$/.test(id) ? path.resolve(path.dirname(id), name)
        : require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}

const entry = collect('components/modules/inbox-module.tsx');
const origin = 'https://inbox-state-fixture.invalid';
const messages = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json','utf8'));
const rows = ['A','B'].map(id=>({id, family_id:'family-A',created_by:'user-A',contact_id:null,thread_id:null,channel:'sms',direction:'inbound',subject:'Message '+id,body:'Body '+id,summary:null,action_items:['Action '+id],category:'general',priority:'normal',status:'read',received_at:'2026-09-27T12:00:00Z'}));
async function fixture(page:Page) {
  page.on('pageerror',error=>console.log('fixture page error:',error.message));
  await page.route('**/*', async route=> {
    if(route.request().url()!==origin+'/') throw new Error('Unexpected network request');
    await route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><main id="root"></main></body></html>'});
  });
  await page.goto(origin);
  await page.addScriptTag({content:react}); await page.addScriptTag({content:reactDom}); await page.addScriptTag({content:'window.react=window.React;'}); await page.addScriptTag({content:icons});
  await page.addScriptTag({content: `(() => {
    const sources=${JSON.stringify(modules)}, entry=${JSON.stringify(entry)}, messages=${JSON.stringify(messages)}, rows=${JSON.stringify(rows)}, loaded={};
    const h=React.createElement,p=window.__inboxState={reminders:[],notices:[],inserts:[],updates:[],errors:[],pending:null,holdReminders:false,holdInserts:false,pendingReminders:[],pendingInserts:[],settledReminders:0,settledInserts:0,refreshes:0};
    window.addEventListener('error', e=>p.errors.push(e.message)); window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
    p.flush=async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);};
    p.finishReminder=async(index,result={ok:true})=>{p.pendingReminders[index].resolve(result);await p.flush();};
    p.rejectReminder=async index=>{p.pendingReminders[index].reject(new Error('Synthetic reminder transport rejection'));await p.flush();};
    p.finishInsert=async(index,result={error:null})=>{p.pendingInserts[index].resolve(result);await p.flush();};
    const translate=(key,vars={})=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),messages[key]||key);
    const db={from:table=>({insert:async input=>{p.inserts.push({table,...input});const result=p.holdInserts?await new Promise((resolve,reject)=>p.pendingInserts.push({input,resolve,reject})):{error:null};p.settledInserts++;return result;},update:input=>{const eqs=[];const query={eq:(key,value)=>{eqs.push([key,value]);return query;},select:async()=>{p.updates.push({table,input,eqs});return {data:[{id:'saved'}],error:null};}};return query;}})};
    const mocks={
      react:React,'react-dom':ReactDOM,'lucide-react':window.LucideReact,
      'next/link':{__esModule:true,default:({href,children,...props})=>h('a',{...props,href},children)},
      '@/components/app/app-context':{useApp:()=>({familyId:'family-A',userId:'user-A'})},
      '@/components/i18n/locale-provider':{useTranslations:()=>translate,useLocale:()=>({code:'en-US'}),useFamilyTimeZone:()=>undefined},
      '@/components/ui/toast':{useToast:()=>({success:x=>p.notices.push(x),error:x=>p.notices.push(x)})},
      '@/lib/hooks/use-realtime-query':{useRealtimeQuery:opts=>({data:opts.table==='family_communications'?rows:[],loading:false,error:null,refresh:()=>{p.refreshes++;}})},
      '@/lib/supabase/client':{createClient:()=>db},
      '@/app/(app)/dashboard/reminders/actions':{createReminderAction:async input=>{p.reminders.push(input);const result=p.holdReminders?await new Promise((resolve,reject)=>p.pendingReminders.push({input,resolve,reject})):{ok:true};p.settledReminders++;return result;}},
    };
    window.fetch=async()=>new Promise(resolve=>p.pending=async()=>{resolve({ok:true,json:async()=>({message:'Draft for A'})}); await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);});
    function load(id){if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected Inbox module: '+id);const module=loaded[id]={exports:{}};new Function('require','module','exports',item.source)(name=>load(item.imports[name]),module,module.exports);return module.exports;}
    ReactDOM.flushSync(()=>ReactDOM.createRoot(document.getElementById('root')).render(h(load(entry).InboxModule)));
  })();`});
}

test('a typed reply belongs to its selected message',async({page})=>{
  await fixture(page); expect(await page.evaluate(()=>(window as any).__inboxState?.errors)).toEqual([]);
  await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('textbox').last().fill('Private reply for A');
  await page.getByRole('button',{name:/^Message B/}).click();
  await expect(page.getByRole('textbox').last()).toHaveValue('');
});
test('a saved action does not disable the next message action',async({page})=>{
  await fixture(page); expect(await page.evaluate(()=>(window as any).__inboxState?.errors)).toEqual([]);
  await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('button',{name:'Remind',exact:true}).click();
  await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:/^Message B/}).click();
  await expect(page.getByRole('button',{name:'Remind',exact:true})).toBeEnabled();
});
test('a delayed draft for A cannot populate selected B',async({page})=>{
  await fixture(page); expect(await page.evaluate(()=>(window as any).__inboxState?.errors)).toEqual([]);
  await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('button',{name:'Draft reply',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>Boolean((window as any).__inboxState.pending))).toBe(true);
  await page.getByRole('button',{name:/^Message B/}).click();
  await page.evaluate(()=>(window as any).__inboxState.pending());
  await expect(page.getByRole('textbox').last()).toHaveValue('');
});

test('same-message draft completion and return navigation retain the right text',async({page})=>{
  await fixture(page);
  await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('button',{name:'Draft reply',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>Boolean((window as any).__inboxState.pending))).toBe(true);
  await page.evaluate(()=>(window as any).__inboxState.pending());
  await expect(page.getByRole('textbox').last()).toHaveValue('Draft for A');
  await page.getByRole('button',{name:/^Message B/}).click();
  await page.getByRole('textbox').last().fill('Reply for B');
  await page.getByRole('button',{name:/^Message A/}).click();
  await expect(page.getByRole('textbox').last()).toHaveValue('Draft for A');
});
test('each message reminder stays saved when returning without another action',async({page})=>{
  await fixture(page);
  await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('button',{name:'Remind',exact:true}).click();
  await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:/^Message B/}).click();
  await page.getByRole('button',{name:'Remind',exact:true}).click();
  await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:/^Message A/}).click();
  await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).__inboxState.reminders.map((r:any)=>r.title))).toEqual(['Action A','Action B']);
});


for(const order of ['A-first','B-first'] as const) test(`held reminder completions stay with their messages: ${order}`,async({page})=>{
  await fixture(page);await page.evaluate(()=>{(window as any).__inboxState.holdReminders=true;});
  await page.getByRole('button',{name:/^Message A/}).click();await page.getByRole('button',{name:'Remind',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__inboxState.pendingReminders.length)).toBe(1);
  await page.getByRole('button',{name:/^Message B/}).click();await expect(page.getByRole('button',{name:'Remind',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Remind',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).__inboxState.pendingReminders.length)).toBe(2);
  const first=order==='A-first'?0:1;
  await page.evaluate(i=>(window as any).__inboxState.finishReminder(i),first);
  expect(await page.evaluate(()=>(window as any).__inboxState.settledReminders)).toBe(1);
  if(first===0)expect(await page.getByRole('button',{name:'Added',exact:true}).count()).toBe(0);else await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  await page.evaluate(i=>(window as any).__inboxState.finishReminder(i),1-first);
  await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:/^Message A/}).click();await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  const calls=await page.evaluate(()=>(window as any).__inboxState.reminders);
  expect(calls.map((x:any)=>x.title)).toEqual(['Action A','Action B']);expect(calls[0].submissionId).not.toBe(calls[1].submissionId);
  expect(await page.evaluate(()=>(window as any).__inboxState.errors)).toEqual([]);
});

test('failed held A reminder retries with original submission id and leaves saved B untouched',async({page})=>{
  await fixture(page);await page.evaluate(()=>{(window as any).__inboxState.holdReminders=true;});
  await page.getByRole('button',{name:/^Message A/}).click();await page.getByRole('button',{name:'Remind',exact:true}).click();
  await page.getByRole('button',{name:/^Message B/}).click();await page.getByRole('button',{name:'Remind',exact:true}).click();
  await page.evaluate(async()=>{const p=(window as any).__inboxState;await p.finishReminder(1);await p.finishReminder(0,{ok:false,error:'Synthetic retryable failure'});});
  await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:/^Message A/}).click();await expect(page.getByRole('button',{name:'Remind',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Remind',exact:true}).click();
  const calls=await page.evaluate(()=>(window as any).__inboxState.reminders);
  expect(calls.map((x:any)=>x.title)).toEqual(['Action A','Action B','Action A']);expect(calls[0].submissionId).toBe(calls[2].submissionId);expect(calls[0].submissionId).not.toBe(calls[1].submissionId);
  await page.evaluate(()=>(window as any).__inboxState.finishReminder(2));await expect(page.getByRole('button',{name:'Added',exact:true})).toBeDisabled();
});

for(const order of ['A-first','B-first'] as const) test(`held log reply completions retain exact thread and draft owner: ${order}`,async({page})=>{
  await fixture(page);await page.evaluate(()=>{(window as any).__inboxState.holdInserts=true;});
  for(const id of ['A','B']){await page.getByRole('button',{name:new RegExp('^Message '+id)}).click();await page.getByRole('textbox').last().fill('Reply for '+id);await page.getByRole('button',{name:'Log reply',exact:true}).click();}
  await expect.poll(()=>page.evaluate(()=>(window as any).__inboxState.pendingInserts.length)).toBe(2);
  const first=order==='A-first'?0:1;await page.evaluate(i=>(window as any).__inboxState.finishInsert(i),first);
  expect(await page.evaluate(()=>(window as any).__inboxState.settledInserts)).toBe(1);
  if(first===0){await expect(page.getByRole('textbox').last()).toHaveValue('Reply for B');await expect(page.getByRole('button',{name:'Log reply',exact:true})).toBeDisabled();}
  else {await expect(page.getByRole('textbox').last()).toHaveValue('');await page.getByRole('textbox').last().fill('New B draft');}
  await page.evaluate(i=>(window as any).__inboxState.finishInsert(i),1-first);
  await expect(page.getByRole('textbox').last()).toHaveValue(first===0?'':'New B draft');
  const writes=await page.evaluate(()=>({inserts:(window as any).__inboxState.inserts,updates:(window as any).__inboxState.updates,errors:(window as any).__inboxState.errors}));
  expect(writes.inserts.map((x:any)=>({body:x.body,thread:x.thread_id,family:x.family_id,actor:x.created_by}))).toEqual([{body:'Reply for A',thread:'A',family:'family-A',actor:'user-A'},{body:'Reply for B',thread:'B',family:'family-A',actor:'user-A'}]);
  expect(writes.updates.map((x:any)=>x.eqs)).toEqual(order==='A-first'?[[['id','A'],['family_id','family-A']],[['id','B'],['family_id','family-A']]]:[[['id','B'],['family_id','family-A']],[['id','A'],['family_id','family-A']]]);expect(writes.errors).toEqual([]);
});

test('late saved A reply does not erase a newer A draft after returning from B',async({page})=>{
  await fixture(page);await page.evaluate(()=>{(window as any).__inboxState.holdInserts=true;});
  await page.getByRole('button',{name:/^Message A/}).click();await page.getByRole('textbox').last().fill('Original A reply');await page.getByRole('button',{name:'Log reply',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>(window as any).__inboxState.pendingInserts.length)).toBe(1);
  await page.getByRole('button',{name:/^Message B/}).click();await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('textbox').last().fill('Newer A draft');await page.evaluate(()=>(window as any).__inboxState.finishInsert(0));
  expect(await page.evaluate(()=>(window as any).__inboxState.settledInserts)).toBe(1);
  expect(await page.evaluate(()=>(window as any).__inboxState.inserts.map((x:any)=>({thread:x.thread_id,body:x.body})))).toEqual([{thread:'A',body:'Original A reply'}]);
  await expect(page.getByRole('textbox').last()).toHaveValue('Newer A draft');
});

test('held A AI draft does not overwrite a newer manual A edit after returning from B',async({page})=>{
  await fixture(page);await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('textbox').last().fill('Original A draft');await page.getByRole('button',{name:'Redraft',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>Boolean((window as any).__inboxState.pending))).toBe(true);
  await page.getByRole('button',{name:/^Message B/}).click();await page.getByRole('button',{name:/^Message A/}).click();
  await page.getByRole('textbox').last().fill('Newer manual A draft');await page.evaluate(()=>(window as any).__inboxState.pending());
  await expect(page.getByRole('button',{name:'Redraft',exact:true})).toBeEnabled();
  await expect(page.getByRole('textbox').last()).toHaveValue('Newer manual A draft');
});

test.afterEach(async ({page}) => {
  expect(await page.evaluate(() => (window as any).__inboxState?.errors ?? [])).toEqual([]);
});
