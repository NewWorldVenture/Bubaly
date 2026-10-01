import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Mount the real component and Button with controlled action promises. No
// server, provider SDK, database, or network is involved in these UI checks.
const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries(['components/wallet/money-cards-view.tsx', 'components/ui/button.tsx', 'lib/wallet/card-controls.ts'].map(file => [
  `@/${file.replace(/\.tsx?$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));
type ActionCall = { action: string; args?: Record<string, unknown>; settled: boolean };
type Outcome = 'refusal' | 'rejection' | 'success';
type FormProbe = {
  calls: ActionCall[]; errors: string[]; successes: string[]; refreshes: number; faults: string[];
  complete: (index: number, outcome: Outcome) => void;
  capture: (kind: 'physical' | 'controls') => void;
  dispatchCaptured: (times?: number) => void;
  settle: () => Promise<void>; unmount: () => void;
};
declare global { interface Window { __moneyForms: FormProbe } }
const requestsByPage = new WeakMap<Page, string[]>();

async function fixture(page: Page) {
  await page.context().setOffline(true);
  const requests: string[] = [];
  requestsByPage.set(page, requests);
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => { throw error; });
  await page.setContent('<!doctype html><main id="root"></main>');
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, modules = {}, waiting = [];
    const p = window.__moneyForms = { calls: [], errors: [], successes: [], refreshes: 0, faults: [] };
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
      '@/components/ui/modal': { Modal: ({ open, title, onClose, children }) => open ? React.createElement('section', { role: 'dialog', 'aria-label': title }, React.createElement('button', { onClick: onClose, type: 'button' }, 'Modal close'), children) : null },
      '@/components/ui/input': { Field: ({ children }) => children('fixture-field'), Input: props => React.createElement('input', props) },
      '@/components/ui/states': { EmptyState: () => null },
      '@/components/ui/toast': { useToast: () => ({ success: text => p.successes.push(text), error: text => p.errors.push(text) }) },
      '@/components/ui/avatar': { Avatar: () => null },
      '@/lib/utils/cn': { cn: (...values) => values.filter(Boolean).join(' ') },
      '@/components/wallet/wallet-subnav': { WalletSubnav: () => null },
      '@/lib/wallet/ledger': { formatCents: value => String(value) },
      '@/app/(app)/money/actions': Object.fromEntries(['startConnectOnboardingAction', 'issueCardAction', 'setCardFrozenAction', 'updateCardControlsAction'].map(name => [name, args => action(name, args)])),
      '@/components/wallet/card-reveal-modal': { CardRevealModal: () => null },
      '@/components/i18n/locale-provider': { useLocale: () => ({ code: 'en-US' }), useTranslations: () => (key, values) => values?.name ? key + ':' + values.name : key },
      '@/lib/marketplace/listings': { currencyUnit: () => ({ before: true, symbol: '$' }) },
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
      capabilities: { connectOnboarding: true, issuing: true, physicalCards: true },
      accountReady: true, onboardingStarted: false, canManage: true,
      childWallets: ['a', 'b'].map(letter => ({ id: 'child-' + letter, name: 'Child ' + letter.toUpperCase(), color: null })),
      cards: ['a', 'b'].map(letter => ({ id: 'card-' + letter, childWalletId: 'child-' + letter, type: 'virtual', status: 'active', last4: '1234', brand: 'Visa', isFrozen: false, spendLimitCents: null, spendWindow: 'per_authorization', blockedCategories: [] })),
    };
    const root = ReactDOM.createRoot(document.getElementById('root'));
    ReactDOM.flushSync(() => root.render(React.createElement(load('@/components/wallet/money-cards-view').MoneyCardsView, props)));
    p.complete = (index, outcome) => {
      p.calls[index].settled = true;
      if (outcome === 'rejection') waiting[index].reject(new Error('Action unavailable'));
      else waiting[index].resolve(outcome === 'refusal' ? { ok: false, error: 'Action refused' } : { ok: true, data: {} });
    };
    let captured;
    p.capture = kind => {
      const element = kind === 'physical' ? document.querySelector('form') : [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'moneyCards.saveControls');
      if (!element) throw new Error('Missing mounted form ' + kind);
      const props = element[Object.keys(element).find(key => key.startsWith('__reactProps$'))];
      captured = kind === 'physical' ? props.onSubmit : props.onClick;
    };
    p.dispatchCaptured = (times = 1) => { for (let index = 0; index < times; index++) void captured({ preventDefault() {} }); };
    p.unmount = () => ReactDOM.flushSync(() => root.unmount());
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })();` });
  return requests;
}


