import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual MessagesModule and its UI/helper modules, with explicit session,
// formatting, media signing, AI and database/realtime boundaries. These tests
// exercise React ownership and confirmed rendering, not provider RLS/delivery.
const { react, reactDom } = reactBrowserScripts('development');
const icons = fs.readFileSync(path.join(path.dirname(require.resolve('lucide-react/package.json')), 'dist/umd/lucide-react.min.js'), 'utf8');
const isolated = new Set(['react', 'react-dom', 'lucide-react', '@/components/app/app-context', '@/components/i18n/locale-provider', '@/components/i18n/use-format', '@/components/ui/toast', '@/components/ai/ai-insight', '@/lib/supabase/client', '@/lib/utils/format', '@/lib/storage/use-family-media', '@/components/media/family-media-img']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function resolveSource(filename: string) {
  return [filename, `${filename}.ts`, `${filename}.tsx`, path.join(filename, 'index.ts')].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename;
}
function collect(filename: string): string {
  const id = path.resolve(resolveSource(filename));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name)) { item.imports[name] = name; continue; }
    item.imports[name] = collect(name.startsWith('@/') ? path.resolve(name.slice(2)) : name.startsWith('.') ? path.resolve(path.dirname(id), name) : require.resolve(name, { paths: [path.dirname(id)] }));
  }
  return id;
}
const entry = collect('components/modules/messages-module.tsx');
const catalogue = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const origin = 'https://family-chat-fixture.invalid';
const conversationA = '10000000-0000-4000-8000-000000000001';
const conversationB = '10000000-0000-4000-8000-000000000002';
// Compile the production stylesheet/config: responsive assertions must exercise
// real utilities, design tokens and theme overrides, not substitute fixture CSS.
let css: Promise<string> | undefined;
function productionStyles() {
  return css ??= postcss([tailwindcss(require('tailwindcss/loadConfig')(path.resolve('tailwind.config.ts')))])
    .process(fs.readFileSync('app/globals.css', 'utf8'), { from: 'app/globals.css' }).then(result => result.css);
}

