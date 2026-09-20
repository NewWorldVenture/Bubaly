import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Actual NativeBootstrap and React effects run in Chromium. Native promises
// are controlled at the plugin boundary to reproduce navigation races without
// requiring an installed/signed mobile binary or touching a user's device.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.production.min.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.production.min.js'), 'utf8');
const component = ts.transpileModule(fs.readFileSync('components/native/native-bootstrap.tsx', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;
const redirectModule = ts.transpileModule(fs.readFileSync('lib/auth/redirect.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

type Stage = 'none' | 'imports' | 'status' | 'splash' | 'back' | 'url';
type NativeProbe = {
  native: boolean;
  heldStage: Stage;
  failureStage: Stage;
  removalFails: boolean;
  moduleCalls: number;
  statusCalls: number;
  splashCalls: number;
  backAdds: number;
  urlAdds: number;
  backRemoves: number;
  urlRemoves: number;
  backs: number;
  exits: number;
  pushes: string[];
  resume: () => void;
  emitBack: (canGoBack: boolean) => void;
  emitUrl: (url: string) => void;
  loadModule: (id: string) => unknown;
  mount: () => void;
  unmount: () => void;
};

declare global {
  interface Window { __nativeProbe: NativeProbe }
}

async function mount(page: Page) {
  await page.evaluate(() => window.__nativeProbe.mount());
}
async function settle(page: Page) {
  await page.evaluate(async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); });
}

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><html><body><main id="root"></main></body></html>');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.evaluate(() => {
    const pending: Array<() => void> = [];
    const probe: NativeProbe = {
      native: true, heldStage: 'none', failureStage: 'none', removalFails: false,
      moduleCalls: 0, statusCalls: 0, splashCalls: 0, backAdds: 0, urlAdds: 0,
      backRemoves: 0, urlRemoves: 0, backs: 0, exits: 0, pushes: [],
      resume: () => { pending.splice(0).forEach((resolve) => resolve()); },
      emitBack: () => {}, emitUrl: () => {}, loadModule: () => undefined,
      mount: () => {}, unmount: () => {},
    };
    function result<T>(stage: Stage, value: T): Promise<T> {
      if (probe.failureStage === stage) return Promise.reject(new Error(`Plugin ${stage} unavailable`));
      if (probe.heldStage === stage) return new Promise((resolve) => pending.push(() => resolve(value)));
      return Promise.resolve(value);
    }
    const modules: Record<string, unknown> = {
      '@capacitor/status-bar': {
        StatusBar: { setStyle: () => { probe.statusCalls += 1; return result('status', undefined); } },
        Style: { Dark: 'dark', Light: 'light' },
      },
      '@capacitor/splash-screen': {
        SplashScreen: { hide: () => { probe.splashCalls += 1; return result('splash', undefined); } },
      },
      '@capacitor/app': {
        App: {
          addListener: (event: 'backButton' | 'appUrlOpen', callback: (event: { canGoBack: boolean } | { url: string }) => void) => {
            const back = event === 'backButton';
            if (back) { probe.backAdds += 1; probe.emitBack = (canGoBack) => callback({ canGoBack }); }
            else { probe.urlAdds += 1; probe.emitUrl = (url) => callback({ url }); }
            return result(back ? 'back' : 'url', { remove: () => {
              if (back) probe.backRemoves += 1; else probe.urlRemoves += 1;
              return probe.removalFails ? Promise.reject(new Error('Plugin removal failed')) : Promise.resolve();
            } });
          },
          exitApp: () => { probe.exits += 1; return Promise.resolve(); },
        },
      },
    };
    probe.loadModule = (id) => { probe.moduleCalls += 1; return result('imports', modules[id]); };
    window.__nativeProbe = probe;
  });
  await page.addScriptTag({ content: `(() => {
    const exports = {};
    const p = window.__nativeProbe;
    const router = { back: () => p.backs++, push: (target) => p.pushes.push(target) };
    const redirect = (() => { const exports = {}; ${redirectModule}; return exports; })();
    const require = (id) => {
      if (id === 'react') return window.React;
      if (id === 'next/navigation') return { useRouter: () => router };
      if (id === '@/lib/native/capacitor') return { isNative: () => p.native };
      if (id === '@/lib/auth/redirect') return redirect;
      if (id.startsWith('@capacitor/')) return p.loadModule(id);
      throw new Error('Unexpected test import: ' + id);
    };
    ${component}
    let root;
    p.mount = () => {
      root = window.ReactDOM.createRoot(document.getElementById('root'));
      window.ReactDOM.flushSync(() => root.render(window.React.createElement(exports.NativeBootstrap)));
    };
    p.unmount = () => window.ReactDOM.flushSync(() => root.unmount());
  })();` });
});

