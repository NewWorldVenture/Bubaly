import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// MAIN-F-D04, reproduced 2026-09-30 (#679): Escape closed Quick capture and the
// child wallet's dialogs, and focus fell to <body> instead of the trigger. Every
// one of them has a field with `autoFocus`, which takes focus while React
// commits the dialog, before the shared hook's effect records "previously
// focused"; the hook saved that field, and the field was gone on close.
//
// Actual Modal, dialog hook, locale provider and React in Chromium, operated by
// keyboard only. Only the document transport is controlled.
const { react, reactDom } = reactBrowserScripts('development');
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const file = [filename, `${filename}.ts`, `${filename}.tsx`, path.join(filename, 'index.ts')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!file) throw new Error(`Missing fixture source: ${filename}`);
  const id = path.resolve(file);
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (name === 'react' || name === 'react-dom') { item.imports[name] = name; continue; }
    const target = name.startsWith('@/') ? path.resolve(name.slice(2))
      : name.startsWith('.') ? path.resolve(path.dirname(id), name)
        : require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries([
  'components/ui/modal.tsx', 'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts',
].map(file => [file, collect(file)]));
const origin = 'https://modal-focus-return-fixture.invalid';
type Probe = {
  removeTrigger: () => void; closeA: () => void; removeOpenB: () => void; disableOpenB: () => void; inertOpenB: () => void;
  settle: () => Promise<void>; focus: () => { id: string; body: boolean; dialogs: string[] };
};
declare global { interface Window { __modalFocus: Probe } }

