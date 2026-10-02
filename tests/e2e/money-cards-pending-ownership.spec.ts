import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Mount the real component and Button with controlled action promises. No
// server, provider SDK, database, or network is involved in these UI checks.
const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries(['components/wallet/money-cards-view.tsx', 'components/ui/button.tsx'].map(file => [
  `@/${file.replace(/\.tsx$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));
type ActionCall = { action: string; args?: Record<string, unknown>; settled: boolean };
type Outcome = 'refusal' | 'rejection' | 'success';
type Probe = {
  calls: ActionCall[]; errors: string[]; successes: string[]; refreshes: number; faults: string[];
  complete: (index: number, outcome: Outcome) => void;
  capture: (label: string, index?: number) => void;
  dispatchCaptured: (times?: number) => void;
  settle: () => Promise<void>;
};
declare global { interface Window { __moneyPending: Probe } }

async function fixture(page: Page, setup = false) {
  await page.context().setOffline(true);
  const requests: string[] = [];
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => { throw error; });
  await page.setContent('<!doctype html><main id="root"></main>');
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, modules = {}, waiting = [];
    const p = window.__moneyPending = { calls: [], errors: [], successes: [], refreshes: 0, faults: [] };
    window.addEventListener('unhandledrejection', event => { p.faults.push(String(event.reason)); event.preventDefault(); });
    function action(name, args) {
      p.calls.push({ action: name, args, settled: false });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    }
    const mocks = {
      react: React,
      'next/navigation': { useRouter: () => ({ refresh: () => { p.refreshes++; } }) },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/app/page-header': { PageHeader: ({ title }) => React.createElement('h1', null, title) },
      '@/components/ui/modal': { Modal: ({ children }) => React.createElement('div', null, children) },
      '@/components/ui/input': { Field: ({ children }) => children('fixture-field'), Input: props => React.createElement('input', props) },
      '@/components/ui/states': { EmptyState: () => null },
      '@/components/ui/toast': { useToast: () => ({ success: text => p.successes.push(text), error: text => p.errors.push(text) }) },
      '@/components/ui/avatar': { Avatar: () => null },
      '@/lib/utils/cn': { cn: (...values) => values.filter(Boolean).join(' ') },
      '@/components/wallet/wallet-subnav': { WalletSubnav: () => null },
      '@/lib/wallet/ledger': { formatCents: value => String(value) },
      '@/lib/wallet/card-controls': { SPEND_WINDOWS: [], BLOCKABLE_CATEGORIES: [] },
      '@/app/(app)/money/actions': Object.fromEntries(['startConnectOnboardingAction', 'issueCardAction', 'setCardFrozenAction', 'updateCardControlsAction'].map(name => [name, args => action(name, args)])),
      '@/components/wallet/card-reveal-modal': { CardRevealModal: () => null },
      '@/components/i18n/locale-provider': { useLocale: () => ({ code: 'en-US' }), useTranslations: () => (key, values) => values?.count ? key + ':' + values.count : key },
      '@/lib/marketplace/listings': { currencyUnit: () => ({ before: true, symbol: '$' }) },
      // No known identity: each mounted view keeps its own claims, as before.
      '@/components/app/app-context': { useApp: () => ({ userId: null, familyId: null }) },
    };
    function load(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (modules[id]) return modules[id];
      if (!sources[id]) throw new Error('Unexpected browser module ' + id);
      const module = { exports: {} };
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return modules[id] = module.exports;
    }
    const props = {
      capabilities: { connectOnboarding: true, issuing: true, physicalCards: false },
      accountReady: ${!setup}, onboardingStarted: false, canManage: true,
      childWallets: [{ id: 'child-a', name: 'Child A', color: null }, { id: 'child-b', name: 'Child B', color: null }, { id: 'child-c', name: 'Child C', color: null }],
      cards: [{ id: 'card-c', childWalletId: 'child-c', type: 'virtual', status: 'active', last4: '1234', brand: 'Visa', isFrozen: false, spendLimitCents: null, spendWindow: 'per_authorization', blockedCategories: [] }],
    };
    const root = ReactDOM.createRoot(document.getElementById('root'));
    ReactDOM.flushSync(() => root.render(React.createElement(load('@/components/wallet/money-cards-view').MoneyCardsView, props)));
    p.complete = (index, outcome) => {
      p.calls[index].settled = true;
      if (outcome === 'rejection') waiting[index].reject(new Error('Action unavailable'));
      else waiting[index].resolve(outcome === 'refusal' ? { ok: false, error: 'Action refused' } : { ok: true, data: {} });
    };
    let captured;
    p.capture = (label, index = 0) => {
      const button = [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === label)[index];
      if (!button) throw new Error('Missing button ' + label);
      captured = button[Object.keys(button).find(key => key.startsWith('__reactProps$'))].onClick;
    };
    p.dispatchCaptured = (times = 1) => { for (let index = 0; index < times; index++) void captured(); };
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })();` });
  return requests;
}

