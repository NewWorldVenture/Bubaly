import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { renderToString } from 'react-dom/server';
import { expect, test } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual Modal, focus/keyboard/scroll behavior, locale provider and React.
// Only the document transport is controlled; there is no application server.
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
const origin = 'https://modal-hydration-fixture.invalid';
type Snapshot = { dialog: boolean; activeInside: boolean; activeId: string; overflow: string; closeCalls: number };
declare global {
  interface Window { __modalHydration: { open: () => void; snapshot: () => Snapshot; settle: () => Promise<void> } }
}

function markup(initialOpen: boolean): string {
  const loaded: Record<string, { exports: unknown }> = {};
  function load(id: string): unknown {
    if (id === 'react') return React;
    if (id === 'react-dom') return ReactDOM;
    if (loaded[id]) return loaded[id].exports;
    const item = modules[id];
    if (!item) throw new Error('Unexpected fixture module');
    const record = loaded[id] = { exports: {} };
    new Function('require', 'module', 'exports', 'React', 'process', item.source)(
      (name: string) => load(item.imports[name]), record, record.exports, React, { env: { NODE_ENV: 'development' } },
    );
    return record.exports;
  }
  const { Modal } = load(entries['components/ui/modal.tsx']) as { Modal: React.ComponentType<{ open: boolean; onClose: () => void; title: string; children?: React.ReactNode }> };
  const { LocaleProvider } = load(entries['components/i18n/locale-provider.tsx']) as { LocaleProvider: React.ComponentType<{ locale: unknown; source: string; messages: Record<string, string>; children?: React.ReactNode }> };
  const { DEFAULT_LOCALE } = load(entries['lib/i18n/locales.ts']) as { DEFAULT_LOCALE: unknown };
  return renderToString(React.createElement(LocaleProvider, { locale: DEFAULT_LOCALE, source: 'default', messages: { 'modal.closeDialog': 'Close' } },
    React.createElement(Modal, { open: initialOpen, onClose: () => {}, title: 'Fixture dialog' },
      React.createElement('input', { id: 'first', defaultValue: 'fixture' }), React.createElement('button', { id: 'last' }, 'Last'))));
}

for (const initialOpen of [true, false]) {
  test(initialOpen ? 'a dialog open during hydration installs its keyboard and focus behavior' : 'a dialog opened after hydration keeps the same keyboard and focus behavior', async ({ page, context }) => {
    const serverHtml = markup(initialOpen);
    expect(serverHtml).toBe('');
    const errors: string[] = [], unexpected: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await context.route('**/*', async route => {
      if (route.request().url() !== `${origin}/modal`) { unexpected.push(route.request().url()); await route.abort(); return; }
      await route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="overflow: auto"><button id="trigger">Before</button><div id="root">${serverHtml}</div><button id="background">After</button></body></html>` });
    });
    await page.goto(`${origin}/modal`);
    for (const content of [react, reactDom]) await page.addScriptTag({ content });
    await page.addScriptTag({ content: `(() => {
      const sources=${JSON.stringify(modules)},entries=${JSON.stringify(entries)},loaded={},process={env:{NODE_ENV:'development'}};
      function load(id){if(id==='react')return React;if(id==='react-dom')return ReactDOM;if(loaded[id])return loaded[id].exports;const item=sources[id];if(!item)throw new Error('Unexpected fixture module');const module=loaded[id]={exports:{}};new Function('require','module','exports','React','process',item.source)(name=>load(item.imports[name]),module,module.exports,React,process);return module.exports;}
      const Modal=load(entries['components/ui/modal.tsx']).Modal,Provider=load(entries['components/i18n/locale-provider.tsx']).LocaleProvider,locale=load(entries['lib/i18n/locales.ts']).DEFAULT_LOCALE;
      const state=window.__modalHydration={closeCalls:0};
      function App(){const [open,setOpen]=React.useState(${JSON.stringify(initialOpen)});state.open=()=>setOpen(true);return React.createElement(Provider,{locale,source:'default',messages:{'modal.closeDialog':'Close'}},React.createElement(Modal,{open,onClose:()=>{state.closeCalls++;setOpen(false);},title:'Fixture dialog'},React.createElement('input',{id:'first',defaultValue:'fixture'}),React.createElement('button',{id:'last'},'Last')));}
      document.getElementById('trigger').focus();
      ReactDOM.hydrateRoot(document.getElementById('root'),React.createElement(App));
      state.snapshot=()=>{const dialog=document.querySelector('[role="dialog"]');return {dialog:!!dialog,activeInside:!!dialog&&dialog.contains(document.activeElement),activeId:document.activeElement?.id??'',overflow:document.body.style.overflow,closeCalls:state.closeCalls};};
      state.settle=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    })();` });
    await page.waitForFunction(() => typeof window.__modalHydration.open === 'function');
    await page.evaluate(() => window.__modalHydration.settle());
    if (!initialOpen) await page.evaluate(() => window.__modalHydration.open());
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => window.__modalHydration.settle());
    expect(await page.evaluate(() => window.__modalHydration.snapshot())).toMatchObject({ dialog: true, activeInside: true, overflow: 'hidden', closeCalls: 0 });
    await page.locator('#last').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#last')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.__modalHydration.snapshot())).toMatchObject({ dialog: false, activeId: 'trigger', overflow: 'auto', closeCalls: 1 });
    expect(errors).toEqual([]);
    expect(unexpected).toEqual([]);
  });
}
