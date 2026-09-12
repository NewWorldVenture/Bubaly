import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Actual React effects, sign-out form handler, offline cache and query hook.
// Auth/native transports and visual primitives are the fixture boundaries.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sources = Object.fromEntries([
  'components/auth/session-keeper.tsx', 'components/auth/sign-out-button.tsx',
  'lib/offline/cache.ts', 'lib/hooks/use-realtime-query.ts',
  'lib/offline/cache-scope.tsx', 'lib/auth/cache-session.ts',
  'lib/supabase/errors.ts', 'lib/realtime/published-tables.ts',
].map(file => [`@/${file.replace(/\.tsx?$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText]));

type Probe = {
  native: boolean; held: boolean; removalFails: boolean; removalThrows: boolean; removals: number;
  refreshes: number; errors: string[];
  readHeld: boolean; pendingReads: number;
  mount: (user: string, consumer?: boolean) => void; unmount: () => void;
  emit: (event: string, user: string | null) => void;
  release: () => void; seed: () => void; cached: () => unknown;
  completeRead: () => void; storedUser: (user: string | null, error?: boolean) => void;
  offline: () => void; settle: () => Promise<void>;
};
declare global { interface Window { __authLifecycle: Probe } }
async function settle(page: Page) { await page.evaluate(() => window.__authLifecycle.settle()); }

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }));
  await page.goto('https://auth-lifecycle-fixture.invalid');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const p = window.__authLifecycle = { native: false, held: false, removalFails: false, removalThrows: false, removals: 0, refreshes: 0, errors: [], readHeld: false, pendingReads: 0 };
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    let callback, release, currentUser = 'user-a', sessionError = false;
    const userId = user => user === 'user-a' ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const sessionFor = user => user ? { access_token: [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      btoa(JSON.stringify({ sub: userId(user), session_id: sessionId })).replace(/=/g, ''), 'synthetic-signature'].join('.'),
      refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600,
      user: { id: userId(user), aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } } : null;
    const completeReads = [];
    const db = {
      auth: { getSession: async () => ({ data: { session: sessionFor(currentUser) }, error: sessionError ? new Error('Fixture refresh unavailable') : null }),
        onAuthStateChange: handler => { callback = handler; return { data: { subscription: { unsubscribe() {} } } }; } },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel: async () => {},
    };
    const router = { refresh: () => { p.refreshes += 1; } };
    const mocks = {
      react: React, 'next/navigation': { useRouter: () => router },
      '@/lib/supabase/client': { createClient: () => db },
      '@/lib/native/capacitor': { isNative: () => p.native },
      '@capacitor/app': { App: { addListener: () => {
        const handle = { remove: () => { p.removals += 1; if (p.removalThrows) throw new Error('Fixture native cleanup failed'); return p.removalFails ? Promise.reject(new Error('Fixture native cleanup failed')) : Promise.resolve(); } };
        return p.held ? new Promise(resolve => { release = () => resolve(handle); }) : Promise.resolve(handle);
      } } },
      'lucide-react': { LogOut: () => null },
      '@/components/ui/modal': { Modal: ({ open, children }) => open ? children : null },
      '@/components/ui/button': { Button: ({ variant, loading, ...props }) => React.createElement('button', props) },
      '@/components/i18n/locale-provider': { useTranslations: () => key => key },
    };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected fixture import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return module.exports;
    }
    const { SessionKeeper } = load('@/components/auth/session-keeper');
    const { SignOutButton } = load('@/components/auth/sign-out-button');
    const { useRealtimeQuery } = load('@/lib/hooks/use-realtime-query');
    const cache = load('@/lib/offline/cache');
    const { AuthenticatedCacheBoundary, cacheAccessKey } = load('@/lib/offline/cache-scope');
    const access = user => ({ userId: userId(user), familyId: 'same-family', memberId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      membershipUpdatedAt: '2026-09-12T00:00:00Z', role: 'parent', isSuperAdmin: false, planLevel: 2, featureTiers: {} });
    const key = cache.cacheIdentity({ userId: userId('user-a'), sessionId, accessIdentity: cacheAccessKey(access('user-a')) }, 'calendar_events', 'same-family', ['same-family']);
    p.seed = () => { cache.writePartitionedCache(key, [{ id: 'user-a-private' }]); localStorage.setItem('unrelated-preference', 'keep'); };
    p.cached = () => cache.readPartitionedCache(key);
    p.offline = () => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    p.emit = (event, user) => { currentUser = user; callback(event, sessionFor(user)); };
    p.storedUser = (user, error = false) => { currentUser = user; sessionError = error; };
    p.release = () => release();
    p.completeRead = () => completeReads[0]();
    p.settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    function Consumer({ user }) {
      const state = useRealtimeQuery({ table: 'calendar_events', familyId: 'same-family', deps: ['same-family'],
        fetcher: () => { p.pendingReads += 1; return p.readHeld
          ? new Promise(resolve => { completeReads.push(() => resolve({ data: [{ id: 'late-user-a-private' }], error: null })); })
          : Promise.resolve({ data: null, error: { message: 'Fixture offline' } }); } });
      return React.createElement('pre', null, JSON.stringify({ user, data: state.data, error: state.error }));
    }
    let root;
    p.mount = (user, consumer = false) => {
      if (!root) root = ReactDOM.createRoot(document.getElementById('root'));
      ReactDOM.flushSync(() => root.render(React.createElement(React.Fragment, null,
        React.createElement(SessionKeeper, { userId: userId(user) }), React.createElement(SignOutButton),
        consumer ? React.createElement(AuthenticatedCacheBoundary, { access: access(user) }, React.createElement(Consumer, { user })) : null)));
    };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
  })();` });
});

