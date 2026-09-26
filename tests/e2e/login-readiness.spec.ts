import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as React from 'react';
import { renderToString } from 'react-dom/server';
import { expect, test, type Page } from '@playwright/test';

// Actual server-rendered LoginForm and actual React hydration, with a synthetic
// password-action boundary. The separate password-login-boundaries suite covers
// the installed SDK and owned-session adoption. No application server or provider.
const origin = 'https://login-readiness-fixture.invalid';
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const isolated = new Set(['react', 'lucide-react', 'next/link', 'next/navigation', '@/components/ui/toast',
  '@/components/i18n/locale-provider', '@/app/(auth)/actions', '@/lib/auth/password-client', '@/lib/utils/cn',
  '@/components/auth/oauth-buttons', '@/components/auth/phone-auth', '@/components/auth/recovery-form']);
const sources: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = [filename, `${filename}.ts`, `${filename}.tsx`].map(candidate => path.resolve(candidate))
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!id) throw new Error('Missing login readiness fixture module');
  if (sources[id]) return id;
  const raw = fs.readFileSync(id, 'utf8');
  const source = /\.tsx?$/.test(id) ? ts.transpileModule(raw, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText : raw;
  const item = sources[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    if (isolated.has(name)) item.imports[name] = name;
    else item.imports[name] = collect(name.startsWith('@/') ? name.slice(2) : name.startsWith('.') && /\.tsx?$/.test(id)
      ? path.resolve(path.dirname(id), name) : require.resolve(name, { paths: [path.dirname(id)] }));
  }
  return id;
}
const entry = collect('components/auth/login-form.tsx');
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
  .filter(([key]) => /^(login\.|loginForm\.|legalConsent\.|authRecovery\.)/.test(key)));
type Probe = { hydrated: boolean; calls: Array<{ email: string; password: string }>; errors: string[]; hydrate: () => void };
declare global { interface Window { __loginReady: Probe } }

// Identical markup-producing modules run in Node's SSR and browser hydration.
const loader = `
  const loaded = {};
  const mocks = {
    react: React, 'lucide-react': new Proxy({}, { get: () => () => null }),
    'next/link': { default: ({ children, ...props }) => React.createElement('a', props, children) },
    'next/navigation': { useRouter: () => ({ push: () => {}, refresh: () => {} }), useSearchParams: () => new URLSearchParams('reviewPlan=plus_annual') },
    '@/components/i18n/locale-provider': { useTranslations: () => key => messages[key] ?? key },
    '@/components/ui/toast': { useToast: () => ({ error: () => {} }) },
    '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
    '@/components/auth/oauth-buttons': { authButtonClass: '', OAuthButtons: () => null },
    '@/components/auth/phone-auth': { PhoneAuth: () => null },
    '@/components/auth/recovery-form': { RecoveryForm: () => null },
    '@/app/(auth)/actions': { stitchIdentityAction: async () => {}, resolveLandingPathAction: async () => '/home' },
    '@/lib/auth/password-client': {
      isPasswordSessionCurrent: () => false,
      signInWithOwnedSession: async (credentials, canCommit) => {
        if (!canCommit()) throw new Error('Retired synthetic login');
        probe.calls.push(credentials);
        return { data: { user: null, session: null }, error: new Error('Synthetic credential rejection') };
      },
    },
  };
  function load(id) {
    if (id in mocks) return mocks[id];
    if (loaded[id]) return loaded[id].exports;
    const item = sources[id]; if (!item) throw new Error('Unexpected login readiness fixture import');
    const module = loaded[id] = { exports: {} };
    new Function('require', 'module', 'exports', 'React', item.source)(name => load(item.imports[name]), module, module.exports, React);
    return module.exports;
  }
  const Form = load(entry).LoginForm;
  function Hydrated() {
    React.useLayoutEffect(() => { probe.hydrated = true; }, []);
    return React.createElement(Form);
  }
`;
function serverMarkup(): string {
  const Form = new Function('React', 'sources', 'entry', 'messages', 'probe', `${loader}; return Hydrated;`)(
    React, sources, entry, messages, { calls: [] },
  );
  return renderToString(React.createElement(Form));
}
async function fixture(page: Page) {
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="root">${serverMarkup()}</main></body></html>`;
  const submissions: Array<{ method: string; credentialsInQuery: boolean; credentialsInBody: boolean }> = [];
  let served = false;
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { await route.abort(); return; }
    if (!served) { served = true; await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }); return; }
    if (request.isNavigationRequest()) {
      const body = new URLSearchParams(request.postData() ?? '');
      submissions.push({ method: request.method(), credentialsInQuery: url.searchParams.has('email') || url.searchParams.has('password'),
        credentialsInBody: body.has('email') || body.has('password') });
      await route.fulfill({ status: 204 }); return;
    }
    await route.abort();
  });
  await page.goto(`${origin}/login?reviewPlan=plus_annual`, { waitUntil: 'domcontentloaded' });
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, entry = ${JSON.stringify(entry)}, messages = ${JSON.stringify(messages)};
    const probe = window.__loginReady = { hydrated: false, calls: [], errors: [] };
    window.addEventListener('error', event => probe.errors.push(event.message));
    window.addEventListener('unhandledrejection', event => { probe.errors.push(String(event.reason)); event.preventDefault(); });
    ${loader}
    probe.hydrate = () => ReactDOM.hydrateRoot(document.getElementById('root'), React.createElement(Hydrated), {
      onRecoverableError: error => probe.errors.push(String(error)),
    });
  })();` });
  return submissions;
}
async function hydrate(page: Page) {
  await page.evaluate(() => window.__loginReady.hydrate());
  await expect.poll(() => page.evaluate(() => window.__loginReady.hydrated)).toBe(true);
  expect(await page.evaluate(() => window.__loginReady.errors)).toEqual([]);
}
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('SSR password fields and submit wait for real hydration, then accept the first edits', async ({ page }) => {
  const submissions = await fixture(page);
  const email = page.locator('input[name="email"]'), password = page.locator('input[name="password"]');
  await expect(email).toBeDisabled(); await expect(password).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeDisabled();
  const firstEdit = email.fill('synthetic@example.invalid');
  await hydrate(page); await firstEdit;
  await password.fill('synthetic-only-password');
  await expect(email).toHaveValue('synthetic@example.invalid');
  await expect(password).toHaveValue('synthetic-only-password');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  expect(submissions.length).toBe(0);
  expect(await page.evaluate(() => window.__loginReady.calls.length)).toBe(0);
});

