import fs from 'node:fs';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';
import { reactBrowserScripts } from './helpers/react-browser';

// Second pass over the merged card lifecycle repairs (#749 reveal, #751
// pending ownership, #753 form ownership), for the paths their own specs do not
// drive: the same card reopened while its old session is pending, a thrown
// (not refused) reveal step, a freeze or controls save that is still pending
// when the whole view unmounts, the order dialog's own close button, and a
// view that is mounted again while an operation is still pending.
//
// Same harness as those specs: the real components and hooks in React 19, with
// every server action and Stripe.js call replaced before module evaluation, the
// context offline and every request aborted and recorded. No key, card,
// provider, authentication, database or network operation runs.
const { react, reactDom } = reactBrowserScripts('development');
const compile = (file: string) => ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const viewSources = Object.fromEntries(['components/wallet/money-cards-view.tsx', 'components/ui/button.tsx', 'lib/wallet/card-controls.ts']
  .map(file => [`@/${file.replace(/\.tsx?$/, '')}`, compile(file)]));
const revealSource = compile('components/wallet/card-reveal-modal.tsx');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

// ─── The cards view ──────────────────────────────────────────────────────────

type ActionCall = { action: string; args?: Record<string, unknown>; settled: boolean };
type Outcome = 'refusal' | 'rejection' | 'success';
type ViewProbe = {
  calls: ActionCall[]; errors: string[]; successes: string[]; refreshes: number; faults: string[];
  complete: (index: number, outcome: Outcome) => void;
  unmount: () => void; remount: () => void;
  settle: () => Promise<void>;
};
declare global { interface Window { __cardView: ViewProbe; __cardReveal: RevealProbe } }
const requestsByPage = new WeakMap<Page, string[]>();

