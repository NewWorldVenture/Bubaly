import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual JoinInvite and installed React/DOM, including real effect cleanup and
// StrictMode replay. Next navigation, Auth and server actions are controlled
// boundaries. This proves component consent/ownership, not database enrollment;
// join-invite-http.spec.ts owns the separate native Next/Auth/PostgREST proof.
const scripts = reactBrowserScripts('development');
const isolated = new Set([
  'react', 'next/link', 'next/navigation', 'lucide-react',
  '@/components/ui/button', '@/components/ui/states',
  '@/components/i18n/locale-provider', '@/lib/supabase/client',
  '@/app/(auth)/actions', '@/app/join/actions',
]);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve(filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name)) { item.imports[name] = name; continue; }
    const base = name.startsWith('@/') ? path.resolve(name.slice(2))
      : name.startsWith('.') ? path.resolve(path.dirname(id), name) : '';
    const resolved = base && [base, `${base}.ts`, `${base}.tsx`].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!resolved) throw new Error(`Unallocated invite fixture dependency: ${name}`);
    item.imports[name] = collect(resolved);
  }
  return id;
}
const entry = collect('components/auth/join-invite.tsx');
const catalogue = JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8'));
const origin = 'http://127.0.0.1:31919';
type Options = { token?: string; strict?: boolean; holdPreview?: boolean; holdAccept?: boolean; holdSettlement?: boolean; holdLanding?: boolean };
type Probe = {
  previews: string[]; accepts: string[]; completions: string[]; pushes: string[]; refreshes: number; settlements: number; landings: number; errors: string[];
  settlementPending: boolean; landingPending: boolean;
  navigate(token: string): void; releasePreview(index: number): void; releaseAccept(): void;
  releaseSettlement(): void; releaseLanding(): void;
  replaceTranslator(): void;
  captureAccept(): void; invokeCapturedAccept(): Promise<void>; unmount(): void; flush(): Promise<void>;
};
declare global { interface Window { __joinInviteOwnership: Probe } }

