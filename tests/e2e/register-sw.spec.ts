import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, type Page } from '@playwright/test';

// Execute the production component with real React/DOM and browser EventTargets.
// Only the service-worker boundary is controlled: no Supabase account, Next
// server, network provider or persistent browser profile is needed for this suite.
const react = fs.readFileSync(path.join(path.dirname(require.resolve('react/package.json')), 'umd/react.production.min.js'), 'utf8');
const reactDom = fs.readFileSync(path.join(path.dirname(require.resolve('react-dom/package.json')), 'umd/react-dom.production.min.js'), 'utf8');
const component = ts.transpileModule(fs.readFileSync('components/pwa/register-sw.tsx', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;

type Probe = {
  registerCalls: number;
  registeredUrl: string;
  registrationMode: 'success' | 'denied' | 'pending';
  updateFails: boolean;
  updateCalls: number;
  activePoll: boolean;
  pending: (() => void) | null;
  container: EventTarget & { controller: object | null; listenerCount: (type: string) => number };
  registration: EventTarget & {
    waiting: object | null;
    installing: (EventTarget & { state: string; listenerCount: (type: string) => number }) | null;
    listenerCount: (type: string) => number;
  };
  worker: EventTarget & { state: string; listenerCount: (type: string) => number };
  poll: () => void;
  mount: () => void;
  unmount: () => void;
};
declare global {
  interface Window { __pwa: Probe }
}

async function mount(page: Page) {
  await page.evaluate(() => window.__pwa.mount());
}

test.beforeEach(async ({ page }) => {
  await page.setContent('<!doctype html><html><body><main id="root"></main></body></html>');
  await page.addScriptTag({ content: react });
  await page.addScriptTag({ content: reactDom });
  await page.evaluate(() => {
    class TrackedTarget extends EventTarget {
      private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
      override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if (callback) {
          if (!this.listeners.has(type)) this.listeners.set(type, new Set());
          this.listeners.get(type)!.add(callback);
        }
        super.addEventListener(type, callback, options);
      }
      override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        if (callback) this.listeners.get(type)?.delete(callback);
        super.removeEventListener(type, callback, options);
      }
      listenerCount(type: string) { return this.listeners.get(type)?.size ?? 0; }
    }
    const worker = Object.assign(new TrackedTarget(), { state: 'installing' });
    const registration = Object.assign(new TrackedTarget(), {
      waiting: null as object | null,
      installing: null as typeof worker | null,
      update: () => {
        probe.updateCalls += 1;
        return probe.updateFails ? Promise.reject(new Error('Offline')) : Promise.resolve(registration);
      },
    });
    const container = Object.assign(new TrackedTarget(), {
      controller: null as object | null,
      register: (url: string) => {
        probe.registerCalls += 1;
        probe.registeredUrl = url;
        if (probe.registrationMode === 'denied') return Promise.reject(new DOMException('Service worker denied', 'SecurityError'));
        if (probe.registrationMode === 'pending') return new Promise<typeof registration>((resolve) => { probe.pending = () => resolve(registration); });
        return Promise.resolve(registration);
      },
    });
    const probe: Probe = {
      registerCalls: 0, registeredUrl: '', registrationMode: 'success', updateFails: false,
      updateCalls: 0, activePoll: false, pending: null, container, registration, worker,
      poll: () => {}, mount: () => {}, unmount: () => {},
    };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    window.setInterval = ((callback: () => void) => {
      probe.activePoll = true;
      probe.poll = () => { if (probe.activePoll) callback(); };
      return 1;
    }) as typeof window.setInterval;
    window.clearInterval = () => { probe.activePoll = false; };
    window.__pwa = probe;
  });
  await page.addScriptTag({ content: `(() => {
    const exports = {};
    const process = { env: { NODE_ENV: 'production' } };
    const require = (id) => {
      if (id === 'react') return window.React;
      if (id === '@/components/i18n/locale-provider') return { useTranslations: () => (key) => ({
        'registerSw.aNewVersionOfBubalyIs': 'A new version of Bubaly is available.',
        'registerSw.later': 'Later', 'registerSw.reload': 'Reload'
      })[key] ?? key };
      throw new Error('Unexpected test import: ' + id);
    };
    ${component}
    let root;
    window.__pwa.mount = () => {
      root = window.ReactDOM.createRoot(document.getElementById('root'));
      window.ReactDOM.flushSync(() => root.render(window.React.createElement(exports.RegisterSW)));
    };
    window.__pwa.unmount = () => window.ReactDOM.flushSync(() => root.unmount());
  })();` });
});