async function viewFixture(page: Page) {
  await page.context().setOffline(true);
  const requests: string[] = [];
  requestsByPage.set(page, requests);
  await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => { throw error; });
  await page.setContent('<!doctype html><main id="root"></main>');
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(viewSources)}, modules = {}, waiting = [];
    const p = window.__cardView = { calls: [], errors: [], successes: [], refreshes: 0, faults: [] };
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
      // No known identity: each mounted view keeps its own claims (#811 keys
      // claims by actor and family; these reproductions pin the per-view case).
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
    // Child A has a card to freeze and configure; child B has none yet.
    const props = {
      capabilities: { connectOnboarding: true, issuing: true, physicalCards: true },
      accountReady: true, onboardingStarted: false, canManage: true,
      childWallets: ['a', 'b'].map(letter => ({ id: 'child-' + letter, name: 'Child ' + letter.toUpperCase(), color: null })),
      cards: [{ id: 'card-a', childWalletId: 'child-a', type: 'virtual', status: 'active', last4: '1234', brand: 'Visa', isFrozen: false, spendLimitCents: null, spendWindow: 'per_authorization', blockedCategories: [] }],
    };
    const element = document.getElementById('root');
    let root;
    const mount = () => { root = ReactDOM.createRoot(element); ReactDOM.flushSync(() => root.render(React.createElement(load('@/components/wallet/money-cards-view').MoneyCardsView, props))); };
    mount();
    p.complete = (index, outcome) => {
      p.calls[index].settled = true;
      if (outcome === 'rejection') waiting[index].reject(new Error('Action unavailable'));
      else waiting[index].resolve(outcome === 'refusal' ? { ok: false, error: 'Action refused' } : { ok: true, data: {} });
    };
    // Navigation away, and back: a new instance of the view, with the props the
    // page still holds because no refresh has landed.
    p.unmount = () => ReactDOM.flushSync(() => root.unmount());
    p.remount = () => mount();
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })();` });
}

const readView = (page: Page) => page.evaluate(() => {
  const { calls, errors, successes, refreshes, faults } = window.__cardView;
  return { calls, errors, successes, refreshes, faults };
});
async function completeView(page: Page, index: number, outcome: Outcome) {
  await page.evaluate(({ index, outcome }) => window.__cardView.complete(index, outcome), { index, outcome });
  await page.evaluate(() => window.__cardView.settle());
}
const unmountView = (page: Page) => page.evaluate(() => window.__cardView.unmount());
const remountView = (page: Page) => page.evaluate(() => window.__cardView.remount());
const freezeButton = (page: Page) => page.getByRole('button', { name: 'Freeze', exact: true });
const controlsButton = (page: Page) => page.getByRole('button', { name: 'moneyCards.controls', exact: true });
const saveControls = (page: Page) => page.getByRole('button', { name: 'moneyCards.saveControls', exact: true });
// Every child row offers both issue buttons; index 0 is child A, index 1 child B.
const physicalButton = (page: Page) => page.getByRole('button', { name: 'moneyCardsView.physical', exact: true }).nth(0);
const orderButton = (page: Page) => page.getByRole('button', { name: 'moneyCards.orderCard', exact: true });
const virtualButton = (page: Page) => page.getByRole('button', { name: 'Virtual', exact: true }).nth(1);

test.describe('cards view', () => {
  test.afterEach(async ({ page }) => {
    expect((await readView(page)).faults).toEqual([]);
    expect(requestsByPage.get(page)).toEqual([]);
  });

  for (const outcome of ['success', 'refusal', 'rejection'] as const) {
    test(`freeze: a ${outcome} that lands after the view unmounts dispatches once and faults nothing`, async ({ page }) => {
      await viewFixture(page);
      await freezeButton(page).click();
      await expect(freezeButton(page)).toBeDisabled();
      await unmountView(page);
      await completeView(page, 0, outcome);

      const state = await readView(page);
      expect(state.calls).toEqual([{ action: 'setCardFrozenAction', args: { cardId: 'card-a', frozen: true }, settled: true }]);
      expect(await page.locator('#root').innerHTML()).toBe('');
    });
  }

  for (const outcome of ['refusal', 'rejection'] as const) {
    test(`controls: a ${outcome} that lands after the view unmounts has no stale presentation`, async ({ page }) => {
      await viewFixture(page);
      await controlsButton(page).click();
      await saveControls(page).click();
      await expect(saveControls(page)).toBeDisabled();
      await unmountView(page);
      await completeView(page, 0, outcome);

      expect(await readView(page)).toMatchObject({ errors: [], successes: [], refreshes: 0 });
      expect((await readView(page)).calls).toHaveLength(1);
    });
  }

  test('physical: the dialog\'s own close keeps the pending order claimed, like Cancel, and its late success touches nothing', async ({ page }) => {
    await viewFixture(page);
    await physicalButton(page).click();
    await orderButton(page).click();
    await expect(orderButton(page)).toBeDisabled();
    await page.getByRole('button', { name: 'Modal close', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Reopened: the old order still owns the claim, so it cannot be sent twice.
    await physicalButton(page).click();
    await expect(orderButton(page)).toBeDisabled();
    await orderButton(page).evaluate(button => (button as HTMLButtonElement).click());
    expect((await readView(page)).calls).toHaveLength(1);

    await completeView(page, 0, 'success');
    // The success belongs to a dismissed dialog: the reopened one stays open
    // and is released, and nothing is presented for the dismissed order.
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(orderButton(page)).toBeEnabled();
    expect(await readView(page)).toMatchObject({ errors: [], successes: [] });
  });

  // ── Reported, not blessed ─────────────────────────────────────────────────
  // The pending claim lives in a ref of the mounted view (busyRef). A view
  // mounted again while an operation is still pending, which is what leaving
  // the page and coming back does, starts with no claims, and the page still
  // holds the props from before because no refresh has landed. Whether a claim
  // should outlive the view is a product decision, not established here; these
  // pin what happens today so the coordinator can decide, and so a change in
  // either direction is visible.

  test('today: a remounted view dispatches a second freeze while the first is still pending (reproduction)', async ({ page }) => {
    await viewFixture(page);
    await freezeButton(page).click();
    await unmountView(page);
    await remountView(page);
    await expect(freezeButton(page)).toBeEnabled();
    await freezeButton(page).click();
    const { calls } = await readView(page);
    expect(calls.map(call => [call.action, call.args, call.settled])).toEqual([
      ['setCardFrozenAction', { cardId: 'card-a', frozen: true }, false],
      ['setCardFrozenAction', { cardId: 'card-a', frozen: true }, false],
    ]);
  });

  test('today: a remounted view issues a second virtual card for a child whose first issuance is still pending (reproduction)', async ({ page }) => {
    await viewFixture(page);
    await virtualButton(page).click();
    await unmountView(page);
    await remountView(page);
    await expect(virtualButton(page)).toBeEnabled();
    await virtualButton(page).click();
    const issued = (await readView(page)).calls.filter(call => call.action === 'issueCardAction');
    expect(issued.map(call => call.args?.childWalletId)).toEqual(['child-b', 'child-b']);
  });

  test('today: a freeze that lands after the view unmounts is still announced and refreshed (reproduction)', async ({ page }) => {
    // Unlike the forms (#753), toggleFreeze has no mounted-view guard. For a
    // freeze, telling the parent the outcome after they navigated may be the
    // right call; this pins today's answer for the coordinator to decide.
    await viewFixture(page);
    await freezeButton(page).click();
    await unmountView(page);
    await completeView(page, 0, 'success');
    expect(await readView(page)).toMatchObject({ successes: ['Card frozen'], errors: [], refreshes: 1 });
  });
});

// ─── The reveal modal ────────────────────────────────────────────────────────

type Stage = 'prepare' | 'import' | 'load' | 'nonce' | 'key';
type Call = { stage: string; card: string; data?: unknown };
type Display = { card: string; session: number; type: string; mounts: number; destroys: number };
type RevealProbe = {
  close(): void; open(card: string): void;
  release(stage: Stage, index: number): Promise<void>;
  settle(): Promise<void>;
  get(): { calls: Call[]; displays: Display[]; loading: boolean; error: string | null; held: Array<{ stage: string; card: string }>; faults: string[] };
};

async function revealFixture(page: Page, options: { hold?: Stage; reject?: Stage } = {}) {
  const unexpected: string[] = [], errors: string[] = [];
  const origin = 'https://card-reveal-second-pass.invalid';
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/*', async route => {
    if (route.request().url() !== `${origin}/`) { unexpected.push(route.request().url()); await route.abort(); return; }
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="icon" href="data:,"><style>.hidden{display:none}</style></head><body><div id="root"></div></body></html>' });
  });
  await page.goto(`${origin}/`);
  for (const content of [react, reactDom]) await page.addScriptTag({ content });
  await page.addScriptTag({ content: `(() => {
    const options = ${JSON.stringify(options)}, calls = [], displays = [], held = [], faults = [], h = React.createElement;
    window.addEventListener('unhandledrejection', event => { faults.push(String(event.reason)); event.preventDefault(); });
    let session = 0;
    const tr = key => key;
    const record = (stage, card, data) => calls.push({ stage, card, ...(data === undefined ? {} : { data }) });
    // Every call of a held stage waits on its own entry, so two sessions of the
    // same card can be released separately and in either order. A rejected
    // stage throws, as a failed transport or SDK call does, rather than
    // answering a structured refusal.
    function gate(stage, card, value) {
      const settle = (resolve, reject) => options.reject === stage ? reject(new Error('synthetic ' + stage + ' failure')) : resolve(value);
      if (options.hold === stage) return new Promise((resolve, reject) => held.push({ stage, card, run: () => settle(resolve, reject) }));
      return new Promise(settle);
    }
    const prep = card => ({ ok: true, data: { stripeCardId: 'card-' + card, publishableKey: 'synthetic-public-' + card, stripeAccount: 'account-' + card } });
    const key = card => ({ ok: true, data: { ...prep(card).data, ephemeralKeySecret: 'synthetic-secret-' + card } });
    const actions = {
      prepareCardRevealAction: card => { session++; record('prepare', card); return gate('prepare', card, prep(card)); },
      createCardRevealAction: input => { record('key', input.cardId, input); return gate('key', input.cardId, key(input.cardId)); },
    };
    const sdk = { loadStripe: (publishableKey, config) => {
      const card = config.stripeAccount.replace('account-', ''); const owner = session; record('load', card);
      const stripe = {
        createEphemeralKeyNonce: input => { record('nonce', card, input); return gate('nonce', card, { nonce: 'synthetic-nonce-' + card }); },
        elements: () => ({ create: (type, auth) => {
          record('create', card, { type, nonce: auth.nonce });
          const item = { card, session: owner, type, mounts: 0, destroys: 0 }; displays.push(item);
          return { mount(node) { item.mounts++; node.textContent = 'synthetic display ' + card; }, destroy() { item.destroys++; } };
        } }),
      };
      return gate('load', card, stripe);
    } };
    let currentCard = 'A';
    const modules = {
      react: React, 'lucide-react': new Proxy({}, { get: () => () => null }),
      '@/components/ui/modal': { Modal: ({ children, onClose, title }) => h('section', { 'data-modal': true }, h('h1', null, title), h('button', { onClick: onClose }, 'Close reveal'), children) },
      '@/app/(app)/money/actions': actions,
      // Stable, as the real provider's memoized translator is: the reveal effect
      // depends on it, and a new function per render would restart the session.
      '@/components/i18n/locale-provider': { useTranslations: () => tr },
    };
    const exports = {};
    new Function('require', 'exports', 'React', ${JSON.stringify(revealSource)})(name => {
      if (name === '@stripe/stripe-js') { record('import', currentCard); return gate('import', currentCard, sdk); }
      if (!(name in modules)) throw new Error('Unexpected fixture module ' + name);
      return modules[name];
    }, exports, React);
    let setCard;
    const root = ReactDOM.createRoot(document.getElementById('root'));
    function App() { const [card, update] = React.useState('A'); setCard = update; currentCard = card; return card ? h(exports.CardRevealModal, { cardId: card, childName: 'Synthetic ' + card, onClose: () => update(null) }) : null; }
    const p = window.__cardReveal = {
      close: () => ReactDOM.flushSync(() => setCard(null)),
      open: card => ReactDOM.flushSync(() => setCard(card)),
      settle: async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); },
      release: async (stage, index) => {
        const entries = held.filter(entry => entry.stage === stage);
        if (!entries[index]) throw new Error('Missing held ' + stage + ' #' + index);
        entries[index].run(); await p.settle();
      },
      get: () => ({
        calls, displays, faults, held: held.map(({ stage, card }) => ({ stage, card })),
        loading: document.body.textContent.includes('cardRevealModal.openingASecureSession'),
        error: (document.body.textContent.match(/synthetic [a-z]+ failure/) ?? [null])[0],
      }),
    };
    ReactDOM.flushSync(() => root.render(h(App)));
  })();` });
  await page.waitForFunction(() => typeof window.__cardReveal?.get === 'function');
  await page.evaluate(() => window.__cardReveal.settle());
  return { errors, unexpected };
}

const reveal = (page: Page) => page.evaluate(() => window.__cardReveal.get());
const release = (page: Page, stage: Stage, index: number) => page.evaluate(({ stage, index }) => window.__cardReveal.release(stage, index), { stage, index });
const stages = (state: Awaited<ReturnType<typeof reveal>>, stage: string) => state.calls.filter(call => call.stage === stage).length;

test.describe('card reveal', () => {
  for (const hold of ['prepare', 'key'] as const) {
    test(`the same card reopened while its old ${hold} is pending never adopts the old completion`, async ({ page }) => {
      const receipt = await revealFixture(page, { hold });
      await page.evaluate(() => window.__cardReveal.close());
      await page.evaluate(() => window.__cardReveal.open('A'));
      await page.evaluate(() => window.__cardReveal.settle());
      expect((await reveal(page)).held).toEqual([{ stage: hold, card: 'A' }, { stage: hold, card: 'A' }]);

      // The new session finishes first, then the old one answers.
      await release(page, hold, 1);
      await expect.poll(async () => (await reveal(page)).displays.filter(display => display.mounts === 1).length).toBe(3);
      const before = await reveal(page);
      await release(page, hold, 0);
      const after = await reveal(page);

      // The old session stops where it was cancelled: no further step, no display.
      expect(after.calls).toEqual(before.calls);
      expect(after.displays).toEqual(before.displays);
      expect(new Set(after.displays.map(display => display.session))).toEqual(new Set([2]));
      expect(stages(after, 'create')).toBe(3);
      expect(after.loading).toBe(false);
      await page.getByRole('button', { name: 'Close reveal' }).click();
      expect((await reveal(page)).displays.map(display => display.destroys)).toEqual([1, 1, 1]);
      expect(receipt.errors).toEqual([]); expect(receipt.unexpected).toEqual([]); expect(after.faults).toEqual([]);
    });
  }

  for (const reject of ['prepare', 'import', 'load', 'nonce', 'key'] as const) {
    test(`a thrown ${reject} ends loading with an error and creates no display`, async ({ page }) => {
      const receipt = await revealFixture(page, { reject });
      await expect.poll(async () => (await reveal(page)).error).toBe(`synthetic ${reject} failure`);
      const state = await reveal(page);
      expect(state.loading).toBe(false);
      expect(state.displays).toEqual([]);
      expect(stages(state, 'key')).toBe(['prepare', 'import', 'load', 'nonce'].includes(reject) ? 0 : 1);
      expect(receipt.errors).toEqual([]); expect(receipt.unexpected).toEqual([]); expect(state.faults).toEqual([]);
    });
  }

  for (const stage of ['prepare', 'key'] as const) {
    test(`a ${stage} that throws after the modal closes is swallowed with no display and no fault`, async ({ page }) => {
      const receipt = await revealFixture(page, { hold: stage, reject: stage });
      await page.evaluate(() => window.__cardReveal.close());
      await release(page, stage, 0);
      const state = await reveal(page);
      expect(state.displays).toEqual([]);
      expect(state.error).toBeNull();
      expect(stages(state, 'create')).toBe(0);
      if (stage === 'prepare') expect(stages(state, 'load')).toBe(0);
      expect(receipt.errors).toEqual([]); expect(receipt.unexpected).toEqual([]); expect(state.faults).toEqual([]);
    });
  }
});