async function fixture(page: Page, { holdA = false, mobile = false, olderHistory = false, theme = 'dark', legacy = false, otherCreator = false } = {}) {
  await page.setViewportSize({ width: mobile ? 390 : 1280, height: 844 });
  const stylesheet = await productionStyles();
  await page.route('**/*', async route => {
    if (route.request().url() !== `${origin}/`) throw new Error(`Unexpected network request: ${route.request().url()}`);
    await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${theme}"><head><style>${stylesheet}</style></head><body><main id="root" style="padding:16px"></main></body></html>` });
  });
  await page.goto(origin);
  await page.addScriptTag({ content: react }); await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: 'window.react=window.React;' }); await page.addScriptTag({ content: icons });
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)},entry=${JSON.stringify(entry)},catalogue=${JSON.stringify(catalogue)},loaded={},A=${JSON.stringify(conversationA)},B=${JSON.stringify(conversationB)};
    const h=React.createElement,p=window.__familyChat={errors:[],notices:[],reads:[],writes:[],pending:[],holdA:${holdA},channels:[],insertIds:[],failInserts:0,loseInsertResponse:false,holdInsert:false,pendingInsert:[],archiveCalls:[],pendingArchive:[],holdArchive:false};
    window.addEventListener('error',event=>p.errors.push(event.message));window.addEventListener('unhandledrejection',event=>{p.errors.push(String(event.reason));event.preventDefault();});
    const userId='20000000-0000-4000-8000-000000000001',otherId='20000000-0000-4000-8000-000000000002',familyId='30000000-0000-4000-8000-000000000001';
    let sessionRole='parent';
    const members=[{id:'self-member',family_id:familyId,user_id:userId,display_name:'Alex',role:'parent',is_active:true,color:'#123456'},{id:'other-member',family_id:familyId,user_id:otherId,display_name:'Blair',role:'adult',is_active:true,color:'#456789'}];
    const convs=[A,B].map((id,index)=>({id,family_id:familyId,name:'Chat '+(index?'B':'A'),kind:'group',avatar_emoji:'💬',description:null,is_archived:false,is_family_chat:index===0,member_ids:[userId,otherId],participant_ids:members.map(m=>m.id),created_by:userId,last_message_at:'2026-10-02T12:00:00Z',created_at:'2026-10-01T12:00:00Z',updated_at:'2026-10-02T12:00:00Z'}));
    if(${otherCreator})convs[1].created_by=otherId;
    // Production's schema before 0475/0476: no is_family_chat, none of the new
    // RPCs (PostgREST's PGRST202 naming each) and no preference table.
    const legacy=${legacy};
    if(legacy)for(const conv of convs)delete conv.is_family_chat;
    const base=(id,conversation_id,content,sender_id=otherId)=>({id,conversation_id,content,sender_id,family_id:familyId,sender_name:sender_id===userId?'Alex':'Blair',kind:'text',attachment_url:null,attachment_name:null,attachment_mime:null,reply_to_id:null,reactions:{},read_by:[],is_pinned:false,deleted_at:null,created_at:'2026-10-02T12:00:00Z',edited_at:null});
    p.rows=[base('40000000-0000-4000-8000-000000000001',A,'Message from A'),base('40000000-0000-4000-8000-000000000002',B,'Message from B')];
    if(${olderHistory}){
      for(let i=0;i<55;i++)p.rows.push({...base('old-'+String(i).padStart(3,'0'),A,'History '+i),created_at:new Date(Date.parse('2026-10-01T12:00:00Z')+i*60000).toISOString()});
      p.rows.push({...base('old-pin',A,'Pinned from before the loaded page'),is_pinned:true,created_at:'2026-09-01T12:00:00Z'});
      p.rows.push({...base('old-photo',A,null),kind:'image',attachment_url:'family/messages/older.jpg',attachment_name:'Older family photo',created_at:'2026-09-01T12:01:00Z'});
    }
    p.flush=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    p.releaseA=async()=>{p.holdA=false;for(const resolve of p.pending.splice(0))resolve();await p.flush();};
    p.releaseInsert=async()=>{p.holdInsert=false;for(const resolve of p.pendingInsert.splice(0))resolve();await p.flush();};
    function query(table){let action='select',input=null,filters=[],order=[],limit=Infinity,offset=0,singular=false,cursor=null,inside=null;
      const q={select:()=>q,eq:(key,value)=>{filters.push([key,value]);return q;},is:(key,value)=>{filters.push([key,value]);return q;},in:(key,values)=>{inside=[key,values];return q;},order:(key,opts)=>{order.push([key,opts]);return q;},limit:value=>{limit=value;return q;},range:(from,to)=>{offset=from;limit=to-from+1;return q;},or:value=>{cursor=value;return q;},ilike:()=>q,abortSignal:()=>q,insert:value=>{action='insert';input=value;return q;},update:value=>{action='update';input=value;return q;},upsert:value=>{action='upsert';input=value;return q;},single:()=>{singular=true;return execute();},maybeSingle:()=>{singular=true;return execute();},then:(resolve,reject)=>execute().then(resolve,reject)};
      async function execute(){
        if(legacy&&table==='family_conversation_preferences')return{data:null,error:{code:'PGRST205',message:"Could not find the table 'public.family_conversation_preferences' in the schema cache"}};
        let rows=table==='family_conversations'?convs:table==='family_messages'?p.rows:[];
        let selected=rows.filter(row=>filters.every(([key,value])=>row[key]===value));
        if(inside)selected=selected.filter(row=>inside[1].includes(row[inside[0]]));
        if(cursor){const time=cursor.match(/created_at\\.lt\\.([^,]+)/)?.[1],id=cursor.match(/id\\.(lt|lte)\\.([^)]*)/) ;selected=selected.filter(row=>row.created_at<time||(row.created_at===time&&id&&(id[1]==='lte'?row.id<=id[2]:row.id<id[2])));}
        const count=selected.length;
        if(action==='insert'){p.insertIds.push(input.id);if(p.failInserts-->0)throw new Error('Network unavailable');const row={...base(input.id,input.conversation_id,input.content,input.sender_id),...input,created_at:'2026-10-02T12:01:00Z'};p.rows.push(row);p.writes.push(row);selected=[row];if(p.holdInsert)await new Promise(resolve=>p.pendingInsert.push(resolve));if(p.loseInsertResponse){p.loseInsertResponse=false;return{data:null,error:{message:'Response lost'}};}}
        else if(action==='update'){
          if(table==='family_conversations'){
            p.archiveCalls.push({filters:[...filters],input:{...input}});
            if(p.holdArchive){const outcome=await new Promise(resolve=>p.pendingArchive.push(resolve));if(outcome==='denied')return{data:null,error:{code:'42501',message:'Synthetic archive denied'}};if(outcome==='zero')return{data:null,error:null};}
          }
          for(const row of selected)Object.assign(row,input);p.writes.push(input);
        }
        else if(action==='upsert'){selected=[input];p.writes.push(input);}
        else if(table==='family_messages'){
          selected=[...selected].sort((a,b)=>{for(const [key,opts] of order){const n=String(a[key]).localeCompare(String(b[key]));if(n)return opts?.ascending===false?-n:n;}return 0;});
          selected=selected.slice(offset,offset+limit).map(row=>({...row,read_by:[...row.read_by]}));
          if(p.holdA&&filters.some(([key,value])=>key==='conversation_id'&&value===A))await new Promise(resolve=>p.pending.push(resolve));
        }
        // Like actual SDK JSON, responses never share mutable database-row objects with React state.
        return {data:JSON.parse(JSON.stringify(singular?(selected[0]??null):selected)),count,error:null};
      }return q;
    }
    const db={from:query,rpc:(name,args)=>{
      if(!legacy&&name==='family_conversation_overview'){let offset=0,limit=Infinity;const rows=convs.map(conv=>{const rows=p.rows.filter(row=>row.conversation_id===conv.id);return{conversation_id:conv.id,last_message:rows.at(-1)||null,unread_count:rows.filter(row=>row.sender_id!==userId&&!row.read_by.includes(userId)).length};}).sort((a,b)=>a.conversation_id.localeCompare(b.conversation_id));const q={order:()=>q,limit:n=>{limit=n;return q;},range:(from,to)=>{offset=from;limit=to-from+1;return q;},then:(resolve,reject)=>Promise.resolve({data:rows.slice(offset,offset+limit),count:rows.length,error:null}).then(resolve,reject)};return q;}
      return (async()=>{
      if(legacy&&name==='mark_conversation_read'){p.reads.push({legacy:name,...args});for(const row of p.rows)if(row.conversation_id===args.p_conversation_id)row.read_by=[...new Set([...row.read_by,userId])];return{data:null,error:null};}
      if(legacy)return{data:null,error:{code:'PGRST202',message:'Could not find the function public.'+name+'('+Object.keys(args).join(', ')+') in the schema cache'}};
      if(name==='ensure_family_conversation')return{data:A,error:null};
      if(name==='family_conversation_overview')return{data:convs.map(conv=>{const rows=p.rows.filter(row=>row.conversation_id===conv.id);return{conversation_id:conv.id,last_message:rows.at(-1)||null,unread_count:rows.filter(row=>row.sender_id!==userId&&!row.read_by.includes(userId)).length};}),error:null};
      if(name==='mark_conversation_read_through'){p.reads.push(args);for(const row of p.rows)if(row.conversation_id===args.p_conversation_id)row.read_by=[...new Set([...row.read_by,userId])];return{data:1,error:null};}
      if(name==='leave_family_conversation'){const index=convs.findIndex(conv=>conv.id===args.p_conversation_id);if(index>=0)convs.splice(index,1);return{data:null,error:null};}
      throw new Error('Unexpected RPC '+name);
      })();
    },channel:name=>{const c={on:()=>c,subscribe:()=>c,track:async()=>{},untrack:async()=>{},send:async()=>{},presenceState:()=>({})};p.channels.push(name);return c;},removeChannel:async()=>{}};
    const translate=(key,vars={})=>Object.entries(vars).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),catalogue[key]||key);
    const fmt={fmtDate:iso=>new Date(iso).toLocaleDateString('en-US'),fmtTime:iso=>new Date(iso).toLocaleTimeString('en-US')};
    const clock={dayKeyOf:iso=>iso.slice(0,10),todayKey:()=> '2026-10-02',wallKey:()=> '2026-10-01',addDays:x=>x,wallToday:()=>new Date('2026-10-02')};
    const toast={error:message=>p.notices.push(message),success:message=>p.notices.push(message)};
    const mocks={react:React,'react-dom':ReactDOM,'lucide-react':window.LucideReact,
      '@/components/app/app-context':{useApp:()=>({familyId,userId,members,selfMember:members[0],role:sessionRole})},
      '@/components/i18n/locale-provider':{useTranslations:()=>translate,useLocale:()=>({code:'en-US'})},
      '@/components/i18n/use-format':{useFormat:()=>fmt,useFamilyClock:()=>clock},
      '@/lib/utils/format':{firstName:name=>name.split(' ')[0],initials:name=>name.slice(0,2),createFormat:()=>fmt},
      '@/components/ui/toast':{useToast:()=>toast},'@/components/ai/ai-insight':{AiInsight:()=>null},
      '@/lib/supabase/client':{createClient:()=>db},'@/lib/storage/use-family-media':{useFamilyMediaUrls:()=>()=>undefined},
      '@/components/media/family-media-img':{FamilyMediaImg:props=>h('div',{role:'img','aria-label':props.alt,className:props.className})}};
    function load(id){if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected module '+id);const module=loaded[id]={exports:{}};new Function('require','module','exports',item.source)(name=>load(item.imports[name]),module,module.exports);return module.exports;}
    const root=ReactDOM.createRoot(document.getElementById('root'));
    const render=()=>ReactDOM.flushSync(()=>root.render(h(load(entry).MessagesModule)));
    p.setAuthority=(role,active=true)=>{sessionRole=role;members[0]={...members[0],role,is_active:active};render();};
    p.resolveArchive=(outcome='success')=>{const resolve=p.pendingArchive.shift();if(!resolve)throw new Error('No synthetic pending archive');resolve(outcome);};
    p.unmount=()=>ReactDOM.flushSync(()=>root.unmount());
    render();
  })();` });
  await page.evaluate(() => (window as any).__familyChat.flush());
  expect(await page.evaluate(() => (window as any).__familyChat.errors)).toEqual([]);
  if (!legacy) await expect(page.getByRole('button', { name: /^💬 Chat B/ })).toBeVisible();
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Type a message...' });
const select = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^💬 Chat ${name}`) }).click();
const clean = async (page: Page) => expect(await page.evaluate(() => (window as any).__familyChat.errors)).toEqual([]);