test('registers when first mounted after document load', async ({ page }) => {
  expect(await page.evaluate(() => document.readyState)).toBe('complete');
  await mount(page);
  await expect.poll(() => page.evaluate(() => window.__pwa.registerCalls)).toBe(1);
  expect(await page.evaluate(() => window.__pwa.registeredUrl)).toBe('/sw.js');
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('waits for load when the document is still loading and registers once', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' }));
  await mount(page);
  expect(await page.evaluate(() => window.__pwa.registerCalls)).toBe(0);
  await page.evaluate(() => { window.dispatchEvent(new Event('load')); window.dispatchEvent(new Event('load')); });
  await expect.poll(() => page.evaluate(() => window.__pwa.registerCalls)).toBe(1);
});

test('removing a pre-load mount cancels registration and polling', async ({ page }) => {
  await page.evaluate(() => Object.defineProperty(document, 'readyState', { configurable: true, value: 'loading' }));
  await mount(page);
  await page.evaluate(() => { window.__pwa.unmount(); window.dispatchEvent(new Event('load')); });
  expect(await page.evaluate(() => ({ calls: window.__pwa.registerCalls, polling: window.__pwa.activePoll }))).toEqual({ calls: 0, polling: false });
});

test('does not attach observers after a pending registration resolves after unmount', async ({ page }) => {
  await page.evaluate(() => { window.__pwa.registrationMode = 'pending'; });
  await mount(page);
  await expect.poll(() => page.evaluate(() => window.__pwa.registerCalls)).toBe(1);
  await page.evaluate(async () => {
    const p = window.__pwa;
    p.unmount(); p.pending?.(); await Promise.resolve();
  });
  expect(await page.evaluate(() => {
    const p = window.__pwa;
    return { registration: p.registration.listenerCount('updatefound'), container: p.container.listenerCount('controllerchange'), polling: p.activePoll };
  })).toEqual({ registration: 0, container: 0, polling: false });
});

test('observes a worker that is already installing when registration resolves', async ({ page }) => {
  await page.evaluate(() => { const p = window.__pwa; p.registration.installing = p.worker; p.container.controller = {}; });
  await mount(page);
  await page.evaluate(() => { const p = window.__pwa; p.worker.state = 'installed'; p.worker.dispatchEvent(new Event('statechange')); });
  await expect(page.getByRole('status')).toContainText('A new version of Bubaly is available.');
});

test('shows waiting updates and lets the user dismiss the banner', async ({ page }) => {
  await page.evaluate(() => { const p = window.__pwa; p.registration.waiting = {}; p.container.controller = {}; });
  await mount(page);
  await expect(page.getByRole('status')).toBeVisible();
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('reload control reloads the page', async ({ page }) => {
  await page.evaluate(() => { const p = window.__pwa; p.registration.waiting = {}; p.container.controller = {}; });
  await mount(page);
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', { name: 'Reload', exact: true }).click()]);
  await expect(page.locator('#root')).toHaveCount(0);
});

test('deduplicates worker observers and removes every observer on unmount', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const p = window.__pwa;
    p.registration.installing = p.worker;
    p.registration.dispatchEvent(new Event('updatefound'));
    p.registration.dispatchEvent(new Event('updatefound'));
  });
  expect(await page.evaluate(() => window.__pwa.worker.listenerCount('statechange'))).toBe(1);
  await page.evaluate(() => window.__pwa.unmount());
  expect(await page.evaluate(() => {
    const p = window.__pwa;
    return [p.worker.listenerCount('statechange'), p.registration.listenerCount('updatefound'), p.container.listenerCount('controllerchange')];
  })).toEqual([0, 0, 0]);
});

test('remounting has one live registration observer and still detects an update', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => { const p = window.__pwa; p.unmount(); p.mount(); });
  await expect.poll(() => page.evaluate(() => window.__pwa.registerCalls)).toBe(2);
  expect(await page.evaluate(() => window.__pwa.registration.listenerCount('updatefound'))).toBe(1);
  await page.evaluate(() => { const p = window.__pwa; p.container.controller = {}; p.container.dispatchEvent(new Event('controllerchange')); });
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.evaluate(() => window.__pwa.container.dispatchEvent(new Event('controllerchange')));
  await expect(page.getByRole('status')).toBeVisible();
});

test('does not mistake first installation for an update', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const p = window.__pwa;
    p.registration.installing = p.worker;
    p.registration.dispatchEvent(new Event('updatefound'));
    p.worker.state = 'installed'; p.worker.dispatchEvent(new Event('statechange'));
    p.container.controller = {}; p.container.dispatchEvent(new Event('controllerchange'));
  });
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('permission denial leaves the app usable without false update or unhandled rejection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluate(() => { window.__pwa.registrationMode = 'denied'; });
  await mount(page);
  await expect.poll(() => page.evaluate(() => window.__pwa.registerCalls)).toBe(1);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.evaluate(() => window.__pwa.unmount());
  expect(await page.evaluate(() => window.__pwa.activePoll)).toBe(false);
});

test('update polling tolerates offline failures and stops after unmount', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mount(page);
  await page.evaluate(async () => { const p = window.__pwa; p.updateFails = true; p.poll(); await Promise.resolve(); });
  expect(await page.evaluate(() => window.__pwa.updateCalls)).toBe(1);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.evaluate(() => { const p = window.__pwa; p.unmount(); p.poll(); });
  expect(await page.evaluate(() => window.__pwa.updateCalls)).toBe(1);
});

test('unsupported browsers perform no registration or polling', async ({ page }) => {
  await page.evaluate(() => { Reflect.deleteProperty(navigator, 'serviceWorker'); });
  await mount(page);
  expect(await page.evaluate(() => ({ calls: window.__pwa.registerCalls, polling: window.__pwa.activePoll }))).toEqual({ calls: 0, polling: false });
  await expect(page.getByRole('status')).toHaveCount(0);
});
