import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect, request as apiRequest, test as base, type APIRequestContext, type APIResponse, type BrowserContext, type Page, type Request as BrowserRequest } from '@playwright/test';
import { callbackAdmissionMaterial, parseCallbackAdmissionCookies } from '../../lib/auth/callback-witness';
import { encodePkceInitiationRecord, pkceInitiationCookieName, readPkceInitiationSlot } from '../../lib/auth/pkce-initiation';
import {
  authCookieName, authCookies, closeWithoutSnapshot, createOwnedAccount, readSession, requireLocalOrigin,
  type CloseWithoutSnapshotCounts, type CloseWithoutSnapshotPhase, type OwnedAccount,
} from './helpers/durable-session';

// Runs against the real Next server and the CI job's disposable GoTrue. This is
// not a component fixture: an isolated request obtains the original HTTP
// redirect, and only its browser delivery is delayed. No provider response or
// server action is mocked. The isolated jar cannot publish cookies early.
// The invalid-code control covers explicit rejection; the Mailpit case follows
// a real emailed recovery code through exchange, adoption and password change.
const enabled = process.env.E2E_AUTHENTICATED === '1';
const provider = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const test = base.extend<{ account: OwnedAccount; replacement: OwnedAccount }>({
  account: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    try { await runFixture(account); } finally { await account.dispose(); }
  },
  replacement: async ({ baseURL }, runFixture) => {
    requireLocalOrigin(baseURL);
    const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
    try { await runFixture(account); } finally { await account.dispose(); }
  },
});
test.use({ trace: 'off', screenshot: 'off', video: 'off', locale: 'en-US' });

