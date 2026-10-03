import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// JIMMY-SUPPORT-CARD-RETRY-20261001, repair A: a pending card operation belongs
// to the signed-in actor and the active family the page was rendered for, and it
// outlives the mounted view that started it. Leaving and re-entering the page
// before the request answers must not allow a second freeze or a second order
// of the same thing; a different account, another family or an unknown
// identity must never inherit someone else's pending state; a claim is released
// under the owner that made it when its request settles; and a remounted view
// re-reads its data when an inherited claim settles.
//
// The real MoneyCardsView and Button run in the browser. Every server action is
// a controlled promise; the app identity (useApp) is a fixture value. A forced
// dispatch calls the control's React handler directly, as a retained callback
// would, because click() on a disabled button never reaches it. The context is
// offline and every request is aborted and recorded. No server, provider,
// database or network is involved.
const { react, reactDom } = reactBrowserScripts('development');
const sources = Object.fromEntries(['components/wallet/money-cards-view.tsx', 'components/ui/button.tsx'].map(file => [
  `@/${file.replace(/\.tsx$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));
type ActionCall = { action: string; args?: Record<string, unknown>; settled: boolean };
type Outcome = 'refusal' | 'rejection' | 'success';
type Who = { user: string | null; family: string | null };
type Probe = {
  calls: ActionCall[]; errors: string[]; successes: string[]; refreshes: number; faults: string[]; mounted: boolean;
  complete: (index: number, outcome: Outcome) => void;
  mount: (who: Who) => void; unmount: () => void; rerender: (who: Who) => void;
  forceClick: (label: string, index?: number) => void; forceSubmit: () => void;
  settle: () => Promise<void>;
};
declare global { interface Window { __cardOwner: Probe } }

const U1: Who = { user: 'user-1', family: 'family-1' };
const U2: Who = { user: 'user-2', family: 'family-1' };
const UNKNOWN: Who = { user: null, family: null };

async function fixture(page: Page, who: Who = U1) {
  await page.context().setOffline(true);
  const requests: string[] = [];
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => { throw error; });
  await page.setContent('<!doctype html><main id="root"></main>');
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, modules = {}, waiting = [];
    const p = window.__cardOwner = { calls: [], errors: [], successes: [], refreshes: 0, faults: [], mounted: false };
    window.addEventListener('unhandledrejection', event => { p.faults.push(String(event.reason)); event.preventDefault(); });
    function action(name, args) {
      p.calls.push({ action: name, args, settled: false });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    }
    // What useApp() returns for the identity the page was rendered for.
    let identity = { userId: null, familyId: null };
    function identityFor(who) { return { userId: who.user, familyId: who.family }; }
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
      '@/components/app/app-context': { useApp: () => identity },
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
      childWallets: [{ id: 'child-a', name: 'Child A', color: null }, { id: 'child-b', name: 'Child B', color: null }],
      cards: [{ id: 'card-a', childWalletId: 'child-a', type: 'virtual', status: 'active', last4: '1234', brand: 'Visa', isFrozen: false, spendLimitCents: null, spendWindow: 'per_authorization', blockedCategories: [] }],
    };
    const View = load('@/components/wallet/money-cards-view').MoneyCardsView;
    let root = null;
    function render() { ReactDOM.flushSync(() => root.render(React.createElement(View, props))); }
    p.mount = who => {
      if (root) throw new Error('already mounted');
      identity = identityFor(who);
      root = ReactDOM.createRoot(document.getElementById('root'));
      render(); p.mounted = true;
    };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; p.mounted = false; };
    // The same mounted view re-rendered with another identity, without a remount.
    p.rerender = who => { identity = identityFor(who); render(); };
    const reactProps = element => element[Object.keys(element).find(key => key.startsWith('__reactProps$'))];
    p.forceClick = (label, index = 0) => {
      const button = [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === label)[index];
      if (!button) throw new Error('Missing button ' + label);
      void reactProps(button).onClick();
    };
    p.forceSubmit = () => {
      const form = document.querySelector('form');
      if (!form) throw new Error('Missing form');
      void reactProps(form).onSubmit({ preventDefault() {} });
    };
    p.complete = (index, outcome) => {
      p.calls[index].settled = true;
      if (outcome === 'rejection') waiting[index].reject(new Error('Action unavailable'));
      else waiting[index].resolve(outcome === 'refusal' ? { ok: false, error: 'Action refused' } : { ok: true, data: {} });
    };
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    p.mount(${JSON.stringify(who)});
  })();` });
  return requests;
}

