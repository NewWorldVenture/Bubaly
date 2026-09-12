import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { expect, test, type Page } from '@playwright/test';

// Render the actual child form on the server, then explicitly release its real
// React hydration. The action/adoption boundary is synthetic: these cases prove
// readiness and retained input; kid-login-boundaries covers the actual auth SDK.
const origin = 'https://kid-readiness-fixture.invalid';
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/link', 'next/navigation', '@/components/ui/toast',
  '@/components/i18n/locale-provider', '@/app/(auth)/actions', '@/lib/auth/password-client', '@/lib/utils/cn']);
const sources: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = [filename, `${filename}.ts`, `${filename}.tsx`].map(candidate => path.resolve(candidate))
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!id) throw new Error('Missing readiness fixture module');
  if (sources[id]) return id;
  const source = ts.transpileModule(fs.readFileSync(id, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const item = sources[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name)) item.imports[name] = name;
    else item.imports[name] = collect(name.startsWith('@/') ? name.slice(2) : path.resolve(path.dirname(id), name));
  }
  return id;
}
const entry = collect('components/auth/kid-login-form.tsx');
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
  .filter(([key]) => /^(kidLogin\.|actions\.)/.test(key)));

type Probe = { hydrated: boolean; calls: number; errors: string[]; hydrate: () => void };
declare global { interface Window { __kidReady: Probe } }

// One loader is used in Node's server renderer and the browser's hydrator so
// the real form and each markup-producing dependency are identical on both.
const loader = `
  const loaded = {};
  const mocks = {
    react: React, 'lucide-react': new Proxy({}, { get: () => () => null }),
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
    'next/navigation': { useRouter: () => ({ push: () => {}, refresh: () => {} }) },
    '@/components/i18n/locale-provider': { useTranslations: () => key => messages[key] ?? key },
    '@/components/ui/toast': { useToast: () => ({ error: () => {} }) },
    '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
    '@/app/(auth)/actions': { childSignInAction: async () => {
      probe.calls++;
      return { ok: false, error: 'Synthetic credential rejection' };
    } },
    '@/lib/auth/password-client': {
      isPasswordSessionCurrent: () => false,
      signInWithOwnedSessionTokens: async (receiveTokens, canCommit) => {
        if (!canCommit()) throw new Error('Retired synthetic attempt');
        await receiveTokens();
        throw new Error('Synthetic adoption must not run');
      },
    },
  };
  function load(id) {
    if (id in mocks) return mocks[id];
    if (loaded[id]) return loaded[id].exports;
    const item = sources[id];
    if (!item) throw new Error('Unexpected readiness fixture import');
    const module = loaded[id] = { exports: {} };
    new Function('require', 'module', 'exports', 'React', item.source)(name => load(item.imports[name]), module, module.exports, React);
    return module.exports;
  }
  const Form = load(entry).KidLoginForm;
`;
function serverMarkup(): string {
  const Form = new Function('React', 'sources', 'entry', 'messages', 'probe', `${loader}; return Form;`)(
    React, sources, entry, messages, { calls: 0 },
  );
  return renderToString(React.createElement(Form));
}
async function fixture(page: Page): Promise<void> {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="root">${serverMarkup()}</main></body></html>`;
  await page.route('**/*', async route => {
    if (route.request().url() === `${origin}/`) await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    else await route.abort();
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, entry = ${JSON.stringify(entry)}, messages = ${JSON.stringify(messages)};
    const probe = window.__kidReady = { hydrated: false, calls: 0, errors: [] };
    window.addEventListener('error', event => probe.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { probe.errors.push(String(event.reason)); event.preventDefault(); });
    ${loader}
    function Hydrated() {
      React.useLayoutEffect(() => { probe.hydrated = true; }, []);
      return React.createElement(Form);
    }
    probe.hydrate = () => ReactDOM.hydrateRoot(document.getElementById('root'), React.createElement(Hydrated), {
      onRecoverableError: error => probe.errors.push(String(error)),
    });
  })();` });
}
async function hydrate(page: Page): Promise<void> {
  await page.evaluate(() => window.__kidReady.hydrate());
  await expect.poll(() => page.evaluate(() => window.__kidReady.hydrated)).toBe(true);
  expect(await page.evaluate(() => window.__kidReady.errors)).toEqual([]);
}
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('server-rendered child credentials wait for hydration before accepting the first edits', async ({ page }) => {
  await fixture(page);
  const username = page.locator('input[name="username"]'), pin = page.locator('input[name="pin"]');
  await expect(username).toBeDisabled();
  await expect(pin).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Show PIN', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
  // A normal browser fill initiated before readiness must wait, not leave a DOM
  // value that React never observed. No force events or private React state.
  const firstEdit = username.fill('syntheticchild');
  await hydrate(page);
  await firstEdit;
  await pin.fill('1234');
  await expect(username).toHaveValue('syntheticchild');
  await expect(pin).toHaveValue('1234');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__kidReady.calls)).toBe(0);
});

test('control: input after actual hydration enables one child sign-in attempt', async ({ page }) => {
  await fixture(page);
  await hydrate(page);
  await page.locator('input[name="username"]').fill('syntheticchild');
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  await page.locator('input[name="pin"]').fill('123');
  await expect(submit).toBeDisabled();
  await page.locator('input[name="pin"]').fill('1234');
  await page.getByRole('button', { name: 'Show PIN', exact: true }).click();
  await expect(page.locator('input[name="pin"]')).toHaveAttribute('type', 'text');
  await expect(page.locator('input[name="pin"]')).toHaveValue('1234');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect.poll(() => page.evaluate(() => window.__kidReady.calls)).toBe(1);
  await expect(submit).toBeEnabled();
  expect(await page.evaluate(() => window.__kidReady.errors)).toEqual([]);
});