async function signIn(page: Page, origin: string, account: OwnedAccount) {
  await page.goto(`${origin}/login?redirect=/home`, { waitUntil: 'domcontentloaded' });
  try {
    await page.locator('input[name="email"]').fill(account.email);
    await page.locator('input[name="password"]').fill(account.password);
  } catch { throw new Error('Callback admission E2E could not fill its owned sign-in form.'); }
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/home`, { timeout: 60_000 });
  expect(readSession(await page.context().cookies(), authCookieName(provider)).user.id === account.userId,
    'Production sign-in must adopt the owned fixture account').toBe(true);
}

async function seedInvalidExchange(context: BrowserContext, origin: string) {
  // No session is injected. This synthetic verifier accompanies a nonexistent
  // code so the unchanged control exercises the real action's rejection path.
  await context.addCookies([{ name: authCookieName(provider) + '-code-verifier',
    value: 'base64-' + Buffer.from(JSON.stringify('synthetic-admission-verifier-' + randomUUID())).toString('base64url'),
    url: origin, sameSite: 'Lax' }]);
  // Seal the original owner before the callback request. Held-response cases
  // retain these exact hashes through logout or a newer password login.
  const key = authCookieName(provider);
  const cookies = parseCallbackAdmissionCookies((await context.cookies(origin))
    .map(({ name, value }) => `${name}=${value}`).join('; '));
  const material = cookies && callbackAdmissionMaterial(cookies, key);
  if (!material) throw new Error('Callback admission E2E cannot capture its original initiation owner.');
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const nonce = randomBytes(16).toString('hex');
  const record = encodePkceInitiationRecord({ v: 1, nonce, kind: 'oauth',
    project: hash(material.project), generation: hash(material.generation),
    verifier: hash(material.verifier), session: hash(material.session) });
  await context.addCookies([{ name: pkceInitiationCookieName(key), value: record, url: origin, sameSite: 'Lax' }]);
  return `${origin}/auth/callback?${new URLSearchParams({ code: randomUUID(), next: '/home', attempt: nonce })}`;
}

function actionRequest(request: { url(): string; method(): string; headers(): Record<string, string> }, origin: string) {
  const url = new URL(request.url());
  return url.origin === origin && url.pathname === '/auth/complete' && request.method() === 'POST'
    && typeof request.headers()['next-action'] === 'string';
}

async function captureActualActionReceipt(page: Page, origin: string, expected: 'rejected' | 'exchanged') {
  let receipt: { status: number; cookieNeutral: boolean; matches: boolean } | null | undefined;
  await page.route(url => url.origin === origin && url.pathname === '/auth/complete', async route => {
    if (!actionRequest(route.request(), origin)) { await route.continue(); return; }
    try {
      const response = await route.fetch({ maxRedirects: 0, timeout: 15_000 });
      try {
        // Capture the real receipt before releasing it to the browser: a layout
        // navigation can discard Chromium's body handle. Retain no token bytes.
        const captured = { status: response.status(), cookieNeutral: !response.headers()['set-cookie'],
          matches: (await response.text()).includes(`"status":"${expected}"`) };
        await route.fulfill({ response });
        receipt = captured;
      } finally { await response.dispose().catch(() => {}); }
    } catch {
      receipt = null;
      await route.abort().catch(() => {});
    }
  });
  return async () => {
    await expect.poll(() => receipt !== undefined, { timeout: 30_000 }).toBe(true);
    expect(receipt, `The actual completion action must return ${expected} without setting auth cookies`)
      .toEqual({ status: 200, cookieNeutral: true, matches: true });
  };
}

async function holdOriginalAdmission(page: Page, origin: string) {
  let ready = false, failed = false, cleanupFailed = false, releaseGate = () => {};
  let released = false, decisionComplete = false, deliveries = 0;
  let originalUrl: string | undefined, completionUrl: string | undefined;
  let deliveredCookies: string | undefined, cookieNeutral = false;
  const phases: string[] = [];
  const pending: Promise<void>[] = [];
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const release = () => { released = true; releaseGate(); };
  const observeDelivery = (request: BrowserRequest) => {
    if (request.method() !== 'GET' || !request.isNavigationRequest()
      || request.url() !== completionUrl || request.redirectedFrom()?.url() !== originalUrl) return;
    deliveries++;
    phases.push('original-response-delivered');
    // This is Chromium's immutable outgoing Cookie header after it processes
    // the original 307. Later completion code cannot repair this observation.
    const observed = request.allHeaders().then(headers => {
      const cookies = parseCallbackAdmissionCookies(headers.cookie ?? null);
      if (!cookies) throw new Error('Invalid redirected request cookies');
      const key = authCookieName(provider);
      deliveredCookies = JSON.stringify(cookies.filter(cookie => cookie.name === key
        || (cookie.name.startsWith(`${key}.`) && /^\d+$/.test(cookie.name.slice(key.length + 1))))
        .map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name)));
    }).catch(() => { failed = true; });
    pending.push(observed);
  };
  page.on('request', observeDelivery);
  await page.route(url => url.origin === origin && url.pathname === '/auth/callback', async route => {
    const handled = (async () => {
      let isolated: APIRequestContext | undefined, response: APIResponse | undefined;
      try {
        if (originalUrl !== undefined || route.request().method() !== 'GET') throw new Error('Unexpected callback request');
        originalUrl = route.request().url();
        // route.fetch uses the browser's cookie jar and applies Set-Cookie
        // before returning. Keep capture isolated until actual browser delivery.
        isolated = await apiRequest.newContext({ timeout: 15_000 });
        response = await isolated.get(originalUrl, { headers: await route.request().allHeaders(), maxRedirects: 0 });
        const location = new URL(response.headers().location ?? '', origin);
        if (response.status() !== 307 || location.origin !== origin || location.pathname !== '/auth/complete'
          || !location.searchParams.get('admission')) {
          throw new Error('Unexpected callback admission response');
        }
        completionUrl = location.href;
        cookieNeutral = !response.headers()['set-cookie'];
        phases.push('original-response-captured');
        ready = true;
        await gate;
        await route.fulfill({ response });
      } catch {
        failed = true;
        await route.abort().catch(() => {});
      } finally {
        try { await response?.dispose(); } catch { cleanupFailed = true; }
        try { await isolated?.dispose(); } catch { cleanupFailed = true; }
      }
    })();
    pending.push(handled);
    await handled;
  });
  return {
    wait: async () => {
      await expect.poll(() => ready || failed, { timeout: 30_000 }).toBe(true);
      if (failed) throw new Error('Callback admission E2E could not hold the original Next redirect.');
    },
    release,
    decisionComplete: () => {
      expect({ ready, failed, released, decisionComplete, deliveries })
        .toEqual({ ready: true, failed: false, released: false, decisionComplete: false, deliveries: 0 });
      decisionComplete = true;
      phases.push('newer-decision-complete');
    },
    deliveredCookies: async () => {
      await expect.poll(() => deliveredCookies !== undefined || failed, { timeout: 30_000 }).toBe(true);
      expect(failed, 'The actual old redirect must reach the browser').toBe(false);
      expect(deliveries).toBe(1);
      expect(phases).toEqual(['original-response-captured', 'newer-decision-complete', 'original-response-delivered']);
      return deliveredCookies;
    },
    cookieNeutral: () => cookieNeutral,
    failed: () => failed,
    dispose: async () => {
      release();
      await Promise.allSettled(pending);
      page.off('request', observeDelivery);
      if (cleanupFailed) throw new Error('Callback admission E2E could not dispose its isolated capture.');
    },
  };
}

function sessionBytes(context: BrowserContext) {
  return context.cookies().then(cookies => JSON.stringify(authCookies(cookies, authCookieName(provider))
    .map(({ name, value }) => ({ name, value })).sort((a, b) => a.name.localeCompare(b.name))));
}

type MailpitMessage = { ID?: unknown; To?: { Address?: unknown }[]; Text?: unknown; HTML?: unknown };

async function readLocalMailbox(path: string): Promise<unknown> {
  // Supabase CLI 2.109.1 starts Mailpit here in the existing disposable stack.
  // No remote override or mailbox-wide cleanup is allowed for this fixture.
  const mailbox = requireLocalOrigin('http://127.0.0.1:54324');
  try {
    const response = await fetch(new URL(path, mailbox), { redirect: 'error', signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error();
    const body = await response.text();
    if (body.length > 1_048_576) throw new Error();
    return JSON.parse(body) as unknown;
  } catch { throw new Error('Callback admission E2E requires the disposable Mailpit API on local port 54324.'); }
}

function ownedRecipient(message: MailpitMessage, email: string) {
  return Array.isArray(message.To) && message.To.length === 1 && message.To[0]?.Address === email;
}

function recoveryLink(message: MailpitMessage, origin: string, attempt: string): string | null {
  const providerOrigin = requireLocalOrigin(provider);
  const body = [message.Text, message.HTML].filter((value): value is string => typeof value === 'string').join('\n');
  if (body.length > 262_144) throw new Error('Callback admission E2E received an oversized owned recovery email.');
  const links = new Set<string>();
  // Mailpit returns decoded MIME content. Decode HTML ampersands without ever
  // rendering the message or visiting an arbitrary link contained in it.
  for (const candidate of body.replace(/&(?:amp|#38|#x26);/gi, '&').match(/https?:\/\/[^\s<>"')]+/g) ?? []) {
    let url: URL;
    try { url = new URL(candidate); } catch { continue; }
    if (url.origin !== providerOrigin || url.pathname !== '/auth/v1/verify') continue;
    const redirect = url.searchParams.getAll('redirect_to');
    const token = url.searchParams.getAll('token');
    const kind = url.searchParams.getAll('type');
    if (url.username || url.password || url.hash || candidate.length > 8_192
      || token.length !== 1 || !token[0] || token[0].length > 4_096
      || kind.length !== 1 || kind[0] !== 'recovery'
      || redirect.length !== 1 || redirect[0] !== `${origin}/auth/callback?${new URLSearchParams({ next: '/auth/recovery', attempt })}`) {
      throw new Error('Callback admission E2E recovery email has an invalid provider link or disposable redirect configuration.');
    }
    links.add(url.href);
  }
  if (links.size > 1) throw new Error('Callback admission E2E received ambiguous owned recovery links.');
  return links.values().next().value ?? null;
}

async function waitForOwnedRecoveryEmail(email: string, origin: string, attempt: string): Promise<string> {
  const deadline = Date.now() + 30_000;
  const seen = new Set<string>();
  do {
    const result = await readLocalMailbox(`/api/v1/search?${new URLSearchParams({ query: `to:${email}`, limit: '5' })}`);
    if (!result || typeof result !== 'object' || !('messages' in result) || !Array.isArray(result.messages)) {
      throw new Error('Callback admission E2E received an invalid disposable Mailpit search response.');
    }
    for (const summary of result.messages.slice(0, 5) as MailpitMessage[]) {
      if (!summary || !ownedRecipient(summary, email)) continue;
      if (typeof summary.ID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(summary.ID)) {
        throw new Error('Callback admission E2E received an invalid owned Mailpit message ID.');
      }
      if (seen.has(summary.ID)) continue;
      seen.add(summary.ID);
      const message = await readLocalMailbox(`/api/v1/message/${summary.ID}`) as MailpitMessage;
      if (!message || !ownedRecipient(message, email)) {
        throw new Error('Callback admission E2E refuses a mailbox message for a different recipient.');
      }
      const link = recoveryLink(message, origin, attempt);
      if (link) return link;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error('Callback admission E2E did not receive its owned recovery email within 30 seconds. Check disposable SMTP configuration.');
}

test.describe('callback admission through the real Next HTTP path', () => {
  test.skip(!enabled, 'Requires E2E_AUTHENTICATED=1 and the existing disposable local Supabase/Next CI setup.');
  test.setTimeout(120_000);

  test('held original redirect cannot continue after production logout before completion mounts', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    let release = () => {}, dispose = async () => {};
    try {
      const decision = await context.newPage(); await signIn(decision, origin, account);
      const callbackUrl = await seedInvalidExchange(context, origin);
      const completion = await context.newPage();
      let actions = 0;
      completion.on('request', request => { if (actionRequest(request, origin)) actions++; });
      const original = await sessionBytes(context);
      const held = await holdOriginalAdmission(completion, origin); release = held.release; dispose = held.dispose;
      const navigation = completion.goto(callbackUrl, { waitUntil: 'domcontentloaded' }).then(() => true, () => false);
      await held.wait();
      expect(await sessionBytes(context) === original, 'Isolated response capture must preserve browser cookies').toBe(true);
      await decision.getByRole('button', { name: 'Account menu', exact: true }).click();
      await decision.getByRole('button', { name: 'Sign out', exact: true }).click();
      await decision.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
      await expect(decision).toHaveURL(/\/login(?:\?|$)/);
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
      held.decisionComplete(); held.release();
      expect(await held.deliveredCookies() === '[]', 'The old redirect must not reintroduce auth cookies after logout').toBe(true);
      expect(held.cookieNeutral(), 'The actual old redirect must contain no Set-Cookie').toBe(true);
      expect(await navigation).toBe(true);
      await expect(completion.getByRole('alert').filter({ hasText: 'Your sign-in state changed' })).toContainText('Your sign-in state changed');
      expect(new URL(completion.url()).pathname).toBe('/auth/complete');
      expect(actions, 'Stale admission must be refused before a real server action').toBe(0);
      expect(held.failed()).toBe(false);
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
    } finally { release(); try { await dispose(); } finally { await closeWithoutSnapshot(context); } }
  });

  test('held original redirect preserves a newer production login without intervening logout', async ({ browser, baseURL, account, replacement }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    let release = () => {}, dispose = async () => {};
    try {
      const decision = await context.newPage(); await signIn(decision, origin, account);
      const callbackUrl = await seedInvalidExchange(context, origin);
      const completion = await context.newPage();
      let actions = 0;
      completion.on('request', request => { if (actionRequest(request, origin)) actions++; });
      const original = await sessionBytes(context);
      const held = await holdOriginalAdmission(completion, origin); release = held.release; dispose = held.dispose;
      const navigation = completion.goto(callbackUrl, { waitUntil: 'domcontentloaded' }).then(() => true, () => false);
      await held.wait();
      expect(await sessionBytes(context) === original, 'Isolated response capture must preserve browser cookies').toBe(true);
      await signIn(decision, origin, replacement);
      const before = await sessionBytes(context);
      held.decisionComplete(); held.release();
      expect(await held.deliveredCookies() === before, 'The old redirect must send the newer session cookies unchanged').toBe(true);
      expect(held.cookieNeutral(), 'The actual old redirect must contain no Set-Cookie').toBe(true);
      expect(await navigation).toBe(true);
      await expect(completion.getByRole('alert').filter({ hasText: 'Your sign-in state changed' })).toContainText('Your sign-in state changed');
      expect(new URL(completion.url()).pathname).toBe('/auth/complete');
      expect(actions, 'Newer login must be detected before a real server action').toBe(0);
      expect(held.failed()).toBe(false);
      expect(await sessionBytes(context) === before, 'The original response must preserve the newer session bytes').toBe(true);
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === replacement.userId).toBe(true);
    } finally { release(); try { await dispose(); } finally { await closeWithoutSnapshot(context); } }
  });

  test('untouched admission runs the real rejected-code action and preserves the existing login', async ({ browser, baseURL, account }) => {
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    try {
      const decision = await context.newPage(); await signIn(decision, origin, account);
      const callbackUrl = await seedInvalidExchange(context, origin);
      const before = await sessionBytes(context);
      const completion = await context.newPage();
      const receipt = await captureActualActionReceipt(completion, origin, 'rejected');
      await completion.goto(callbackUrl, { waitUntil: 'domcontentloaded' });
      await receipt();
      await expect(completion.getByRole('alert').filter({ hasText: 'This sign-in link is invalid' }))
        .toContainText('This sign-in link is invalid or has expired');
      expect(new URL(completion.url()).pathname).toBe('/auth/complete');
      expect(await sessionBytes(context) === before, 'Failed code exchange must retain the existing session bytes').toBe(true);
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId).toBe(true);
    } finally { await closeWithoutSnapshot(context); }
  });

  for (const missing of ['nonce', 'record'] as const) {
    test(`missing initiation ${missing} refuses completion before a real action and preserves the existing login`, async ({ browser, baseURL, account }) => {
      const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
      try {
        const decision = await context.newPage(); await signIn(decision, origin, account);
        const callbackUrl = new URL(await seedInvalidExchange(context, origin));
        if (missing === 'nonce') callbackUrl.searchParams.delete('attempt');
        else await context.clearCookies({ name: pkceInitiationCookieName(authCookieName(provider)) });
        const before = await sessionBytes(context), completion = await context.newPage();
        let actions = 0;
        completion.on('request', request => { if (actionRequest(request, origin)) actions++; });
        await completion.goto(callbackUrl.href, { waitUntil: 'domcontentloaded' });
        await expect(completion.getByRole('alert').filter({ hasText: 'This sign-in link is invalid' }))
          .toContainText('This sign-in link is invalid or has expired');
        expect(new URL(completion.url()).pathname).toBe('/auth/complete');
        expect(actions, 'Missing initiation authority must be refused before a real server action').toBe(0);
        expect(await sessionBytes(context) === before, 'Refused completion must preserve the existing session bytes').toBe(true);
        expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId).toBe(true);
      } finally { await closeWithoutSnapshot(context); }
    });
  }

  test('real emailed recovery completes PKCE and the saved password works after production logout', async ({ browser, baseURL, account }, testInfo) => {
    type Phase = CloseWithoutSnapshotPhase | 'context-create-start' | 'context-create-complete'
      | 'reset-form-start' | 'reset-form-ready' | 'recovery-request-start' | 'recovery-request-accepted'
      | 'initiation-checks-start' | 'initiation-checks-complete' | 'mailbox-wait-start' | 'mailbox-wait-complete'
      | 'action-receipt-start' | 'action-receipt-complete' | 'recovery-adoption-start' | 'recovery-adoption-complete'
      | 'password-save-start' | 'password-save-complete' | 'home-navigation-start' | 'home-navigation-complete'
      | 'logout-start' | 'logout-complete' | 'password-relogin-start' | 'password-relogin-complete'
      | 'logout-account-menu-start' | 'logout-account-menu-complete' | 'logout-sign-out-start' | 'logout-sign-out-complete'
      | 'logout-confirmation-start' | 'logout-confirmation-complete' | 'logout-redirect-check-start' | 'logout-redirect-check-complete'
      | 'logout-cookie-check-start' | 'logout-cookie-check-complete'
      | 'body-complete' | 'body-failed' | 'cleanup-complete';
    const startedAt = performance.now();
    const report = (phase: Phase, counts?: CloseWithoutSnapshotCounts) => {
      // Only static phases, runner identifiers, time and counts may reach CI logs.
      try {
        console.log('[callback-admission-recovery]', JSON.stringify({
          phase, elapsedMs: Math.round(performance.now() - startedAt), timeoutMs: testInfo.timeout,
          retry: testInfo.retry, project: testInfo.project.name, workerIndex: testInfo.workerIndex,
          status: testInfo.status, pageCount: counts?.pageCount, rejectedCount: counts?.rejectedCount,
        }));
      } catch {}
    };
    report('context-create-start');
    const origin = requireLocalOrigin(baseURL), context = await browser.newContext({ locale: 'en-US' });
    report('context-create-complete');
    try {
      report('reset-form-start');
      const page = await context.newPage();
      await page.goto(`${origin}/login?reset=1`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Reset your password', exact: true })).toBeVisible();
      report('reset-form-ready');
      report('recovery-request-start');
      try { await page.locator('input[name="email"]').fill(account.email); }
      catch { throw new Error('Callback admission E2E could not fill its owned recovery request.'); }
      await page.getByRole('button', { name: 'Send recovery link', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('check your inbox for a recovery link', { timeout: 30_000 });
      report('recovery-request-accepted');
      report('initiation-checks-start');
      const verifier = authCookieName(provider) + '-code-verifier';
      expect((await context.cookies()).some(cookie => cookie.value && (cookie.name === verifier || cookie.name.startsWith(`${verifier}.`))),
        'The production email request must create a PKCE verifier').toBe(true);
      const initiated = readPkceInitiationSlot(await context.cookies(origin), authCookieName(provider))?.record;
      if (!initiated || initiated.kind !== 'recovery') throw new Error('The production recovery request must retain its original initiation record.');
      report('initiation-checks-complete');
      report('mailbox-wait-start');
      const link = await waitForOwnedRecoveryEmail(account.email, origin, initiated.nonce);
      report('mailbox-wait-complete');
      report('action-receipt-start');
      const exchange = await captureActualActionReceipt(page, origin, 'exchanged');
      // Keep the token-bearing URL out of Playwright's named navigation steps.
      try { await page.evaluate(value => { window.location.assign(value); }, link); }
      catch { throw new Error('Callback admission E2E could not follow its validated local recovery link.'); }
      await exchange();
      report('action-receipt-complete');
      report('recovery-adoption-start');
      // Compare a boolean so a broken redirect cannot expose its code in output.
      await expect.poll(() => page.url() === `${origin}/auth/recovery`, { timeout: 30_000 }).toBe(true);
      await expect(page.getByRole('button', { name: 'Save new password', exact: true })).toBeVisible({ timeout: 30_000 });
      expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId,
        'Successful callback adoption must install the owned recovery account').toBe(true);
      expect((await context.cookies()).some(cookie => cookie.name === verifier || cookie.name.startsWith(`${verifier}.`)),
        'Successful isolated exchange must retire its PKCE verifier').toBe(false);
      expect(readPkceInitiationSlot(await context.cookies(origin), authCookieName(provider))?.raw,
        'Successful callback adoption must consume its exact initiation record').toBe(null);
      report('recovery-adoption-complete');
      report('password-save-start');
      const password = `Recovery1!${randomBytes(24).toString('base64url')}`;
      try {
        await page.locator('input[name="password"]').fill(password);
        await page.locator('input[name="confirmation"]').fill(password);
      } catch { throw new Error('Callback admission E2E could not fill its owned replacement password.'); }
      await page.getByRole('button', { name: 'Save new password', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Password updated', exact: true })).toBeVisible({ timeout: 30_000 });
      report('password-save-complete');
      report('home-navigation-start');
      await page.goto(`${origin}/home`, { waitUntil: 'domcontentloaded' });
      report('home-navigation-complete');
      report('logout-start');
      report('logout-account-menu-start');
      await page.getByRole('button', { name: 'Account menu', exact: true }).click();
      report('logout-account-menu-complete');
      report('logout-sign-out-start');
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      report('logout-sign-out-complete');
      report('logout-confirmation-start');
      await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
      report('logout-confirmation-complete');
      report('logout-redirect-check-start');
      await expect.poll(() => new URL(page.url()).pathname === '/login').toBe(true);
      report('logout-redirect-check-complete');
      report('logout-cookie-check-start');
      expect(authCookies(await context.cookies(), authCookieName(provider)).length).toBe(0);
      report('logout-cookie-check-complete');
      report('logout-complete');
      report('password-relogin-start');
      await signIn(page, origin, { ...account, password });
      report('password-relogin-complete');
      report('body-complete');
    } catch (error) {
      report('body-failed');
      throw error;
    } finally {
      await closeWithoutSnapshot(context, report);
      report('cleanup-complete');
    }
  });
});

test('a real completed password save remains successful when its browser receipt crosses grant expiry', async ({ browser, baseURL }, testInfo) => {
  test.skip(!enabled, 'Requires E2E_AUTHENTICATED=1 and the existing disposable local Supabase/Next CI setup.');
  test.setTimeout(120_000);
  const origin = requireLocalOrigin(baseURL);
  const account = await createOwnedAccount(provider, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '');
  const storageKey = 'bubaly.auth.recovery.grant.v1';
  const password = `Recovery1!${randomBytes(24).toString('base64url')}`;
  let context: BrowserContext | undefined, loginContext: BrowserContext | undefined;
  let response: APIResponse | undefined, saveWork: Promise<void> | undefined;
  let releaseReceipt = () => {}, saves = 0, captured = false, delivered = false, captureFailed = false;
  let primaryError: unknown, bodyFailed = false;
  const cleanupErrors: Error[] = [];
  const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
  const startedAt = performance.now();
  const report = (phase: 'recovery-ready' | 'real-save-captured' | 'new-password-login-verified'
    | 'client-expiry-crossed' | 'unchanged-receipt-delivered' | 'body-complete' | 'body-failed' | 'owned-cleanup-complete') => {
    // No URLs, grants, passwords, cookie values, response bodies or account IDs.
    try {
      console.log('[callback-recovery-expiry]', JSON.stringify({
        phase, elapsedMs: Math.round(performance.now() - startedAt), retry: testInfo.retry,
        project: testInfo.project.name, saves, captured, delivered, captureFailed,
      }));
    } catch { /* Diagnostics must not replace a body or cleanup failure. */ }
  };
  try {
    context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    // Install before application code creates timers. Only this browser clock
    // changes; the real server's signed grant and Auth clock remain untouched.
    await page.clock.install();
    await page.goto(`${origin}/login?reset=1`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Reset your password', exact: true })).toBeVisible();
    try { await page.locator('input[name="email"]').fill(account.email); }
    catch { throw new Error('Recovery expiry E2E could not fill its owned recovery request.'); }
    await page.getByRole('button', { name: 'Send recovery link', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('check your inbox for a recovery link', { timeout: 30_000 });
    const initiated = readPkceInitiationSlot(await context.cookies(origin), authCookieName(provider))?.record;
    if (!initiated || initiated.kind !== 'recovery') throw new Error('Recovery expiry E2E requires its real recovery initiation.');
    const link = await waitForOwnedRecoveryEmail(account.email, origin, initiated.nonce);
    const exchange = await captureActualActionReceipt(page, origin, 'exchanged');
    try { await page.evaluate(value => { window.location.assign(value); }, link); }
    catch { throw new Error('Recovery expiry E2E could not follow its validated local recovery link.'); }
    await exchange();
    await expect.poll(() => page.url() === `${origin}/auth/recovery`, { timeout: 30_000 }).toBe(true);
    await expect(page.getByRole('button', { name: 'Save new password', exact: true })).toBeEnabled({ timeout: 30_000 });
    expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId,
      'The real recovery flow must install the owned account').toBe(true);
    const verifier = authCookieName(provider) + '-code-verifier';
    expect((await context.cookies()).some(cookie => cookie.name === verifier || cookie.name.startsWith(`${verifier}.`))).toBe(false);
    expect(readPkceInitiationSlot(await context.cookies(origin), authCookieName(provider))?.raw).toBe(null);
    const grant = await page.evaluate(async ({ key, userId }) => {
      try {
        const value = sessionStorage.getItem(key);
        if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return null;
        const payload = JSON.parse(atob(value.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
        if (payload.purpose !== 'password-recovery' || payload.sub !== userId || !Number.isSafeInteger(payload.expiresAt)) return null;
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return { expiresAt: payload.expiresAt as number, digest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
      } catch { return null; }
    }, { key: storageKey, userId: account.userId });
    if (!grant) throw new Error('Recovery expiry E2E could not read its genuine server-issued grant.');
    // Decoding selects a clock boundary, never grants authority or changes the
    // signed value. The unchanged real save action verifies its own authority.
    const remaining = grant.expiresAt - await page.evaluate(() => Date.now());
    expect(remaining > 10_000 && remaining <= 15 * 60_000, 'The genuine grant must have a usable future cutoff').toBe(true);
    try {
      await page.locator('input[name="password"]').fill(password);
      await page.locator('input[name="confirmation"]').fill(password);
    } catch { throw new Error('Recovery expiry E2E could not fill its owned replacement password.'); }
    report('recovery-ready');
    await page.route(url => url.origin === origin && url.pathname === '/auth/recovery', async route => {
      const request = route.request();
      if (request.method() !== 'POST' || typeof request.headers()['next-action'] !== 'string') {
        await route.continue(); return;
      }
      const work = (async () => {
        try {
          saves++;
          // Match the intended real action without printing its capability or
          // password, and forward the original request exactly once.
          const body = request.postData();
          if (saves !== 1 || !body || body.length > 16_384) throw new Error();
          const args: unknown = JSON.parse(body);
          if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== 'string'
            || createHash('sha256').update(args[0]).digest('hex') !== grant.digest || args[1] !== password) throw new Error();
          response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 15_000 });
          const bytes = await response.body();
          if (response.status() !== 200 || response.headers()['set-cookie'] || bytes.length > 65_536) throw new Error();
          const updatedRecords = bytes.toString('utf8').split('\n').filter(line => {
            try {
              const separator = line.indexOf(':');
              if (separator < 1 || !/^[0-9a-f]+$/i.test(line.slice(0, separator))) return false;
              const value: unknown = JSON.parse(line.slice(separator + 1));
              return value !== null && typeof value === 'object' && !Array.isArray(value)
                && Object.keys(value).length === 1 && 'outcome' in value && value.outcome === 'updated';
            } catch { return false; }
          });
          if (updatedRecords.length !== 1) throw new Error();
          captured = true;
          await receiptGate;
          // Preserve every byte/status/header of the completed real response.
          await route.fulfill({ response });
          delivered = true;
        } catch {
          captureFailed = true;
          await route.abort().catch(() => { cleanupErrors.push(new Error('Recovery expiry E2E could not abort its owned save route.')); });
        }
      })();
      saveWork = saveWork ? Promise.all([saveWork, work]).then(() => {}) : work;
      await work;
    });
    // Pause only after the page is ready. The held response is crossed by
    // 10,001 client milliseconds, comfortably below the 35-second save deadline.
    await page.clock.pauseAt(grant.expiresAt - 10_000);
    const submittedAt = await page.evaluate(() => Date.now());
    await page.getByRole('button', { name: 'Save new password', exact: true }).click();
    await expect.poll(() => captured || captureFailed, { timeout: 30_000 }).toBe(true);
    expect(captureFailed, 'Capture must complete the real updated save without substituting a response').toBe(false);
    expect(captured).toBe(true); expect(delivered).toBe(false); expect(saves).toBe(1);
    report('real-save-captured');
    // This fresh, unclocked browser has no recovery cookies. A successful real
    // password login proves persistence before the held receipt is delivered.
    loginContext = await browser.newContext({ locale: 'en-US' });
    const loginPage = await loginContext.newPage();
    await signIn(loginPage, origin, { ...account, password });
    expect(readSession(await loginContext.cookies(), authCookieName(provider)).user.id === account.userId,
      'The real replacement password must authenticate the same owned account in a fresh browser').toBe(true);
    expect(delivered).toBe(false);
    report('new-password-login-verified');
    await page.clock.fastForward(10_001);
    const crossedAt = await page.evaluate(() => Date.now());
    expect(crossedAt > grant.expiresAt && crossedAt - submittedAt < 35_000,
      'The browser must cross grant expiry while still inside the dispatched-save deadline').toBe(true);
    report('client-expiry-crossed');
    expect.soft(await page.getByRole('alert').allTextContents()).not.toContain('This recovery link has expired. Request a new link.');
    releaseReceipt();
    await saveWork;
    expect(captureFailed).toBe(false); expect(delivered).toBe(true); expect(saves).toBe(1);
    report('unchanged-receipt-delivered');
    await expect(page.getByRole('heading', { name: 'Password updated', exact: true })).toBeVisible();
    expect(await page.evaluate(key => sessionStorage.getItem(key) === null, storageKey), 'The consumed grant must be cleared').toBe(true);
    expect(readSession(await context.cookies(), authCookieName(provider)).user.id === account.userId,
      'The held receipt must preserve its owned recovery account').toBe(true);
    await expect(page.getByRole('button', { name: 'Save new password', exact: true })).toHaveCount(0);
    report('body-complete');
  } catch (error) {
    bodyFailed = true; primaryError = error; report('body-failed');
  } finally {
    releaseReceipt();
    try { await saveWork; } catch { cleanupErrors.push(new Error('Recovery expiry E2E could not finish its owned save route.')); }
    try { await response?.dispose(); } catch { cleanupErrors.push(new Error('Recovery expiry E2E could not dispose its owned save response.')); }
    for (const ownedContext of [loginContext, context]) {
      if (ownedContext) {
        try { await closeWithoutSnapshot(ownedContext); }
        catch { cleanupErrors.push(new Error('Recovery expiry E2E could not close an owned browser context.')); }
      }
    }
    try { await account.dispose(); } catch { cleanupErrors.push(new Error('Recovery expiry E2E could not remove its owned account.')); }
    if (cleanupErrors.length === 0) report('owned-cleanup-complete');
  }
  if (bodyFailed && cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], 'Recovery expiry E2E failed and owned cleanup also failed.');
  if (bodyFailed) throw primaryError;
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Recovery expiry E2E owned cleanup failed.');
});