test('unmount during imports prevents all late native initialization', async ({ page }) => {
  await page.evaluate(() => { window.__nativeProbe.heldStage = 'imports'; });
  await mount(page);
  await expect.poll(() => page.evaluate(() => window.__nativeProbe.moduleCalls)).toBe(3);
  await page.evaluate(() => { const p = window.__nativeProbe; p.unmount(); p.resume(); });
  await settle(page);
  expect(await page.evaluate(() => {
    const p = window.__nativeProbe; return [p.statusCalls, p.splashCalls, p.backAdds, p.urlAdds];
  })).toEqual([0, 0, 0, 0]);
});

for (const stage of ['status', 'splash'] as const) {
  test(`unmount during ${stage} prevents subsequent plugin work`, async ({ page }) => {
    await page.evaluate((held) => { window.__nativeProbe.heldStage = held; }, stage);
    await mount(page);
    await expect.poll(() => page.evaluate((held) => window.__nativeProbe[held === 'status' ? 'statusCalls' : 'splashCalls'], stage)).toBe(1);
    await page.evaluate(() => { const p = window.__nativeProbe; p.unmount(); p.resume(); });
    await settle(page);
    expect(await page.evaluate(() => ({ back: window.__nativeProbe.backAdds, url: window.__nativeProbe.urlAdds }))).toEqual({ back: 0, url: 0 });
    if (stage === 'status') expect(await page.evaluate(() => window.__nativeProbe.splashCalls)).toBe(0);
  });
}

test('unmount while first listener resolves removes it and suppresses queued callbacks', async ({ page }) => {
  await page.evaluate(() => { window.__nativeProbe.heldStage = 'back'; });
  await mount(page);
  await expect.poll(() => page.evaluate(() => window.__nativeProbe.backAdds)).toBe(1);
  await page.evaluate(() => { const p = window.__nativeProbe; p.unmount(); p.emitBack(true); p.emitBack(false); p.resume(); });
  await settle(page);
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return [p.backRemoves, p.urlAdds, p.backs, p.exits]; })).toEqual([1, 0, 0, 0]);
});

test('unmount between listener registrations removes both handles and ignores late URLs', async ({ page }) => {
  await page.evaluate(() => { window.__nativeProbe.heldStage = 'url'; });
  await mount(page);
  await expect.poll(() => page.evaluate(() => window.__nativeProbe.urlAdds)).toBe(1);
  await page.evaluate(() => {
    const p = window.__nativeProbe; p.unmount(); p.emitBack(true); p.emitUrl('https://www.bubaly.com/dashboard?tab=week'); p.resume();
  });
  await settle(page);
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return { removals: [p.backRemoves, p.urlRemoves], backs: p.backs, pushes: p.pushes }; })).toEqual({ removals: [1, 1], backs: 0, pushes: [] });
});