test('a confirmed send renders without any realtime event', async ({ page }) => {
  await fixture(page);
  await expect(page.locator(`#message-40000000-0000-4000-8000-000000000001`)).toBeVisible();
  await composer(page).fill('Saved without websocket');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('[id^="message-"]').filter({ hasText: 'Saved without websocket' })).toBeVisible();
  await expect(composer(page)).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__familyChat.writes.length)).toBe(1);
  await clean(page);
});

test('late A history cannot replace B after switching threads', async ({ page }) => {
  await fixture(page, { holdA: true });
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.pending.length)).toBeGreaterThan(0);
  await select(page, 'B');
  await expect(page.locator('#message-40000000-0000-4000-8000-000000000002')).toBeVisible();
  await page.evaluate(() => (window as any).__familyChat.releaseA());
  await expect(page.locator('#message-40000000-0000-4000-8000-000000000001')).toHaveCount(0);
  await expect(page.locator('#message-40000000-0000-4000-8000-000000000002')).toBeVisible();
  await clean(page);
});

test('drafts and reply targets stay with their conversation', async ({ page }) => {
  await fixture(page);
  await page.locator('#message-40000000-0000-4000-8000-000000000001').getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await composer(page).fill('Draft only for A');
  await select(page, 'B');
  await expect(composer(page)).toHaveValue('');
  await expect(page.getByText('Replying to', { exact: false })).toHaveCount(0);
  await composer(page).fill('Draft only for B');
  await select(page, 'A');
  await expect(composer(page)).toHaveValue('Draft only for A');
  await expect(page.getByText('Replying to', { exact: false })).toBeVisible();
  await clean(page);
});