const virtual = (page: Page, index = 0) => page.getByRole('button', { name: 'Virtual', exact: true }).nth(index);
const freeze = (page: Page) => page.getByRole('button', { name: 'Freeze', exact: true });
const bulk = (page: Page) => page.getByRole('button', { name: 'moneyCards.issueAll', exact: true });
const setup = (page: Page) => page.getByRole('button', { name: /^Get started/ });
const read = (page: Page) => page.evaluate(() => {
  const { calls, errors, successes, refreshes, faults } = window.__moneyPending;
  return { calls, errors, successes, refreshes, faults };
});
async function complete(page: Page, index: number, outcome: Outcome) {
  await page.evaluate(({ index, outcome }) => window.__moneyPending.complete(index, outcome), { index, outcome });
  await page.evaluate(() => window.__moneyPending.settle());
}
async function capture(page: Page, label: string, index = 0) {
  await page.evaluate(({ label, index }) => window.__moneyPending.capture(label, index), { label, index });
}
async function dispatch(page: Page, times = 1) {
  await page.evaluate(times => window.__moneyPending.dispatchCaptured(times), times);
  await page.evaluate(() => window.__moneyPending.settle());
}
test.afterEach(async ({ page }) => {
  expect((await read(page)).faults).toEqual([]);
});

test('B refusal leaves A disabled until its own issuance finishes, without duplicate ordinary clicks', async ({ page }) => {
  const requests = await fixture(page);
  await virtual(page).click(); await expect(virtual(page)).toBeDisabled();
  await expect(virtual(page, 1)).toBeEnabled(); await virtual(page, 1).click();
  await complete(page, 1, 'refusal');
  await expect(virtual(page, 1)).toBeEnabled(); await expect(virtual(page)).toBeDisabled();
  await virtual(page).evaluate(button => (button as HTMLButtonElement).click());
  expect(await read(page)).toMatchObject({ calls: [{ settled: false }, { settled: true }], errors: ['Action refused'], successes: [], refreshes: 0 });
  await complete(page, 0, 'success');
  await expect(virtual(page)).toBeEnabled();
  expect(await read(page)).toMatchObject({ successes: ['moneyCardsView.virtualCardCreated'], refreshes: 1 });
  expect(requests).toEqual([]);
});

for (const operation of ['virtual', 'freeze', 'setup'] as const) {
  for (const outcome of ['refusal', 'rejection', 'success'] as const) {
    test(`${operation} ${outcome} releases its own control with honest feedback and allows an explicit next action`, async ({ page }) => {
      const requests = await fixture(page, operation === 'setup');
      const button = operation === 'virtual' ? virtual(page) : operation === 'freeze' ? freeze(page) : setup(page);
      await button.click(); await expect(button).toBeDisabled();
      await complete(page, 0, outcome); await expect(button).toBeEnabled();
      const result = await read(page);
      expect(result.calls).toHaveLength(1);
      expect(result.errors).toEqual(outcome === 'refusal' ? ['Action refused'] : outcome === 'rejection' ? ['globalError.somethingWentWrong'] : []);
      expect(result.successes).toEqual(outcome === 'success' && operation !== 'setup' ? [operation === 'virtual' ? 'moneyCardsView.virtualCardCreated' : 'Card frozen'] : []);
      expect(result.refreshes).toBe(outcome === 'success' && operation !== 'setup' ? 1 : 0);
      await button.click(); expect((await read(page)).calls).toHaveLength(2);
      await complete(page, 1, 'refusal'); expect(requests).toEqual([]);
    });
  }
}

for (const operation of ['virtual', 'freeze', 'setup', 'bulk'] as const) {
  test(`${operation} blocks same-turn retained callbacks while its action is pending`, async ({ page }) => {
    const requests = await fixture(page, operation === 'setup');
    const button = operation === 'virtual' ? virtual(page) : operation === 'freeze' ? freeze(page) : operation === 'setup' ? setup(page) : bulk(page);
    await capture(page, (await button.innerText()).trim());
    await dispatch(page, 2);
    expect((await read(page)).calls).toHaveLength(1); await expect(button).toBeDisabled();
    await dispatch(page); expect((await read(page)).calls).toHaveLength(1);
    await complete(page, 0, 'refusal');
    if (operation === 'bulk') await complete(page, 1, 'refusal');
    await expect(button).toBeEnabled(); expect(requests).toEqual([]);
  });
}

