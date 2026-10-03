import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// JIMMY-SUPPORT-CARD-RETRY-20261001: what repair A (pending card claims owned by
// the signed-in actor and family, in a module-level registry) does and does not
// cover, reproduced in mounted browser views.
//
// Repair A holds a pending order inside ONE tab: a remounted view, or a retained
// callback, cannot dispatch the same order again while the first is in flight.
// A browser tab is its own JavaScript realm with its own module registry, and the
// view shares nothing between tabs (no BroadcastChannel, storage or lock), so a
// second tab of the same parent never sees the first tab's claim. Both tabs send
// issueCardAction for the same child and type, with byte-identical input: the
// client sends no attempt identity, so nothing in the request tells "the same
// order twice" from "a second deliberate order". The same holds for a stale tab
// that orders after the first tab's order already completed.
//
// The tests labelled "reproduces:" document that CURRENT behaviour and pass on
// the current source; "preserves:" tests are controls that must keep passing.
//
// DESIRED outcome, server side (repair B, lib/stripe/issuing.ts, owned by
// another change and not exercised here): one card per attempt. A repeated
// dispatch of an attempt must yield the card already issued for that attempt,
// never a second live card. Today the server issues a card for each call
// (characterized in the server-side tests); here every action is a held promise
// and the fixture's answers stand in for the server.
//
// The real MoneyCardsView and Button run in Chromium. Each tab is a separate page
// in one browser context, each with its own copy of the view module (as each real
// tab loads its own bundle) and the same app identity (useApp) and props. Every
// action call is recorded in the page and also reported to one Node-side log
// through a context binding, so both tabs' calls land in one ordered list. The
// context is offline and every request is aborted and recorded. No server,
// provider, database or network is involved.
const { react, reactDom } = reactBrowserScripts('development');
const VIEW = 'components/wallet/money-cards-view.tsx';
const viewSource = fs.readFileSync(VIEW, 'utf8');
const sources = Object.fromEntries([VIEW, 'components/ui/button.tsx'].map(file => [
  `@/${file.replace(/\.tsx$/, '')}`,
  ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText,
]));

type ActionCall = { action: string; args?: Record<string, unknown>; settled: boolean };
type Outcome = 'refusal' | 'rejection' | 'success';
type ServerCall = { tab: string; action: string; args?: Record<string, unknown> };
type Probe = {
  tab: string; calls: ActionCall[]; errors: string[]; successes: string[]; refreshes: number; faults: string[];
  complete: (index: number, outcome: Outcome) => void;
  mount: () => void; unmount: () => void;
  forceClick: (label: string, index?: number) => void; forceSubmit: () => void;
  capture: (label: string) => void; dispatchCaptured: () => void;
  refreshReads: (cards: unknown[]) => void;
  settle: () => Promise<void>;
};
declare global { interface Window { __cardTab: Probe; __issuingServer: (call: Omit<ServerCall, 'tab'>) => Promise<void> } }

// One parent, signed in to one family, in every tab.
const IDENTITY = { userId: 'user-1', familyId: 'family-1' };
// One child with no card yet.
const PROPS = {
  capabilities: { connectOnboarding: true, issuing: true, physicalCards: true },
  accountReady: true, onboardingStarted: false, canManage: true,
  childWallets: [{ id: 'child-a', name: 'Child A', color: null }],
  cards: [],
};
// What a re-read of the page returns once the first order has been issued.
const ISSUED = { id: 'card-1', childWalletId: 'child-a', type: 'virtual', status: 'active', last4: '4242', brand: 'Visa', isFrozen: false, spendLimitCents: null, spendWindow: 'per_authorization', blockedCategories: [] };
const VIRTUAL_INPUT = { childWalletId: 'child-a', type: 'virtual', spendLimitCents: null, spendWindow: 'per_authorization' };
const PHYSICAL_INPUT = { childWalletId: 'child-a', type: 'physical', spendLimitCents: null, spendWindow: 'daily' };