test('explicit sign-out confirmation clears offline rows and preserves unrelated preferences', async ({ page }) => {
  await page.evaluate(() => { const p = window.__authLifecycle; p.seed(); p.mount('user-a'); });
  await page.getByRole('button', { name: 'signOutButton.signOut', exact: true }).click();
  await page.getByRole('button', { name: 'signOutButton.cancel', exact: true }).click();
  expect(await page.evaluate(() => window.__authLifecycle.cached())).not.toBeNull();
  await page.getByRole('button', { name: 'signOutButton.signOut', exact: true }).click();
  await page.evaluate(() => {
    const form = document.querySelector('form')!;
    form.addEventListener('submit', event => event.preventDefault());
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  expect(await page.evaluate(() => window.__authLifecycle.cached())).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('unrelated-preference'))).toBe('keep');
});

for (const event of ['SIGNED_OUT', 'SIGNED_IN']) {
  test(`${event} identity transition clears offline cache before server reconciliation`, async ({ page }) => {
    await page.evaluate(() => { const p = window.__authLifecycle; p.seed(); p.mount('user-a'); });
    await page.evaluate(event => window.__authLifecycle.emit(event, event === 'SIGNED_OUT' ? null : 'user-b'), event);
    expect(await page.evaluate(() => window.__authLifecycle.refreshes)).toBe(1);
    expect(await page.evaluate(() => window.__authLifecycle.cached())).toBeNull();
  });
}

test('new user in the same family cannot hydrate the previous user cache after auth transition', async ({ page }) => {
  await page.evaluate(() => { const p = window.__authLifecycle; p.seed(); p.mount('user-a'); });
  await page.evaluate(() => { const p = window.__authLifecycle; p.emit('SIGNED_IN', 'user-b'); p.unmount(); p.offline(); p.mount('user-b', true); });
  await settle(page);
  expect(JSON.parse(await page.locator('pre').innerText())).toMatchObject({ user: 'user-b', data: [] });
});

for (const held of [false, true]) for (const synchronous of [false, true]) {
  test(`native ${synchronous ? 'thrown' : 'rejected'} cleanup is contained when registration ${held ? 'finishes after unmount' : 'finishes before unmount'}`, async ({ page }) => {
    await page.evaluate(({ held, synchronous }) => { const p = window.__authLifecycle; p.native = true; p.held = held; p.removalFails = !synchronous; p.removalThrows = synchronous; p.mount('user-a'); }, { held, synchronous });
    await settle(page);
    await page.evaluate(held => { const p = window.__authLifecycle; p.unmount(); if (held) p.release(); }, held);
    await settle(page);
    expect(await page.evaluate(() => window.__authLifecycle.removals)).toBe(1);
    expect(await page.evaluate(() => window.__authLifecycle.errors)).toEqual([]);
  });
}

for (const user of [null, 'user-b']) {
  test(`successful foreground identity reconciliation to ${user ?? 'signed-out'} clears offline cache`, async ({ page }) => {
    await page.evaluate(() => { const p = window.__authLifecycle; p.seed(); p.mount('user-a'); });
    await settle(page);
    await page.evaluate(user => { const p = window.__authLifecycle; p.storedUser(user); const now = Date.now(); Date.now = () => now + 31_000; window.dispatchEvent(new Event('focus')); }, user);
    await settle(page);
    expect(await page.evaluate(() => window.__authLifecycle.refreshes)).toBe(1);
    expect(await page.evaluate(() => window.__authLifecycle.cached())).toBeNull();
  });
}

test('transient failed foreground refresh retains cached data and existing identity', async ({ page }) => {
  await page.evaluate(() => { const p = window.__authLifecycle; p.seed(); p.mount('user-a'); });
  await settle(page);
  await page.evaluate(() => { const p = window.__authLifecycle; p.storedUser(null, true); const now = Date.now(); Date.now = () => now + 31_000; window.dispatchEvent(new Event('focus')); });
  await settle(page);
  expect(await page.evaluate(() => window.__authLifecycle.refreshes)).toBe(0);
  expect(await page.evaluate(() => window.__authLifecycle.cached())).not.toBeNull();
});

test('an auth-ending cache purge fences an already pending previous-user query', async ({ page }) => {
  await page.evaluate(() => { const p = window.__authLifecycle; p.readHeld = true; p.mount('user-a', true); });
  await settle(page);
  expect(await page.evaluate(() => window.__authLifecycle.pendingReads)).toBe(1);
  await page.evaluate(() => window.__authLifecycle.emit('SIGNED_OUT', null));
  expect(await page.evaluate(() => window.__authLifecycle.cached())).toBeNull();
  await page.evaluate(() => window.__authLifecycle.completeRead());
  await settle(page);
  expect(await page.evaluate(() => window.__authLifecycle.cached())).toBeNull();
});
