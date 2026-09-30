import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// C2-B06 (reproduced on main 231e8140 in #679): the language picker declared
// role="listbox"/"option" and implemented none of the pattern. Opening it left
// focus on the trigger, ArrowDown did nothing, and the list (rendered before
// the trigger) was reachable only by Shift+Tab backwards.
//
// Actual LanguageBar, locale provider and React in Chromium, operated by
// keyboard only. The server action that sets the locale cookie, the router and
// the icon set are the only stand-ins.
const { react, reactDom } = reactBrowserScripts('development');
const isolated = new Set(['react', 'next/navigation', 'lucide-react', '@/lib/i18n/actions']);
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
    if (isolated.has(name)) { item.imports[name] = name; continue; }
    const target = name.startsWith('@/') ? path.resolve(name.slice(2))
      : name.startsWith('.') ? path.resolve(path.dirname(id), name)
        : require.resolve(name, { paths: [path.dirname(id)] });
    item.imports[name] = collect(target);
  }
  return id;
}
const entries = Object.fromEntries([
  'components/i18n/language-picker.tsx', 'components/i18n/locale-provider.tsx', 'lib/i18n/locales.ts',
].map(file => [file, collect(file)]));
const origin = 'https://language-picker-fixture.invalid';
type Probe = {
  chosen: string[]; refreshes: number; codes: string[]; current: string;
  // 'deferred' leaves each save pending until finish() settles it.
  mode: 'immediate' | 'deferred'; finish: (ok: boolean) => void;
  focus: () => { name: string; role: string | null; tabIndex: number };
};
declare global { interface Window { __languagePicker: Probe } }

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    if (route.request().url() !== `${origin}/`) { await route.abort(); return; }
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><a id="before" href="#x">Before</a><div id="root"></div><a id="after" href="#y">After</a><input id="elsewhere" aria-label="Elsewhere"></body></html>' });
  });
  await page.goto(`${origin}/`);
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)},entries=${JSON.stringify(entries)},loaded={},process={env:{NODE_ENV:'development'}};
    const p=window.__languagePicker={chosen:[],refreshes:0,mode:'immediate',finish:()=>{}};
    const setLocale=code=>{p.chosen.push(code);if(p.mode!=='deferred')return Promise.resolve({ok:true});return new Promise(resolve=>{p.finish=ok=>resolve({ok});});};
    const mocks={react:React,'next/navigation':{useRouter:()=>({refresh:()=>{p.refreshes+=1;}})},'lucide-react':new Proxy({},{get:()=>()=>null}),'@/lib/i18n/actions':{setLocale}};
    function load(id){if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected fixture module: '+id);const module=loaded[id]={exports:{}};new Function('require','module','exports','process',item.source)(name=>load(item.imports[name]),module,module.exports,process);return module.exports;}
    const {LanguageBar}=load(entries['components/i18n/language-picker.tsx']),{LocaleProvider}=load(entries['components/i18n/locale-provider.tsx']),{LOCALES,DEFAULT_LOCALE}=load(entries['lib/i18n/locales.ts']);
    const locale=LOCALES.find(item=>item.code===DEFAULT_LOCALE);
    p.codes=LOCALES.map(item=>item.code);p.current=locale.code;
    const messages={'language.change':'Change language','language.menuLabel':'Choose your language'};
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(LocaleProvider,{locale,source:'default',messages},React.createElement(LanguageBar)));
    p.focus=()=>{const el=document.activeElement;return {name:(el.getAttribute('aria-label')||el.textContent||'').trim().replace(/\\s+/g,' '),role:el.getAttribute('role'),tabIndex:el.tabIndex};};
  })();` });
  await expect(page.getByRole('button', { name: 'Change language' })).toBeVisible();
  return { errors };
}
const focused = (page: Page) => page.evaluate(() => window.__languagePicker.focus());
const options = (page: Page) => page.getByRole('listbox', { name: 'Choose your language' }).getByRole('option');

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('Enter opens the list and moves focus to the current language', async ({ page }) => {
  const { errors } = await fixture(page);
  const trigger = page.getByRole('button', { name: 'Change language' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const list = page.getByRole('listbox', { name: 'Choose your language' });
  await expect(list).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(await trigger.getAttribute('aria-controls')).toBe(await list.getAttribute('id'));
  const selected = list.locator('[role="option"][aria-selected="true"]');
  await expect(selected).toBeFocused();
  // Exactly one option holds the tab stop.
  expect(await options(page).evaluateAll(els => els.filter(el => (el as HTMLElement).tabIndex === 0).length)).toBe(1);
  expect(errors).toEqual([]);
});

test('arrow keys, Home and End move through the options, wrapping at the ends', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Change language' }).focus();
  await page.keyboard.press('Enter');
  const count = await options(page).count();
  expect(count).toBeGreaterThan(2);
  const index = () => options(page).evaluateAll(els => els.indexOf(document.activeElement as HTMLElement));
  const start = await index();
  await page.keyboard.press('ArrowDown');
  expect(await index()).toBe((start + 1) % count);
  await page.keyboard.press('ArrowUp');
  expect(await index()).toBe(start);
  await page.keyboard.press('End');
  expect(await index()).toBe(count - 1);
  await page.keyboard.press('ArrowDown');
  expect(await index()).toBe(0);
  await page.keyboard.press('ArrowUp');
  expect(await index()).toBe(count - 1);
  await page.keyboard.press('Home');
  expect(await index()).toBe(0);
  expect(await focused(page)).toMatchObject({ role: 'option', tabIndex: 0 });
});

test('ArrowDown on the closed trigger opens the list', async ({ page }) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Change language' }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('listbox', { name: 'Choose your language' })).toBeVisible();
  expect(await focused(page)).toMatchObject({ role: 'option' });
});

test('Escape closes the list and returns focus to the trigger', async ({ page }) => {
  await fixture(page);
  const trigger = page.getByRole('button', { name: 'Change language' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('Enter on another language chooses it, closes the list and returns focus to the trigger', async ({ page }) => {
  await fixture(page);
  const trigger = page.getByRole('button', { name: 'Change language' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  const target = await page.evaluate(() => document.activeElement?.textContent ?? '');
  expect(target).not.toBe('');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__languagePicker.chosen.length)).toBe(1);
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.__languagePicker.refreshes)).toBe(1);
  // The request names the language that had focus: the one after the current.
  const { chosen, codes, current } = await page.evaluate(() => window.__languagePicker);
  expect(chosen).toEqual([codes[(codes.indexOf(current) + 1) % codes.length]]);
});

test('choosing the current language closes the list without a request and returns focus', async ({ page }) => {
  await fixture(page);
  const trigger = page.getByRole('button', { name: 'Change language' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => window.__languagePicker.chosen)).toEqual([]);
});

test('Tab leaves the open list, closing it, and lands on the trigger', async ({ page }) => {
  await fixture(page);
  const trigger = page.getByRole('button', { name: 'Change language' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('Shift+Tab leaves the open list backwards, closing it', async ({ page }) => {
  await fixture(page);
  const trigger = page.getByRole('button', { name: 'Change language' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(options(page).and(page.locator('[aria-selected="true"]'))).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.locator('#before')).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

// Integration review of 3a1e758c: a save that completes after the person has
// closed the picker and moved on must not pull focus back to it.
async function chooseNextPending(page: Page) {
  await page.evaluate(() => { window.__languagePicker.mode = 'deferred'; });
  await page.getByRole('button', { name: 'Change language' }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__languagePicker.chosen.length)).toBe(1);
  // While saving, every option refuses another choice, and keyboard focus
  // stays on the chosen one instead of dropping to <body>.
  await expect(options(page).first()).toBeDisabled();
  expect(await options(page).evaluateAll(els => els.every(el => el.getAttribute('aria-disabled') === 'true'))).toBe(true);
  const { codes, current } = await page.evaluate(() => window.__languagePicker);
  const chosen = options(page).nth((codes.indexOf(current) + 1) % codes.length);
  await expect(chosen).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.__languagePicker.chosen)).toEqual([codes[(codes.indexOf(current) + 1) % codes.length]]);
  await chosen.focus();
}

test('a save that completes after the person moved to another field leaves their focus there', async ({ page }) => {
  const { errors } = await fixture(page);
  await chooseNextPending(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  const elsewhere = page.locator('#elsewhere');
  await elsewhere.focus();
  await page.keyboard.type('abc');
  await page.evaluate(() => window.__languagePicker.finish(true));
  await expect.poll(() => page.evaluate(() => window.__languagePicker.refreshes)).toBe(1);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(elsewhere).toBeFocused();
  await expect(elsewhere).toHaveValue('abc');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  expect(await page.evaluate(() => window.__languagePicker.chosen)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a save that completes while the picker still holds focus closes it and returns focus to the trigger', async ({ page }) => {
  const { errors } = await fixture(page);
  await chooseNextPending(page);
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.evaluate(() => window.__languagePicker.finish(true));
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change language' })).toBeFocused();
  expect(await page.evaluate(() => window.__languagePicker.refreshes)).toBe(1);
  expect(errors).toEqual([]);
});

test('a failed save keeps the list open and usable, and refreshes nothing', async ({ page }) => {
  const { errors } = await fixture(page);
  await chooseNextPending(page);
  await page.evaluate(() => window.__languagePicker.finish(false));
  await expect(options(page).first()).toBeEnabled();
  await expect(page.getByRole('listbox')).toBeVisible();
  expect(await page.evaluate(() => window.__languagePicker.refreshes)).toBe(0);
  // The chosen option is still where the keyboard is, so it can be tried again.
  const { codes, current } = await page.evaluate(() => window.__languagePicker);
  await expect(options(page).nth((codes.indexOf(current) + 1) % codes.length)).toBeFocused();
  await page.evaluate(() => { window.__languagePicker.mode = 'immediate'; });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change language' })).toBeFocused();
  expect(await page.evaluate(() => window.__languagePicker.chosen)).toHaveLength(2);
  expect(errors).toEqual([]);
});
