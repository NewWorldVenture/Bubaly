import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/navigation', '@/components/ui/toast', '@/lib/utils/cn']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, `${filename}.ts`, `${filename}.tsx`].find(f => fs.existsSync(f) && fs.statSync(f).isFile()) ?? filename);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? `module.exports={default:${JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).filter(([key]) => /^(phoneAuth\.|phoneInput\.)/.test(key))))}};`
    : /\.tsx?$/.test(id) ? ts.transpileModule(raw, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name) || name === '@supabase/supabase-js') { item.imports[name] = name; continue; }
    item.imports[name] = collect(name.startsWith('@/') ? path.resolve(name.slice(2)) : name.startsWith('.') && /\.tsx?$/.test(id)
      ? path.resolve(path.dirname(id), name) : require.resolve(name, { paths: [path.dirname(id)] }));
  }
  return id;
}
const entries = Object.fromEntries(['components/auth/phone-auth.tsx', 'components/i18n/locale-provider.tsx', 'lib/auth/password-client.ts',
  'lib/auth/browser-signout.ts', 'lib/auth/browser-session-storage.ts', 'lib/auth/pkce-initiation-client.ts'].map(p => [p, collect(p)]));
entries.ssr = collect(require.resolve('@supabase/ssr'));
const key = 'sb-phone-otp-provider-auth-token';
const origin='https://phone-otp-fixture.invalid',provider='https://phone-otp-provider.invalid';
const ids={a:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',b:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
function session(who:'a'|'b',kind='password') {
  const exp=Math.floor(Date.now()/1000)+3600;
  const claims={sub:ids[who],session_id:kind==='otp'?'33333333-3333-4333-8333-333333333333':who==='a'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222',exp,iss:provider+'/auth/v1',aud:'authenticated',role:'authenticated'};
  return {access_token:Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.synthetic',refresh_token:who+'-'+kind+'-synthetic-refresh',token_type:'bearer',expires_in:3600,expires_at:exp,
    user:{id:ids[who],phone:'+15550101234',email:who+'@example.invalid',aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:'2026-09-19T00:00:00Z'}};
}
type Probe={advanceCountdown:()=>void;timerCount:()=>number;sendFinished:number;throwSend:boolean;verified:number;paused:boolean;holdWrite:boolean;holdDispose:boolean;release:()=>void;drain:()=>Promise<void>;changeNext:()=>void;duplicate:()=>void;reset:()=>Promise<void>;rotate:()=>void;replaceMarker:()=>void;verifier:()=>string|null;errors:string[];routes:string[];refreshes:number;messages:string[];retire:()=>void;login:(who:'a'|'b')=>Promise<void>;logout:()=>string;snapshot:()=>{userId:string|null;generation:string;cookies:unknown[]}|null};
declare global { interface Window {__phoneOtp:Probe} }
test.use({trace:'off',screenshot:'off',video:'off'});
type Options={response?:unknown;status?:number;write?:boolean;dispose?:boolean;block?:'session'|'reservation'|'duplicate';sendHold?:boolean;sendStatus?:number;sendThrow?:boolean;skipCode?:boolean};
async function fixture(page:Page,hold=false,existing?:'a'|'b',options:Options={}) {
  let release:()=>Promise<void>=async()=>{};let verifies=0,sends=0,resets=0;let holdSend=!!options.sendHold;let releaseSend:()=>Promise<void>=async()=>{};
  await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(url.origin===origin){await route.fulfill({contentType:'text/html',body:'<!doctype html><main id="root"></main>'});return;}
    if(url.origin!==provider)throw new Error('Unexpected phone fixture destination');
    const headers={'access-control-allow-origin':origin,'access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS'};
    if(req.method()==='OPTIONS'){await route.fulfill({status:204,headers});return;}
    if(url.pathname==='/auth/v1/otp'){sends++;expect(req.postDataJSON().phone).toBe('+15550101234');releaseSend=()=>route.fulfill({status:options.sendStatus??200,contentType:'application/json',headers,body:options.sendStatus?JSON.stringify({msg:'SMS unavailable',error_code:'sms_send_failed'}):'{}'});if(!holdSend)await releaseSend();return;}
    if(url.pathname==='/auth/v1/recover'){resets++;await route.fulfill({contentType:'application/json',headers,body:'{}'});return;}
    if(url.pathname==='/auth/v1/verify'){
      verifies++;expect(req.postDataJSON()).toMatchObject({phone:'+15550101234',token:'123456',type:'sms'});
      release=()=>route.fulfill({status:options.status??200,contentType:'application/json',headers,body:JSON.stringify(options.response??session('a','otp'))});if(!hold)await release();return;
    }
    if(url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='password'){
      const who=req.postDataJSON().email.startsWith('b@')?'b':'a';await route.fulfill({contentType:'application/json',headers,body:JSON.stringify(session(who))});return;
    }
    if(url.pathname==='/auth/v1/user'){
      const claims=JSON.parse(Buffer.from(req.headers().authorization!.slice(7).split('.')[1],'base64url').toString());await route.fulfill({contentType:'application/json',headers,body:JSON.stringify(session(claims.sub===ids.b?'b':'a').user)});return;
    }
    throw new Error('Unexpected phone fixture endpoint');
  });
  await page.goto(origin+'/login');for(const content of[react,reactDom,sdk])await page.addScriptTag({content});
  const messages=Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json','utf8'))).filter(([key])=>/^(phoneAuth\.|phoneInput\.)/.test(key)));
  await page.addScriptTag({content:`(()=>{
    const sources=${JSON.stringify(modules)},entries=${JSON.stringify(entries)},loaded={},wrapped=new WeakSet();
    const p=window.__phoneOtp={errors:[],routes:[],refreshes:0,messages:[],verified:0,sendFinished:0,throwSend:false,paused:false,holdWrite:false,holdDispose:false};
    window.addEventListener('error',e=>p.errors.push(e.message));window.addEventListener('unhandledrejection',e=>{p.errors.push(String(e.reason));e.preventDefault();});
    const timers=new Map(),originalInterval=window.setInterval.bind(window),originalClear=window.clearInterval.bind(window);
    window.setInterval=(callback,delay,...args)=>{const id=originalInterval(callback,delay,...args);if(delay===1000)timers.set(id,()=>callback(...args));return id;};
    window.clearInterval=id=>{timers.delete(id);return originalClear(id);};
    p.timerCount=()=>timers.size;p.advanceCountdown=()=>{for(let n=0;n<30;n++)for(const callback of [...timers.values()])callback();};
    const process={env:{NEXT_PUBLIC_SUPABASE_URL:${JSON.stringify(provider)},NEXT_PUBLIC_SUPABASE_ANON_KEY:'synthetic-public-key'}};
    const mocks={react:React,'@supabase/supabase-js':window.supabase,'lucide-react':new Proxy({},{get:()=>()=>null}),
      'next/navigation':{useRouter:()=>({push:url=>p.routes.push(url),refresh:()=>p.refreshes++})},
      '@/components/ui/toast':{useToast:()=>({error:m=>p.messages.push(m),success:m=>p.messages.push(m)})},
      '@/lib/utils/cn':{cn:(...values)=>values.filter(v=>typeof v==='string').join(' ')}};
    function load(id){if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unknown module '+id);const module=loaded[id]={exports:{}};new Function('require','module','exports','process',item.source)(name=>load(item.imports[name]),module,module.exports,process);if(id===entries.ssr){const actual=module.exports;module.exports={...actual,createBrowserClient:(...args)=>{
      const options=args[2],cookies=options?.cookies;if(cookies?.setAll){const write=cookies.setAll;options.cookies={...cookies,setAll:async batch=>{
        if(p.holdWrite&&batch.some(c=>(c.name===${JSON.stringify(key)}||c.name.startsWith(${JSON.stringify(key+'.')}))&&c.options.maxAge!==0)){
          p.holdWrite=false;p.paused=true;await new Promise(resolve=>p.release=resolve);
        }return write(batch);
      }};}
      const client=actual.createBrowserClient(...args);if(!wrapped.has(client)){wrapped.add(client);const verify=client.auth.verifyOtp.bind(client.auth),send=client.auth.signInWithOtp.bind(client.auth),dispose=client.auth.dispose.bind(client.auth);
        client.auth.signInWithOtp=async(...args)=>{try{if(p.throwSend){p.throwSend=false;throw new Error('Synthetic thrown SMS transport');}return await send(...args);}finally{p.sendFinished++;}};
        client.auth.verifyOtp=async(...args)=>{try{return await verify(...args);}finally{p.verified++;}};
        client.auth.dispose=async()=>{if(p.holdDispose){p.holdDispose=false;p.paused=true;await new Promise(resolve=>p.release=resolve);}return dispose();};
      }return client;
    }};}return module.exports;}
    const Phone=load(entries['components/auth/phone-auth.tsx']).PhoneAuth,Locale=load(entries['components/i18n/locale-provider.tsx']).LocaleProvider;
    const password=load(entries['lib/auth/password-client.ts']),signout=load(entries['lib/auth/browser-signout.ts']),storage=load(entries['lib/auth/browser-session-storage.ts']);
    p.login=async who=>{const r=await password.signInWithOwnedSession({email:who+'@example.invalid',password:'synthetic-password'},()=>true);if(r.error)throw r.error;};
    p.logout=()=>signout.signOutBrowserSession(signout.captureSignOutIntent(),{revoke:false}).status;
    p.snapshot=()=>storage.captureBrowserSessionSnapshot();
    p.drain=async()=>{for(let n=0;n<4;n++)await new Promise(resolve=>setTimeout(resolve,0));};
    p.reset=async()=>{const r=await load(entries['lib/auth/pkce-initiation-client.ts']).sendOwnedRecoveryEmail('b@example.invalid',()=>true);if(r.error)throw r.error;};
    const desc=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
    p.block=kind=>Object.defineProperty(document,'cookie',{configurable:true,get:()=>desc.get.call(document),set:value=>{
      const name=value.slice(0,value.indexOf('='));const deny=kind==='reservation'?name===${JSON.stringify(key+'-pkce-initiation')}:name===${JSON.stringify(key)}||name.startsWith(${JSON.stringify(key+'.')});if(!deny)desc.set.call(document,value);
    }});
    p.duplicateSlot=()=>{for(const path of ['/','/login'])document.cookie=${JSON.stringify(key+'-pkce-initiation=session-v1-11111111111111111111111111111111; Path=')}+path;};
    p.replaceMarker=()=>{document.cookie=${JSON.stringify(key+'-pkce-initiation=session-v1-22222222222222222222222222222222; Path=/')};};
    p.verifier=()=>{const pair=document.cookie.split('; ').find(v=>v.startsWith(${JSON.stringify(key+'-code-verifier=')}));return pair?pair.slice(pair.indexOf('=')+1):null;};
    p.rotate=()=>{const cookie=document.cookie.split('; ').find(v=>v.startsWith(${JSON.stringify(key+'=')}));const encoded=decodeURIComponent(cookie.slice(cookie.indexOf('=')+1));const ssr=load(entries.ssr);const session=JSON.parse(ssr.stringFromBase64URL(encoded.slice(7)));const pieces=session.access_token.split('.');const claims=JSON.parse(atob(pieces[1].replace(/-/g,'+').replace(/_/g,'/')));claims.exp+=600;pieces[1]=btoa(JSON.stringify(claims)).replace(/=/g,'').split('+').join('-').split('/').join('_');session.access_token=pieces.join('.');session.expires_at=claims.exp;session.refresh_token+='-rotated';document.cookie=ssr.serializeCookieHeader(${JSON.stringify(key)},'base64-'+ssr.stringToBase64URL(JSON.stringify(session)),{path:'/'});};
    p.duplicate=()=>{const input=document.querySelector('[aria-label="Digit 1"]');let fiber=input[Object.keys(input).find(k=>k.startsWith('__reactFiber'))];while(fiber&&!fiber.memoizedProps?.onComplete)fiber=fiber.return;
      const button=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Verify'));const props=button[Object.keys(button).find(k=>k.startsWith('__reactProps'))];fiber.memoizedProps.onComplete('123456');props.onClick();};
    const root=ReactDOM.createRoot(document.getElementById('root'));let next='/dashboard/meals';p.retire=()=>ReactDOM.flushSync(()=>root.render(React.createElement('p',null,'Other route')));
    p.mount=()=>ReactDOM.flushSync(()=>root.render(React.createElement(Locale,{locale:'en-US',source:'default',messages:${JSON.stringify(messages)}},React.createElement(Phone,{next,onBack:p.retire}))));
    p.changeNext=()=>{next='/dashboard/calendar';p.mount();};
  })();`});
  if(existing)await page.evaluate(who=>window.__phoneOtp.login(who),existing);
  await page.evaluate(()=>((window.__phoneOtp as Probe&{mount:()=>void}).mount()));
  await page.getByRole('textbox',{name:'Phone number',exact:true}).fill('5550101234');
  if(options.sendThrow)await page.evaluate(()=>{window.__phoneOtp.throwSend=true;});
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  if(options.skipCode)return {release:()=>release(),verifies:()=>verifies,sends:()=>sends,releaseSend:()=>releaseSend(),resets:()=>resets,holdSends:()=>{holdSend=true;}};
  await expect(page.getByRole('textbox',{name:'Digit 1',exact:true})).toBeVisible();
  await page.evaluate(options=>{const p=window.__phoneOtp as Probe&{block:(kind:string)=>void;duplicateSlot:()=>void};p.holdWrite=!!options.write;p.holdDispose=!!options.dispose;if(options.block==='duplicate')p.duplicateSlot();else if(options.block)p.block(options.block);},options);
  for(let i=0;i<6;i++)await page.getByRole('textbox',{name:'Digit '+(i+1),exact:true}).fill(String(i+1));
  if(options.block&&options.block!=='session')await expect.poll(()=>page.evaluate(()=>window.__phoneOtp.messages.length)).toBe(1);
  else await expect.poll(()=>verifies).toBe(1);expect(sends).toBe(1);
  return {release:()=>release(),verifies:()=>verifies,sends:()=>sends,releaseSend:()=>releaseSend(),resets:()=>resets,holdSends:()=>{holdSend=true;}};
}
async function settled(page:Page){
  // Real SDK completion is neutral: rejected/retired work need not navigate.
  await expect.poll(()=>page.evaluate(()=>window.__phoneOtp.verified)).toBe(1);
  await page.evaluate(()=>window.__phoneOtp.drain());
}
async function unchanged(page:Page,before:Awaited<ReturnType<Probe['snapshot']>>){
  const after=await page.evaluate(()=>window.__phoneOtp.snapshot());
  expect(after?.userId??null).toBe(before?.userId??null);expect(after?.cookies??[]).toEqual(before?.cookies??[]);
  expect(await page.evaluate(()=>window.__phoneOtp.routes)).toEqual([]);
}
test.afterEach(async({page})=>{expect(await page.evaluate(()=>window.__phoneOtp?.errors??[])).toEqual([]);});
test('normal actual phone OTP control adopts A and navigates once',async({page})=>{
  const state=await fixture(page);await settled(page);
  expect(await page.evaluate(()=>window.__phoneOtp.snapshot()?.userId)).toBe(ids.a);
  expect(await page.evaluate(()=>window.__phoneOtp.routes)).toEqual(['/dashboard/meals']);expect(state.verifies()).toBe(1);expect(state.sends()).toBe(1);
});
for(const boundary of ['response','write']as const)for(const change of['logout','newer-login','unmount','different-number','destination']as const){
  test('held OTP '+boundary+' preserves '+change,async({page})=>{
    const state=await fixture(page,boundary==='response',change==='newer-login'?'a':'b',{write:boundary==='write'});
    if(boundary==='write')await expect.poll(()=>page.evaluate(()=>window.__phoneOtp.paused)).toBe(true);
    if(change==='logout')expect(await page.evaluate(()=>window.__phoneOtp.logout())).toBe('signed-out');
    if(change==='newer-login')await page.evaluate(()=>window.__phoneOtp.login('b'));
    if(change==='unmount')await page.evaluate(()=>window.__phoneOtp.retire());
    if(change==='destination')await page.evaluate(()=>window.__phoneOtp.changeNext());
    if(change==='different-number'){await page.getByRole('button',{name:'Use a different number',exact:true}).click();await page.getByRole('textbox',{name:'Phone number',exact:true}).fill('5550109876');}
    const before=await page.evaluate(()=>window.__phoneOtp.snapshot());if(change==='logout')expect(before).toBeNull();else expect(before?.userId).toBe(ids.b);
    if(boundary==='response')await state.release();else await page.evaluate(()=>window.__phoneOtp.release());
    await settled(page);await unchanged(page,before);expect(await page.evaluate(()=>window.__phoneOtp.messages)).toEqual([]);
  });
}
for(const code of ['otp_expired','otp_disabled'])test('provider rejection '+code+' preserves current login',async({page})=>{
  const state=await fixture(page,true,'b',{status:403,response:{msg:'Provider rejected code',error_code:code}});
  const before=await page.evaluate(()=>window.__phoneOtp.snapshot());await state.release();await settled(page);await unchanged(page,before);
  expect(await page.evaluate(()=>window.__phoneOtp.messages.length)).toBe(1);
});
for(const invalid of ['empty','missing-refresh','identity-mismatch','expired']as const)test('malformed '+invalid+' OTP receipt cannot authenticate',async({page})=>{
  const response:Record<string,unknown>={...session('a','otp')};
  if(invalid==='empty')for(const key of Object.keys(response))delete response[key];
  if(invalid==='missing-refresh')delete response.refresh_token;
  if(invalid==='identity-mismatch')response.user=session('b').user;
  if(invalid==='expired'){const pieces=String(response.access_token).split('.');const claims=JSON.parse(Buffer.from(pieces[1],'base64url').toString());claims.exp=1;pieces[1]=Buffer.from(JSON.stringify(claims)).toString('base64url');response.access_token=pieces.join('.');response.expires_at=1;response.expires_in=-1;}
  const state=await fixture(page,true,'b',{response});const before=await page.evaluate(()=>window.__phoneOtp.snapshot());await state.release();await settled(page);await unchanged(page,before);
  expect(await page.evaluate(()=>window.__phoneOtp.messages.length)).toBe(1);
});
test('automatic and manual handlers share a synchronous verification lock',async({page})=>{
  const state=await fixture(page,true);await page.evaluate(()=>window.__phoneOtp.duplicate());await page.evaluate(()=>window.__phoneOtp.drain());expect(state.verifies()).toBe(1);
  await state.release();await settled(page);expect(await page.evaluate(()=>window.__phoneOtp.routes)).toEqual(['/dashboard/meals']);
});
for(const block of ['session','reservation','duplicate']as const)test('refused '+block+' storage cannot adopt OTP',async({page})=>{
  const state=await fixture(page,false,'b',{block});await expect.poll(()=>page.evaluate(()=>window.__phoneOtp.messages.length)).toBe(1);
  expect(await page.evaluate(()=>window.__phoneOtp.snapshot()?.userId)).toBe(ids.b);expect(await page.evaluate(()=>window.__phoneOtp.routes)).toEqual([]);expect(state.verifies()).toBe(block==='session'?1:0);
});
for(const change of ['recovery','marker','rotation']as const)test('held OTP respects '+change,async({page})=>{
  const state=await fixture(page,true,'b');if(change==='recovery')await page.evaluate(()=>window.__phoneOtp.reset());
  if(change==='marker')await page.evaluate(()=>window.__phoneOtp.replaceMarker());if(change==='rotation')await page.evaluate(()=>window.__phoneOtp.rotate());
  const before=await page.evaluate(()=>window.__phoneOtp.snapshot()),verifier=await page.evaluate(()=>window.__phoneOtp.verifier());
  if(change==='recovery'){expect(state.resets()).toBe(1);expect(verifier).toBeTruthy();}
  await state.release();await settled(page);
  if(change==='rotation'){expect(await page.evaluate(()=>window.__phoneOtp.snapshot()?.userId)).toBe(ids.a);expect(await page.evaluate(()=>window.__phoneOtp.routes)).toEqual(['/dashboard/meals']);}
  else{await unchanged(page,before);expect(await page.evaluate(()=>window.__phoneOtp.verifier())).toBe(verifier);}
});
test('late provider rejection after newer login is silent',async({page})=>{
  const state=await fixture(page,true,'a',{status:403,response:{msg:'Expired code',error_code:'otp_expired'}});await page.evaluate(()=>window.__phoneOtp.login('b'));
  const before=await page.evaluate(()=>window.__phoneOtp.snapshot());await state.release();await settled(page);await unchanged(page,before);expect(await page.evaluate(()=>window.__phoneOtp.messages)).toEqual([]);
});
for(const change of ['unmount','different-number','destination']as const)test('late SMS send cannot advance after '+change,async({page})=>{
  const state=await fixture(page,false,undefined,{sendHold:true,skipCode:true});await expect.poll(state.sends).toBe(1);
  if(change==='unmount')await page.evaluate(()=>window.__phoneOtp.retire());if(change==='destination')await page.evaluate(()=>window.__phoneOtp.changeNext());
  if(change==='different-number')await page.getByRole('textbox',{name:'Phone number',exact:true}).fill('5550109876');
  await state.releaseSend();await page.evaluate(()=>window.__phoneOtp.drain());expect(await page.getByRole('textbox',{name:'Digit 1',exact:true}).count()).toBe(0);expect(await page.evaluate(()=>window.__phoneOtp.messages)).toEqual([]);
});
for(const change of ['marker','logout-refused']as const)test('held SDK disposal retires OTP after '+change,async({page})=>{
  await fixture(page,false,'b',{dispose:true});await expect.poll(()=>page.evaluate(()=>window.__phoneOtp.paused)).toBe(true);
  const adopted=await page.evaluate(()=>window.__phoneOtp.snapshot());expect(adopted?.userId).toBe(ids.a);
  if(change==='marker')await page.evaluate(()=>window.__phoneOtp.replaceMarker());
  else{
    await page.evaluate(()=>{(window.__phoneOtp as Probe&{block:(kind:string)=>void}).block('session');window.__phoneOtp.logout();});
    const current=await page.evaluate(()=>window.__phoneOtp.snapshot());expect(current?.userId).toBe(ids.a);expect(current?.generation).not.toBe(adopted?.generation);
  }
  const before=await page.evaluate(()=>window.__phoneOtp.snapshot());await page.evaluate(()=>window.__phoneOtp.release());await settled(page);await unchanged(page,before);
  expect(await page.evaluate(()=>window.__phoneOtp.messages)).toEqual([]);
});