async function fixture(page: Page, options: Options = {}) {
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin && url.pathname === '/join'
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' })
      : route.abort('blockedbyclient');
  });
  await page.goto(`${origin}/join?token=${encodeURIComponent(options.token ?? 'token-a')}`);
  await page.addScriptTag({ content: scripts.react });
  await page.addScriptTag({ content: scripts.reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)}, entry=${JSON.stringify(entry)}, catalogue=${JSON.stringify(catalogue)}, options=${JSON.stringify(options)};
    const h=React.createElement, loaded={}, previewWaiters=[];
    let acceptRelease=null, settlementRelease=null, landingRelease=null, capturedAccept=null, latestAccept=null;
    const p=window.__joinInviteOwnership={previews:[],accepts:[],completions:[],pushes:[],refreshes:0,settlements:0,landings:0,errors:[],settlementPending:false,landingPending:false};
    window.addEventListener('error',event=>p.errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>p.errors.push(String(event.reason)));
    const translate=(key,params={})=>Object.entries(params).reduce((text,[name,value])=>text.split('{'+name+'}').join(String(value)),catalogue[key]||key);
    const query=React.createContext(new URLSearchParams(location.search));
    const translations=React.createContext(translate);
    const user={id:'synthetic-user',email:'invitee@example.test'};
    const previews={
      'token-a':{ok:true,familyName:'Synthetic Family A',roleLabel:'Caregiver'},
      'token-b':{ok:true,familyName:'Synthetic Family B',roleLabel:'Adult'},
    };
    const db={
      auth:{getUser:async()=>({data:{user},error:null})},
      rpc:async(name,args)=>{
        if(name!=='accept_invite')throw new Error('Unexpected synthetic RPC');
        const token=args.p_token;
        p.accepts.push(token);
        if(options.holdAccept)await new Promise(resolve=>{acceptRelease=resolve;});
        if(!previews[token])return {data:null,error:{code:'P0001',message:'Invite is invalid or expired'}};
        p.completions.push(token);
        return {data:token==='token-a'?'synthetic-family-a':'synthetic-family-b',error:null};
      },
    };
    const mocks={
      react:React,
      'next/link':{default:({children,...props})=>h('a',props,children)},
      'next/navigation':{
        useSearchParams:()=>React.useContext(query),
        useRouter:()=>({push:url=>p.pushes.push(url),refresh:()=>{p.refreshes++;}}),
      },
      'lucide-react':new Proxy({},{get:(_target,name)=>name==='__esModule'?false:()=>null}),
      '@/components/ui/button':{Button:({children,loading,variant,...props})=>{
        if(children===translate('joinInvite.acceptInvitation'))latestAccept=props.onClick;
        return h('button',{...props,disabled:props.disabled||loading},children);
      }},
      '@/components/ui/states':{LoadingBlock:({label})=>h('p',{role:'status'},label||'Loading')},
      '@/components/i18n/locale-provider':{useTranslations:()=>React.useContext(translations)},
      '@/lib/supabase/client':{createClient:()=>db},
      '@/app/(auth)/actions':{resolveLandingPathAction:async()=>{
        p.landings++;
        if(options.holdLanding){p.landingPending=true;await new Promise(resolve=>{landingRelease=resolve;});p.landingPending=false;}
        return '/synthetic-landing';
      }},
      '@/app/join/actions':{
        previewInviteAction:async token=>{
          p.previews.push(token);
          const answer=previews[token]||{ok:false,reason:'invalid'};
          if(options.holdPreview)await new Promise(resolve=>previewWaiters.push(resolve));
          return answer;
        },
        settleOtherInvitesAction:async()=>{
          p.settlements++;
          if(options.holdSettlement){p.settlementPending=true;await new Promise(resolve=>{settlementRelease=resolve;});p.settlementPending=false;}
          return {ok:true};
        },
      },
    };
    function load(id){
      if(id in mocks)return mocks[id];
      if(loaded[id])return loaded[id].exports;
      const item=sources[id];if(!item)throw new Error('Unexpected synthetic import: '+id);
      const module={exports:{}};loaded[id]=module;
      new Function('module','exports','require',item.source)(module,module.exports,name=>load(item.imports[name]));
      return module.exports;
    }
    const JoinInvite=load(entry).JoinInvite;
    let setQuery, setTranslator;
    function App(){
      const [value,setValue]=React.useState(()=>new URLSearchParams(location.search));
      const [translator,replaceTranslator]=React.useState(()=>translate);
      setQuery=setValue;
      setTranslator=replaceTranslator;
      return h(translations.Provider,{value:translator},h(query.Provider,{value},h(JoinInvite)));
    }
    const root=ReactDOM.createRoot(document.getElementById('root'));
    root.render(options.strict===false?h(App):h(React.StrictMode,null,h(App)));
    // Deliberately controlled Next boundary: retain the same component instance
    // and deliver changed search params, as App Router's history API does.
    p.navigate=token=>{
      const url='/join'+(token?'?token='+encodeURIComponent(token):'');
      history.pushState({},'',url);
      setQuery(new URLSearchParams(location.search));
    };
    p.releasePreview=index=>{const done=previewWaiters[index];if(!done)throw new Error('Missing preview barrier');previewWaiters[index]=null;done();};
    p.releaseAccept=()=>{if(!acceptRelease)throw new Error('Missing accept barrier');const done=acceptRelease;acceptRelease=null;done();};
    p.releaseSettlement=()=>{if(!settlementRelease)throw new Error('Missing settlement barrier');const done=settlementRelease;settlementRelease=null;done();};
    p.releaseLanding=()=>{if(!landingRelease)throw new Error('Missing landing barrier');const done=landingRelease;landingRelease=null;done();};
    p.replaceTranslator=()=>setTranslator(()=>((key,params)=>translate(key,params)));
    p.captureAccept=()=>{if(!latestAccept)throw new Error('No accept handler');capturedAccept=latestAccept;};
    p.invokeCapturedAccept=async()=>{if(!capturedAccept)throw new Error('No captured handler');await capturedAccept();};
    p.unmount=()=>root.unmount();
    p.flush=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  })();` });
  await page.evaluate(() => window.__joinInviteOwnership.flush());
}

async function navigate(page: Page, token: string) {
  await page.evaluate(value => window.__joinInviteOwnership.navigate(value), token);
  await page.evaluate(() => window.__joinInviteOwnership.flush());
}
const confirm = (page: Page) => page.getByRole('button', { name: 'Accept invitation', exact: true });

test.use({ trace: 'off', screenshot: 'off', video: 'off', serviceWorkers: 'block' });
test.setTimeout(15_000);
test.afterEach(async ({ page }) => {
  const initialized = await page.evaluate(() => !!window.__joinInviteOwnership).catch(() => false);
  if (initialized) {
    const errors = await page.evaluate(() => {
      window.__joinInviteOwnership.unmount();
      return window.__joinInviteOwnership.errors;
    });
    expect(errors, 'No uncaught component or fixture error').toEqual([]);
  }
});

for (const strict of [false, true]) {
  test(`healthy explicit acceptance stays bound to its preview (StrictMode ${strict})`, async ({ page }) => {
    await fixture(page, { strict });
    await expect(page.getByText('You’re invited to join Synthetic Family A as Caregiver.')).toBeVisible();
    expect(await page.evaluate(() => window.__joinInviteOwnership.accepts)).toEqual([]);
    await confirm(page).click();
    await expect(page.getByText('Welcome to the family!', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => ({
      accepts: window.__joinInviteOwnership.accepts, completions: window.__joinInviteOwnership.completions,
    }))).toEqual({ accepts: ['token-a'], completions: ['token-a'] });
  });
}

test('an initially invalid invitation never offers acceptance', async ({ page }) => {
  await fixture(page, { token: 'invalid' });
  await expect(page.getByText('This invite is invalid or has expired. Ask whoever invited you to send a new one.')).toBeVisible();
  await expect(confirm(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__joinInviteOwnership.accepts)).toEqual([]);
});

test('a changed URL cannot submit a family different from the visible confirmation', async ({ page }) => {
  await fixture(page);
  await expect(confirm(page)).toBeVisible();
  await navigate(page, 'token-b');
  const displayedFamily = await page.locator('body').innerText();
  await confirm(page).click();
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.accepts.length)).toBe(1);
  const acceptedToken = await page.evaluate(() => window.__joinInviteOwnership.accepts[0]);
  expect({ shownA: displayedFamily.includes('Synthetic Family A'), shownB: displayedFamily.includes('Synthetic Family B'), acceptedToken })
    .toEqual({ shownA: false, shownB: true, acceptedToken: 'token-b' });
});

for (const token of ['invalid', '']) {
  test(`replacing a valid invitation with ${token || 'a missing token'} retires the old confirmation`, async ({ page }) => {
    await fixture(page);
    await expect(confirm(page)).toBeVisible();
    await navigate(page, token);
    expect(await page.evaluate(() => window.__joinInviteOwnership.accepts)).toEqual([]);
    await expect(confirm(page)).toHaveCount(0);
    await expect(page.getByText('Synthetic Family A', { exact: false })).toHaveCount(0);
  });
}

test('a late preview for A cannot become confirmation for the current B token', async ({ page }) => {
  await fixture(page, { holdPreview: true, strict: false });
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.previews)).toEqual(['token-a']);
  await navigate(page, 'token-b');
  await page.evaluate(() => window.__joinInviteOwnership.releasePreview(0));
  await page.evaluate(() => window.__joinInviteOwnership.flush());
  const state = await page.evaluate(() => ({
    previews: window.__joinInviteOwnership.previews, text: document.body.innerText,
  }));
  expect(state.previews).toEqual(['token-a', 'token-b']);
  expect(state.text).not.toContain('Synthetic Family A');
  await expect(confirm(page)).toHaveCount(0);
  await page.evaluate(() => window.__joinInviteOwnership.releasePreview(1));
  await expect(page.getByText('You’re invited to join Synthetic Family B as Adult.')).toBeVisible();
});

test('A to B to A requires the current visit preview, not the first pending A response', async ({ page }) => {
  await fixture(page, { holdPreview: true, strict: false });
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.previews)).toEqual(['token-a']);
  await navigate(page, 'token-b');
  await navigate(page, 'token-a');
  await page.evaluate(() => window.__joinInviteOwnership.releasePreview(0));
  await page.evaluate(() => window.__joinInviteOwnership.flush());
  await expect(confirm(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__joinInviteOwnership.previews)).toEqual(['token-a', 'token-b', 'token-a']);
  await page.evaluate(() => window.__joinInviteOwnership.releasePreview(2));
  await expect(confirm(page)).toBeVisible();
  await page.evaluate(() => window.__joinInviteOwnership.releasePreview(1));
  await page.evaluate(() => window.__joinInviteOwnership.flush());
  await expect(page.getByText('You’re invited to join Synthetic Family A as Caregiver.')).toBeVisible();
});

test('StrictMode cleanup rejects all retired A previews without requiring a single fetch', async ({ page }) => {
  await fixture(page, { holdPreview: true, strict: true });
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.previews.includes('token-a'))).toBe(true);
  await navigate(page, 'token-b');
  await page.evaluate(() => {
    window.__joinInviteOwnership.previews.forEach((token, index) => {
      if (token === 'token-a') window.__joinInviteOwnership.releasePreview(index);
    });
  });
  await page.evaluate(() => window.__joinInviteOwnership.flush());
  await expect(page.getByText('Synthetic Family A', { exact: false })).toHaveCount(0);
  await expect(confirm(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.__joinInviteOwnership.previews.includes('token-b'))).toBe(true);
  await page.evaluate(() => {
    window.__joinInviteOwnership.previews.forEach((token, index) => {
      if (token === 'token-b') window.__joinInviteOwnership.releasePreview(index);
    });
  });
  await expect(page.getByText('You’re invited to join Synthetic Family B as Adult.')).toBeVisible();
});

test('a retained A click handler is invalid after navigation to B', async ({ page }) => {
  await fixture(page);
  await expect(confirm(page)).toBeVisible();
  await page.evaluate(() => window.__joinInviteOwnership.captureAccept());
  await navigate(page, 'token-b');
  // Explicit old-handler replay is a controlled ownership boundary, not a
  // claim that browsers dispatch click events to unmounted DOM nodes.
  await page.evaluate(() => window.__joinInviteOwnership.invokeCapturedAccept());
  expect(await page.evaluate(() => window.__joinInviteOwnership.accepts)).toEqual([]);
});

test('one confirmed click cannot submit twice while its acceptance is pending', async ({ page }) => {
  await fixture(page, { holdAccept: true });
  await expect(confirm(page)).toBeVisible();
  await page.evaluate(() => {
    window.__joinInviteOwnership.captureAccept();
    void window.__joinInviteOwnership.invokeCapturedAccept();
    void window.__joinInviteOwnership.invokeCapturedAccept();
  });
  expect(await page.evaluate(() => window.__joinInviteOwnership.accepts)).toEqual(['token-a']);
  await page.evaluate(() => window.__joinInviteOwnership.releaseAccept());
  await expect(page.getByText('Welcome to the family!', { exact: true })).toBeVisible();
});

test('an already submitted A completion cannot replace or navigate the later B visit', async ({ page }) => {
  await fixture(page, { holdAccept: true });
  await confirm(page).click();
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.accepts)).toEqual(['token-a']);
  await navigate(page, 'token-b');
  await page.evaluate(() => window.__joinInviteOwnership.releaseAccept());
  await page.evaluate(() => window.__joinInviteOwnership.flush());
  expect(await page.evaluate(() => window.__joinInviteOwnership.completions)).toEqual(['token-a']);
  await expect(page.getByText('Welcome to the family!', { exact: true })).toHaveCount(0);
  await expect(page.getByText('You’re invited to join Synthetic Family B as Adult.')).toBeVisible();
  await page.waitForTimeout(1_600);
  expect(await page.evaluate(() => window.__joinInviteOwnership.pushes)).toEqual([]);
});

test('a healthy accepted invitation performs exactly one eventual navigation and refresh', async ({ page }) => {
  await fixture(page);
  await confirm(page).click();
  await expect(page.getByText('Welcome to the family!', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.pushes)).toEqual(['/synthetic-landing']);
  expect(await page.evaluate(() => ({
    accepts: window.__joinInviteOwnership.accepts, settlements: window.__joinInviteOwnership.settlements,
    landings: window.__joinInviteOwnership.landings, refreshes: window.__joinInviteOwnership.refreshes,
  }))).toEqual({ accepts: ['token-a'], settlements: 1, landings: 1, refreshes: 1 });
});

test('navigation while post-RPC sibling settlement awaits cannot confirm or redirect the later visit', async ({ page }) => {
  await fixture(page, { holdSettlement: true });
  await confirm(page).click();
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.settlementPending)).toBe(true);
  expect(await page.evaluate(() => window.__joinInviteOwnership.completions)).toEqual(['token-a']);
  await navigate(page, 'token-b');
  await page.evaluate(() => window.__joinInviteOwnership.releaseSettlement());
  await page.waitForTimeout(1_600);
  expect(await page.evaluate(() => ({
    hasAWelcome: document.body.innerText.includes('Welcome to the family!'),
    hasBPreview: document.body.innerText.includes('Synthetic Family B'),
    landings: window.__joinInviteOwnership.landings,
    pushes: window.__joinInviteOwnership.pushes,
  }))).toEqual({ hasAWelcome: false, hasBPreview: true, landings: 0, pushes: [] });
});

test('navigation while the post-success landing lookup awaits cannot schedule an old redirect', async ({ page }) => {
  await fixture(page, { holdLanding: true });
  await confirm(page).click();
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.landingPending)).toBe(true);
  expect(await page.evaluate(() => window.__joinInviteOwnership.completions)).toEqual(['token-a']);
  await navigate(page, 'token-b');
  await page.evaluate(() => window.__joinInviteOwnership.releaseLanding());
  await page.waitForTimeout(1_600);
  expect(await page.evaluate(() => ({
    hasAWelcome: document.body.innerText.includes('Welcome to the family!'),
    hasBPreview: document.body.innerText.includes('Synthetic Family B'),
    pushes: window.__joinInviteOwnership.pushes, refreshes: window.__joinInviteOwnership.refreshes,
  }))).toEqual({ hasAWelcome: false, hasBPreview: true, pushes: [], refreshes: 0 });
});

for (const leave of ['navigate', 'unmount'] as const) {
  test(`an already scheduled success redirect is retired on ${leave}`, async ({ page }) => {
    await fixture(page);
    await confirm(page).click();
    await expect(page.getByText('Welcome to the family!', { exact: true })).toBeVisible();
    await page.evaluate(() => window.__joinInviteOwnership.flush());
    expect(await page.evaluate(() => ({
      landings: window.__joinInviteOwnership.landings, pushes: window.__joinInviteOwnership.pushes,
    }))).toEqual({ landings: 1, pushes: [] });
    if (leave === 'navigate') await navigate(page, 'token-b');
    else await page.evaluate(() => window.__joinInviteOwnership.unmount());
    await page.waitForTimeout(1_600);
    expect(await page.evaluate(() => ({
      pushes: window.__joinInviteOwnership.pushes, refreshes: window.__joinInviteOwnership.refreshes,
    }))).toEqual({ pushes: [], refreshes: 0 });
  });
}

test('a translator update at the same token does not retire an already approved acceptance', async ({ page }) => {
  await fixture(page, { holdAccept: true });
  await confirm(page).click();
  await expect.poll(() => page.evaluate(() => window.__joinInviteOwnership.accepts)).toEqual(['token-a']);
  // A locale/catalogue provider can replace its translator function without
  // changing the invitation. The identity changes through real React context.
  await page.evaluate(() => window.__joinInviteOwnership.replaceTranslator());
  await page.evaluate(() => window.__joinInviteOwnership.flush());
  await page.evaluate(() => window.__joinInviteOwnership.releaseAccept());
  await page.waitForTimeout(1_600);
  expect(await page.evaluate(() => ({
    accepts: window.__joinInviteOwnership.accepts, completions: window.__joinInviteOwnership.completions,
    welcome: document.body.innerText.includes('Welcome to the family!'),
    pushes: window.__joinInviteOwnership.pushes, refreshes: window.__joinInviteOwnership.refreshes,
  }))).toEqual({ accepts: ['token-a'], completions: ['token-a'], welcome: true, pushes: ['/synthetic-landing'], refreshes: 1 });
});
