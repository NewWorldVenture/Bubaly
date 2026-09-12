import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Execute the production hook/cache/publication decision with real React and
// localStorage in Chromium. Only Supabase transport is controlled. No Next
// server, authenticated account, database or external request is used here.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.development.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.development.js'), 'utf8');
const sources = Object.fromEntries([
  'lib/hooks/use-realtime-query.ts', 'lib/offline/cache.ts',
  'lib/supabase/errors.ts', 'lib/realtime/published-tables.ts',
].map(file => [`@/${file.replace(/\.ts$/, '')}`, ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText]));

type Row = { id: string };
type Config = { family: string; day: string; table?: string; omitDeps?: boolean; version?: number; strict?: boolean };
type Snapshot = Config & { data: Row[]; loading: boolean; error: string | null; stale: boolean; updatedAt: number | null };
type Reply = { data: Row[] | null; error: { message: string; code?: string } | null };
type Probe = {
  requests: Array<{ config: Config; resolve: (reply: Reply) => void; reject: (error: unknown) => void }>;
  renders: Snapshot[];
  channels: Array<{ removed: boolean; callback: () => void; name: string }>;
  errors: string[];
  state: { refresh: () => Promise<void>; setData: (data: Row[] | ((rows: Row[]) => Row[])) => void };
  oldRefresh: (() => Promise<void>) | null;
  oldSetData: ((data: Row[]) => void) | null;
  mount: (config: Config) => void;
  unmount: () => void;
  snapshot: () => Snapshot;
  flush: () => Promise<void>;
  seed: (config: Config, rows: Row[]) => void;
  cached: (config: Config) => { rows: Row[]; savedAt: number } | null;
  purge: () => void;
  generation: () => number;
  blockStorage: () => void;
  restoreStorage: () => void;
  failRemoval: () => void;
};

declare global { interface Window { __realtimeProbe: Probe } }

const A: Config = { family: 'fixture-family-A', day: '2026-09-12' };
const B: Config = { family: 'fixture-family-B', day: '2026-10-12' };

async function mount(page: Page, config = A) {
  await page.evaluate(value => window.__realtimeProbe.mount(value), config);
  await flush(page);
}
async function flush(page: Page) {
  await page.evaluate(() => window.__realtimeProbe.flush());
}
async function resolve(page: Page, index: number, rows: Row[]) {
  await page.evaluate(({ index, rows }) => window.__realtimeProbe.requests[index].resolve({ data: rows, error: null }), { index, rows });
  await flush(page);
}
async function failure(page: Page, index: number, message = 'Fixture read unavailable', code?: string) {
  await page.evaluate(({ index, message, code }) => window.__realtimeProbe.requests[index].resolve({ data: null, error: { message, code } }), { index, message, code });
  await flush(page);
}
async function snapshot(page: Page) { return page.evaluate(() => window.__realtimeProbe.snapshot()); }