async function fixture(page: Page, options: { focusBeforeLoad?: boolean } = {}) {
  const errors: string[] = [], unexpected: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    if (route.request().url() !== `${origin}/`) { unexpected.push(route.request().url()); await route.abort(); return; }
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="root"></div></body></html>' });
  });
  await page.goto(`${origin}/`);
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  if (options.focusBeforeLoad) {
    // A trigger that has focus before the dialog code is even loaded, like a
    // button whose dialog lives in a chunk fetched on demand.
    await page.evaluate(() => {
      const trigger = Object.assign(document.createElement('button'), { id: 'pre-trigger', textContent: 'Open P' });
      document.body.prepend(trigger);
      trigger.focus();
      (window as unknown as { __openP: boolean }).__openP = true;
    });
  }
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)},entries=${JSON.stringify(entries)},loaded={},process={env:{NODE_ENV:'development'}};
    function load(id){if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected fixture module');const module=loaded[id]={exports:{}};new Function('require','module','exports','React','process',item.source)(name=>load(item.imports[name]),module,module.exports,React,process);return module.exports;}
    const Modal=load(entries['components/ui/modal.tsx']).Modal,Provider=load(entries['components/i18n/locale-provider.tsx']).LocaleProvider,locale=load(entries['lib/i18n/locales.ts']).DEFAULT_LOCALE;
    const h=React.createElement,p=window.__modalFocus={};
    function App(){
      const [a,setA]=React.useState(false),[b,setB]=React.useState(false),[r,setR]=React.useState(false),[plain,setPlain]=React.useState(false),[showR,setShowR]=React.useState(true);
      const [showOpenB,setShowOpenB]=React.useState(true),[pre,setPre]=React.useState(window.__openP===true);
      p.removeTrigger=()=>ReactDOM.flushSync(()=>setShowR(false));
      p.closeA=()=>ReactDOM.flushSync(()=>setA(false));
      p.removeOpenB=()=>ReactDOM.flushSync(()=>setShowOpenB(false));
      p.disableOpenB=()=>{document.getElementById('open-b').disabled=true;};
      p.inertOpenB=()=>{document.getElementById('open-b-wrap').setAttribute('inert','');};
      return h(Provider,{locale,source:'default',messages:{'modal.closeDialog':'Close'}},
        h('main',{id:'main-content'},
          h('button',{id:'open-a',onClick:()=>setA(true)},'Open A'),
          h('button',{id:'open-plain',onClick:()=>setPlain(true)},'Open plain'),
          showR?h('button',{id:'open-r',onClick:()=>setR(true)},'Open R'):null,
          // Like Quick capture and the wallet's dialogs: a field takes focus with autoFocus.
          h(Modal,{open:a,onClose:()=>setA(false),title:'Dialog A'},h('input',{id:'a-field','aria-label':'A field',autoFocus:true}),h('span',{id:'open-b-wrap'},showOpenB?h('button',{id:'open-b',onClick:()=>setB(true)},'Open B'):null)),
          h(Modal,{open:b,onClose:()=>setB(false),title:'Dialog B'},h('input',{id:'b-field','aria-label':'B field',autoFocus:true})),
          h(Modal,{open:r,onClose:()=>setR(false),title:'Dialog R'},h('input',{id:'r-field','aria-label':'R field',autoFocus:true})),
          h(Modal,{open:plain,onClose:()=>setPlain(false),title:'Plain dialog'},h('button',{id:'plain-ok'},'OK')),
          h(Modal,{open:pre,onClose:()=>setPre(false),title:'Dialog P'},h('input',{id:'p-field','aria-label':'P field',autoFocus:true}))));
    }
    ReactDOM.createRoot(document.getElementById('root')).render(h(App));
    p.settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    p.focus=()=>({id:document.activeElement?.id??'',body:document.activeElement===document.body,dialogs:[...document.querySelectorAll('[role="dialog"]')].map(d=>d.getAttribute('aria-label')||d.textContent.slice(0,12))});
  })();` });
  await page.waitForFunction(() => typeof window.__modalFocus?.removeTrigger === 'function');
  return { errors, unexpected };
}
const focus = (page: Page) => page.evaluate(() => window.__modalFocus.focus());
async function openByKeyboard(page: Page, trigger: string, title: string) {
  await page.locator(trigger).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: title })).toBeVisible();
  await page.evaluate(() => window.__modalFocus.settle());
  expect(await page.getByRole('dialog', { name: title }).evaluate(d => d.contains(document.activeElement)), `focus moves into ${title}`).toBe(true);
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('Escape closes a dialog whose field took focus with autoFocus, and focus returns to the trigger', async ({ page }) => {
  const { errors, unexpected } = await fixture(page);
  await openByKeyboard(page, '#open-a', 'Dialog A');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#open-a')).toBeFocused();
  expect(await focus(page)).toMatchObject({ id: 'open-a', body: false });
  expect(errors).toEqual([]); expect(unexpected).toEqual([]);
});

test('the close button, operated by keyboard, returns focus to the trigger', async ({ page }) => {
  const { errors } = await fixture(page);
  await openByKeyboard(page, '#open-a', 'Dialog A');
  await page.getByRole('button', { name: 'Close', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#open-a')).toBeFocused();
  expect(errors).toEqual([]);
});

test('a dialog without autoFocus still returns focus to its connected trigger', async ({ page }) => {
  const { errors } = await fixture(page);
  await openByKeyboard(page, '#open-plain', 'Plain dialog');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#open-plain')).toBeFocused();
  expect(errors).toEqual([]);
});

test('when the trigger is gone, focus lands on the main landmark rather than <body>', async ({ page }) => {
  const { errors } = await fixture(page);
  await openByKeyboard(page, '#open-r', 'Dialog R');
  await page.evaluate(() => window.__modalFocus.removeTrigger());
  await expect(page.locator('#open-r')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await focus(page)).toMatchObject({ id: 'main-content', body: false });
  expect(errors).toEqual([]);
});

test('nested dialogs return focus to each opener in turn', async ({ page }) => {
  const { errors } = await fixture(page);
  await openByKeyboard(page, '#open-a', 'Dialog A');
  await openByKeyboard(page, '#open-b', 'Dialog B');
  // One Escape closes only the top dialog, and focus goes back into the one below.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Dialog B' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Dialog A' })).toBeVisible();
  await expect(page.locator('#open-b')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#open-a')).toBeFocused();
  expect(errors).toEqual([]);
});

// Integration review of bee7614e (LIBRARY-836BF6D8DBFF / COMPONENT-DA7D449CE911):
// nested disposal order, openers that cannot take focus back, and a trigger
// focused before the dialog code loaded.
test('closing a dialog underneath the open one leaves focus in the open one', async ({ page }) => {
  const { errors } = await fixture(page);
  await openByKeyboard(page, '#open-a', 'Dialog A');
  await openByKeyboard(page, '#open-b', 'Dialog B');
  await page.locator('#b-field').focus();
  await page.evaluate(() => window.__modalFocus.closeA());
  await expect(page.getByRole('dialog', { name: 'Dialog A' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Dialog B' })).toBeVisible();
  await expect(page.locator('#b-field')).toBeFocused();
  // B's opener went with A, and nothing is open below B.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await focus(page)).toMatchObject({ id: 'main-content', body: false });
  expect(errors).toEqual([]);
});

for (const [how, act] of [
  ['removed', (page: Page) => page.evaluate(() => window.__modalFocus.removeOpenB())],
  ['disabled', (page: Page) => page.evaluate(() => window.__modalFocus.disableOpenB())],
  ['inert', (page: Page) => page.evaluate(() => window.__modalFocus.inertOpenB())],
] as const) {
  test(`when a nested dialog's opener is ${how}, focus stays inside the dialog still open`, async ({ page }) => {
    const { errors } = await fixture(page);
    await openByKeyboard(page, '#open-a', 'Dialog A');
    await openByKeyboard(page, '#open-b', 'Dialog B');
    await act(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Dialog B' })).toHaveCount(0);
    const dialogA = page.getByRole('dialog', { name: 'Dialog A' });
    await expect(dialogA).toBeVisible();
    expect(await dialogA.evaluate(d => d.contains(document.activeElement)), 'focus is inside Dialog A, not behind it').toBe(true);
    expect(await focus(page)).not.toMatchObject({ id: 'open-b' });
    // A still answers keys, and closing it returns focus to its own opener.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('#open-a')).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test('a trigger focused before the dialog code loaded still gets focus back', async ({ page }) => {
  const { errors } = await fixture(page, { focusBeforeLoad: true });
  await expect(page.getByRole('dialog', { name: 'Dialog P' })).toBeVisible();
  await page.evaluate(() => window.__modalFocus.settle());
  expect(await page.getByRole('dialog', { name: 'Dialog P' }).evaluate(d => d.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#pre-trigger')).toBeFocused();
  expect(errors).toEqual([]);
});