test('normal setup preserves navigation behavior and cleans up once on unmount', async ({ page }) => {
  await mount(page);
  await expect.poll(() => page.evaluate(() => window.__nativeProbe.urlAdds)).toBe(1);
  await page.evaluate(() => {
    const p = window.__nativeProbe;
    p.emitBack(true); p.emitBack(false);
    p.emitUrl('https://www.bubaly.com/dashboard/calendar?view=week#today');
    p.emitUrl('not a url'); p.emitUrl('https://www.bubaly.com/');
  });
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return [p.backs, p.exits, p.pushes]; })).toEqual([1, 1, ['/dashboard/calendar?view=week#today']]);
  await page.evaluate(() => { const p = window.__nativeProbe; p.unmount(); p.emitBack(true); p.emitUrl('https://www.bubaly.com/dashboard/notes'); });
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return [p.backRemoves, p.urlRemoves, p.backs, p.pushes]; })).toEqual([1, 1, 1, ['/dashboard/calendar?view=week#today']]);
});

test('second-listener failure releases the first listener and makes its callbacks inert', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => { window.__nativeProbe.failureStage = 'url'; });
  await mount(page);
  await settle(page);
  await page.evaluate(() => window.__nativeProbe.emitBack(true));
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return [p.backAdds, p.backRemoves, p.backs]; })).toEqual([1, 1, 0]);
  expect(errors).toEqual([]);
});

test('missing native modules cause no listeners or unhandled rejection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => { window.__nativeProbe.failureStage = 'imports'; });
  await mount(page); await settle(page);
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return [p.statusCalls, p.backAdds, p.urlAdds]; })).toEqual([0, 0, 0]);
  expect(errors).toEqual([]);
});

test('optional status-bar failure preserves other native behavior', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => { window.__nativeProbe.failureStage = 'status'; });
  await mount(page); await settle(page);
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return [p.splashCalls, p.backAdds, p.urlAdds]; })).toEqual([1, 1, 1]);
  expect(errors).toEqual([]);
});

test('listener removal failures are handled without allowing stale navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mount(page); await settle(page);
  await page.evaluate(() => { const p = window.__nativeProbe; p.removalFails = true; p.unmount(); p.emitBack(true); p.emitUrl('https://www.bubaly.com/dashboard'); });
  await settle(page);
  expect(await page.evaluate(() => { const p = window.__nativeProbe; return [p.backRemoves, p.urlRemoves, p.backs, p.pushes]; })).toEqual([1, 1, 0, []]);
  expect(errors).toEqual([]);
});

test('non-native browser imports no native modules', async ({ page }) => {
  await page.evaluate(() => { window.__nativeProbe.native = false; });
  await mount(page); await settle(page);
  expect(await page.evaluate(() => window.__nativeProbe.moduleCalls)).toBe(0);
});

for (const [name, url] of [
  ['protocol-relative path', 'https://www.bubaly.com//outside.example/path'],
  ['backslash path', 'https://www.bubaly.com/\\outside.example/path'],
  ['encoded slash path', 'https://www.bubaly.com/%2f%2foutside.example/path'],
  ['encoded backslash path', 'https://www.bubaly.com/%5coutside.example/path'],
] as const) {
  test(`rejects native ${name} without calling the router`, async ({ page }) => {
    await mount(page); await settle(page);
    await page.evaluate((value) => window.__nativeProbe.emitUrl(value), url);
    expect(await page.evaluate(() => window.__nativeProbe.pushes)).toEqual([]);
  });
}

for (const [name, url, target] of [
  ['OAuth callback', 'https://project.supabase.co/auth/callback?code=valid-code&state=state-value#return', '/auth/callback?code=valid-code&state=state-value#return'],
  ['encoded OAuth values', 'https://project.supabase.co/auth/callback?code=valid%2Fcode&next=%2Fhome&state=opaque%5Cvalue#return%2Fhere', '/auth/callback?code=valid%2Fcode&next=%2Fhome&state=opaque%5Cvalue#return%2Fhere'],
  ['custom-scheme route', 'bubaly://open/dashboard/notes?filter=family#recent', '/dashboard/notes?filter=family#recent'],
] as const) {
  test(`preserves the existing ${name} path, query and hash`, async ({ page }) => {
    await mount(page); await settle(page);
    await page.evaluate((value) => window.__nativeProbe.emitUrl(value), url);
    expect(await page.evaluate(() => window.__nativeProbe.pushes)).toEqual([target]);
  });
}