test.beforeEach(async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="root"></main></body></html>' }));
  await page.goto('https://realtime-query-fixture.invalid');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.addScriptTag({ content: `(() => {
    const sources = ${JSON.stringify(sources)};
    const p = window.__realtimeProbe = { requests: [], renders: [], channels: [], errors: [], oldRefresh: null, oldSetData: null };
    window.addEventListener('unhandledrejection', event => { p.errors.push(String(event.reason)); event.preventDefault(); });
    const db = {
      channel(name) {
        const channel = { name, removed: false, on(_event, _filter, callback) { this.callback = callback; return this; }, subscribe() { return this; } };
        p.channels.push(channel); return channel;
      },
      removeChannel(channel) { channel.removed = true; return Promise.resolve(); },
    };
    const mocks = { react: window.React, '@/lib/supabase/client': { createClient: () => db } };
    const modules = {};
    function load(id) {
      if (id in mocks) return mocks[id];
      if (id in modules) return modules[id];
      if (!(id in sources)) throw new Error('Unexpected fixture import: ' + id);
      const module = { exports: {} }; modules[id] = module.exports;
      new Function('require', 'module', 'exports', sources[id])(load, module, module.exports);
      return module.exports;
    }
    const { useRealtimeQuery } = load('@/lib/hooks/use-realtime-query');
    const cache = load('@/lib/offline/cache');
    const key = config => cache.cacheKey(config.table || 'calendar_events', config.family, config.omitDeps ? [] : [config.family, config.day]);
    p.seed = (config, rows) => cache.writeCache(key(config), rows);
    p.cached = config => cache.readCache(key(config));
    p.purge = () => cache.clearAllCache();
    p.generation = () => cache.getCacheGeneration();
    const originalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    p.blockStorage = () => Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new Error('Fixture storage unavailable'); } });
    p.restoreStorage = () => Object.defineProperty(window, 'localStorage', originalStorage);
    p.failRemoval = () => { Storage.prototype.removeItem = () => { throw new Error('Fixture remove denied'); }; };
    function Consumer(config) {
      const state = useRealtimeQuery({
        table: config.table || 'calendar_events', familyId: config.family,
        deps: config.omitDeps ? [] : [config.family, config.day],
        fetcher: () => new Promise((resolve, reject) => p.requests.push({ config, resolve, reject })),
      });
      p.state = state;
      const result = { ...config, data: state.data, loading: state.loading, error: state.error, stale: state.stale, updatedAt: state.updatedAt };
      p.renders.push(result);
      return React.createElement('pre', null, JSON.stringify(result));
    }
    let root;
    p.mount = config => {
      if (!root) root = ReactDOM.createRoot(document.getElementById('root'));
      const child = React.createElement(Consumer, config);
      ReactDOM.flushSync(() => root.render(config.strict ? React.createElement(React.StrictMode, null, child) : child));
    };
    p.unmount = () => { ReactDOM.flushSync(() => root.unmount()); root = null; };
    p.snapshot = () => JSON.parse(document.querySelector('pre').textContent);
    p.flush = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })();` });
});

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => window.__realtimeProbe.errors)).toEqual([]);
});

test('successful rows and successful empty reads are verified and persisted', async ({ page }) => {
  await mount(page);
  expect(await snapshot(page)).toMatchObject({ data: [], loading: true, error: null, updatedAt: null });
  await resolve(page, 0, [{ id: 'fresh' }]);
  expect(await snapshot(page)).toMatchObject({ data: [{ id: 'fresh' }], loading: false, error: null, stale: false });
  expect((await snapshot(page)).updatedAt).toBeGreaterThan(0);
  await page.evaluate(() => { void window.__realtimeProbe.state.refresh(); });
  await resolve(page, 1, []);
  expect(await snapshot(page)).toMatchObject({ data: [], loading: false, error: null, stale: false });
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config)?.rows, A)).toEqual([]);
});

for (const next of [B, { ...A, day: '2026-11-12' }, { ...A, table: 'grocery_items' }]) {
  test(`masks previous rows before effects when switching to ${next.family}/${next.day}/${next.table ?? 'calendar_events'}`, async ({ page }) => {
    await mount(page); await resolve(page, 0, [{ id: 'A-private' }]);
    const before = await page.evaluate(() => window.__realtimeProbe.renders.length);
    await mount(page, next);
    const renders = await page.evaluate(index => window.__realtimeProbe.renders.slice(index), before);
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every(render => render.data.length === 0 && render.error === null)).toBe(true);
    expect(await snapshot(page)).toMatchObject({ data: [], loading: true });
    await resolve(page, 1, [{ id: 'new-key-only' }]);
    expect((await snapshot(page)).data).toEqual([{ id: 'new-key-only' }]);
  });
}

test('family and table changes trigger new reads even when the caller omits deps', async ({ page }) => {
  await mount(page, { ...A, omitDeps: true });
  await resolve(page, 0, [{ id: 'A' }]);
  await mount(page, { ...B, omitDeps: true });
  await resolve(page, 1, [{ id: 'B' }]);
  await mount(page, { ...B, table: 'grocery_items', omitDeps: true });
  expect(await snapshot(page)).toMatchObject({ data: [], loading: true });
  expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(3);
});