const virtual = (page: Page, index = 0) => page.getByRole('button', { name: 'Virtual', exact: true }).nth(index);
const freeze = (page: Page) => page.getByRole('button', { name: 'Freeze', exact: true });
const physical = (page: Page, index = 0) => page.getByRole('button', { name: 'moneyCardsView.physical', exact: true }).nth(index);
const order = (page: Page) => page.getByRole('button', { name: 'moneyCards.orderCard', exact: true });
const read = (page: Page) => page.evaluate(() => {
  const { calls, errors, successes, refreshes, faults } = window.__cardOwner;
  return { calls, errors, successes, refreshes, faults };
});
async function complete(page: Page, index: number, outcome: Outcome) {
  await page.evaluate(({ index, outcome }) => window.__cardOwner.complete(index, outcome), { index, outcome });
  await page.evaluate(() => window.__cardOwner.settle());
}
async function remount(page: Page, who: Who) {
  await page.evaluate(() => window.__cardOwner.unmount());
  await page.evaluate(w => window.__cardOwner.mount(w), who);
  await page.evaluate(() => window.__cardOwner.settle());
}
async function rerender(page: Page, who: Who) {
  await page.evaluate(w => window.__cardOwner.rerender(w), who);
  await page.evaluate(() => window.__cardOwner.settle());
}
/** Call a control's React handler directly, as a retained callback would; click() on a disabled button never reaches it. */
async function force(page: Page, label: string, index = 0) {
  await page.evaluate(({ label, index }) => window.__cardOwner.forceClick(label, index), { label, index });
  await page.evaluate(() => window.__cardOwner.settle());
}
async function forceSubmit(page: Page) {
  await page.evaluate(() => window.__cardOwner.forceSubmit());
  await page.evaluate(() => window.__cardOwner.settle());
}
test.afterEach(async ({ page }) => {
  expect((await read(page)).faults).toEqual([]);
});

