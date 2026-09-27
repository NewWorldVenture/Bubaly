import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { expect, test } from '@playwright/test';

// Actual AccountRow, LocaleProvider, useFormat/createFormat and ToastProvider
// render on a Node server and hydrate in Chromium. Server actions and native
// haptics are isolated; the fixture never starts a server or calls a provider.
const isolated = new Set([
  'react', 'lucide-react', '@capacitor/core', '@capacitor/haptics',
  '@/app/(app)/dashboard/social/actions',
]);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function resolveFile(file: string): string {
  return [file, `${file}.ts`, `${file}.tsx`, `${file}.js`, `${file}.json`, path.join(file, 'index.ts')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? file;
}
function collect(file: string): string {
  const id = path.resolve(resolveFile(file));
  if (modules[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = id.endsWith('.json') ? `module.exports=${raw}` : /\.tsx?$/.test(id)
    ? ts.transpileModule(raw, { compilerOptions: {
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    } }).outputText : raw;
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
const roots = {
  account: collect('components/social/account-row.tsx'),
  locale: collect('components/i18n/locale-provider.tsx'),
  toast: collect('components/ui/toast.tsx'),
  format: collect('components/i18n/use-format.ts'),
  locales: collect('lib/i18n/locales.ts'),
};
const locales = ['de-DE', 'en-US', 'fr-FR'] as const;
const catalogues = Object.fromEntries(locales.map(locale => [locale,
  JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>,
]));
const samples = {
  summer: '2026-07-14T00:30:00Z',
  berlinBefore: '2026-03-29T00:30:00Z', berlinAfter: '2026-03-29T01:30:00Z',
  nyBefore: '2026-03-08T06:30:00Z', nyAfter: '2026-03-08T07:30:00Z',
  fallBefore: '2026-11-01T05:30:00Z', fallAfter: '2026-11-01T06:30:00Z',
  numericOffset: '2026-07-14T02:30:00+02:00',
  postgresOffset: '2026-07-14 00:30:00+00',
  namedZone: 'July 14 2026 00:30 GMT',
};

function loader(locale: string): string {
  return `const modules=${JSON.stringify(modules)},roots=${JSON.stringify(roots)},cache={};
  function load(id){if(id in external)return external[id];if(cache[id])return cache[id].exports;
    const item=modules[id];if(!item)throw new Error('Unexpected fixture module '+id);
    const m=cache[id]={exports:{}};new Function('require','module','exports',item.source)(name=>load(item.imports[name]),m,m.exports);return m.exports;}
  function Controls(){const f=load(roots.format).useFormat();React.useEffect(()=>{globalThis.__formatHydrated=true;},[]);
    const values=[...Object.entries(${JSON.stringify(samples)}).map(([id,value])=>[id,f.fmtDateTime(value)]),
      ['dateOnly',f.fmtDate('2026-03-29','MMM d, yyyy')],
      ['isoLocal',f.fmtDateTime('2026-07-14T00:30:00')],
      ['slashLocal',f.fmtDateTime('2026/07/14 00:30')],
      ['namedLocal',f.fmtDateTime('July 14 2026 00:30')],
      ['money',f.fmtMoney(12345,'EUR')],['invalid',f.fmtDateTime('not-a-date')]];
    return React.createElement('section',{id:'format-controls'},values.map(([id,value])=>React.createElement('output',{id,key:id},value)));}
  const tree=React.createElement(load(roots.locale).LocaleProvider,{
    locale:load(roots.locales).localeOrDefault(${JSON.stringify(locale)}),source:'cookie',messages:${JSON.stringify(catalogues[locale])}},
    React.createElement(load(roots.toast).ToastProvider,null,
      React.createElement(load(roots.account).AccountRow,{id:'synthetic-account',platform:'instagram',name:'Family',status:'connected',lastError:null,lastSyncedAt:${JSON.stringify(samples.summer)}}),React.createElement(Controls)));`;
}

const rendered = new Map<string, string>();
function serverHtml(locale: string, serverZone: string): string {
  const key = `${locale}:${serverZone}`;
  const cached = rendered.get(key);
  if (cached !== undefined) return cached;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bubaly-format-hydration-'));
  const file = path.join(directory, 'render.cjs');
  const server = `require=require('node:module').createRequire(${JSON.stringify(path.resolve('package.json'))});
    const React=global.React=require('react');const external={react:React,'lucide-react':require('lucide-react'),
      '@/app/(app)/dashboard/social/actions':{},'@capacitor/core':{},'@capacitor/haptics':{}};
    ${loader(locale)}process.stdout.write(require('react-dom/server').renderToString(tree));`;
  try {
    fs.writeFileSync(file, server);
    const html = execFileSync(process.execPath, [file], {
      env: { ...process.env, TZ: serverZone }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    });
    rendered.set(key, html);
    return html;
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  }
}

const normaliseClock = (text: string) => text.replace(/\u202f/g, ' ');
function expectedDate(locale: string, zone: string, stamp: string): string {
  return normaliseClock(new Intl.DateTimeFormat(locale, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone,
  }).format(new Date(stamp)));
}

declare global {
  interface Window {
    __formatHydrated?: boolean;
    __formatBefore?: Element | null;
    __formatErrors?: string[];
  }
}

const contexts = [
  ...locales.map(locale => ({ locale, serverZone: 'UTC' })),
  { locale: 'de-DE', serverZone: 'America/Los_Angeles' },
];
for (const { locale, serverZone } of contexts) {
  for (const timezoneId of ['UTC', 'Europe/Berlin', 'America/New_York']) {
    test(`${locale}: SSR ${serverZone} hydrates in ${timezoneId} without replacing the account row`, async ({ browser }) => {
      const context = await browser.newContext({ locale, timezoneId });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.route('**/*', route => route.abort());
      try {
        await page.setContent(`<html><body><div id="root">${serverHtml(locale, serverZone)}</div></body></html>`);
        await expect(page.locator('#summer')).toHaveText(expectedDate(locale, 'UTC', samples.summer));
        await page.evaluate(() => { window.__formatBefore = document.getElementById('root')!.firstElementChild; });
        for (const [pkg, file] of [
          ['react', 'umd/react.development.js'], ['react-dom', 'umd/react-dom.development.js'],
          ['lucide-react', 'dist/umd/lucide-react.min.js'],
        ]) {
          await page.addScriptTag({ path: path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file) });
          if (pkg === 'react') await page.addScriptTag({ content: 'window.react=window.React;' });
        }
        await page.addScriptTag({ content: `const React=window.React;
          const external={react:React,'lucide-react':window.LucideReact,
          '@/app/(app)/dashboard/social/actions':{},'@capacitor/core':{},'@capacitor/haptics':{}};
          ${loader(locale)}window.__formatErrors=[];ReactDOM.hydrateRoot(document.getElementById('root'),tree,
          {onRecoverableError:error=>window.__formatErrors.push(error.message)});` });
        await expect.poll(() => page.evaluate(() => window.__formatHydrated)).toBe(true);
        for (const [id, stamp] of Object.entries(samples)) {
          await expect(page.locator(`#${id}`)).toHaveText(expectedDate(locale, timezoneId, stamp));
        }
        for (const id of ['isoLocal', 'slashLocal', 'namedLocal']) {
          await expect(page.locator(`#${id}`)).toHaveText(expectedDate(locale, 'UTC', samples.summer));
        }
        await expect(page.locator('#dateOnly')).toHaveText(normaliseClock(new Intl.DateTimeFormat(locale, {
          month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
        }).format(new Date('2026-03-29T00:00:00Z'))));
        await expect(page.locator('#money')).toHaveText(new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(123.45));
        await expect(page.locator('#invalid')).toBeEmpty();
        expect(await page.evaluate(() => window.__formatErrors)).toEqual([]);
        expect(pageErrors).toEqual([]);
        expect(await page.evaluate(() => window.__formatBefore === document.getElementById('root')!.firstElementChild)).toBe(true);
      } finally { await context.close(); }
    });
  }
}