test('late old-owner success cannot clear new loading, render rows or write a cache', async ({ page }) => {
  await mount(page); await mount(page, B);
  await resolve(page, 0, [{ id: 'obsolete-A' }]);
  expect(await snapshot(page)).toMatchObject({ family: B.family, data: [], loading: true, error: null });
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
  await resolve(page, 1, [{ id: 'current-B' }]);
  expect((await snapshot(page)).data).toEqual([{ id: 'current-B' }]);
});

test('late old-owner failure cannot replace the new successful result', async ({ page }) => {
  await mount(page); await mount(page, B);
  await resolve(page, 1, [{ id: 'B' }]); await failure(page, 0);
  expect(await snapshot(page)).toMatchObject({ data: [{ id: 'B' }], loading: false, error: null, stale: false });
});

test('A to B to A uses a new lifetime and ignores the first A result', async ({ page }) => {
  await mount(page); await mount(page, B); await mount(page);
  await resolve(page, 2, [{ id: 'A-latest' }]);
  await resolve(page, 0, [{ id: 'A-obsolete' }]); await failure(page, 1);
  expect((await snapshot(page)).data).toEqual([{ id: 'A-latest' }]);
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config)?.rows, A)).toEqual([{ id: 'A-latest' }]);
});

test('newest overlapping refresh owns rows, errors, loading and persistent cache', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { void window.__realtimeProbe.state.refresh(); });
  await failure(page, 0);
  expect(await snapshot(page)).toMatchObject({ data: [], loading: true, error: null });
  await resolve(page, 1, [{ id: 'newest' }]);
  await page.evaluate(() => { void window.__realtimeProbe.state.refresh(); void window.__realtimeProbe.state.refresh(); });
  await resolve(page, 3, [{ id: 'newest-again' }]); await resolve(page, 2, [{ id: 'older' }]);
  expect(await snapshot(page)).toMatchObject({ data: [{ id: 'newest-again' }], loading: false, error: null, stale: false });
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config)?.rows, A)).toEqual([{ id: 'newest-again' }]);
});

test('old refresh and setter callbacks cannot act under a new owner', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { const p = window.__realtimeProbe; p.oldRefresh = p.state.refresh; p.oldSetData = p.state.setData; });
  await mount(page, B); await resolve(page, 1, [{ id: 'B' }]);
  await page.evaluate(() => { const p = window.__realtimeProbe; void p.oldRefresh!(); p.oldSetData!([{ id: 'A-old-local' }]); });
  await flush(page);
  expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(2);
  expect((await snapshot(page)).data).toEqual([{ id: 'B' }]);
});

for (const cachedRows of [[], [{ id: 'same-key-cached' }]]) {
  test(`hydrates ${cachedRows.length ? 'nonempty' : 'empty'} exact-key cache as stale and keeps failed reads distinct`, async ({ page }) => {
    await page.evaluate(({ config, rows }) => window.__realtimeProbe.seed(config, rows), { config: A, rows: cachedRows });
    await mount(page);
    expect(await snapshot(page)).toMatchObject({ data: cachedRows, loading: false, stale: true, error: null });
    expect((await snapshot(page)).updatedAt).toBeGreaterThan(0);
    await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
    await failure(page, 0, 'Failed to fetch');
    expect(await snapshot(page)).toMatchObject({ data: cachedRows, loading: false, stale: true });
    expect((await snapshot(page)).error).toBeTruthy();
    await page.evaluate(() => { window.dispatchEvent(new Event('online')); });
    await resolve(page, 1, []);
    expect(await snapshot(page)).toMatchObject({ data: [], loading: false, stale: false, error: null });
  });
}

test('an offline uncached owner never inherits previous rows', async ({ page }) => {
  await mount(page); await resolve(page, 0, [{ id: 'private-A' }]);
  await mount(page, B);
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await failure(page, 1, 'Failed to fetch');
  expect(await snapshot(page)).toMatchObject({ family: B.family, data: [], loading: false, stale: true, updatedAt: null });
  expect((await snapshot(page)).error).toBeTruthy();
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config), B)).toBeNull();
});

