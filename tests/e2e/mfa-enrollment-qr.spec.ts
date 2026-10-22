import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Actual SecurityPanel, shared controls, React and installed Supabase SDK.
// Only provider HTTP, formatting/translations and toast/clipboard sinks are
// fixtures. The synthetic SVG proves image decoding, not authenticator scanning
// or production enrollment. No real account, token or TOTP secret is used.
const { react, reactDom } = reactBrowserScripts();
const sdk = fs.readFileSync(path.join(path.dirname(require.resolve('@supabase/supabase-js/package.json')), 'dist/umd/supabase.js'), 'utf8');
const isolated = new Set(['react', 'react-dom', 'lucide-react', '@/lib/supabase/client',
  '@/components/i18n/locale-provider', '@/components/i18n/use-format', '@/components/ui/toast', '@/lib/utils/cn']);
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(filename: string): string {
  const id = path.resolve([filename, `${filename}.ts`, `${filename}.tsx`]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? filename);
  if (modules[id]) return id;
  const source = ts.transpileModule(fs.readFileSync(id, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
  const item = modules[id] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(["']([^"']+)["']\)/g)) {
    const name = match[1];
    item.imports[name] = isolated.has(name) ? name : collect(name.startsWith('@/')
      ? path.resolve(name.slice(2)) : path.resolve(path.dirname(id), name));
  }
  return id;
}
const entry = collect('components/settings/security-panel.tsx');
const messages = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync('lib/i18n/messages/en-US.json', 'utf8')))
  .filter(([key]) => key.startsWith('securityPanel.') || key.startsWith('otp.')));
const origin = 'https://mfa-enrollment-fixture.invalid';
const provider = 'https://mfa-enrollment-provider.invalid';
const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const factorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const secret = 'SYNTHETICFIXTUREKEY';
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="29" height="29" viewBox="0 0 29 29"><rect width="29" height="29" fill="white"/><path fill="black" d="M2 2h7v7H2zM20 2h7v7h-7zM2 20h7v7H2zM14 14h3v3h-3z"/></svg>';
type Probe = { errors: string[]; toasts: string[]; copied: string[]; ready: boolean };
declare global { interface Window { __mfaEnrollmentQr: Probe } }

