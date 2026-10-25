import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';

// TEST-TOAST-COMMIT-WINDOW-20261022. Tests first: actual React19.3, LocaleProvider,
// ToastProvider and Chromium DOM. A concurrent Suspense commit is intentionally
// held while native browser timers advance. This is not a reconstruction of
// MAIN92b's unknown first hosted flake, or a full Next/app/CSS/a11y qualification.
let browser: Browser, origin: string, bundle: string, fixtureRoot: string;
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><title>Owned toast commit fixture</title><div id="root"></div><script src="/fixture.js"></script>');
});
type State = { at: number; attempts: number; committed: number; timers: { pending: number; fired: number; canceled: number }; events: { event: string; at: number; text?: string }[]; toasts: { text: string; queued: boolean; role: string | null }[] };
type Api = { push: (message: string, action: boolean) => void; hold: (message: string, action: boolean) => void; release: () => void; repaint: () => void; unmount: () => void; state: () => State };
const api = (page: Page, command: 'push' | 'hold', message: string, action = false) => page.evaluate(({ command, message, action }) => (window as unknown as { toastFixture: Api }).toastFixture[command](message, action), { command, message, action });
const state = (page: Page) => page.evaluate(() => (window as unknown as { toastFixture: Api }).toastFixture.state());
async function record(name: string, values: Record<string, unknown>) {
  const target = process.env.BUBALY_TOAST_COMMIT_RECEIPT;
  if (!target) return;
  expect(resolve(target).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  await appendFile(target, JSON.stringify({ name, ...values }) + '\n');
}
async function fixture(width: number, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width, height: 844 } });
  try {
    const page = await context.newPage();
    const pageErrors: string[] = []; page.on('pageerror', error => pageErrors.push(String(error))); 
    // Clock controls native browser timers; React, toast scheduling and DOM are
    // real. No vi fake timers, mocked hooks, fake ToastApi, or toast model.
    await page.clock.install({ time: new Date('2026-10-22T12:00:00Z') });
    // Pause autonomous passage before navigation: exact lifetime-minus-1ms
    // checks must not spend their final millisecond between driver calls.
    await page.clock.pauseAt(new Date('2026-10-22T12:00:01Z'));
    await page.goto(origin);
    await page.clock.runFor(50);
    try { await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { toastFixture?: Api }).toastFixture)), { timeout: 5000 }).toBe(true); }
    catch (error) { await record('SETUP REFUSAL', { width, pageErrors, url: page.url() }); throw error; }
    expect((await state(page)).committed).toBe(0);
    expect(await page.locator('[data-harness-ready]').count()).toBe(1);
    await run(page);
    expect(pageErrors).toEqual([]);
  } finally { await context.close(); }
}
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'owned-toast-commit-'));
  const entry = join(fixtureRoot, 'entry.tsx');
  await writeFile(entry, `
import React, { Suspense, startTransition, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider, useToast } from '@/components/ui/toast';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { localeOrDefault } from '@/lib/i18n/locales';
import messages from '@/lib/i18n/messages/en-US.json';
let release, ready = false, attempts = 0, committed = -1;
// Observe actual browser-clock timer handles at the two exported toast delays.
// Callback execution and cancellation remain the real native-clock operations.
const originalSetTimeout = window.setTimeout.bind(window), originalClearTimeout = window.clearTimeout.bind(window);
const ownedTimers = new Set(); let firedTimers = 0, canceledTimers = 0;
window.setTimeout = (callback, delay, ...args) => {
  if (delay !== 4200 && delay !== 7000) return originalSetTimeout(callback, delay, ...args);
  let handle; handle = originalSetTimeout(() => { ownedTimers.delete(handle); firedTimers++; callback(...args); }, delay);
  ownedTimers.add(handle); return handle;
};
window.clearTimeout = handle => { if (ownedTimers.delete(handle)) canceledTimers++; originalClearTimeout(handle); };
const held = new Promise(done => { release = () => { ready = true; log('release'); done(); }; });
const events = [];
function log(event, text) { events.push({ event, at: Date.now(), ...(text ? { text } : {}) }); }
function Gate({ generation }) { if (generation && !ready) { attempts++; log('suspended-render'); throw held; } return null; }
function Harness() {
  const toast = useToast();
  const [generation, setGeneration] = useState(0);
  const push = (message, action) => { log('enqueue', message); toast.error(message, action ? { label: 'Undo synthetic', onClick: () => log('undo') } : undefined); };
  window.toastFixture = { push, hold(message, action) { startTransition(() => { setGeneration(1); push(message, action); }); }, release, repaint: () => mount(), unmount: () => root.unmount(), state() { return { at: Date.now(), attempts, committed, timers: { pending: ownedTimers.size, fired: firedTimers, canceled: canceledTimers }, events, toasts: Array.from(document.querySelectorAll('[data-toast]')).map(el => ({ text: el.textContent, queued: el.hasAttribute('data-queued'), role: el.getAttribute('role') })) }; } };
  useLayoutEffect(() => { committed = generation; log('harness-commit-' + generation); }, [generation]);
  return <><Gate generation={generation}/><button data-harness-ready data-generation={generation}>Outside fixture</button></>;
}
const observer = new MutationObserver(() => { for (const el of document.querySelectorAll('[data-toast]')) { const key = el.getAttribute('data-toast-id'); if (!el.dataset.observed) { el.dataset.observed = '1'; log('toast-dom-' + key, el.textContent); } } });
observer.observe(document.getElementById('root'), { childList: true, subtree: true });
const root = createRoot(document.getElementById('root'));
function mount() { root.render(<Suspense fallback={<p data-fallback>Held initial commit</p>}><LocaleProvider locale={localeOrDefault('en-US')} source="default" messages={messages}><ToastProvider><Harness/></ToastProvider></LocaleProvider></Suspense>); }
mount();
`);
  await build({ configFile: false, root: process.cwd(), cacheDir: join(fixtureRoot, 'cache'), logLevel: 'error', resolve: { alias: { '@': process.cwd(), react: resolve('node_modules/react'), 'react-dom': resolve('node_modules/react-dom') } }, oxc: { jsx: { runtime: 'automatic', development: false } }, define: { 'process.env.NODE_ENV': JSON.stringify('production') }, build: { outDir: join(fixtureRoot, 'bundle'), emptyOutDir: true, lib: { entry, formats: ['iife'], name: 'OwnedToastCommit', fileName: () => 'fixture.js' } } });
  bundle = await readFile(join(fixtureRoot, 'bundle/fixture.js'), 'utf8');
  if (process.env.BUBALY_TOAST_COMMIT_RECEIPT) { const prefix = process.env.BUBALY_TOAST_COMMIT_RECEIPT; await writeFile(prefix + '.bundle.js', bundle); await writeFile(prefix + '.entry.tsx', await readFile(entry)); }
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned local HTTP listener missing');
  origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH, headless: true });
}, 60_000);
afterAll(async () => {
  try { if (browser) await browser.close(); }
  finally { if (server.listening) await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); }
  expect(server.listening).toBe(false);
});