const serverLogs = new WeakMap<BrowserContext, ServerCall[]>();
const tabNames = new WeakMap<Page, string>();
let opened: { page: Page; requests: string[] }[] = [];

/** One Node-side log of every action call from every tab in the context, in arrival order. */
async function server(context: BrowserContext): Promise<ServerCall[]> {
  const existing = serverLogs.get(context);
  if (existing) return existing;
  const log: ServerCall[] = [];
  serverLogs.set(context, log);
  await context.exposeBinding('__issuingServer', ({ page }, call: Omit<ServerCall, 'tab'>) => {
    log.push({ tab: tabNames.get(page) ?? 'unknown', ...call });
  });
  return log;
}

async function fixture(page: Page, tab: string) {
  await server(page.context());
  tabNames.set(page, tab);
  await page.context().setOffline(true);
  const requests: string[] = [];
  opened.push({ page, requests });
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => { throw error; });
  await page.setContent('<!doctype html><main id="root"></main>');
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)}, modules = {}, waiting = [];
    const p = window.__cardTab = { tab: ${JSON.stringify(tab)}, calls: [], errors: [], successes: [], refreshes: 0, faults: [] };
    window.addEventListener('unhandledrejection', event => { p.faults.push(String(event.reason)); event.preventDefault(); });
    function action(name, args) {
      p.calls.push({ action: name, args, settled: false });
      void window.__issuingServer({ action: name, args });
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    }
    let props = ${JSON.stringify(PROPS)}, reread = null, root = null;
    // router.refresh() re-reads the page: the same mounted view re-renders with
    // what the server now returns (set per tab), as a Next refresh does.
    const router = { refresh: () => {
      p.refreshes++;
      if (reread) { props = { ...props, cards: reread }; if (root) render(false); }
    } };
    const mocks = {
      react: React,
      'next/navigation': { useRouter: () => router },
      'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/app/page-header': { PageHeader: ({ title }) => React.createElement('h1', null, title) },
      '@/components/ui/modal': { Modal: ({ open, title, children }) => open ? React.createElement('section', { role: 'dialog', 'aria-label': title }, children) : null },
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
      '@/components/i18n/locale-provider': { useLocale: () => ({ code: 'en-US' }), useTranslations: () => (key, values) => values?.name ? key + ':' + values.name : values?.count ? key + ':' + values.count : key },
      '@/lib/marketplace/listings': { currencyUnit: () => ({ before: true, symbol: '$' }) },
      '@/components/app/app-context': { useApp: () => (${JSON.stringify(IDENTITY)}) },
    };
    function load(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (modules[id]) return modules[id];
      if (!sources[id]) throw new Error('Unexpected browser module ' + id);
      const module = { exports: {} };
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return modules[id] = module.exports;
    }
    const View = load('@/components/wallet/money-cards-view').MoneyCardsView;
    function render(sync = true) {
      const element = React.createElement(View, props);
      if (sync) ReactDOM.flushSync(() => root.render(element)); else root.render(element);
    }
    p.mount = () => {
      if (root) throw new Error('already mounted');
      root = ReactDOM.createRoot(document.getElementById('root'));
      render();
    };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.refreshReads = cards => { reread = cards; };
    const reactProps = element => element[Object.keys(element).find(key => key.startsWith('__reactProps$'))];
    const button = (label, index = 0) => {
      const found = [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === label)[index];
      if (!found) throw new Error('Missing button ' + label);
      return found;
    };
    p.forceClick = (label, index = 0) => { void reactProps(button(label, index)).onClick(); };
    p.forceSubmit = () => {
      const form = document.querySelector('form');
      if (!form) throw new Error('Missing form');
      void reactProps(form).onSubmit({ preventDefault() {} });
    };
    let captured = null;
    p.capture = label => { captured = reactProps(button(label)).onClick; };
    p.dispatchCaptured = () => { void captured(); };
    p.complete = (index, outcome) => {
      p.calls[index].settled = true;
      if (outcome === 'rejection') waiting[index].reject(new Error('Action unavailable'));
      else waiting[index].resolve(outcome === 'refusal' ? { ok: false, error: 'Action refused' } : { ok: true, data: { cardId: 'card-' + (index + 1) } });
    };
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    p.mount();
  })();` });
  return requests;
}

const virtual = (page: Page) => page.getByRole('button', { name: 'Virtual', exact: true });
const physical = (page: Page) => page.getByRole('button', { name: 'moneyCardsView.physical', exact: true });
const order = (page: Page) => page.getByRole('button', { name: 'moneyCards.orderCard', exact: true });
const bulk = (page: Page) => page.getByRole('button', { name: 'moneyCards.issueAll', exact: true });
const read = (page: Page) => page.evaluate(() => {
  const { calls, errors, successes, refreshes, faults } = window.__cardTab;
  return { calls, errors, successes, refreshes, faults };
});
async function settle(page: Page) { await page.evaluate(() => window.__cardTab.settle()); }
async function complete(page: Page, index: number, outcome: Outcome) {
  await page.evaluate(({ index, outcome }) => window.__cardTab.complete(index, outcome), { index, outcome });
  await settle(page);
}
async function remount(page: Page) {
  await page.evaluate(() => window.__cardTab.unmount());
  await page.evaluate(() => window.__cardTab.mount());
  await settle(page);
}
/** Call a control's React handler directly, as a retained callback would; click() on a disabled button never reaches it. */
async function force(page: Page, label: string) {
  await page.evaluate(label => window.__cardTab.forceClick(label), label);
  await settle(page);
}
async function forceSubmit(page: Page) {
  await page.evaluate(() => window.__cardTab.forceSubmit());
  await settle(page);
}
/** Wait until exactly `count` calls have reached the shared log, then return them. */
async function received(log: ServerCall[], count: number) {
  await expect.poll(() => log.length).toBe(count);
  return [...log];
}
async function twoTabs(context: BrowserContext) {
  const log = await server(context);
  const tab1 = await context.newPage();
  const tab2 = await context.newPage();
  await fixture(tab1, 'tab-1');
  await fixture(tab2, 'tab-2');
  return { log, tab1, tab2 };
}

test.beforeEach(() => { opened = []; });
test.afterEach(async () => {
  for (const { page, requests } of opened) {
    expect((await read(page)).faults).toEqual([]);
    expect(requests).toEqual([]);
  }
});

test('reproduces: two tabs of the same parent each send a Virtual order for the same child while the first is pending (2 identical calls)', async ({ context }) => {
  // Nothing in the view crosses a tab boundary; the claim registry is module state.
  expect(viewSource).toContain('const pendingByOwner = new Map');
  expect(viewSource).not.toMatch(/BroadcastChannel|localStorage|sessionStorage|navigator\.locks|addEventListener\(\s*['"]storage/);

  const { log, tab1, tab2 } = await twoTabs(context);
  await virtual(tab1).click();
  await expect(virtual(tab1)).toBeDisabled();
  await expect(bulk(tab1)).toBeDisabled();
  // Tab 2 renders for the same user and family but cannot see tab 1's claim.
  await expect(virtual(tab2)).toBeEnabled();
  await expect(bulk(tab2)).toBeEnabled();
  await virtual(tab2).click();
  await expect(virtual(tab2)).toBeDisabled();
  // Repair A still holds within tab 2: its own retained handler sends nothing more.
  await force(tab2, 'Virtual');

  // Both orders are in flight at once and reach the "server" with identical
  // input: no attempt identity tells them apart.
  expect(await received(log, 2)).toEqual([
    { tab: 'tab-1', action: 'issueCardAction', args: VIRTUAL_INPUT },
    { tab: 'tab-2', action: 'issueCardAction', args: VIRTUAL_INPUT },
  ]);
  expect((await read(tab1)).calls).toEqual([{ action: 'issueCardAction', args: VIRTUAL_INPUT, settled: false }]);
  expect((await read(tab2)).calls).toEqual([{ action: 'issueCardAction', args: VIRTUAL_INPUT, settled: false }]);

  // Today the server issues a card for each call; each tab then presents its own
  // success and re-reads. DESIRED (repair B, server): one card per attempt.
  await complete(tab1, 0, 'success');
  await complete(tab2, 0, 'success');
  for (const tab of [tab1, tab2]) {
    expect(await read(tab)).toMatchObject({ successes: ['moneyCardsView.virtualCardCreated'], errors: [], refreshes: 1 });
    expect((await read(tab)).calls).toHaveLength(1);
    await expect(virtual(tab)).toBeEnabled();
  }
  expect(log).toHaveLength(2);
});

test('preserves: in one tab, repair A refuses a second Virtual dispatch across a remount and from a retained handler (1 call)', async ({ page }) => {
  const log = await server(page.context());
  await fixture(page, 'tab-1');
  // A handler retained from the first mounted view.
  await page.evaluate(() => window.__cardTab.capture('Virtual'));
  await virtual(page).click();
  await expect(virtual(page)).toBeDisabled();
  await remount(page);
  await expect(virtual(page)).toBeDisabled();
  await force(page, 'Virtual');
  await page.evaluate(() => window.__cardTab.dispatchCaptured());
  await settle(page);

  expect(await received(log, 1)).toEqual([{ tab: 'tab-1', action: 'issueCardAction', args: VIRTUAL_INPUT }]);
  expect((await read(page)).calls).toHaveLength(1);

  await complete(page, 0, 'success');
  await expect(virtual(page)).toBeEnabled();
  // One toast and refresh from the request's own handler, plus one re-read by
  // the remounted view whose inherited claim settled.
  expect(await read(page)).toMatchObject({ successes: ['moneyCardsView.virtualCardCreated'], errors: [], refreshes: 2 });
  expect(log).toHaveLength(1);
});

test('preserves: in one tab, repair A refuses a second physical order submitted after a remount (1 call)', async ({ page }) => {
  const log = await server(page.context());
  await fixture(page, 'tab-1');
  await physical(page).click();
  await order(page).click();
  await expect(order(page)).toBeDisabled();
  await remount(page);
  await physical(page).click();
  await expect(order(page)).toBeDisabled();
  await forceSubmit(page);

  expect(await received(log, 1)).toEqual([{ tab: 'tab-1', action: 'issueCardAction', args: PHYSICAL_INPUT }]);
  expect((await read(page)).calls).toHaveLength(1);

  await complete(page, 0, 'success');
  // The unmounted dialog presents nothing; the remounted view re-reads once.
  expect(await read(page)).toMatchObject({ successes: [], errors: [], refreshes: 1 });
  await expect(order(page)).toBeEnabled();
  expect(log).toHaveLength(1);
});

test('reproduces: two tabs of the same parent each submit a physical order for the same child while the first is pending (2 identical calls)', async ({ context }) => {
  const { log, tab1, tab2 } = await twoTabs(context);
  await physical(tab1).click();
  await order(tab1).click();
  await expect(order(tab1)).toBeDisabled();
  await physical(tab2).click();
  // Tab 2's dialog cannot see tab 1's pending physical order.
  await expect(order(tab2)).toBeEnabled();
  await order(tab2).click();
  await expect(order(tab2)).toBeDisabled();
  await forceSubmit(tab2);

  expect(await received(log, 2)).toEqual([
    { tab: 'tab-1', action: 'issueCardAction', args: PHYSICAL_INPUT },
    { tab: 'tab-2', action: 'issueCardAction', args: PHYSICAL_INPUT },
  ]);
  expect((await read(tab1)).calls).toHaveLength(1);
  expect((await read(tab2)).calls).toHaveLength(1);

  // DESIRED (repair B, server): one card per attempt, not two shipped cards.
  await complete(tab1, 0, 'success');
  await complete(tab2, 0, 'success');
  for (const tab of [tab1, tab2]) {
    expect(await read(tab)).toMatchObject({ successes: ['wallet.physicalCardOrdered:Child A'], errors: [], refreshes: 1 });
    await expect(order(tab)).toHaveCount(0);
  }
  expect(log).toHaveLength(2);
});

test('preserves: a Virtual order in one tab and a physical order in another for the same child are independent (2 calls, not a duplicate)', async ({ context }) => {
  const { log, tab1, tab2 } = await twoTabs(context);
  await virtual(tab1).click();
  await expect(virtual(tab1)).toBeDisabled();
  await physical(tab2).click();
  await order(tab2).click();
  await expect(order(tab2)).toBeDisabled();

  // Different card types are different orders; two calls are expected.
  expect(await received(log, 2)).toEqual([
    { tab: 'tab-1', action: 'issueCardAction', args: VIRTUAL_INPUT },
    { tab: 'tab-2', action: 'issueCardAction', args: PHYSICAL_INPUT },
  ]);

  await complete(tab1, 0, 'success');
  await complete(tab2, 0, 'success');
  expect(await read(tab1)).toMatchObject({ successes: ['moneyCardsView.virtualCardCreated'], errors: [], refreshes: 1 });
  expect(await read(tab2)).toMatchObject({ successes: ['wallet.physicalCardOrdered:Child A'], errors: [], refreshes: 1 });
  expect((await read(tab1)).calls).toHaveLength(1);
  expect((await read(tab2)).calls).toHaveLength(1);
  expect(log).toHaveLength(2);
});

test('reproduces: a stale second tab orders the same Virtual card after the first tab\'s order completed and refreshed (2 calls, no attempt identity)', async ({ context }) => {
  const { log, tab1, tab2 } = await twoTabs(context);
  // After the first order is issued, a re-read in tab 1 returns the new card.
  await tab1.evaluate(card => window.__cardTab.refreshReads([card]), ISSUED);

  await virtual(tab1).click();
  await complete(tab1, 0, 'success');
  expect(await read(tab1)).toMatchObject({ successes: ['moneyCardsView.virtualCardCreated'], errors: [], refreshes: 1 });
  // Tab 1 refreshed and shows the card.
  await expect(tab1.getByText('Visa card', { exact: false })).toBeVisible();
  await expect(tab1.getByText('moneyCardsView.noCardYetUseThe')).toHaveCount(0);
  await expect(bulk(tab1)).toHaveCount(0);
  // A deliberate further order from the refreshed tab is still allowed (several cards per child).
  await expect(virtual(tab1)).toBeEnabled();

  // Tab 2 was never refreshed: it still shows the child with no card.
  await expect(tab2.getByText('moneyCardsView.noCardYetUseThe')).toBeVisible();
  await expect(tab2.getByText('moneyCards.childNoCard:Child A')).toBeVisible();
  await expect(virtual(tab2)).toBeEnabled();
  await virtual(tab2).click();

  // The second call is identical to the first: the server cannot tell a stale
  // tab's repeat from a deliberate second card. DESIRED (repair B, server): one
  // card per attempt; how a later, separate attempt is told apart is the server's
  // decision and is not asserted here.
  expect(await received(log, 2)).toEqual([
    { tab: 'tab-1', action: 'issueCardAction', args: VIRTUAL_INPUT },
    { tab: 'tab-2', action: 'issueCardAction', args: VIRTUAL_INPUT },
  ]);
  expect((await read(tab1)).calls).toEqual([{ action: 'issueCardAction', args: VIRTUAL_INPUT, settled: true }]);
  expect((await read(tab2)).calls).toEqual([{ action: 'issueCardAction', args: VIRTUAL_INPUT, settled: false }]);

  await complete(tab2, 0, 'success');
  expect(await read(tab2)).toMatchObject({ successes: ['moneyCardsView.virtualCardCreated'], errors: [], refreshes: 1 });
  expect((await read(tab1)).refreshes).toBe(1);
  expect(log).toHaveLength(2);
});
