import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Real AssistantModule, ConversationPane, ownership guard and SSE parser mounted
// with installed React. Auth, DB, voice device and provider transport are explicit
// controlled boundaries; these cases prove UI ownership, not live RLS/model quality.
const { react, reactDom } = reactBrowserScripts('development');
const isolated = new Set([
  'react', 'lucide-react', '@/components/app/app-context', '@/components/i18n/locale-provider',
  '@/components/assistant/workspace', '@/components/assistant/result-pane', '@/components/assistant/context-rail',
  '@/lib/supabase/client', '@/lib/hooks/use-voice', '@/components/voice/mic-button', '@/components/i18n/use-format',
  '@/components/ui/button', '@/components/ui/states', '@capacitor/core', '@capacitor/haptics',
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
const entry = collect('components/modules/assistant-module.tsx');
const catalogue = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const origin = 'https://assistant-lifecycle-fixture.invalid';

async function fixture(page: Page, search = '') {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }));
  await page.goto(origin + search);
  await page.addScriptTag({ content: react }); await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)}, entry=${JSON.stringify(entry)}, catalogue=${JSON.stringify(catalogue)}, A=${JSON.stringify(A)}, B=${JSON.stringify(B)}, loaded={};
    const h=React.createElement, p=window.__assistant={errors:[],sends:[],streams:[],replies:[],pending:[],hold:null,readFailure:false,stopSpeech:0};
    window.addEventListener('error',e=>p.errors.push(e.message)); window.addEventListener('unhandledrejection',e=>p.errors.push(String(e.reason)));
    const translate=(key,params={})=>Object.entries(params).reduce((value,[key,replacement])=>value.split('{'+key+'}').join(String(replacement)),catalogue[key]||key);
    const initial={userId:'user-a',familyId:'family-a',family:{id:'family-a'},selfMember:{id:'member-a',display_name:'Casey'},role:'parent'};
    let app=initial;
    const context=React.createContext(initial);
    const conversations=[{id:A,title:'Thread A',updated_at:'2026-10-02T12:00:00Z',family_id:'family-a',user_id:'user-a'},{id:B,title:'Thread B',updated_at:'2026-10-02T11:00:00Z',family_id:'family-a',user_id:'user-a'}];
    let messages=[A,B].flatMap((id,i)=>['user','assistant'].map((role,j)=>({id:id+'-'+j,conversation_id:id,family_id:'family-a',role,content:(j?'Saved answer ':'Saved question ')+(i?'B':'A'),created_at:'2026-10-02T10:00:00Z',tool_results:null,structured_content:j?{version:1,cards:[],runIds:['run-'+(i?'B':'A')]}:null})));
    p.flush=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    p.longHistory=(id,count)=>{messages=messages.filter(m=>m.conversation_id!==id).concat(Array.from({length:count},(_,i)=>({id:String(i).padStart(5,'0'),conversation_id:id,family_id:'family-a',role:i%2?'assistant':'user',content:'History '+i,created_at:new Date(Date.UTC(2026,9,1,0,i)).toISOString(),tool_results:null,structured_content:null})));};
    const db={from:table=>{
      const filters=[],orders=[];let limit=Infinity,offset=0,single=false,signal=null,operation='read',patch=null,or='';
      const q={select:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},in:()=>q,gte:()=>q,lte:()=>q,lt:()=>q,
        order:(k,o={})=>{orders.push([k,o.ascending!==false]);return q;},limit:n=>{limit=n;return q;},range:(start,end)=>{offset=start;limit=end-start+1;return q;},
        abortSignal:value=>{signal=value;return q;},or:value=>{or=value;return q;},
        update:value=>{operation='update';patch=value;return q;},delete:()=>{operation='delete';return q;},maybeSingle:()=>{single=true;return q;},
        then:(resolve,reject)=>{
          const run=()=>{
            if(table==='ai_messages'&&p.readFailure)return {data:null,error:{message:'Synthetic unavailable'},count:null};
            let rows=(table==='ai_conversations'?conversations:table==='ai_messages'?messages:[]).filter(row=>filters.every(([key,value])=>row[key]===value));
            if(or){const match=/created_at.lt.([^,]+)/.exec(or);if(match)rows=rows.filter(row=>row.created_at<match[1]);}
            rows=[...rows].sort((a,b)=>{for(const [key,asc] of orders){const v=String(a[key]).localeCompare(String(b[key]));if(v)return asc?v:-v;}return 0;}).slice(offset,offset+limit);
            if(operation==='update')rows.forEach(row=>Object.assign(row,patch));
            if(operation==='delete')for(const row of rows){const index=conversations.indexOf(row);if(index>=0)conversations.splice(index,1);}
            return {data:single?rows[0]??null:rows,error:null,count:rows.length};
          };
          if(table==='ai_messages'&&filters.some(([key,value])=>key==='conversation_id'&&value===p.hold)){
            p.pending.push({signal,resolve:()=>resolve(run())});return Promise.resolve();
          }
          return Promise.resolve(run()).then(resolve,reject);
        }};return q;}};
    const voice={mode:'text',status:'idle',stopSpeaking:()=>{p.stopSpeech++;},speak:()=>{},shouldSpeak:()=>false,setMode:()=>{}};
    const clock={hourNow:()=>12,dayStart:(offset)=>new Date(Date.UTC(2026,9,2+offset))};const fmtRelative=()=>'';
    const mocks={
      react:React,'lucide-react':new Proxy({},{get:(_o,name)=>name==='__esModule'?false:()=>null}),
      '@/components/app/app-context':{useApp:()=>React.useContext(context)},
      '@/components/i18n/locale-provider':{useTranslations:()=>translate,usePlural:()=>((key,count)=>translate(key,{count}))},
      '@/components/i18n/use-format':{useFamilyClock:()=>clock,useFormat:()=>({fmtRelative})},
      '@/components/assistant/workspace':{useDesktop:()=>true,AssistantWorkspace:({conversation,hero,plan,context})=>h('div',null,conversation,hero,plan,context)},
      '@/components/assistant/result-pane':{cardId:(id,index)=>id+':'+index,ResultPane:({messages})=>h('output',{'data-testid':'plan'},JSON.stringify(messages.map(m=>({id:m.id,cards:m.cards,runIds:m.runIds}))))},
      '@/components/assistant/context-rail':{ContextRail:()=>null},
      '@/lib/supabase/client':{createClient:()=>db},'@/lib/hooks/use-voice':{useVoice:()=>voice},'@/components/voice/mic-button':{MicButton:()=>null},
      '@/components/ui/button':{Button:({children,variant,size,...props})=>h('button',props,children)},
      '@/components/ui/states':{ErrorState:({message,onRetry})=>h('div',{role:'alert'},message,h('button',{onClick:onRetry},'Retry')),SkeletonText:()=>h('p',null,'Loading')},
    };
    // A queued reply answers the next send: {status,json} as JSON, {network:true}
    // as a dropped connection; otherwise the send streams under test control.
    window.fetch=async(_url,init)=>{p.sends.push({body:JSON.parse(init.body),signal:init.signal,key:init.headers['Idempotency-Key']});const reply=p.replies.shift()||{};
      if(reply.network)throw new TypeError('Failed to fetch');
      if(reply.status)return new Response(JSON.stringify(reply.json),{status:reply.status,headers:{'Content-Type':'application/json'}});
      let controller;const stream=new ReadableStream({start:c=>{controller=c;}});p.streams.push(controller);return new Response(stream,{headers:{'Content-Type':'text/event-stream'}});};
    p.event=(index,event)=>p.streams[index].enqueue(new TextEncoder().encode('data: '+JSON.stringify(event)+'\\n\\n'));
    p.end=index=>p.streams[index].close();
    function load(id){if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected module '+id);const module=loaded[id]={exports:{}};new Function('require','module','exports',item.source)(name=>load(item.imports[name]),module,module.exports);return module.exports;}
    const root=ReactDOM.createRoot(document.getElementById('root'));
    p.render=()=>ReactDOM.flushSync(()=>root.render(h(React.StrictMode,null,h(context.Provider,{value:app},h(load(entry).AssistantModule)))));
    p.changeOwner=change=>{app={...initial,...change};p.render();};
    p.render();
  })();` });
  await expect(page.locator('button[aria-controls="assistant-conversation-list"]')).toContainText('2 saved');
}

async function select(page: Page, name: 'A' | 'B') {
  await page.locator('button[aria-controls="assistant-conversation-list"]').click();
  await page.getByRole('button', { name: `Thread ${name}`, exact: true }).click();
}
test.afterEach(async ({ page }) => { expect(await page.evaluate(() => (window as any).__assistant?.errors ?? [])).toEqual([]); });

test('saved conversation restores outcomes and each draft stays with its conversation', async ({ page }) => {
  await fixture(page); await select(page, 'A');
  await expect(page.getByText('Saved answer A', { exact: true })).toBeVisible();
  await expect(page.getByTestId('plan')).toContainText('run-A');
  await page.getByRole('textbox').fill('Draft belonging to A');
  await select(page, 'B'); await expect(page.getByRole('textbox')).toHaveValue('');
  await page.getByRole('textbox').fill('Draft belonging to B');
  await select(page, 'A'); await expect(page.getByRole('textbox')).toHaveValue('Draft belonging to A');
  expect(await page.evaluate(() => sessionStorage.getItem('assistant-conv-id:user-a:family-a'))).toBe(A);
  await fixture(page);
  await expect(page.getByText('Saved answer A', { exact: true })).toBeVisible();
  await expect(page.getByTestId('plan')).toContainText('run-A');
});

test('a deep-linked request survives StrictMode mount cleanup and is submitted only once', async ({ page }) => {
  await fixture(page, '?q=Plan%20the%20week');
  await expect.poll(() => page.evaluate(() => (window as any).__assistant.sends.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__assistant.sends[0].signal.aborted)).toBe(false);
  expect(await page.evaluate(() => (window as any).__assistant.sends[0].body.message)).toBe('Plan the week');
  await expect(page).toHaveURL(origin + '/');
});

test('a held previous-thread read cannot replace a new conversation or its draft', async ({ page }) => {
  await fixture(page); await select(page, 'A');
  await page.evaluate(id => { (window as any).__assistant.hold = id; }, B);
  await select(page, 'B');
  await expect.poll(() => page.evaluate(() => (window as any).__assistant.pending.length)).toBe(1);
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await page.getByRole('textbox').fill('New conversation draft');
  await page.evaluate(async () => { const p=(window as any).__assistant; p.pending[0].resolve(); await p.flush(); });
  await expect(page.getByRole('textbox')).toHaveValue('New conversation draft');
  await expect(page.getByText('Saved answer B', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__assistant.pending[0].signal.aborted)).toBe(true);
});

test('a changed account hides private state and aborts the old streaming request', async ({ page }) => {
  await fixture(page); await select(page, 'A');
  await page.getByRole('textbox').fill('Private prompt A'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__assistant.sends.length)).toBe(1);
  await page.evaluate(async () => { const p=(window as any).__assistant; p.event(0,{type:'delta',text:'Private partial answer'}); await p.flush(); });
  await expect(page.getByText('Private partial answer', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__assistant.changeOwner({userId:'user-b',familyId:'family-b',family:{id:'family-b'},selfMember:{id:'member-b',display_name:'Taylor'}}));
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(page.getByText('Private partial answer', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Private prompt A', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('plan')).not.toContainText('run-A');
  expect(await page.evaluate(() => (window as any).__assistant.sends[0].signal.aborted)).toBe(true);
});

test('partial/save errors remain visible beside streamed text and Stop never submits another request', async ({ page }) => {
  await fixture(page); await select(page, 'A');
  await page.getByRole('textbox').fill('Make a plan'); await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.evaluate(async () => { const p=(window as any).__assistant; p.event(0,{type:'delta',text:'Partial plan'});p.event(0,{type:'error',error:'Could not save this reply.'});p.event(0,{type:'done',content:'Partial plan',persisted:false});p.end(0);await p.flush(); });
  await expect(page.getByText('Partial plan', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Could not save this reply.');
  await page.getByRole('textbox').fill('Another question');await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await expect(page.getByText(/Response stopped. Actions already started/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__assistant.sends.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__assistant.sends[1].signal.aborted)).toBe(true);
});

test('newest history is visible first and older pages remain reachable', async ({ page }) => {
  await fixture(page);await page.evaluate(id => (window as any).__assistant.longHistory(id,205), A);await select(page, 'A');
  await expect(page.getByText('History 204', { exact: true })).toBeVisible();
  await expect(page.getByText('History 0', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name:'Load earlier messages',exact:true }).click();
  await expect(page.getByText('History 5', {exact:true})).toBeVisible();
  await page.getByRole('button', { name:'Load earlier messages',exact:true }).click();
  await expect(page.getByText('History 0', {exact:true})).toBeVisible();
  await expect(page.getByRole('button', {name:'Load earlier messages',exact:true})).toHaveCount(0);
  await expect(page.getByText('History 204', {exact:true})).toBeVisible();
});

test('a refused history read preserves the old thread and exposes a working retry', async ({ page }) => {
  await fixture(page); await select(page,'A');
  await page.evaluate(() => { (window as any).__assistant.readFailure=true; });await select(page,'B');
  await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('Saved answer A',{exact:true})).toBeVisible();
  await page.evaluate(() => { (window as any).__assistant.readFailure=false; });await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByText('Saved answer B',{exact:true})).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});

// A retried send is the same turn (F19). Edit & retry with the words unchanged
// must carry the first attempt's Idempotency-Key, so the server replays a turn
// that already finished instead of counting and running it again; every other
// send — edited, independent, or after the server called the key spent — is a
// new turn with a new key.
type Send = { body: { message: string }; key: string };
const sends = (page: Page) => page.evaluate(() => (window as any).__assistant.sends.map((s: Send) => ({ body: s.body, key: s.key })) as Send[]);
const queue = (page: Page, ...replies: object[]) => page.evaluate(r => { (window as any).__assistant.replies.push(...r); }, replies);
async function sendText(page: Page, text: string, count: number) {
  await page.getByRole('textbox').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await sends(page)).length).toBe(count);
}
async function resend(page: Page, count: number) {
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(async () => (await sends(page)).length).toBe(count);
}
/** Stream events into the `index`th streamed send and close it. */
async function stream(page: Page, index: number, events: object[]) {
  await page.evaluate(async ([i, list]) => {
    const p = (window as any).__assistant;
    for (const e of list as object[]) p.event(i, e);
    p.end(i); await p.flush();
  }, [index, events] as const);
}
const answer = (text: string, requestId: string) => [{ type: 'delta', text }, { type: 'done', content: text, persisted: true, requestId }];
async function editAndRetry(page: Page, expected: string) {
  await page.getByRole('button', { name: 'Edit and retry', exact: true }).last().click();
  await expect(page.getByRole('textbox')).toHaveValue(expected);
}

test('an interrupted stream retried unchanged reuses its key, renders the replay, and the next send is a new turn', async ({ page }) => {
  await fixture(page);
  await sendText(page, 'Plan dinner for Friday', 1);
  // The stream drops before `done`: the turn may have finished server-side.
  await stream(page, 0, [{ type: 'delta', text: 'Partial dinner' }]);
  await expect(page.getByRole('alert')).toContainText('The response was interrupted');
  await editAndRetry(page, 'Plan dinner for Friday');
  await resend(page, 2);
  const [first, retry] = await sends(page);
  expect(retry.body.message).toBe('Plan dinner for Friday');
  expect(retry.key).toBe(first.key);

  // The server replays the saved answer (one delta + done): an ordinary reply.
  await stream(page, 1, answer('Tacos on Friday.', 'req-1'));
  await expect(page.getByText('Tacos on Friday.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(1);

  // A later send, even of the same words, is a fresh turn.
  await sendText(page, 'Plan dinner for Friday', 3);
  expect((await sends(page))[2].key).not.toBe(first.key);
});

test('a failed request (500, network, unsaved reply) retried unchanged sends the same key', async ({ page }) => {
  await fixture(page);
  await queue(page, { status: 500, json: { error: 'Server trouble' } });
  await sendText(page, 'Remind me about soccer', 1);
  await expect(page.getByRole('alert')).toContainText('Server trouble');
  await queue(page, { network: true });
  await editAndRetry(page, 'Remind me about soccer');
  await resend(page, 2);
  await expect(page.getByRole('alert').last()).toContainText('The response was interrupted');
  await editAndRetry(page, 'Remind me about soccer');
  await resend(page, 3);
  await stream(page, 0, [{ type: 'error', error: 'Could not save this reply.' }, { type: 'done', content: 'Saved?', persisted: false, requestId: 'req-2' }]);
  await expect(page.getByRole('alert').last()).toContainText('Could not save this reply.');
  await editAndRetry(page, 'Remind me about soccer');
  await resend(page, 4);
  expect(new Set((await sends(page)).map(s => s.key)).size).toBe(1);
});

test('an edited retry, a key the server called spent, and independent sends each get a new key', async ({ page }) => {
  await fixture(page);
  await sendText(page, 'First question', 1);
  await stream(page, 0, answer('First answer.', 'req-a'));
  await sendText(page, 'Second question', 2);
  await stream(page, 1, answer('Second answer.', 'req-b'));
  const [a, b] = await sends(page);
  expect(a.key).not.toBe(b.key);

  await queue(page, { status: 500, json: { error: 'Server trouble' } });
  await sendText(page, 'Book the dentist', 3);
  await editAndRetry(page, 'Book the dentist');
  await sendText(page, 'Book the dentist for Tuesday', 4);
  const [, , failed, edited] = await sends(page);
  expect(edited.body.message).toBe('Book the dentist for Tuesday');
  expect(edited.key).not.toBe(failed.key);
  await stream(page, 2, answer('Booked.', 'req-c'));

  // The server says this key's turn ended without an answer: sending again is
  // a new turn, so the retry must not reuse a key that can only be refused.
  await queue(page, { status: 409, json: { error: 'That attempt didn’t finish. Send the message again.', code: 'turn_failed' } });
  await sendText(page, 'Order groceries', 5);
  await expect(page.getByRole('alert').last()).toContainText('That attempt didn’t finish');
  await editAndRetry(page, 'Order groceries');
  await resend(page, 6);
  const [, , , , spent, fresh] = await sends(page);
  expect(fresh.body.message).toBe('Order groceries');
  expect(fresh.key).not.toBe(spent.key);
});