test('opening the mobile inbox does not mark its hidden thread read', async ({ page }) => {
  await fixture(page, { mobile: true });
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.rows.length)).toBe(2);
  await page.evaluate(() => (window as any).__familyChat.flush());
  expect(await page.evaluate(() => (window as any).__familyChat.reads)).toEqual([]);
  await select(page, 'B');
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.reads.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__familyChat.reads[0].p_conversation_id)).toBe(conversationB);
  await clean(page);
});

test('retry preserves the draft and reuses its original message id', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).__familyChat.failInserts = 1; });
  await composer(page).fill('Retry this exact message');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.notices.length)).toBe(1);
  await expect(composer(page)).toHaveValue('Retry this exact message');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('[id^="message-"]').filter({ hasText: 'Retry this exact message' })).toHaveCount(1);
  const ids = await page.evaluate(() => (window as any).__familyChat.insertIds);
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]);
  await clean(page);
});

test('a committed send with a lost response is reconciled without duplication', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).__familyChat.loseInsertResponse = true; });
  await composer(page).fill('Saved despite lost response');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(composer(page)).toHaveValue('');
  await expect(page.locator('[id^="message-"]').filter({ hasText: 'Saved despite lost response' })).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__familyChat.writes.length)).toBe(1);
  await clean(page);
});