test('native pre-hydration submission never serializes credential fields into the URL', async ({ page }) => {
  const submissions = await fixture(page);
  // DOM population models autofill. Native requestSubmit has no React handler
  // yet and exercises the browser's real method/disabled-field serialization.
  await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('input[name="email"]')!.value = 'synthetic@example.invalid';
    document.querySelector<HTMLInputElement>('input[name="password"]')!.value = 'synthetic-only-password';
    document.querySelector<HTMLFormElement>('form')!.requestSubmit();
  });
  await expect.poll(() => submissions.length).toBe(1);
  expect.soft(submissions[0].credentialsInQuery, 'Native submission must never place credentials in the query string').toBe(false);
  expect.soft(submissions[0].method).toBe('POST');
  expect(submissions[0].credentialsInBody, 'Pre-hydration disabled fields must not become successful native controls').toBe(false);
});

test('hydrated login retains editing and retry after a rejected owned attempt', async ({ page }) => {
  const submissions = await fixture(page);
  await hydrate(page);
  const email = page.locator('input[name="email"]'), password = page.locator('input[name="password"]');
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  await email.fill('FIRST@EXAMPLE.INVALID'); await password.fill('synthetic-first-password');
  await submit.click();
  await expect.poll(() => page.evaluate(() => window.__loginReady.calls.length)).toBe(1);
  await expect(email).toBeEnabled(); await expect(password).toBeEnabled(); await expect(submit).toBeEnabled();
  await email.fill('SECOND@EXAMPLE.INVALID'); await password.fill('synthetic-second-password');
  await submit.click();
  await expect.poll(() => page.evaluate(() => window.__loginReady.calls.length)).toBe(2);
  expect(await page.evaluate(() => window.__loginReady.calls)).toEqual([
    { email: 'first@example.invalid', password: 'synthetic-first-password' },
    { email: 'second@example.invalid', password: 'synthetic-second-password' },
  ]);
  expect(submissions.length).toBe(0);
  expect(await page.evaluate(() => window.__loginReady.errors)).toEqual([]);
});