describe('the toast lifetime begins when its DOM commits', () => {
  for (const width of [390, 1280]) {
    it(`${width}px: a visible predecessor keeps its clock while a successor waits for commit`, async () => fixture(width, async page => {
      await api(page, 'push', 'Visible predecessor');
      await expect.poll(() => page.locator('[data-toast]').count()).toBe(1);
      await page.clock.runFor(2100);
      await api(page, 'hold', 'Held successor');
      await expect.poll(async () => (await state(page)).attempts).toBeGreaterThan(0);
      expect((await state(page)).committed).toBe(0);
      await page.clock.runFor(2099);
      expect((await state(page)).toasts.map(t => t.text)).toContainEqual(expect.stringContaining('Visible predecessor'));
      await page.clock.runFor(2);
      await expect.poll(async () => (await state(page)).toasts.some(t => t.text.includes('Visible predecessor'))).toBe(false);
      expect((await state(page)).toasts.some(t => t.text.includes('Held successor'))).toBe(false);
      await page.evaluate(() => (window as unknown as { toastFixture: Api }).toastFixture.release());
      await expect.poll(async () => (await state(page)).committed).toBe(1);
      expect((await state(page)).toasts.map(t => t.text)).toContainEqual(expect.stringContaining('Held successor'));
      await page.clock.runFor(4199); expect((await state(page)).toasts).toHaveLength(1);
      await page.clock.runFor(2); expect((await state(page)).toasts).toHaveLength(0);
      await record(`Predecessor held successor ${width}`, { after: await state(page) });
    }));
    it(`${width}px: a notice arriving under focus waits for release`, async () => fixture(width, async page => {
      await api(page, 'push', 'Focused predecessor', true);
      await page.locator('[data-toast-dismiss]').focus();
      await api(page, 'push', 'Paused arrival', true);
      await expect.poll(() => page.locator('[data-toast]').count()).toBe(2);
      await page.clock.runFor(15_000); expect((await state(page)).toasts).toHaveLength(2);
      await page.locator('[data-harness-ready]').focus();
      await page.clock.runFor(6999); expect((await state(page)).toasts).toHaveLength(2);
      await page.clock.runFor(2);
      expect((await state(page)).toasts).toHaveLength(width === 390 ? 1 : 0);
      await record(`Paused arrival ${width}`, { after: await state(page) });
    }));
    it(`${width}px: an unrelated provider commit preserves the original deadline`, async () => fixture(width, async page => {
      await api(page, 'push', 'Unrelated commit');
      await expect.poll(() => page.locator('[data-toast]').count()).toBe(1);
      await page.clock.runFor(2100);
      await page.evaluate(() => (window as unknown as { toastFixture: Api }).toastFixture.repaint());
      await page.clock.runFor(2099); expect((await state(page)).toasts).toHaveLength(1);
      await page.clock.runFor(2); expect((await state(page)).toasts).toHaveLength(0);
      await record(`Unrelated commit ${width}`, { after: await state(page) });
    }));
    it(`${width}px: Undo invokes its real action once and removes its notice`, async () => fixture(width, async page => {
      await api(page, 'push', 'Undo control', true);
      await page.getByRole('button', { name: 'Undo synthetic' }).click();
      expect((await state(page)).events.filter(event => event.event === 'undo')).toHaveLength(1);
      expect((await state(page)).toasts).toHaveLength(0);
      await page.clock.runFor(7100); expect((await state(page)).toasts).toHaveLength(0);
      await record(`Undo ${width}`, { after: await state(page) });
    }));
    for (const action of [false, true]) it(`${width}px ${action ? 'action' : 'plain'}: unmount cancels the owned native timer`, async () => fixture(width, async page => {
      await api(page, 'push', 'Unmount control', action);
      await expect.poll(() => page.locator('[data-toast]').count()).toBe(1);
      expect((await state(page)).timers.pending).toBe(1);
      await page.evaluate(() => (window as unknown as { toastFixture: Api }).toastFixture.unmount());
      const unmounted = await state(page);
      await page.clock.runFor(15_000);
      const after = await state(page);
      await record(`Unmount native timer ${width} ${action}`, { unmounted, after });
      expect(unmounted.timers.pending).toBe(0);
      expect(unmounted.timers.canceled).toBe(1);
      expect(after.timers.fired).toBe(0);
      expect(after.timers.pending).toBe(0);
      expect(after.toasts).toHaveLength(0);
      expect(await page.locator('#root').textContent()).toBe('');
    }));
    if (width === 390) it('390px: an arrival in the expanded queue stays held until the list closes', async () => fixture(width, async page => {
      await api(page, 'push', 'Expanded one'); await api(page, 'push', 'Expanded two');
      await page.locator('[data-toast-more]').click();
      await api(page, 'push', 'Expanded arrival');
      await expect.poll(() => page.locator('[data-toast]').count()).toBe(3);
      await page.clock.runFor(15_000); expect((await state(page)).toasts).toHaveLength(3);
      expect((await state(page)).toasts.every(t => !t.queued)).toBe(true);
      await page.locator('[data-harness-ready]').focus();
      await page.mouse.move(0, 0);
      await expect.poll(() => page.locator('[data-toast-more]').getAttribute('aria-expanded')).toBe('false');
      await page.clock.runFor(4199); expect((await state(page)).toasts).toHaveLength(3);
      await page.clock.runFor(2); expect((await state(page)).toasts).toHaveLength(2);
      await record('Expanded arrival 390', { after: await state(page) });
    }));
    for (const action of [false, true]) {
      const lifetime = action ? 7000 : 4200;
      it(`${width}px ${action ? 'action' : 'plain'}: a held transition retains a full post-commit window`, async () => fixture(width, async page => {
        const message = `Held ${width} ${action ? 'action' : 'plain'}`;
        await api(page, 'hold', message, action);
        await expect.poll(async () => (await state(page)).attempts).toBeGreaterThan(0);
        const before = await state(page);
        // Hard causal setup controls: initial committed tree remains; the
        // actual transition rendered/suspended and has exposed no new toast.
        expect(before.committed).toBe(0); expect(before.toasts).toHaveLength(0);
        await page.clock.runFor(lifetime + 100);
        const held = await state(page);
        expect(held.at - before.at).toBeGreaterThanOrEqual(lifetime + 100);
        expect(held.committed).toBe(0); expect(held.toasts).toHaveLength(0);
        await page.evaluate(() => (window as unknown as { toastFixture: Api }).toastFixture.release());
        await expect.poll(async () => (await state(page)).committed).toBe(1);
        const after = await state(page);
        await record(message, { width, action, lifetime, before, held, after });
        // Desired RED on current source is only after commit-hold is proven.
        expect(after.toasts.map(t => t.text)).toContainEqual(expect.stringContaining(message));
        await page.clock.runFor(lifetime - 1);
        expect((await state(page)).toasts.map(t => t.text)).toContainEqual(expect.stringContaining(message));
        await page.clock.runFor(2);
        expect((await state(page)).toasts).toHaveLength(0);
      }));
      it(`${width}px ${action ? 'action' : 'plain'}: an immediate toast receives its ordinary window`, async () => fixture(width, async page => {
        const message = `Immediate ${width} ${action ? 'action' : 'plain'}`;
        await api(page, 'push', message, action);
        await expect.poll(() => page.locator('[data-toast]').count()).toBe(1);
        await page.clock.runFor(lifetime - 1);
        expect((await state(page)).toasts).toHaveLength(1);
        await page.clock.runFor(2);
        expect((await state(page)).toasts).toHaveLength(0);
        await record(message, { width, action, lifetime, after: await state(page) });
      }));
    }
    it(`${width}px: focus pauses and leaving gives a full fresh window`, async () => fixture(width, async page => {
      await api(page, 'push', 'Focus pause');
      await page.locator('[data-toast-dismiss]').focus();
      await page.clock.runFor(10_000);
      expect((await state(page)).toasts).toHaveLength(1);
      await page.locator('[data-harness-ready]').focus();
      await page.clock.runFor(4199); expect((await state(page)).toasts).toHaveLength(1);
      await page.clock.runFor(2); expect((await state(page)).toasts).toHaveLength(0);
      await record(`Focus ${width}`, { after: await state(page) });
    }));
    it(`${width}px: manual dismissal retires an action toast`, async () => fixture(width, async page => {
      await api(page, 'push', 'Manual dismissal', true);
      await page.locator('[data-toast-dismiss]').click();
      expect((await state(page)).toasts).toHaveLength(0);
      await page.clock.runFor(7100); expect((await state(page)).toasts).toHaveLength(0);
      await record(`Dismiss ${width}`, { after: await state(page) });
    }));
    it(`${width}px: the real queue clock preserves an older notice only in queue mode`, async () => fixture(width, async page => {
      await api(page, 'push', 'Older'); await expect.poll(() => page.locator('[data-toast]').count()).toBe(1);
      await page.clock.runFor(2100);
      await api(page, 'push', 'Newer'); await expect.poll(() => page.locator('[data-toast]').count()).toBe(2);
      const both = await state(page);
      expect(both.toasts.find(t => t.text.includes('Older'))?.queued).toBe(width === 390);
      await page.clock.runFor(4201);
      if (width === 390) {
        const remaining = await state(page);
        expect(remaining.toasts).toHaveLength(1); expect(remaining.toasts[0].text).toContain('Older'); expect(remaining.toasts[0].queued).toBe(false);
        await page.clock.runFor(4199); expect((await state(page)).toasts).toHaveLength(1);
        await page.clock.runFor(2);
      }
      expect((await state(page)).toasts).toHaveLength(0);
      await record(`Queue ${width}`, { both, after: await state(page) });
    }));
  }
});