type Kind = 'physical' | 'controls';
const opener = (page: Page, kind: Kind, index = 0) => page.getByRole('button', { name: kind === 'physical' ? 'moneyCardsView.physical' : 'moneyCards.controls', exact: true }).nth(index);
const submit = (page: Page, kind: Kind) => page.getByRole('button', { name: kind === 'physical' ? 'moneyCards.orderCard' : 'moneyCards.saveControls', exact: true });
const read = (page: Page) => page.evaluate(() => {
  const { calls, errors, successes, refreshes, faults } = window.__moneyForms;
  return { calls, errors, successes, refreshes, faults };
});
async function complete(page: Page, index: number, outcome: Outcome) {
  await page.evaluate(({ index, outcome }) => window.__moneyForms.complete(index, outcome), { index, outcome });
  await page.evaluate(() => window.__moneyForms.settle());
}
async function close(page: Page, kind: Kind) {
  if (kind === 'physical') await page.getByRole('button', { name: 'moneyCards.cancel', exact: true }).click();
  else await opener(page, kind).click();
}
test.afterEach(async ({ page }) => {
  expect((await read(page)).faults).toEqual([]);
  expect(requestsByPage.get(page)).toEqual([]);
});

for (const kind of ['physical', 'controls'] as const) {
  for (const value of ['', '12']) test(`${kind}: normal ${value || 'blank'} input and structured refusal preserve payload and release pending`, async ({ page }) => {
    const requests = await fixture(page); await opener(page, kind).click();
    if (value) await page.locator('input').fill(value);
    if (kind === 'controls') {
      await page.locator('select').selectOption('weekly');
      await page.getByRole('button', { name: /Gambling & casinos/ }).click();
    }
    await submit(page, kind).click(); await expect(submit(page, kind)).toBeDisabled();
    await submit(page, kind).evaluate(button => (button as HTMLButtonElement).click());
    const expected = kind === 'physical'
      ? { childWalletId: 'child-a', type: 'physical', spendLimitCents: value ? 1200 : null, spendWindow: 'daily' }
      : { cardId: 'card-a', spendLimitCents: value ? 1200 : null, spendWindow: 'weekly', blockedCategories: ['betting_casino_gambling'] };
    expect((await read(page)).calls).toEqual([{ action: kind === 'physical' ? 'issueCardAction' : 'updateCardControlsAction', args: expected, settled: false }]);
    await complete(page, 0, 'refusal'); await expect(submit(page, kind)).toBeEnabled();
    expect(await read(page)).toMatchObject({ errors: ['Action refused'], successes: [], refreshes: 0 }); expect(requests).toEqual([]);
  });
  test(`${kind}: healthy success closes only its own UI and refreshes`, async ({ page }) => {
    await fixture(page); await opener(page, kind).click(); await submit(page, kind).click(); await complete(page, 0, 'success');
    await expect(submit(page, kind)).toHaveCount(0);
    expect(await read(page)).toMatchObject({ errors: [], refreshes: 1, successes: [kind === 'physical' ? 'wallet.physicalCardOrdered:Child A' : 'moneyCardsView.controlsSaved'] });
  });
  test(`${kind}: rejected transport releases pending with a generic safe error`, async ({ page }) => {
    await fixture(page); await opener(page, kind).click(); await submit(page, kind).click(); await complete(page, 0, 'rejection');
    await expect(submit(page, kind)).toBeEnabled();
    expect(await read(page)).toMatchObject({ errors: ['globalError.somethingWentWrong'], successes: [], refreshes: 0 });
    await submit(page, kind).click(); expect((await read(page)).calls).toHaveLength(2); await complete(page, 1, 'refusal');
  });
  test(`${kind}: same-turn mounted callback cannot dispatch its pending operation twice`, async ({ page }) => {
    await fixture(page); await opener(page, kind).click();
    await page.evaluate(kind => { window.__moneyForms.capture(kind); window.__moneyForms.dispatchCaptured(2); }, kind);
    expect((await read(page)).calls).toHaveLength(1); await complete(page, 0, 'refusal');
  });
  for (const sameItem of [false, true]) for (const outcome of ['success', 'refusal', 'rejection'] as const) {
    test(`${kind}: old ${outcome} preserves ${sameItem ? 'reopened A' : 'new B'} input and releases only A`, async ({ page }) => {
      await fixture(page); await opener(page, kind).click(); await submit(page, kind).click(); await close(page, kind);
      await opener(page, kind, sameItem ? 0 : 1).click(); await page.locator('input').fill('29');
      if (sameItem) await expect(submit(page, kind)).toBeDisabled();
      else await expect(submit(page, kind)).toBeEnabled();
      await complete(page, 0, outcome);
      await expect(page.locator('input')).toHaveValue('29'); await expect(submit(page, kind)).toBeEnabled();
      expect(await read(page)).toMatchObject({ errors: [], successes: [], refreshes: outcome === 'success' ? 1 : 0 });
      await submit(page, kind).click();
      expect((await read(page)).calls[1].args).toMatchObject(kind === 'physical' ? { childWalletId: sameItem ? 'child-a' : 'child-b', spendLimitCents: 2900 } : { cardId: sameItem ? 'card-a' : 'card-b', spendLimitCents: 2900 });
      await complete(page, 1, 'refusal');
    });
  }
  test(`${kind}: close and reopen cannot erase the original pending claim`, async ({ page }) => {
    await fixture(page); await opener(page, kind).click(); await submit(page, kind).click(); await close(page, kind); await opener(page, kind).click();
    await expect(submit(page, kind)).toBeDisabled();
    await submit(page, kind).evaluate(button => (button as HTMLButtonElement).click());
    expect((await read(page)).calls).toHaveLength(1); await complete(page, 0, 'refusal'); await expect(submit(page, kind)).toBeEnabled();
  });
  test(`${kind}: old retained callback cannot submit after dismissal`, async ({ page }) => {
    await fixture(page); await opener(page, kind).click(); await page.evaluate(kind => window.__moneyForms.capture(kind), kind);
    await close(page, kind); await page.evaluate(() => window.__moneyForms.dispatchCaptured());
    expect((await read(page)).calls).toEqual([]);
  });
  test(`${kind}: independent B remains pending after A settles`, async ({ page }) => {
    await fixture(page); await opener(page, kind).click(); await submit(page, kind).click(); await close(page, kind);
    await opener(page, kind, 1).click(); await submit(page, kind).click();
    expect((await read(page)).calls).toHaveLength(2); await complete(page, 0, 'success');
    await expect(submit(page, kind)).toBeDisabled(); await complete(page, 1, 'refusal'); await expect(submit(page, kind)).toBeEnabled();
    expect(await read(page)).toMatchObject({ errors: ['Action refused'], successes: [], refreshes: 1 });
  });
  test(`${kind}: success after the whole view unmounts has no stale presentation effect`, async ({ page }) => {
    await fixture(page); await opener(page, kind).click(); await submit(page, kind).click();
    await page.evaluate(() => window.__moneyForms.unmount()); await complete(page, 0, 'success');
    expect(await read(page)).toMatchObject({ errors: [], successes: [], refreshes: 0 });
  });
}
test('controls: zero limit fails locally without acquiring a lasting pending claim', async ({ page }) => {
  await fixture(page); await opener(page, 'controls').click(); await page.locator('input').fill('0'); await submit(page, 'controls').click();
  expect((await read(page)).calls).toEqual([]); await expect(submit(page, 'controls')).toBeEnabled();
  expect((await read(page)).errors).toEqual(['moneyCardsView.enterAValidLimitOr']);
});
test('physical: native negative input validity prevents submit', async ({ page }) => {
  await fixture(page); await opener(page, 'physical').click(); await page.locator('input').fill('-1'); await submit(page, 'physical').click();
  expect((await read(page)).calls).toEqual([]); await expect(submit(page, 'physical')).toBeEnabled();
});
test('physical and controls operations remain independent within the same mounted view', async ({ page }) => {
  await fixture(page); await opener(page, 'controls').click(); await submit(page, 'controls').click();
  await opener(page, 'physical').click(); await submit(page, 'physical').click();
  expect((await read(page)).calls).toHaveLength(2); await complete(page, 0, 'refusal');
  await expect(submit(page, 'physical')).toBeDisabled(); await complete(page, 1, 'refusal');
  await expect(submit(page, 'physical')).toBeEnabled(); await expect(submit(page, 'controls')).toBeEnabled();
});
