import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual React, module, form, portal and dialog behavior; only app data and
// server actions are synthetic. No stylesheet or backend workflow claim.
const scripts = reactBrowserScripts('development');
const files = [
  'components/modules/pantry-module.tsx', 'components/ui/modal.tsx',
  'components/ui/input.tsx', 'components/ui/button.tsx',
  'lib/a11y/use-dialog-behavior.ts', 'lib/pantry/logic.ts',
  'lib/time/zoned.ts', 'lib/supabase/errors.ts',
];
const sources = Object.fromEntries(files.map((file) => [
  '@/' + file.replace(/\.tsx?$/, ''),
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));
type Outcome = 'success' | 'refusal' | 'rejection';
interface PantryFixture {
  calls: { id: string; input: { quantity: number; unit: string | null } }[];
  rows: { id: string; quantity: number; unit: string | null }[];
  errors: string[];
  toasts: { kind: string; message: string }[];
  refreshes: number;
  commits: number;
  hold: boolean;
  outcome: Outcome;
  release: () => void;
  reload: () => void;
}
declare global { interface Window { __pantryCompletion: PantryFixture } }
const observed = new WeakMap<Page, string[]>();

async function start(page: Page) {
  const errors: string[] = [];
  observed.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text());
  });
  page.on('requestfailed', (request) => errors.push('Request failed: ' + request.url()));
  await page.route('**/*', (route) => {
    if (route.request().url() === 'https://pantry-fixture.invalid/') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' });
    }
    errors.push('Unexpected request: ' + route.request().url());
    return route.abort();
  });
  await page.goto('https://pantry-fixture.invalid');
  await page.addScriptTag({ content: scripts.react });
  await page.addScriptTag({ content: scripts.reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const row = (id, name, quantity, unit) => ({id, name, quantity, unit,
      family_id:'synthetic-family', category:'Pantry', location:'pantry',
      low_threshold:0, is_staple:false, expires_at:null, notes:'original note'});
    const p = window.__pantryCompletion = {calls:[], errors:[], toasts:[],
      refreshes:0, commits:0, hold:false, outcome:'success',
      rows:[row('rice-1','Rice',1.5,'kg'), row('beans-2','Beans',3,'cans')]};
    window.addEventListener('error', e => p.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => {p.errors.push(String(e.reason)); e.preventDefault();});
    const pass = props => React.createElement('div', null, props.children);
    const blank = () => null;
    const stub = new Proxy({__esModule:true, default:pass}, {get:(o,k) => k in o ? o[k] : blank});
    let rerender = () => {};
    const outside = async () => {throw new Error('Action outside pantry save fixture');};
    const mocks = {
      react:React, 'react-dom':ReactDOM,
      '@/components/app/app-context':{useApp:() => ({familyId:'synthetic-family',userId:'synthetic-user',family:{timezone:'UTC'}})},
      '@/lib/hooks/use-realtime-query':{useRealtimeQuery:() => ({data:p.rows,loading:false,error:null,refresh:async () => {p.refreshes++; rerender();}})},
      '@/components/i18n/locale-provider':{useTranslations:() => key => key},
      '@/lib/utils/cn':{cn:(...v) => v.filter(Boolean).join(' ')},
      '@/lib/i18n/grocery-category':{groceryCategoryLabel:(_t,c) => c},
      '@/components/ui/card':{Card:pass},
      '@/components/ui/badge':{Badge:props => React.createElement('span',null,props.children)},
      '@/components/app/page-header':{PageHeader:props => React.createElement('header',null,props.title,props.action)},
      '@/components/ui/toast':{useToast:() => ({
        success:message => p.toasts.push({kind:'success',message}),
        error:message => p.toasts.push({kind:'error',message})})},
      '@/app/(app)/dashboard/pantry/actions':{
        adjustPantryQuantityAction:outside, removePantryItemAction:outside,
        savePantryItemAction:async (id,input) => {
          p.calls.push({id,input});
          // Capture each request's outcome, including held A, independently of B.
          const outcome = p.outcome;
          const finish = () => {
            if (outcome === 'rejection') throw new Error('Synthetic save rejected');
            if (outcome === 'refusal') return {ok:false,error:'Synthetic save refused'};
            const saved = {...row(id || 'new-1',input.name,input.quantity,input.unit),
              category:input.category,location:input.location,low_threshold:input.lowThreshold,
              is_staple:input.isStaple,notes:input.notes,expires_at:input.expiresAt};
            p.rows = id ? p.rows.map(old => old.id === id ? saved : old) : [...p.rows,saved];
            p.commits++;
            return {ok:true,id:saved.id};
          };
          if (!p.hold) return finish();
          return new Promise((resolve,reject) => {p.release = () => {
            try {resolve(finish());} catch (error) {reject(error);}
          };});
        },
      },
    };
    const cache = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in cache) return cache[id];
      if (!(id in sources)) return stub;
      const m = {exports:{}}; cache[id] = m.exports;
      new Function('require','module','exports',sources[id])(load,m,m.exports);
      return m.exports;
    }
    const Component = load('@/components/modules/pantry-module').PantryModule;
    let root = ReactDOM.createRoot(document.getElementById('root'));
    rerender = () => ReactDOM.flushSync(() => root.render(
      React.createElement(React.StrictMode,null,React.createElement(Component))));
    p.reload = () => {ReactDOM.flushSync(() => root.unmount());
      root = ReactDOM.createRoot(document.getElementById('root')); rerender();};
    rerender();
  })();` });
  expect(await page.evaluate(() => (window as unknown as { React: { version: string } }).React.version)).toMatch(/^19\./);
}
test.afterEach(async ({ page }) => {
  expect(observed.get(page) ?? []).toEqual([]);
  expect(await page.evaluate(() => window.__pantryCompletion?.errors ?? [])).toEqual([]);
});
async function edit(page: Page, index = 0) {
  await page.getByRole('button', { name: 'pantry.edit', exact: true }).nth(index).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}
async function draft(page: Page, quantity: string, unit: string) {
  await page.getByLabel('pantry.quantity', { exact: true }).fill(quantity);
  await page.getByLabel('pantry.unit', { exact: true }).fill(unit);
}
async function assertDraft(page: Page, quantity: string, unit: string) {
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('pantry.quantity', { exact: true })).toHaveValue(quantity);
  await expect(page.getByLabel('pantry.unit', { exact: true })).toHaveValue(unit);
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
}
async function save(page: Page) {
  await page.getByRole('button', { name: 'Save', exact: true }).click();
}
for (const [quantity, unit] of [['2.75', 'kg'], ['0', '']]) {
  test(`ordinary ${quantity}/${unit || 'blank'} save survives reload`, async ({ page }) => {
    await start(page); await edit(page); await draft(page, quantity, unit); await save(page);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => [window.__pantryCompletion.calls.length, window.__pantryCompletion.commits, window.__pantryCompletion.refreshes])).toEqual([1, 1, 1]);
    await page.evaluate(() => window.__pantryCompletion.reload()); await edit(page);
    await assertDraft(page, quantity, unit);
    await expect(page.getByLabel('pantry.lowAt', { exact: true })).toHaveValue('0');
  });
}
test('ordinary Cancel discards a draft without saving', async ({ page }) => {
  await start(page); await edit(page); await draft(page, '9', 'cups');
  await page.getByRole('button', { name: 'pantry.cancel', exact: true }).click();
  expect(await page.evaluate(() => window.__pantryCompletion.calls)).toEqual([]);
  await edit(page); await assertDraft(page, '1.5', 'kg');
});

for (const close of ['Cancel', 'Escape', 'X'] as const) {
  for (const outcome of ['success', 'refusal', 'rejection'] as const) {
    test(`closed ${outcome} via ${close} preserves reopened same-item draft and independent save`, async ({ page }) => {
      await start(page);
      await page.evaluate((outcome) => {window.__pantryCompletion.hold = true; window.__pantryCompletion.outcome = outcome;}, outcome);
      await edit(page); await draft(page, '2', 'kg'); await save(page);
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => window.__pantryCompletion.calls.length)).toBe(1);
      if (close === 'Cancel') await page.getByRole('button', { name: 'pantry.cancel', exact: true }).click();
      else if (close === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: 'modal.closeDialog', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await edit(page); await draft(page, '7.25', 'cups');
      await page.evaluate(() => window.__pantryCompletion.release());
      await assertDraft(page, '7.25', 'cups');
      expect(await page.evaluate(() => ({calls:window.__pantryCompletion.calls.length,
        commits:window.__pantryCompletion.commits, refreshes:window.__pantryCompletion.refreshes,
        row:window.__pantryCompletion.rows[0], toasts:window.__pantryCompletion.toasts}))).toMatchObject({
        calls:1, commits:outcome === 'success' ? 1 : 0, refreshes:outcome === 'success' ? 1 : 0,
        row:{quantity:outcome === 'success' ? 2 : 1.5,unit:'kg'}, toasts:[],
      });
      await page.evaluate(() => {window.__pantryCompletion.hold = false; window.__pantryCompletion.outcome = 'success';});
      await save(page); await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => window.__pantryCompletion.rows[0])).toMatchObject({quantity:7.25,unit:'cups'});
      expect(await page.evaluate(() => window.__pantryCompletion.calls)).toMatchObject([
        {id:'rice-1',input:{quantity:2,unit:'kg'}}, {id:'rice-1',input:{quantity:7.25,unit:'cups'}},
      ]);
      expect(await page.evaluate(() => window.__pantryCompletion.toasts)).toEqual([{kind:'success',message:'Updated'}]);
      expect(await page.evaluate(() => [window.__pantryCompletion.commits, window.__pantryCompletion.refreshes])).toEqual(outcome === 'success' ? [2, 2] : [1, 1]);
    });
  }
}
test('old successful Rice save leaves Beans draft intact and independently saveable', async ({ page }) => {
  await start(page); await page.evaluate(() => {window.__pantryCompletion.hold = true;});
  await edit(page); await draft(page, '2', 'kg'); await save(page);
  await page.getByRole('button', { name: 'pantry.cancel', exact: true }).click();
  await edit(page, 1); await draft(page, '4.5', 'jars');
  await page.evaluate(() => window.__pantryCompletion.release());
  await assertDraft(page, '4.5', 'jars');
  await expect(page.getByRole('dialog').locator('input[name="name"]')).toHaveValue('Beans');
  expect(await page.evaluate(() => window.__pantryCompletion.rows)).toMatchObject([{id:'rice-1',quantity:2}, {id:'beans-2',quantity:3}]);
  await page.evaluate(() => {window.__pantryCompletion.hold = false;});
  await save(page); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pantryCompletion.calls)).toMatchObject([
    {id:'rice-1',input:{quantity:2}}, {id:'beans-2',input:{quantity:4.5,unit:'jars'}},
  ]);
  expect(await page.evaluate(() => [window.__pantryCompletion.commits, window.__pantryCompletion.refreshes])).toEqual([2, 2]);
});
for (const outcome of ['refusal', 'rejection'] as const) {
  test(`active ${outcome} preserves draft, reenables Save and permits explicit retry`, async ({ page }) => {
    await start(page); await page.evaluate((outcome) => {window.__pantryCompletion.outcome = outcome;}, outcome);
    await edit(page); await draft(page, '6.25', 'cups'); await save(page);
    await assertDraft(page, '6.25', 'cups');
    expect(await page.evaluate(() => [window.__pantryCompletion.calls.length, window.__pantryCompletion.commits, window.__pantryCompletion.refreshes])).toEqual([1, 0, 0]);
    expect(await page.evaluate(() => window.__pantryCompletion.toasts)).toEqual([{kind:'error',message:outcome === 'refusal' ? 'Synthetic save refused' : 'Synthetic save rejected'}]);
    await page.evaluate(() => {window.__pantryCompletion.outcome = 'success';});
    await save(page); await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pantryCompletion.rows[0])).toMatchObject({quantity:6.25,unit:'cups'});
    expect(await page.evaluate(() => window.__pantryCompletion.calls.length)).toBe(2);
  });
}