for (const code of ['42P01', 'PGRST205', '42501']) {
  test(`required read failure ${code} remains an error and recovers on retry`, async ({ page }) => {
    await mount(page); await failure(page, 0, 'Fixture required table read failed', code);
    expect(await snapshot(page)).toMatchObject({ data: [], loading: false, stale: true, updatedAt: null });
    expect((await snapshot(page)).error).toBeTruthy();
    expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
    await page.evaluate(() => { void window.__realtimeProbe.state.refresh(); });
    await resolve(page, 1, [{ id: 'recovered' }]);
    expect(await snapshot(page)).toMatchObject({ data: [{ id: 'recovered' }], error: null, stale: false });
  });
}

test('thrown transport failures settle loading without unhandled rejection', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.__realtimeProbe.requests[0].reject(new Error('Fixture network rejection')));
  await flush(page);
  expect(await snapshot(page)).toMatchObject({ loading: false, data: [], stale: true });
  expect((await snapshot(page)).error).toBeTruthy();
  await page.evaluate(() => { void window.__realtimeProbe.state.refresh(); });
  await resolve(page, 1, [{ id: 'recovered' }]);
  expect((await snapshot(page)).error).toBeNull();
});

test('realtime and online refresh use the latest same-key fetcher; cleanup blocks old channels', async ({ page }) => {
  await mount(page); await resolve(page, 0, []);
  await mount(page, { ...A, version: 2 });
  await page.evaluate(() => { const p = window.__realtimeProbe; p.channels[0].callback(); window.dispatchEvent(new Event('online')); });
  expect(await page.evaluate(() => window.__realtimeProbe.requests.slice(1).map(request => request.config.version))).toEqual([2, 2]);
  await mount(page, B);
  await page.evaluate(() => window.__realtimeProbe.channels[0].callback());
  expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(4);
  expect(await page.evaluate(() => window.__realtimeProbe.channels[0].removed)).toBe(true);
});

test('unmount fences responses/cache writes and removes channel and online work', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const p = window.__realtimeProbe; p.oldRefresh = p.state.refresh;
    p.unmount(); p.channels[0].callback(); window.dispatchEvent(new Event('online')); void p.oldRefresh();
  });
  await resolve(page, 0, [{ id: 'late-after-unmount' }]);
  expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(1);
  expect(await page.evaluate(() => window.__realtimeProbe.channels[0].removed)).toBe(true);
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
});

test('unpublished tables still fetch and retry without opening inert channels', async ({ page }) => {
  await mount(page, { ...A, table: 'family_reminders' });
  expect(await page.evaluate(() => window.__realtimeProbe.channels)).toEqual([]);
  await failure(page, 0);
  await page.evaluate(() => { void window.__realtimeProbe.state.refresh(); });
  await resolve(page, 1, [{ id: 'reminder' }]);
  expect((await snapshot(page)).data).toEqual([{ id: 'reminder' }]);
});

test('setData preserves replacement/functional batching and supersedes pending reads without caching local edits', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const p = window.__realtimeProbe;
    p.state.setData([{ id: 'local-1' }]);
    p.state.setData(rows => [...rows, { id: 'local-2' }]);
    p.state.setData(rows => [...rows, { id: 'local-3' }]);
  });
  await flush(page); await resolve(page, 0, [{ id: 'old-server' }]);
  expect(await snapshot(page)).toMatchObject({ data: [{ id: 'local-1' }, { id: 'local-2' }, { id: 'local-3' }], loading: false, stale: true });
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
  await page.evaluate(() => { void window.__realtimeProbe.state.refresh(); });
  await resolve(page, 1, [{ id: 'verified' }]);
  expect(await snapshot(page)).toMatchObject({ data: [{ id: 'verified' }], stale: false });
});

test('Strict Mode effect replay fences the disposed request', async ({ page }) => {
  await mount(page, { ...A, strict: true });
  expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(2);
  await resolve(page, 1, [{ id: 'current-effect' }]); await resolve(page, 0, [{ id: 'disposed-effect' }]);
  expect((await snapshot(page)).data).toEqual([{ id: 'current-effect' }]);
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config)?.rows, A)).toEqual([{ id: 'current-effect' }]);
});