test('issuance success cannot release an unrelated pending freeze, and freeze rejection permits its own explicit next action', async ({ page }) => {
  const requests = await fixture(page);
  await freeze(page).click(); await expect(virtual(page)).toBeEnabled();
  await virtual(page).click(); await expect(freeze(page)).toBeDisabled();
  await complete(page, 1, 'success');
  await expect(virtual(page)).toBeEnabled(); await expect(freeze(page)).toBeDisabled();
  await complete(page, 0, 'rejection'); await expect(freeze(page)).toBeEnabled();
  expect(await read(page)).toMatchObject({ errors: ['globalError.somethingWentWrong'], successes: ['moneyCardsView.virtualCardCreated'], refreshes: 1 });
  await freeze(page).click(); expect((await read(page)).calls).toHaveLength(3);
  await complete(page, 2, 'success'); expect((await read(page)).refreshes).toBe(2);
  expect(requests).toEqual([]);
});

test('earlier A completion preserves later B ownership, including a retained B callback', async ({ page }) => {
  const requests = await fixture(page);
  await capture(page, 'Virtual', 1);
  await virtual(page).click(); await virtual(page, 1).click();
  await expect(virtual(page)).toBeDisabled(); await expect(virtual(page, 1)).toBeDisabled();
  await complete(page, 0, 'refusal');
  await expect(virtual(page)).toBeEnabled(); await expect(virtual(page, 1)).toBeDisabled();
  await dispatch(page); expect((await read(page)).calls).toHaveLength(2);
  expect((await read(page)).calls[1].settled).toBe(false);
  await complete(page, 1, 'success'); await expect(virtual(page, 1)).toBeEnabled();
  expect(await read(page)).toMatchObject({ errors: ['Action refused'], successes: ['moneyCardsView.virtualCardCreated'], refreshes: 1 });
  expect(requests).toEqual([]);
});

test('individual issuance blocks overlapping bulk callbacks without blocking another child or freeze', async ({ page }) => {
  const requests = await fixture(page);
  await capture(page, 'moneyCards.issueAll'); await virtual(page).click();
  await expect(bulk(page)).toBeDisabled(); await dispatch(page);
  expect((await read(page)).calls).toHaveLength(1);
  await expect(virtual(page, 1)).toBeEnabled(); await expect(freeze(page)).toBeEnabled();
  await complete(page, 0, 'refusal'); await expect(bulk(page)).toBeEnabled();
  await bulk(page).click(); await complete(page, 1, 'refusal'); await complete(page, 2, 'refusal');
  expect((await read(page)).calls.map(call => call.args?.childWalletId)).toEqual(['child-a', 'child-a', 'child-b']);
  expect(requests).toEqual([]);
});

test('bulk reserves queued children up front while unrelated card work remains independent', async ({ page }) => {
  const requests = await fixture(page);
  await capture(page, 'Virtual', 1); await bulk(page).click();
  await expect(virtual(page)).toBeDisabled(); await expect(virtual(page, 1)).toBeDisabled();
  await dispatch(page); expect((await read(page)).calls).toHaveLength(1);
  await expect(virtual(page, 2)).toBeEnabled(); await freeze(page).click();
  await complete(page, 1, 'refusal'); await expect(bulk(page)).toBeDisabled();
  await expect(virtual(page, 1)).toBeDisabled(); await complete(page, 0, 'success');
  expect((await read(page)).calls.map(call => call.action)).toEqual(['issueCardAction', 'setCardFrozenAction', 'issueCardAction']);
  await expect(virtual(page)).toBeDisabled(); await expect(virtual(page, 1)).toBeDisabled();
  await complete(page, 2, 'refusal');
  await expect(bulk(page)).toBeEnabled(); await expect(virtual(page)).toBeEnabled(); await expect(virtual(page, 1)).toBeEnabled();
  expect(await read(page)).toMatchObject({ errors: ['Action refused', 'Action refused'], successes: ['moneyCards.issuedOneVirtualCard'], refreshes: 1 });
  expect(requests).toEqual([]);
});

test('bulk rejection releases every reserved child and keeps existing failure feedback and refresh semantics', async ({ page }) => {
  const requests = await fixture(page);
  await bulk(page).click(); await complete(page, 0, 'rejection');
  await expect(bulk(page)).toBeEnabled(); await expect(virtual(page)).toBeEnabled(); await expect(virtual(page, 1)).toBeEnabled();
  expect(await read(page)).toMatchObject({ errors: ['Action unavailable'], successes: [], refreshes: 1 });
  expect((await read(page)).calls).toHaveLength(1);
  await virtual(page, 1).click(); expect((await read(page)).calls).toHaveLength(2);
  await complete(page, 1, 'refusal'); expect(requests).toEqual([]);
});

test('all-success bulk retains the real issued count and releases its child controls', async ({ page }) => {
  const requests = await fixture(page);
  await bulk(page).click(); await complete(page, 0, 'success'); await complete(page, 1, 'success');
  await expect(bulk(page)).toBeEnabled(); await expect(virtual(page)).toBeEnabled(); await expect(virtual(page, 1)).toBeEnabled();
  expect(await read(page)).toMatchObject({ errors: [], successes: ['moneyCards.issuedVirtualCards:2'], refreshes: 1 });
  expect(requests).toEqual([]);
});