for(const change of ['unmount','back','destination']as const)test('held resend retires without toast or countdown after '+change,async({page})=>{
  const state=await fixture(page,false,undefined,{skipCode:true});await expect(page.getByRole('textbox',{name:'Digit 1',exact:true})).toBeVisible();
  await page.evaluate(()=>window.__phoneOtp.advanceCountdown());state.holdSends();await page.getByRole('button',{name:'Resend code',exact:true}).click();await expect.poll(state.sends).toBe(2);
  if(change==='unmount')await page.evaluate(()=>window.__phoneOtp.retire());if(change==='destination')await page.evaluate(()=>window.__phoneOtp.changeNext());
  if(change==='back')await page.getByRole('button',{name:'Use a different number',exact:true}).click();
  await state.releaseSend();await expect.poll(()=>page.evaluate(()=>window.__phoneOtp.sendFinished)).toBe(2);await page.evaluate(()=>window.__phoneOtp.drain());
  expect(await page.evaluate(()=>window.__phoneOtp.messages)).toEqual([]);expect(await page.evaluate(()=>window.__phoneOtp.timerCount())).toBe(0);expect(state.verifies()).toBe(0);
});
test('thrown SMS send releases the attempt and a real SDK retry succeeds',async({page})=>{
  const state=await fixture(page,false,undefined,{sendThrow:true,skipCode:true});await expect.poll(()=>page.evaluate(()=>window.__phoneOtp.messages.length)).toBe(1);
  expect(state.sends()).toBe(0);await page.getByRole('button',{name:'Continue',exact:true}).click();await expect(page.getByRole('textbox',{name:'Digit 1',exact:true})).toBeVisible();
  expect(state.sends()).toBe(1);expect(await page.evaluate(()=>window.__phoneOtp.sendFinished)).toBe(2);expect(await page.evaluate(()=>window.__phoneOtp.timerCount())).toBe(1);
});