test('cache purge masks rendered rows and obsolete setters before the replacement read completes', async ({ page }) => {
  await mount(page); await resolve(page, 0, [{ id: 'private-before-purge' }]);
  const before = await page.evaluate(() => window.__realtimeProbe.renders.length);
  await page.evaluate(() => {
    const p = window.__realtimeProbe;
    const oldSetter = p.state.setData, oldRefresh = p.state.refresh;
    p.purge(); oldSetter([{ id: 'obsolete-local' }]); void oldRefresh();
  });
  await flush(page);
  expect(await page.evaluate(index => window.__realtimeProbe.renders.slice(index).every(render => render.data.length === 0), before)).toBe(true);
  expect(await snapshot(page)).toMatchObject({ data: [], loading: true, stale: false, updatedAt: null, error: null });
  expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(2);
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
  await resolve(page, 1, [{ id: 'current-authorized-result' }]);
  expect((await snapshot(page)).data).toEqual([{ id: 'current-authorized-result' }]);
});

for (const blocked of [false, true]) for (const outcome of ['success', 'error', 'throw'] as const) {
  test(`purge fences pending ${outcome} and old callbacks with storage ${blocked ? 'blocked' : 'available'}`, async ({ page }) => {
    await mount(page);
    const generation = await page.evaluate(() => window.__realtimeProbe.generation());
    await page.evaluate(({ blocked, outcome }) => {
      const p = window.__realtimeProbe;
      const oldSetter = p.state.setData, oldRefresh = p.state.refresh;
      if (blocked) p.blockStorage();
      p.purge();
      // Same JS turn as purge: generation must reject these before React effects.
      oldSetter(() => [{ id: 'obsolete-local' }]); void oldRefresh();
      if (outcome === 'throw') p.requests[0].reject(new Error('Obsolete thrown failure'));
      else p.requests[0].resolve(outcome === 'success'
        ? { data: [{ id: 'obsolete-private' }], error: null }
        : { data: null, error: { message: 'Obsolete failed read' } });
    }, { blocked, outcome });
    await flush(page);
    expect(await page.evaluate(() => window.__realtimeProbe.generation())).toBe(generation + 1);
    expect(await snapshot(page)).toMatchObject({ data: [], loading: true, error: null, updatedAt: null });
    expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(2);
    expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
    await failure(page, 1, 'Current authorization unavailable', '42501');
    expect(await snapshot(page)).toMatchObject({ data: [], loading: false, stale: true, error: expect.stringContaining('permission') });
  });
}

test('cache invalidation after unmount does not start work or permit late persistence', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { const p = window.__realtimeProbe; p.unmount(); p.purge(); });
  await resolve(page, 0, [{ id: 'unmounted-private' }]);
  expect(await page.evaluate(() => window.__realtimeProbe.requests.length)).toBe(1);
  expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
});

for (const mode of ['remove-fails', 'storage-recovers'] as const) {
  test(`purge refuses old readable cache after ${mode}, remounts empty and accepts same-instant fresh writes`, async ({ page }) => {
    await page.evaluate(config => {
      Date.now = () => 1000000;
      window.__realtimeProbe.seed(config, [{ id: 'old-persisted-private' }]);
    }, A);
    await mount(page); await failure(page, 0);
    expect((await snapshot(page)).data).toEqual([{ id: 'old-persisted-private' }]);
    await page.evaluate(mode => {
      const p = window.__realtimeProbe;
      if (mode === 'remove-fails') p.failRemoval(); else p.blockStorage();
      p.purge();
      if (mode === 'storage-recovers') p.restoreStorage();
    }, mode);
    await flush(page);
    expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('bub:cache:')))).toBe(true);
    expect(await page.evaluate(config => window.__realtimeProbe.cached(config), A)).toBeNull();
    expect((await snapshot(page)).data).toEqual([]);
    await page.evaluate(() => window.__realtimeProbe.unmount()); await mount(page);
    expect((await snapshot(page)).data).toEqual([]);
    await resolve(page, 2, [{ id: 'new-authorized-same-millisecond' }]);
    expect(await page.evaluate(config => window.__realtimeProbe.cached(config)?.rows, A)).toEqual([{ id: 'new-authorized-same-millisecond' }]);
    await page.evaluate(() => window.__realtimeProbe.unmount()); await mount(page);
    expect((await snapshot(page)).data).toEqual([{ id: 'new-authorized-same-millisecond' }]);
  });
}