test('a remounted view of the same owner keeps an in-flight order pending, then the committed order completes and a new order is allowed', async ({ page }) => {
  const requests = await fixture(page);
  await virtual(page).click(); await expect(virtual(page)).toBeDisabled();
  await remount(page, U1);
  await expect(virtual(page)).toBeDisabled();
  await force(page, 'Virtual');
  expect((await read(page)).calls).toHaveLength(1);
  // The other child is not held by this claim.
  await expect(virtual(page, 1)).toBeEnabled();

  await complete(page, 0, 'success');
  await expect(virtual(page)).toBeEnabled();
  // The committed order completes as before (toast and refresh from the
  // request's own handler), and the remounted view re-reads its stale list.
  expect(await read(page)).toMatchObject({ successes: ['moneyCardsView.virtualCardCreated'], refreshes: 2 });
  // A deliberate new order after the first settled still goes out: several cards per child.
  await virtual(page).click();
  // Each carries the count of child-a's virtual cards the view shows (this
  // fixture's refresh does not re-read the list).
  expect((await read(page)).calls.map(call => call.args)).toEqual([
    { childWalletId: 'child-a', type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization', expectedCount: 1 },
    { childWalletId: 'child-a', type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization', expectedCount: 1 },
  ]);
  await complete(page, 1, 'refusal');
  expect(requests).toEqual([]);
});

test('a remounted view of the same owner keeps an in-flight freeze pending and does not send it twice', async ({ page }) => {
  const requests = await fixture(page);
  await freeze(page).click(); await expect(freeze(page)).toBeDisabled();
  await remount(page, U1);
  await expect(freeze(page)).toBeDisabled();
  await force(page, 'Freeze');
  expect((await read(page)).calls).toEqual([{ action: 'setCardFrozenAction', args: { cardId: 'card-a', frozen: true }, settled: false }]);
  await complete(page, 0, 'success');
  await expect(freeze(page)).toBeEnabled();
  expect(await read(page)).toMatchObject({ successes: ['Card frozen'], refreshes: 2 });
  expect(requests).toEqual([]);
});

test('a physical order left pending by a remount reconciles the remounted view when it settles', async ({ page }) => {
  const requests = await fixture(page);
  await physical(page).click(); await order(page).click();
  await remount(page, U1);
  await physical(page).click();
  await expect(order(page)).toBeDisabled();
  await forceSubmit(page);
  expect((await read(page)).calls).toHaveLength(1);
  await complete(page, 0, 'success');
  // The unmounted dialog presents nothing (#753); the remounted view re-reads
  // the card list before its Order button is used again.
  expect(await read(page)).toMatchObject({ successes: [], errors: [], refreshes: 1 });
  await expect(order(page)).toBeEnabled();
  expect(requests).toEqual([]);
});

for (const { label, next } of [
  { label: 'another account in the same family', next: U2 },
  { label: 'the same user in another family', next: { ...U1, family: 'family-2' } },
  { label: 'a view with no known identity', next: UNKNOWN },
]) {
  test(`${label} does not inherit a pending order, and its own order is independent`, async ({ page }) => {
    const requests = await fixture(page);
    await virtual(page).click();
    await remount(page, next);
    await expect(virtual(page)).toBeEnabled();
    await virtual(page).click(); await expect(virtual(page)).toBeDisabled();
    expect((await read(page)).calls).toHaveLength(2);
    // The first owner's answer releases only the first owner's claim.
    await complete(page, 0, 'success');
    await expect(virtual(page)).toBeDisabled();
    await complete(page, 1, 'refusal');
    await expect(virtual(page)).toBeEnabled();
    expect(requests).toEqual([]);
  });
}

test('the same actor signing in again sees their own order still pending', async ({ page }) => {
  // The owner is the actor and family, not the sign-in: an order the same
  // person placed is still in flight after they sign in again.
  const requests = await fixture(page);
  await virtual(page).click();
  await remount(page, U1);
  await expect(virtual(page)).toBeDisabled();
  await complete(page, 0, 'refusal');
  await expect(virtual(page)).toBeEnabled();
  expect(requests).toEqual([]);
});

test('views without a known identity never share claims with each other', async ({ page }) => {
  const requests = await fixture(page, UNKNOWN);
  await virtual(page).click(); await expect(virtual(page)).toBeDisabled();
  await remount(page, UNKNOWN);
  await expect(virtual(page)).toBeEnabled();
  await complete(page, 0, 'refusal');
  expect(requests).toEqual([]);
});

test('a claim is released under the owner that made it, even if the view re-renders for another', async ({ page }) => {
  // Defensive: the app remounts on an identity change, but a re-render with
  // another identity must still not let one owner's answer release another's claim.
  const requests = await fixture(page);
  await virtual(page).click(); await expect(virtual(page)).toBeDisabled();
  await rerender(page, U2);
  await expect(virtual(page)).toBeEnabled();
  await virtual(page).click(); await expect(virtual(page)).toBeDisabled();
  await complete(page, 0, 'success');
  await expect(virtual(page)).toBeDisabled();
  await complete(page, 1, 'refusal');
  await expect(virtual(page)).toBeEnabled();
  await rerender(page, U1);
  await expect(virtual(page)).toBeEnabled();
  expect(requests).toEqual([]);
});

for (const outcome of ['success', 'refusal', 'rejection'] as const) {
  test(`a ${outcome} answered while no view is mounted still completes and leaves no claim behind`, async ({ page }) => {
    const requests = await fixture(page);
    await virtual(page).click();
    await page.evaluate(() => window.__cardOwner.unmount());
    await complete(page, 0, outcome);
    // The committed action's own completion still runs (toast and refresh).
    expect(await read(page)).toMatchObject(outcome === 'success'
      ? { successes: ['moneyCardsView.virtualCardCreated'], refreshes: 1, errors: [] }
      : { successes: [], refreshes: 0, errors: [outcome === 'refusal' ? 'Action refused' : 'globalError.somethingWentWrong'] });
    await page.evaluate(w => window.__cardOwner.mount(w), U1);
    await page.evaluate(() => window.__cardOwner.settle());
    await expect(virtual(page)).toBeEnabled();
    await expect(freeze(page)).toBeEnabled();
    // Nothing was inherited, so mounting adds no refresh.
    expect((await read(page)).refreshes).toBe(outcome === 'success' ? 1 : 0);
    expect(requests).toEqual([]);
  });
}

test('a pending virtual order does not block a physical order for the same child, and both survive a remount', async ({ page }) => {
  const requests = await fixture(page);
  await virtual(page).click();
  await physical(page).click();
  await expect(order(page)).toBeEnabled();
  await order(page).click();
  expect((await read(page)).calls.map(call => call.args?.type)).toEqual(['virtual', 'physical']);
  await remount(page, U1);
  await expect(virtual(page)).toBeDisabled();
  await force(page, 'Virtual');
  await physical(page).click();
  await expect(order(page)).toBeDisabled();
  await forceSubmit(page);
  expect((await read(page)).calls).toHaveLength(2);
  await complete(page, 0, 'success'); await complete(page, 1, 'success');
  await expect(virtual(page)).toBeEnabled();
  expect(requests).toEqual([]);
});