test('a late send confirmation cannot clear a different thread draft', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { (window as any).__familyChat.holdInsert = true; });
  await composer(page).fill('Send from A');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.pendingInsert.length)).toBe(1);
  await select(page, 'B');
  await composer(page).fill('Keep this B draft');
  await page.evaluate(() => (window as any).__familyChat.releaseInsert());
  await expect(composer(page)).toHaveValue('Keep this B draft');
  await expect(page.locator('[id^="message-"]').filter({ hasText: 'Send from A' })).toHaveCount(0);
  await clean(page);
});

test('late microphone permission stops its tracks after a thread switch', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const state = (window as any).__familyChat;
    state.tracksStopped = 0; state.recordersCreated = 0;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: () => new Promise(resolve => { state.grantMic = () => resolve({ getTracks: () => [{ stop: () => state.tracksStopped++ }] }); }) } });
    (window as any).MediaRecorder = class { constructor() { state.recordersCreated++; } };
  });
  await page.getByRole('button', { name: 'Record voice message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__familyChat.grantMic))).toBe(true);
  await select(page, 'B');
  await page.evaluate(() => (window as any).__familyChat.grantMic());
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.tracksStopped)).toBe(1);
  expect(await page.evaluate(() => (window as any).__familyChat.recordersCreated)).toBe(0);
  await clean(page);
});

