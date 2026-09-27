import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// Exercise the production renderer actually shipped by Next's App Router,
// rather than the separate React 18 package used by component fixtures.
// Upstream regression: https://github.com/react/react/pull/35494
// A lazy CHILD VALUE can suspend inside HostComponent after it has claimed its
// server node. Immediate replay must restore that hydration cursor. Next 15.5.25
// replaced the node and reported #418; normal and delayed hydration still passed.
const modules: Record<string, { source: string; imports: Record<string, string> }> = {};
function collect(specifier: string, importer = path.join(process.cwd(), 'package.json')): string {
  let file = require.resolve(specifier, { paths: [path.dirname(importer)] });
  let source = fs.readFileSync(file, 'utf8');
  // Select the package entry's production CJS branch without rewriting any
  // renderer code. Follow its real require graph so new dependencies fail with
  // their module name instead of silently replacing them with fixture stubs.
  const production = /require\(['"](\.\/cjs\/[^'"]+\.production\.js)['"]\)/.exec(source);
  if (production) {
    file = path.resolve(path.dirname(file), production[1]);
    source = fs.readFileSync(file, 'utf8');
  }
  if (modules[file]) return file;
  const entry = modules[file] = { source, imports: {} as Record<string, string> };
  for (const match of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    entry.imports[match[1]] = collect(match[1], file);
  }
  return file;
}
const react = collect('next/dist/compiled/react');
const client = collect('next/dist/compiled/react-dom/client');

type Mode = 'synchronous' | 'immediate' | 'delayed';
type Replay = {
  initialized: boolean;
  committed: boolean;
  errors: string[];
  sameHost: boolean;
  html: string;
  initCalls: number;
  resolve: () => void;
};
declare global { interface Window { __rendererReplay: Replay } }

function probe(mode: Mode): string {
  return `(() => {
    const sources = ${JSON.stringify(modules)}, cache = {};
    function load(id) {
      if (cache[id]) return cache[id].exports;
      const entry = sources[id];
      if (!entry) throw new Error('Unexpected compiled renderer module: ' + id);
      const record = cache[id] = { exports: {} };
      new Function('require', 'module', 'exports', entry.source)(name => {
        const dependency = entry.imports[name];
        if (!dependency) throw new Error('Unexpected compiled renderer import: ' + name);
        return load(dependency);
      }, record, record.exports);
      return record.exports;
    }
    const React = load(${JSON.stringify(react)}), Client = load(${JSON.stringify(client)});
    const container = document.getElementById('root'), original = container.firstChild;
    const state = window.__rendererReplay = {
      initialized: false, committed: false, errors: [], sameHost: false, html: '', initCalls: 0
    };
    let resolve;
    const promise = new Promise(done => { resolve = () => {
      promise.status = 'fulfilled';
      promise.value = { default: 'value' };
      done(promise.value);
    }; });
    // Flight's ReactPromise exposes status/value. A plain native Promise has no
    // fulfilled status, so the old renderer unwinds instead of taking the broken
    // immediate-replay branch. Only this synthetic input is controlled.
    promise.status = 'pending';
    state.resolve = resolve;
    const content = React.lazy(() => {
      state.initialized = true;
      state.initCalls += 1;
      if (${JSON.stringify(mode)} === 'immediate') queueMicrotask(resolve);
      return promise;
    });
    function App() {
      React.useEffect(() => {
        state.committed = true;
        state.html = container.innerHTML;
        state.sameHost = container.firstChild === original;
      }, []);
      return React.createElement('label', null, ${JSON.stringify(mode)} === 'synchronous' ? 'value' : content);
    }
    React.startTransition(() => Client.hydrateRoot(container, React.createElement(App), {
      onRecoverableError(error) { state.errors.push(error.message); }
    }));
  })();`;
}

for (const mode of ['synchronous', 'immediate', 'delayed'] as const) {
  test(`the shipped renderer preserves server nodes during ${mode} hydration`, async ({ page }) => {
    const errors: string[] = [], requests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', route => { requests.push(route.request().url()); return route.abort(); });
    // Same server markup as the upstream HostComponent regression; no local app
    // server, live account, provider request, or substituted React implementation.
    await page.setContent('<!doctype html><html><head></head><body><div id="root"><label>value</label></div></body></html>');
    await page.addScriptTag({ content: probe(mode) });
    if (mode === 'delayed') {
      await page.waitForFunction(() => window.__rendererReplay.initialized);
      await page.evaluate(() => window.__rendererReplay.resolve());
    }
    await page.waitForFunction(() => window.__rendererReplay.committed);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const result = await page.evaluate(() => ({ ...window.__rendererReplay, resolve: undefined }));
    expect(result.errors).toEqual([]);
    expect(result.sameHost).toBe(true);
    expect(result.html).toBe('<label>value</label>');
    expect(result.initCalls).toBe(mode === 'synchronous' ? 0 : 1);
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
  });
}
