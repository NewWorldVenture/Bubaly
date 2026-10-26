import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, sep } from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';

// TESTS FIRST: real FeedbackBoard/LocaleProvider/ToastProvider, React19,
// installed Next ErrorBoundaryHandler + actual app error UI, and Chromium.
// ONLY the board's server-action IMPORT is controlled. No database/provider,
// full Next server/action transport, Storage, historical-flake cause or repair
// acceptance is claimed. This fixture does not catch the async rejection.
let browser: Browser, origin: string, bundle: string, fixtureRoot: string;
const PRIVATE = 'synthetic-private-provider-diagnostic-never-show-this';
// Copy contract: reuse the existing translated generic uncertainty message.
const UNCERTAIN = 'We could not confirm whether this was saved. Review the destination before creating it again.';
const ACCEPTED = 'Thanks! Your idea is on the board. 💡';
type Mode = 'success' | 'failure' | 'held-success' | 'reject' | 'held-reject' | 'redirect';
type Stats = { calls: number; pending: number; resolved: number; rejected: number; simulatedSaved: boolean };
type Control = { configure: (mode: Mode) => void; release: () => void; stats: () => Stats };
const server = createServer((req, res) => {
  res.setHeader('content-type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(req.url === '/fixture.js' ? bundle : '<!doctype html><meta charset="utf-8"><title>Owned feedback outcome fixture</title><div id="root"></div><script src="/fixture.js"></script>');
});
const stats = (page: Page) => page.evaluate(() => (window as unknown as { feedbackControl: Control }).feedbackControl.stats());
async function record(name: string, value: Record<string, unknown>) {
  const target = process.env.BUBALY_FEEDBACK_OUTCOME_RECEIPT;
  if (!target) return;
  expect(resolve(target).startsWith(resolve(tmpdir()) + sep)).toBe(true);
  await appendFile(target, JSON.stringify({ name, ...value }) + '\n');
}
async function fixture(mode: Mode, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', serviceWorkers: 'block' });
  const external: string[] = [];
  let pageErrors = 0;
  try {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' && url.origin === origin) return route.continue();
      external.push(url.hostname); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', () => { pageErrors++; });
    await page.goto(origin);
    await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { feedbackControl?: Control }).feedbackControl))).toBe(true);
    await page.evaluate(mode => (window as unknown as { feedbackControl: Control }).feedbackControl.configure(mode), mode);
    await page.getByLabel('Title', { exact: true }).fill('Synthetic family feedback');
    await page.getByLabel('What problem would this solve?', { exact: true }).fill('Synthetic problem kept until acknowledgement');
    await page.getByLabel('Your idea', { exact: true }).fill('Synthetic details kept until acknowledgement');
    await run(page);
    expect(external).toEqual([]);
  } finally {
    const page = context.pages()[0];
    if (page && !page.isClosed()) {
      await record(mode, {
        stats: await page.evaluate(() => (window as unknown as { feedbackControl?: Control }).feedbackControl?.stats() ?? null), pageErrors, externalRequests: external.length,
        formPresent: await page.getByLabel('Title', { exact: true }).count(),
        uncertainNotices: await page.getByRole('alert').filter({ hasText: UNCERTAIN }).count(),
        acceptedNotices: await page.getByRole('status').filter({ hasText: ACCEPTED }).count(),
        privateDiagnosticInDom: (await page.locator('body').innerText()).includes(PRIVATE),
        appErrorVisible: await page.getByRole('heading', { name: 'This page hit a snag', exact: true }).count(),
      });
    }
    await context.close();
  }
}
beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'owned-feedback-outcome-'));
  const entry = join(fixtureRoot, 'entry.tsx');
  const actions = `
import { redirect } from 'next/navigation';
let mode = 'success', calls = 0, pending = 0, resolved = 0, rejected = 0, release, simulatedSaved = false;
window.feedbackControl = { configure(value) { mode = value; }, release() { if (release) release(); }, stats() { return { calls, pending, resolved, rejected, simulatedSaved }; } };
export async function submitIdeaAction() {
  calls++; pending++;
  if (mode.startsWith('held-')) await new Promise(done => { release = done; });
  pending--;
  if (mode === 'redirect') { rejected++; redirect('/login'); }
  if (mode === 'reject' || mode === 'held-reject') { rejected++; simulatedSaved = mode === 'held-reject'; throw new Error(${JSON.stringify(PRIVATE)}); }
  resolved++;
  if (mode === 'failure') return { ok: false, error: 'Could not submit the idea.' };
  simulatedSaved = true; return { ok: true, id: '00000000-0000-4000-8000-000000000001' };
}
export async function toggleVoteAction() { throw new Error('Unexpected fixture vote'); }
export async function addCommentAction() { throw new Error('Unexpected fixture comment'); }
export async function setIdeaStatusAction() { throw new Error('Unexpected fixture status'); }
`;
  await writeFile(entry, `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { FeedbackBoard } from '@/app/(app)/feedback/feedback-board';
import AppError from '@/app/(app)/error';
import { ErrorBoundaryHandler } from 'next/dist/client/components/error-boundary';
import { isRedirectError } from 'next/dist/client/components/redirect-error';
import { getURLFromRedirectError } from 'next/dist/client/components/redirect';
import { ToastProvider } from '@/components/ui/toast';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { localeOrDefault } from '@/lib/i18n/locales';
import messages from '@/lib/i18n/messages/en-US.json';
class FrameworkSignalObserver extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) {
      if (!isRedirectError(this.state.error)) throw this.state.error;
      return <h1 data-destination={getURLFromRedirectError(this.state.error)}>Framework navigation signal</h1>;
    }
    return this.props.children;
  }
}
createRoot(document.getElementById('root')).render(
  <LocaleProvider locale={localeOrDefault('en-US')} source="default" messages={messages}>
    <ToastProvider><FrameworkSignalObserver><ErrorBoundaryHandler pathname="/feedback" errorComponent={AppError} errorStyles={null} errorScripts={null}>
      <FeedbackBoard initialIdeas={[]} votedIds={[]} userId="00000000-0000-4000-8000-000000000002" isSuperAdmin={false}/>
    </ErrorBoundaryHandler></FrameworkSignalObserver></ToastProvider>
  </LocaleProvider>);
`);
  await build({
    configFile: false, root: process.cwd(), cacheDir: join(fixtureRoot, 'cache'), logLevel: 'error',
    resolve: { alias: { '@': process.cwd(), react: resolve('node_modules/react'), 'react-dom': resolve('node_modules/react-dom'), next: resolve('node_modules/next') } },
    plugins: [{ name: 'owned-feedback-action-import-boundary', enforce: 'pre',
      resolveId(source, importer) { if (source === './actions' && importer?.replaceAll('\\', '/').endsWith('/app/(app)/feedback/feedback-board.tsx')) return '\0owned-feedback-actions'; },
      load(id) { if (id === '\0owned-feedback-actions') return actions; },
    }],
    oxc: { jsx: { runtime: 'automatic', development: false } },
    define: { 'process.env.NODE_ENV': JSON.stringify('production'), 'process.env': JSON.stringify({ NODE_ENV: 'production', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:9', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'synthetic-no-provider-key' }) },
    build: { outDir: join(fixtureRoot, 'bundle'), emptyOutDir: true, lib: { entry, formats: ['iife'], name: 'OwnedFeedbackOutcome', fileName: () => 'fixture.js' } },
  });
  bundle = await readFile(join(fixtureRoot, 'bundle/fixture.js'), 'utf8');
  const receipt = process.env.BUBALY_FEEDBACK_OUTCOME_RECEIPT;
  if (receipt) { await writeFile(receipt + '.entry.tsx', await readFile(entry)); await writeFile(receipt + '.actions.ts', actions); await writeFile(receipt + '.bundle.js', bundle); }
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Owned feedback HTTP listener missing');
  origin = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM_PATH, headless: true });
}, 90_000);
afterAll(async () => {
  try { if (browser) await browser.close(); }
  finally {
    if (server.listening) { server.closeAllConnections(); await new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())); }
    if (fixtureRoot) {
      expect(resolve(fixtureRoot).startsWith(resolve(tmpdir()) + sep)).toBe(true);
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }
});
async function submit(page: Page) { await page.getByRole('button', { name: 'Submit idea', exact: true }).click(); }
async function preservedDraft(page: Page) {
  expect.soft(await page.getByLabel('Title', { exact: true }).count()).toBe(1);
  if (await page.getByLabel('Title', { exact: true }).count()) {
    expect.soft(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('Synthetic family feedback');
    expect.soft(await page.getByLabel('What problem would this solve?', { exact: true }).inputValue()).toBe('Synthetic problem kept until acknowledgement');
    expect.soft(await page.getByLabel('Your idea', { exact: true }).inputValue()).toBe('Synthetic details kept until acknowledgement');
  }
}
describe('the real feedback form acknowledges the outcome it actually knows', () => {
  it('a genuine framework redirect propagates through the submit catch instead of becoming an uncertainty notice', async () => {
    await fixture('redirect', async page => {
      await submit(page);
      const signal = page.getByRole('heading', { name: 'Framework navigation signal', exact: true });
      await expect.poll(() => signal.count()).toBe(1);
      expect(await signal.getAttribute('data-destination')).toBe('/login');
      expect(await page.getByRole('alert').filter({ hasText: UNCERTAIN }).count()).toBe(0);
      expect(await page.getByRole('heading', { name: 'This page hit a snag', exact: true }).count()).toBe(0);
      expect(await stats(page)).toMatchObject({ calls: 1, pending: 0, rejected: 1 });
    });
  });
  it('a confirmed receipt creates one visible idea, acknowledges success and clears the draft', async () => {
    await fixture('success', async page => {
      await submit(page);
      await expect.poll(async () => (await stats(page)).resolved).toBe(1);
      await expect.poll(() => page.getByRole('status').filter({ hasText: ACCEPTED }).count()).toBe(1);
      expect(await page.getByLabel('Title', { exact: true }).inputValue()).toBe('');
      expect(await page.getByRole('heading', { name: 'Synthetic family feedback', exact: true }).count()).toBe(1);
      expect(await stats(page)).toMatchObject({ calls: 1, pending: 0, resolved: 1, rejected: 0 });
    });
  });
  it('a resolved generic server failure is accessible, keeps the complete draft and creates no optimistic idea', async () => {
    await fixture('failure', async page => {
      await submit(page);
      await expect.poll(() => page.getByRole('alert').filter({ hasText: 'Could not submit the idea.' }).count()).toBe(1);
      await preservedDraft(page);
      expect(await page.getByRole('heading', { name: 'Synthetic family feedback', exact: true }).count()).toBe(0);
      await expect.poll(() => page.getByRole('button', { name: 'Submit idea', exact: true }).isEnabled()).toBe(true);
      expect(await stats(page)).toMatchObject({ calls: 1, pending: 0, resolved: 1, rejected: 0 });
    });
  });
  it('while a receipt is pending the real disabled button dispatches only one action, then consumes one success', async () => {
    await fixture('held-success', async page => {
      await submit(page);
      await expect.poll(async () => (await stats(page)).pending).toBe(1);
      expect(await page.getByRole('button', { name: 'Submit idea', exact: true }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Submit idea', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
      expect((await stats(page)).calls).toBe(1);
      await page.evaluate(() => (window as unknown as { feedbackControl: Control }).feedbackControl.release());
      await expect.poll(() => page.getByRole('status').filter({ hasText: ACCEPTED }).count()).toBe(1);
      expect(await stats(page)).toMatchObject({ calls: 1, pending: 0, resolved: 1, rejected: 0 });
    });
  });
  for (const mode of ['reject', 'held-reject'] as const) it(`${mode}: a lost action acknowledgement is truthfully uncertain, retains the draft and never reposts`, async () => {
    await fixture(mode, async page => {
      await submit(page);
      if (mode === 'held-reject') {
        await expect.poll(async () => (await stats(page)).pending).toBe(1);
        await page.evaluate(() => (window as unknown as { feedbackControl: Control }).feedbackControl.release());
      }
      await expect.poll(async () => (await stats(page)).rejected).toBe(1);
      await expect.poll(async () => await page.getByRole('alert').filter({ hasText: UNCERTAIN }).count()
        + await page.getByRole('heading', { name: 'This page hit a snag', exact: true }).count()).toBe(1);
      expect.soft(await page.getByRole('alert').filter({ hasText: UNCERTAIN }).count()).toBe(1);
      await preservedDraft(page);
      expect.soft((await page.locator('body').innerText()).includes(PRIVATE)).toBe(false);
      expect.soft(await page.getByRole('status').filter({ hasText: ACCEPTED }).count()).toBe(0);
      expect.soft(await page.getByRole('heading', { name: 'Synthetic family feedback', exact: true }).count()).toBe(0);
      expect.soft(await page.getByRole('heading', { name: 'This page hit a snag', exact: true }).count()).toBe(0);
      expect(await stats(page)).toMatchObject({ calls: 1, pending: 0, resolved: 0, rejected: 1 });
    });
  });
});