test('pins and shared photos can reach beyond the initially loaded history page', async ({ page }) => {
  await fixture(page, { olderHistory: true });
  await expect(page.locator('#message-old-pin')).toHaveCount(0);
  await page.getByRole('button', { name: 'Pinned messages', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Pinned from before the loaded page');
  await page.getByRole('dialog').getByRole('button', { name: /Pinned from before the loaded page/ }).click();
  await expect(page.locator('#message-old-pin')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to latest messages' })).toBeVisible();
  await page.getByRole('button', { name: 'All shared photos', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Older family photo', { exact: true })).toBeVisible();
  await clean(page);
});

test('shared archive is explicit and read-only; recorded participants remain immutable', async ({ page }) => {
  await fixture(page);
  await select(page, 'B');
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('for everyone in this chat');
  await page.getByRole('dialog').getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect(composer(page)).toBeDisabled();
  await expect(page.getByText('This chat is archived. Restore it to send new messages.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave chat', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add members', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^💬 Chat B/ })).toHaveCount(1);
  await clean(page);
});

// A missing participant schema must never adopt/render a family-wide legacy
// inbox or retry a privacy-sensitive operation under weaker authorization.
test('without 0475/0476 the workspace refuses legacy adoption and private reads', async ({ page }) => {
  await fixture(page, { legacy: true });
  await expect(page.locator('[id^="message-"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^💬 Chat/ })).toHaveCount(0);
  await expect(composer(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__familyChat.writes)).toEqual([]);
  expect(await page.evaluate(() => (window as any).__familyChat.reads)).toEqual([]);
  await clean(page);
});

for (const theme of ['light', 'dark']) for (const mobile of [true, false]) {
  test(`${theme} ${mobile ? 'mobile' : 'desktop'} uses real styles without horizontal overflow`, async ({ page }, testInfo) => {
    await fixture(page, { theme, mobile });
    if (mobile) await select(page, 'A');
    await composer(page).fill('A long draft with a newline\n' + 'long-word-'.repeat(18));
    await expect(composer(page)).toBeVisible();
    const measurements = await page.evaluate(() => {
      const input = document.querySelector('textarea')!;
      const rect = input.getBoundingClientRect();
      const style = getComputedStyle(input);
      const rgb = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim().split(/\s+/).map(Number);
      const luminance = (values: number[]) => values.map(value => { const x = value / 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }).reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
      const fg = luminance(rgb('--fg')), bg = luminance(rgb('--elevated'));
      return { scrollWidth: document.documentElement.scrollWidth, width: innerWidth, left: rect.left, right: rect.right, fontSize: parseFloat(style.fontSize), contrast: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05), display: getComputedStyle(input.closest('form')!).display };
    });
    expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.width + 1);
    expect(measurements.left).toBeGreaterThanOrEqual(0);
    expect(measurements.right).toBeLessThanOrEqual(measurements.width);
    expect(measurements.fontSize).toBeGreaterThanOrEqual(14);
    expect(measurements.contrast).toBeGreaterThanOrEqual(4.5);
    expect(measurements.display).toBe('flex');
    await page.screenshot({ path: testInfo.outputPath(`messenger-${theme}-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
    await clean(page);
  });
}


async function deliverQueuedThreadSelection(page: Page, name: string) {
  // Dispatch the already queued selection directly to its real React handler;
  // a pointer click at the background coordinates would hit the modal overlay.
  await page.evaluate(value => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('Chat ' + value) && node.textContent.includes('💬'));
    if (!button) throw new Error('Conversation selection button not found');
    button.click();
  }, name);
}

async function retainArchiveConfirmation(page: Page) {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(node => node.textContent === 'Archive chat');
    if (!button) throw new Error('Archive confirmation button not found');
    const props = Object.keys(button).find(key => key.startsWith('__reactProps$'));
    if (!props) throw new Error('Actual React event props not found');
    (window as any).__familyChat.retainedArchive = (button as any)[props].onClick;
  });
}

for (const retirement of ['thread', 'ABA', 'role', 'inactive', 'close-reopen', 'unmount']) test('retained archive confirmation refuses ' + retirement + ' before dispatch', async ({ page }) => {
  await fixture(page, { otherCreator: true }); await select(page, 'B');
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await retainArchiveConfirmation(page);
  if (retirement === 'thread' || retirement === 'ABA') await deliverQueuedThreadSelection(page, 'A');
  if (retirement === 'ABA') await select(page, 'B');
  if (retirement === 'role') await page.evaluate(() => (window as any).__familyChat.setAuthority('child'));
  if (retirement === 'inactive') await page.evaluate(() => (window as any).__familyChat.setAuthority('parent', false));
  if (retirement === 'close-reopen') {
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  }
  if (retirement === 'unmount') await page.evaluate(() => (window as any).__familyChat.unmount());
  await page.evaluate(() => (window as any).__familyChat.retainedArchive());
  await page.evaluate(() => (window as any).__familyChat.flush());
  expect(await page.evaluate(() => (window as any).__familyChat.archiveCalls)).toEqual([]);
  if (retirement === 'close-reopen') {
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive chat', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__familyChat.archiveCalls.length)).toBe(1);
    await expect(composer(page)).toBeDisabled();
  }
  if (retirement === 'role' || retirement === 'inactive') {
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archive chat', exact: true })).toHaveCount(0);
  }
  await clean(page);
});

for (const outcome of ['success', 'denied', 'zero']) test('pending archive ' + outcome + ' cannot repaint another thread or publish stale feedback', async ({ page }) => {
  await fixture(page); await select(page, 'B');
  await page.evaluate(() => (window as any).__familyChat.holdArchive = true);
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.pendingArchive.length)).toBe(1);
  await deliverQueuedThreadSelection(page, 'A');
  const notices = await page.evaluate(() => (window as any).__familyChat.notices.length);
  await page.evaluate(result => (window as any).__familyChat.resolveArchive(result), outcome);
  await page.evaluate(() => (window as any).__familyChat.flush());
  await expect(page.locator('#message-40000000-0000-4000-8000-000000000001')).toBeVisible();
  await expect(page.locator('#message-40000000-0000-4000-8000-000000000002')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(composer(page)).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__familyChat.notices.length)).toBe(notices);
  expect(await page.evaluate(() => (window as any).__familyChat.archiveCalls.length)).toBe(1);
  await clean(page);
});

for (const outcome of ['denied', 'zero']) test('current archive ' + outcome + ' stays retryable without success', async ({ page }) => {
  await fixture(page); await select(page, 'B');
  await page.evaluate(() => (window as any).__familyChat.holdArchive = true);
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.pendingArchive.length)).toBe(1);
  await page.evaluate(result => (window as any).__familyChat.resolveArchive(result), outcome);
  await page.evaluate(() => (window as any).__familyChat.flush());
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Archive chat', exact: true })).toBeEnabled();
  await expect(composer(page)).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__familyChat.notices.length)).toBe(1);
  await clean(page);
});


test('two archive clicks before React rerenders dispatch only once', async ({ page }) => {
  await fixture(page); await select(page, 'B');
  await page.evaluate(() => (window as any).__familyChat.holdArchive = true);
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await retainArchiveConfirmation(page);
  await page.evaluate(() => { (window as any).__familyChat.retainedArchive(); (window as any).__familyChat.retainedArchive(); });
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.pendingArchive.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__familyChat.archiveCalls.length)).toBe(1);
  await page.evaluate(() => (window as any).__familyChat.resolveArchive());
  await expect(composer(page)).toBeDisabled(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await clean(page);
});


for (const captured of ['before-modal', 'current-modal']) test('a retained ' + captured + ' opener cannot replace a pending archive', async ({ page }) => {
  await fixture(page); await select(page, 'B');
  const retainOpener = async () => page.evaluate(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => !node.closest('[role="dialog"]') && node.textContent?.trim() === 'Archive chat');
    if (!button) throw new Error('Archive opener not found');
    const props = Object.keys(button).find(key => key.startsWith('__reactProps$'));
    if (!props) throw new Error('Actual React event props not found');
    (window as any).__familyChat.retainedOpener = (button as any)[props].onClick;
  });
  if (captured === 'before-modal') await retainOpener();
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  if (captured === 'current-modal') await retainOpener();
  await page.evaluate(() => (window as any).__familyChat.holdArchive = true);
  await page.getByRole('dialog').getByRole('button', { name: 'Archive chat', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__familyChat.pendingArchive.length)).toBe(1);
  await page.evaluate(() => (window as any).__familyChat.retainedOpener());
  await page.evaluate(() => (window as any).__familyChat.flush());
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__familyChat.resolveArchive());
  await expect(composer(page)).toBeDisabled(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__familyChat.archiveCalls.length)).toBe(1);
  await clean(page);
});