async function fixture(page: Page, reject = false) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'mfa@example.invalid',
    app_metadata: {}, user_metadata: {}, factors: [], created_at: '2026-10-14T00:00:00Z' };
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: userId, session_id: userId, aal: 'aal1', exp, aud: 'authenticated' })).toString('base64url'), 'synthetic-signature'].join('.');
  const session = { access_token: token, refresh_token: 'synthetic-refresh', expires_at: exp,
    expires_in: 3600, token_type: 'bearer', user };
  const headers = { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-expose-headers': 'x-supabase-api-version',
    'x-supabase-api-version': '2024-01-01' };
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin && url.pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<!doctype html><main id="root"></main>' }); return;
    }
    if (url.origin !== provider) throw new Error(`Unexpected fixture destination: ${url.origin}`);
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    requests.push({ method: request.method(), path: url.pathname, body: request.postData() ? request.postDataJSON() : null });
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password' && request.method() === 'POST') {
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(session) }); return;
    }
    if (url.pathname === '/auth/v1/user' && request.method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(user) }); return;
    }
    if (url.pathname === '/auth/v1/factors' && request.method() === 'POST') {
      await route.fulfill({ status: reject ? 422 : 200, contentType: 'application/json', headers,
        body: JSON.stringify(reject ? { code: 'mfa_totp_enroll_not_enabled', message: 'Fixture TOTP enrollment disabled' }
          : { id: factorId, type: 'totp', friendly_name: 'Bubaly fixture', totp: { qr_code: svg, secret, uri: `otpauth://totp/fixture?secret=${secret}` } }) }); return;
    }
    throw new Error(`Unexpected MFA fixture request: ${request.method()} ${url.pathname}`);
  });
  await page.goto(origin);
  for (const content of [react, reactDom, sdk]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(modules)}, loaded = {}, messages = ${JSON.stringify(messages)};
    const p = window.__mfaEnrollmentQr = { errors: [], toasts: [], copied: [], ready: false };
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { p.copied.push(value); } } });
    const client = window.supabase.createClient(${JSON.stringify(provider)}, 'synthetic-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const mocks = { react: React, 'react-dom': ReactDOM,
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/lib/supabase/client': { createClient: () => client },
      '@/components/i18n/locale-provider': { useTranslations: () => (key, values = {}) => {
        let text = messages[key] ?? key; for (const [name, value] of Object.entries(values)) text = text.replaceAll('{' + name + '}', String(value)); return text;
      } },
      '@/components/i18n/use-format': { useFormat: () => ({ fmtDate: value => value }) },
      '@/components/ui/toast': { useToast: () => ({ success: message => p.toasts.push(message) }) },
      '@/lib/utils/cn': { cn: (...values) => values.filter(value => typeof value === 'string').join(' ') },
    };
    function load(id) {
      if (id in mocks) return mocks[id]; if (loaded[id]) return loaded[id].exports;
      const item = sources[id]; if (!item) throw new Error('Unexpected fixture module: ' + id);
      const module = loaded[id] = { exports: {} };
      new Function('require', 'module', 'exports', item.source)(name => load(item.imports[name]), module, module.exports);
      return module.exports;
    }
    (async () => {
      const { error } = await client.auth.signInWithPassword({ email: 'mfa@example.invalid', password: 'synthetic-password' });
      if (error) throw error;
      const Panel = load(${JSON.stringify(entry)}).SecurityPanel;
      ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Panel)); p.ready = true;
    })().catch(error => p.errors.push(String(error)));
  })();` });
  await expect.poll(() => page.evaluate(() => window.__mfaEnrollmentQr.ready)).toBe(true);
  await expect(page.getByRole('button', { name: 'Set up authenticator', exact: true })).toBeVisible();
  return { requests, runtimeErrors };
}

test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('the installed SDK enrollment result renders as a decoded SVG image', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  const qr = page.getByRole('img', { name: 'QR code for your authenticator app' });
  await expect(qr).toBeVisible();
  await expect.poll(() => qr.evaluate(image => ({ complete: (image as HTMLImageElement).complete,
    width: (image as HTMLImageElement).naturalWidth, height: (image as HTMLImageElement).naturalHeight })))
    .toEqual({ complete: true, width: 29, height: 29 });
  expect(await qr.getAttribute('src')).toBe(`data:image/svg+xml;utf-8,${svg}`);
  expect(state.requests.filter(request => request.path === '/auth/v1/factors')).toEqual([
    { method: 'POST', path: '/auth/v1/factors', body: { factor_type: 'totp', issuer: 'Bubaly', friendly_name: expect.stringMatching(/^Bubaly \d{4}-\d{2}-\d{2}$/) } },
  ]);
  expect(state.runtimeErrors).toEqual([]);
  expect(await page.evaluate(() => window.__mfaEnrollmentQr.errors)).toEqual([]);
});

test('the manual key remains readable and copyable without claiming verified enrollment', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  await expect(page.locator('code')).toHaveText(secret);
  await page.getByRole('button', { name: 'Copy key', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mfaEnrollmentQr.copied)).toEqual([secret]);
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible();
  expect(state.requests.some(request => /\/(challenge|verify)$/.test(request.path))).toBe(false);
  expect(await page.evaluate(() => window.__mfaEnrollmentQr.toasts)).toEqual(['Key copied']);
  expect(state.runtimeErrors).toEqual([]);
  expect(await page.evaluate(() => window.__mfaEnrollmentQr.errors)).toEqual([]);
});

test('provider enrollment refusal shows an error without publishing a QR image or secret', async ({ page }) => {
  const state = await fixture(page, true);
  await page.getByRole('button', { name: 'Set up authenticator', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText("Two-step sign-in isn't switched on");
  await expect(page.getByRole('img')).toHaveCount(0);
  await expect(page.locator('code')).toHaveCount(0);
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up authenticator', exact: true })).toBeEnabled();
  expect(state.requests.filter(request => request.path === '/auth/v1/factors')).toHaveLength(1);
  expect(state.runtimeErrors).toEqual([]);
  expect(await page.evaluate(() => ({ errors: window.__mfaEnrollmentQr.errors, toasts: window.__mfaEnrollmentQr.toasts })))
    .toEqual({ errors: [], toasts: [] });
});
