import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// C2-B06 (reproduced on main 231e8140 in #679): the language picker declared
// role="listbox"/"option" and implemented none of the pattern. Opening it left
// focus on the trigger, ArrowDown did nothing, and the list (rendered before
// the trigger) was reachable only by Shift+Tab backwards.
//
// Actual LanguageBar, locale provider and React in Chromium, operated by
// keyboard only. The server action that sets the locale cookie, the router and
// the icon set are the only stand-ins.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
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
type Probe = { chosen: string[]; refreshes: number; focus: () => { name: string; role: string | null; tabIndex: number } };
declare global { interface Window { __languagePicker: Probe } }

async function fixture(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    if (route.request().url() !== `${origin}/`) { await route.abort(); return; }
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><a id="before" href="#x">Before</a><div id="root"></div><a id="after" href="#y">After</a></body></html>' });
  });
  await page.goto(`${origin}/`);
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources=${JSON.stringify(modules)},entries=${JSON.stringify(entries)},loaded={},process={env:{NODE_ENV:'development'}};
    const p=window.__languagePicker={chosen:[],refreshes:0};
    const mocks={react:React,'next/navigation':{useRouter:()=>({refresh:()=>{p.refreshes+=1;}})},'lucide-react':new Proxy({},{get:()=>()=>null}),'@/lib/i18n/actions':{setLocale:async code=>{p.chosen.push(code);return {ok:true};}}};
    function load(id){if(id in mocks)return mocks[id];if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected fixture module: '+id);const module=loaded[id]={exports:{}};new Function('require','module','exports','process',item.source)(name=>load(item.imports[name]),module,module.exports,process);return module.exports;}
    const {LanguageBar}=load(entries['components/i18n/language-picker.tsx']),{LocaleProvider}=load(entries['components/i18n/locale-provider.tsx']),{LOCALES,DEFAULT_LOCALE}=load(entries['lib/i18n/locales.ts']);
    const locale=LOCALES.find(item=>item.code===DEFAULT_LOCALE);
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
