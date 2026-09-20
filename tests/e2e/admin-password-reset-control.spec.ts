import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Real React effects/handlers and the production admin control execute. Server
// action results are controlled here; the companion unit suite runs the actual
// action with installed Auth/PostgREST and synthetic transport.
const origin = 'https://admin-reset-control-fixture.invalid';
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const source = ts.transpileModule(fs.readFileSync('components/admin/user-security-actions.tsx', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
type Probe = {
  calls: string[]; toasts: string[]; errors: string[]; held: boolean; reject: boolean; result: Record<string, unknown>;
  mount: (id?: string, email?: string | null) => void; unmount: () => void; release: () => void;
  capture: () => void; invoke: () => void; bans: number;
};
declare global { interface Window { __adminResetControl: Probe } }
async function fixture(page: Page, locale = 'en-US') {
  const catalogue = JSON.parse(fs.readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<html><body><main id="root"></main></body></html>' }));
  await page.goto(origin);
  await page.clock.install();
  for (const script of [react, reactDom]) await page.addScriptTag({ content: script });
  await page.addScriptTag({ content: `(() => {
    const catalogue = ${JSON.stringify(catalogue)};
    const p = window.__adminResetControl = { calls: [], toasts: [], errors: [], held: false, reject: false, bans: 0,
      result: { ok: true, outcome: 'accepted', audit: 'recorded' } };
    window.addEventListener('unhandledrejection', event => p.errors.push(String(event.reason)));
    window.addEventListener('error', event => p.errors.push(event.message));
    const waiters = [];
    p.release = () => waiters.splice(0).forEach(resolve => resolve());
    const mocks = {
      react: React, 'next/navigation': { useRouter: () => ({ refresh() {} }) },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/ui/toast': { useToast: () => ({ success: message => p.toasts.push(message), error: message => p.toasts.push(message) }) },
      '@/components/i18n/locale-provider': { useTranslations: () => key => catalogue[key] || key },
      '@/app/(app)/admin/actions': {
        adminSendPasswordResetAction: async email => { p.calls.push(email); if (p.held) await new Promise(resolve => waiters.push(resolve));
          if (p.reject) throw new Error('Synthetic reset action response lost'); return p.result; },
        adminSetUserBanAction: async () => { p.bans++; return { ok: true }; },
      },
    };
    const module = { exports: {} };
    new Function('require','module','exports', ${JSON.stringify(source)})(id => { if (!(id in mocks)) throw new Error('Unexpected import '+id); return mocks[id]; }, module, module.exports);
    const Control = module.exports.UserSecurityActions;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    p.mount = (userId = 'user-a', email = 'a@example.invalid') => ReactDOM.flushSync(() => root.render(React.createElement(Control, { userId, email, banned: false })));
    p.unmount = () => ReactDOM.flushSync(() => root.render(null));
    let captured;
    p.capture = () => { const button = Array.from(document.querySelectorAll('button')).find(node => node.textContent.includes(catalogue['userSecurityActions.sendPasswordReset']));
      const key = Object.keys(button).find(key => key.startsWith('__reactProps$')); captured = button[key].onClick; };
    p.invoke = () => { const result = captured(); if (result && result.catch) result.catch(error => p.errors.push(String(error))); };
    p.mount();
  })();` });
  const menu = page.getByRole('button', { name: catalogue['userSecurityActions.accountActions'] });
  const reset = page.getByRole('button', { name: catalogue['userSecurityActions.sendPasswordReset'], exact: true });
  const ban = page.getByRole('button', { name: catalogue['userSecurityActions.banAccount'], exact: true });
  await menu.click();
  return { menu, reset, ban, catalogue };
}

test('one synchronous attempt prevents two held reset requests', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const p = window.__adminResetControl; p.held = true; p.capture(); p.invoke(); p.invoke(); });
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toHaveLength(1);
  await page.evaluate(() => window.__adminResetControl.release());
});
test('a thrown action is contained, releases busy controls, and blocks repeat across menu reopen', async ({ page }) => {
  const { menu, reset, ban, catalogue } = await fixture(page);
  await page.evaluate(() => { window.__adminResetControl.reject = true; window.__adminResetControl.capture(); });
  await reset.click();
  await expect(ban).toBeEnabled({ timeout: 1000 });
  await expect(reset).toBeDisabled();
  await expect(page.getByRole('status')).toContainText(catalogue['userSecurityActions.resetUncertain']);
  await menu.click(); await menu.click();
  await expect(reset).toBeDisabled();
  await page.evaluate(() => window.__adminResetControl.invoke());
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toHaveLength(1);
  expect(await page.evaluate(() => window.__adminResetControl.errors)).toEqual([]);
});
test('accepted request plus audit warning stays visible without sending again', async ({ page }) => {
  const { menu, reset, catalogue } = await fixture(page);
  await page.evaluate(warning => { const p = window.__adminResetControl; p.result = { ok: true, outcome: 'accepted', audit: 'unconfirmed', warning }; p.capture(); }, catalogue['userSecurityActions.resetAuditUnconfirmed']);
  await reset.click();
  await expect(page.getByRole('status')).toContainText(catalogue['userSecurityActions.resetAuditUnconfirmed']);
  if (!(await reset.isVisible())) await menu.click();
  await expect(reset).toBeDisabled();
  await page.evaluate(() => window.__adminResetControl.invoke());
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toHaveLength(1);
});
test('a definitive rejection permits one corrected retry, then acceptance locks repeat', async ({ page }) => {
  const { menu, reset, catalogue } = await fixture(page);
  await page.evaluate(() => { window.__adminResetControl.result = { ok: false, outcome: 'failed', error: 'Definitive rejection' }; });
  await reset.click();
  await expect.poll(() => page.evaluate(() => window.__adminResetControl.toasts)).toContain('Definitive rejection');
  if (!(await reset.isVisible())) await menu.click();
  await expect(reset).toBeEnabled();
  await page.evaluate(() => { window.__adminResetControl.result = { ok: true, outcome: 'accepted', audit: 'recorded' }; });
  await reset.click();
  await expect(page.getByRole('status')).toContainText(catalogue['userSecurityActions.resetAccepted']);
  if (!(await reset.isVisible())) await menu.click();
  await expect(reset).toBeDisabled();
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toHaveLength(2);
});
test('target change suppresses prior completion and retained callbacks', async ({ page }) => {
  const { reset } = await fixture(page);
  await page.evaluate(() => { const p = window.__adminResetControl; p.held = true; p.capture(); });
  await reset.click();
  await page.evaluate(() => { const p = window.__adminResetControl; p.mount('user-b', 'b@example.invalid'); p.release(); p.invoke(); });
  await expect.poll(() => page.evaluate(() => window.__adminResetControl.toasts)).toEqual([]);
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toEqual(['a@example.invalid']);
});
test('unmounted retained callback never dispatches', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const p = window.__adminResetControl; p.capture(); p.unmount(); p.invoke(); });
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toEqual([]);
});
test('retired callback stays retired after the same target returns', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const p = window.__adminResetControl; p.capture(); p.mount('user-b', 'b@example.invalid'); p.mount(); p.invoke(); });
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toEqual([]);
});
test('returning to a target with a dispatched request keeps its reset locked', async ({ page }) => {
  const { reset, catalogue } = await fixture(page);
  await page.evaluate(() => { window.__adminResetControl.held = true; });
  await reset.click();
  await page.evaluate(() => window.__adminResetControl.mount('user-b', 'b@example.invalid'));
  await expect(reset).toBeEnabled();
  await page.evaluate(() => window.__adminResetControl.mount());
  await expect(reset).toBeDisabled({ timeout: 1000 });
  await expect(page.getByRole('status')).toContainText(catalogue['userSecurityActions.resetUncertain']);
  await page.evaluate(() => { const p = window.__adminResetControl; p.capture(); p.invoke(); p.release(); });
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toHaveLength(1);
});
test('held action reaches review after deadline and late acceptance cannot reopen retry', async ({ page }) => {
  const { reset, ban, catalogue } = await fixture(page);
  await page.evaluate(() => { window.__adminResetControl.held = true; window.__adminResetControl.capture(); });
  await reset.click();
  await page.clock.fastForward(15_001);
  await expect(ban).toBeEnabled({ timeout: 1000 });
  await expect(reset).toBeDisabled();
  await expect(page.getByRole('status')).toContainText(catalogue['userSecurityActions.resetUncertain']);
  await page.evaluate(() => { const p = window.__adminResetControl; p.release(); p.invoke(); });
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toHaveLength(1);
  expect(await page.evaluate(() => window.__adminResetControl.toasts)).not.toContain(catalogue['userSecurityActions.resetAccepted']);
});
test('missing recipient causes no request', async ({ page }) => {
  const { reset, catalogue } = await fixture(page);
  await page.evaluate(() => window.__adminResetControl.mount('user-a', null));
  await reset.click();
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toEqual([]);
  expect(await page.evaluate(() => window.__adminResetControl.toasts)).toContain(catalogue['userSecurityActions.noEmailOnFile']);
});
test('uncertainty is translated in French', async ({ page }) => {
  const { reset, catalogue } = await fixture(page, 'fr-FR');
  await page.evaluate(() => { window.__adminResetControl.result = { ok: false, outcome: 'uncertain', error: 'server detail' }; });
  await reset.click();
  await expect(page.getByRole('status')).toContainText(catalogue['userSecurityActions.resetUncertain']);
  expect(catalogue['userSecurityActions.resetUncertain']).toBeTruthy();
});
test('the existing ban control remains usable without a reset request', async ({ page }) => {
  const { ban } = await fixture(page);
  page.once('dialog', dialog => dialog.accept());
  await ban.click();
  expect(await page.evaluate(() => window.__adminResetControl.bans)).toBe(1);
  expect(await page.evaluate(() => window.__adminResetControl.calls)).toEqual([]);
});
